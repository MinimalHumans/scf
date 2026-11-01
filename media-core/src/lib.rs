// SPDX-License-Identifier: Apache-2.0
//! media-core — discovery and validation of the media server's external
//! backends (docs/media-server-spec.md §3), Phase 1 only.
//!
//! No Tauri or webview dependency, deliberately: this is the seam a
//! standalone, differently-hosted media server (the spec's own future —
//! §2's "networked/shared store" extension point) reuses without pulling
//! in a desktop shell. Settings (manual path overrides) are not read or
//! written here either — that contract belongs to `scf-host`'s `pref`
//! table, and this crate only ever receives an override as a plain
//! argument, never reaches for it itself.

mod discover;
mod validate;

use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;

/// The four backends the spec names (§3). `ALL` is the detection order
/// shown in Settings, not a priority order for dispatch — there is no
/// dispatch yet in Phase 1.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Binary {
    Ffmpeg,
    Ffprobe,
    Magick,
    Oiiotool,
}

impl Binary {
    pub const ALL: [Binary; 4] =
        [Binary::Ffmpeg, Binary::Ffprobe, Binary::Magick, Binary::Oiiotool];

    /// The key this binary is addressed by: in `overrides`, in settings,
    /// and in the status the frontend receives. Also its executable's
    /// base name (no platform extension) — all four happen to match.
    pub fn id(self) -> &'static str {
        match self {
            Binary::Ffmpeg => "ffmpeg",
            Binary::Ffprobe => "ffprobe",
            Binary::Magick => "magick",
            Binary::Oiiotool => "oiiotool",
        }
    }
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendStatus {
    pub id: String,
    pub path: Option<String>,
    pub version: Option<String>,
    pub ok: bool,
    pub error: Option<String>,
    /// A fixed, best-effort set of tokens found in a capability probe
    /// (e.g. `hevc`, `PSD`) — not a real capability matrix. Good enough
    /// for the settings summary line; Phase 5's still pipeline is where
    /// this becomes load-bearing.
    pub notable: Vec<String>,
}

/// Detect and validate every known backend. `overrides` maps a binary's
/// [`Binary::id`] to a user-chosen path (from `scf-host`'s `pref`,
/// resolved by the caller — this function never touches settings
/// itself), tried before PATH and known install locations.
///
/// Never panics: a binary that can't be found, or that fails to spawn or
/// to produce parseable output, is reported in its own `BackendStatus`,
/// never as an error for the whole call. One broken backend must not
/// hide whether the other three work.
pub fn detect_all(overrides: &HashMap<String, String>) -> Vec<BackendStatus> {
    Binary::ALL
        .iter()
        .map(|&binary| detect_one(binary, overrides.get(binary.id()).map(PathBuf::from)))
        .collect()
}

fn detect_one(binary: Binary, override_path: Option<PathBuf>) -> BackendStatus {
    match discover::discover(binary, override_path.as_deref()) {
        discover::Discovered::Found(path) => validate::validate(binary, &path),
        discover::Discovered::OverrideInvalid(path) => BackendStatus {
            id: binary.id().to_string(),
            path: Some(path.display().to_string()),
            error: Some("the configured path does not exist".to_string()),
            ..Default::default()
        },
        discover::Discovered::NotFound => BackendStatus {
            id: binary.id().to_string(),
            error: Some(
                "not found on PATH or in any known install location".to_string(),
            ),
            ..Default::default()
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_stable() {
        let ids: Vec<&str> = Binary::ALL.iter().map(|b| b.id()).collect();
        assert_eq!(ids, ["ffmpeg", "ffprobe", "magick", "oiiotool"]);
    }

    #[test]
    fn invalid_override_short_circuits_before_any_spawn() {
        let mut overrides = HashMap::new();
        overrides.insert(
            "ffmpeg".to_string(),
            "Z:/definitely/does/not/exist/ffmpeg.exe".to_string(),
        );
        let statuses = detect_all(&overrides);
        let ffmpeg = statuses.iter().find(|s| s.id == "ffmpeg").unwrap();
        assert!(!ffmpeg.ok);
        assert_eq!(
            ffmpeg.error.as_deref(),
            Some("the configured path does not exist")
        );
        assert!(ffmpeg.version.is_none());
    }
}
