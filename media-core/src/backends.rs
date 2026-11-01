// SPDX-License-Identifier: Apache-2.0
//! The currently-known-good backend paths (docs/media-server-spec.md
//! §2: "media-core... Contains probe, backends, queue, cache,
//! resolver"). [`detect_all`](crate::detect_all) stays the one-shot
//! "run discovery and validation right now" function Settings' Re-
//! detect button uses; this is the longer-lived registry the probe
//! path reads from instead of re-running discovery on every request.
//!
//! Mirrors `media-server`'s `Handles`: cheap to clone, shareable as
//! Tauri state, written by one side (the detection command) and read
//! by another (the HTTP listener's `/meta` handler).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use crate::BackendStatus;

#[derive(Clone, Default)]
pub struct Backends {
    inner: Arc<Mutex<HashMap<String, PathBuf>>>,
}

impl Backends {
    /// Replace the known path for one binary, or clear it (`None`) when
    /// it's no longer usable.
    pub fn set(&self, id: &str, path: Option<PathBuf>) {
        let mut map = self.inner.lock().unwrap();
        match path {
            Some(p) => { map.insert(id.to_string(), p); }
            None => { map.remove(id); }
        }
    }

    pub fn get(&self, id: &str) -> Option<PathBuf> {
        self.inner.lock().unwrap().get(id).cloned()
    }

    /// Replace every known path from a fresh [`detect_all`](crate::detect_all)
    /// result in one go — the usual way this registry gets updated, at
    /// startup and after every Settings → Re-detect.
    pub fn update_from(&self, statuses: &[BackendStatus]) {
        for status in statuses {
            let path = if status.ok {
                status.path.as_ref().map(PathBuf::from)
            } else {
                None
            };
            self.set(&status.id, path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_binary_resolves_to_nothing() {
        let backends = Backends::default();
        assert_eq!(backends.get("ffmpeg"), None);
    }

    #[test]
    fn set_then_get_round_trips() {
        let backends = Backends::default();
        backends.set("ffmpeg", Some(PathBuf::from("C:/bin/ffmpeg.exe")));
        assert_eq!(backends.get("ffmpeg"), Some(PathBuf::from("C:/bin/ffmpeg.exe")));
    }

    #[test]
    fn setting_none_clears_it() {
        let backends = Backends::default();
        backends.set("ffmpeg", Some(PathBuf::from("C:/bin/ffmpeg.exe")));
        backends.set("ffmpeg", None);
        assert_eq!(backends.get("ffmpeg"), None);
    }

    #[test]
    fn update_from_sets_ok_and_clears_not_ok() {
        let backends = Backends::default();
        backends.set("magick", Some(PathBuf::from("stale")));
        let statuses = vec![
            BackendStatus {
                id: "ffmpeg".to_string(),
                path: Some("C:/bin/ffmpeg.exe".to_string()),
                ok: true,
                ..Default::default()
            },
            BackendStatus {
                id: "magick".to_string(),
                ok: false,
                ..Default::default()
            },
        ];
        backends.update_from(&statuses);
        assert_eq!(backends.get("ffmpeg"), Some(PathBuf::from("C:/bin/ffmpeg.exe")));
        assert_eq!(backends.get("magick"), None);
    }
}
