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
    /// Separate from `inner` rather than folded into one struct value,
    /// so `set`'s existing signature (and every call site, test or
    /// otherwise) stays untouched — this is purely additive, for the
    /// cache key's `backend_version` component (spec §7 "Key").
    versions: Arc<Mutex<HashMap<String, String>>>,
    /// Phase 8: this machine's detected hardware encoders per binary
    /// (really only ever populated for `"ffmpeg"`), same reason it's
    /// separate from `inner` as `versions` is.
    hw_encoders: Arc<Mutex<HashMap<String, Vec<String>>>>,
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

    fn set_version(&self, id: &str, version: Option<String>) {
        let mut map = self.versions.lock().unwrap();
        match version {
            Some(v) => { map.insert(id.to_string(), v); }
            None => { map.remove(id); }
        }
    }

    /// The version string last reported for this binary, or a fixed
    /// placeholder when none is known yet — the cache key (spec §7)
    /// needs *some* value to hash even before a version has ever been
    /// seen, and an empty string would silently collide with "ran once,
    /// reported nothing."
    pub fn version(&self, id: &str) -> String {
        self.versions.lock().unwrap().get(id).cloned()
            .unwrap_or_else(|| "unknown".to_string())
    }

    fn set_hw_encoders(&self, id: &str, encoders: Vec<String>) {
        let mut map = self.hw_encoders.lock().unwrap();
        if encoders.is_empty() {
            map.remove(id);
        } else {
            map.insert(id.to_string(), encoders);
        }
    }

    /// This machine's available hardware encoders for `id` (Phase 8) —
    /// always empty for anything but `"ffmpeg"`.
    pub fn hw_encoders(&self, id: &str) -> Vec<String> {
        self.hw_encoders.lock().unwrap().get(id).cloned().unwrap_or_default()
    }

    /// The hardware encoder `queue.rs` should prefer for `id`'s next
    /// transcode, or `None` to fall back to the software default
    /// (libx264) — nvenc first (the fastest and most broadly available
    /// of the four this crate knows), then qsv, amf, videotoolbox, in a
    /// fixed order rather than anything benchmarked on this machine.
    pub fn best_hw_encoder(&self, id: &str) -> Option<String> {
        const PREFERENCE: [&str; 4] =
            ["h264_nvenc", "h264_qsv", "h264_amf", "h264_videotoolbox"];
        let available = self.hw_encoders(id);
        PREFERENCE.iter().find(|e| available.iter().any(|a| a == *e)).map(|s| s.to_string())
    }

    /// Replace every known path (and version, and hardware encoders)
    /// from a fresh [`detect_all`](crate::detect_all) result in one go
    /// — the usual way this registry gets updated, at startup and
    /// after every Settings → Re-detect.
    pub fn update_from(&self, statuses: &[BackendStatus]) {
        for status in statuses {
            let path = if status.ok {
                status.path.as_ref().map(PathBuf::from)
            } else {
                None
            };
            self.set(&status.id, path);
            self.set_version(&status.id, if status.ok { status.version.clone() } else { None });
            self.set_hw_encoders(&status.id, if status.ok { status.hw_encoders.clone() } else { Vec::new() });
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

    #[test]
    fn an_unknown_version_is_a_stable_placeholder_not_empty() {
        let backends = Backends::default();
        assert_eq!(backends.version("ffmpeg"), "unknown");
    }

    #[test]
    fn best_hw_encoder_is_none_when_nothing_was_detected() {
        let backends = Backends::default();
        assert_eq!(backends.best_hw_encoder("ffmpeg"), None);
        assert_eq!(backends.hw_encoders("ffmpeg"), Vec::<String>::new());
    }

    #[test]
    fn best_hw_encoder_prefers_nvenc_over_other_detected_encoders() {
        let backends = Backends::default();
        backends.update_from(&[BackendStatus {
            id: "ffmpeg".to_string(), path: Some("C:/bin/ffmpeg.exe".to_string()), ok: true,
            hw_encoders: vec!["h264_qsv".to_string(), "h264_nvenc".to_string()],
            ..Default::default()
        }]);
        assert_eq!(backends.best_hw_encoder("ffmpeg"), Some("h264_nvenc".to_string()));
    }

    #[test]
    fn update_from_clears_hw_encoders_when_a_backend_stops_being_ok() {
        let backends = Backends::default();
        backends.update_from(&[BackendStatus {
            id: "ffmpeg".to_string(), path: Some("C:/bin/ffmpeg.exe".to_string()), ok: true,
            hw_encoders: vec!["h264_nvenc".to_string()], ..Default::default()
        }]);
        assert_eq!(backends.best_hw_encoder("ffmpeg"), Some("h264_nvenc".to_string()));

        backends.update_from(&[BackendStatus { id: "ffmpeg".to_string(), ok: false, ..Default::default() }]);
        assert_eq!(backends.best_hw_encoder("ffmpeg"), None);
    }

    #[test]
    fn update_from_also_tracks_version_and_clears_it_when_not_ok() {
        let backends = Backends::default();
        let statuses = vec![BackendStatus {
            id: "ffmpeg".to_string(), path: Some("C:/bin/ffmpeg.exe".to_string()),
            version: Some("6.1.1".to_string()), ok: true, ..Default::default()
        }];
        backends.update_from(&statuses);
        assert_eq!(backends.version("ffmpeg"), "6.1.1");

        let gone = vec![BackendStatus {
            id: "ffmpeg".to_string(), ok: false, ..Default::default()
        }];
        backends.update_from(&gone);
        assert_eq!(backends.version("ffmpeg"), "unknown");
    }
}
