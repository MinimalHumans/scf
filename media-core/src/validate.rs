// SPDX-License-Identifier: Apache-2.0
//! Confirming a discovered binary actually runs, and reading what it
//! says about itself (docs/media-server-spec.md §3 "Validation").
//!
//! Best-effort by design: a real capability matrix (format in/out lists,
//! encoder availability) is Phase 5's still pipeline, not this skeleton.
//! This only has to be reliable about "does it run" and "what version",
//! plus a few fixed tokens worth surfacing in a settings summary line.

use crate::{Binary, BackendStatus};
use std::path::Path;

pub fn validate(binary: Binary, path: &Path) -> BackendStatus {
    let id = binary.id().to_string();
    let path_str = path.display().to_string();

    let Some(version_text) = run(path, &[version_arg(binary)]) else {
        return BackendStatus {
            id,
            path: Some(path_str),
            error: Some("could not run it".to_string()),
            ..Default::default()
        };
    };

    let notable = second_probe_args(binary)
        .and_then(|args| run(path, args))
        .map(|text| notable_tokens(binary, &text))
        .unwrap_or_default();
    let hw_encoders = detect_hw_encoders(binary, path);

    BackendStatus {
        id,
        path: Some(path_str),
        version: parse_version(&version_text),
        ok: true,
        error: None,
        notable,
        hw_encoders,
    }
}

/// Phase 8, spec §3's "Record libx264 / hardware encoder availability":
/// the hardware encoders `convert.rs` actually knows how to drive,
/// checked against `ffmpeg -encoders`' own output (one encoder name
/// per line, among much else this doesn't try to parse). Deliberately
/// a fixed, small list rather than every `*_nvenc`/`*_qsv`/`*_amf`/
/// `*_videotoolbox` name ffmpeg might report — H.264 only, since the
/// output profile (spec §7) is H.264 regardless of which encoder
/// produces it.
const HW_ENCODERS: &[&str] = &["h264_nvenc", "h264_qsv", "h264_amf", "h264_videotoolbox"];

fn hw_encoders_from_text(text: &str) -> Vec<String> {
    HW_ENCODERS.iter().filter(|e| text.contains(*e)).map(|s| s.to_string()).collect()
}

fn detect_hw_encoders(binary: Binary, path: &Path) -> Vec<String> {
    if binary != Binary::Ffmpeg {
        return Vec::new();
    }
    run(path, &["-encoders"]).map(|text| hw_encoders_from_text(&text)).unwrap_or_default()
}

/// Runs `path` with `args`, returning stdout, or stderr when stdout is
/// empty (several of these tools print their version banner there).
/// `None` on a spawn failure — the caller treats that as "not usable",
/// never panics or propagates the error.
fn run(path: &Path, args: &[&str]) -> Option<String> {
    let output = crate::winproc::command(path).args(args).output().ok()?;
    let out = String::from_utf8_lossy(&output.stdout).into_owned();
    if out.trim().is_empty() {
        Some(String::from_utf8_lossy(&output.stderr).into_owned())
    } else {
        Some(out)
    }
}

fn version_arg(binary: Binary) -> &'static str {
    match binary {
        Binary::Ffmpeg | Binary::Ffprobe => "-version",
        Binary::Magick => "-version",
        // oiiotool has no dedicated version flag; its banner is the
        // first line of --help.
        Binary::Oiiotool => "--help",
    }
}

/// A second probe for the summary line's "which types are unlocked"
/// hint. `None` where the first probe already says enough.
fn second_probe_args(binary: Binary) -> Option<&'static [&'static str]> {
    match binary {
        Binary::Ffmpeg => Some(&["-decoders"]),
        Binary::Ffprobe => None,
        Binary::Magick => Some(&["-list", "format"]),
        Binary::Oiiotool => Some(&["--buildinfo"]),
    }
}

/// A fixed, best-effort set of substrings worth surfacing per binary —
/// see the module comment.
fn notable_tokens(binary: Binary, text: &str) -> Vec<String> {
    let candidates: &[&str] = match binary {
        Binary::Ffmpeg => &["hevc", "av1", "prores", "vp9"],
        Binary::Ffprobe => &[],
        Binary::Magick => &["TIFF", "PSD", "HEIC", "DPX"],
        Binary::Oiiotool => &["OpenColorIO", "OpenEXR"],
    };
    let lower = text.to_lowercase();
    candidates
        .iter()
        .filter(|t| lower.contains(&t.to_lowercase()))
        .map(|t| t.to_string())
        .collect()
}

/// The first non-blank line's leading digit-starting token, e.g.
/// `ffmpeg version 6.1.1-full_build ...` -> `6.1.1-full_build`. Falls
/// back to the whole line when nothing looks like a version, so a
/// binary that clearly ran always has something to show.
fn parse_version(text: &str) -> Option<String> {
    let first_line = text.lines().find(|l| !l.trim().is_empty())?.trim();
    let token = first_line
        .split_whitespace()
        .find(|t| t.chars().next().is_some_and(|c| c.is_ascii_digit()));
    Some(token.unwrap_or(first_line).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_typical_ffmpeg_banner() {
        let text = "ffmpeg version 6.1.1-full_build-www.gyan.dev \
                     Copyright (c) 2000-2023 the FFmpeg developers\n\
                     built with gcc 12.2.0";
        assert_eq!(
            parse_version(text),
            Some("6.1.1-full_build-www.gyan.dev".to_string())
        );
    }

    #[test]
    fn parses_an_oiiotool_help_banner() {
        let text = "oiiotool -- Open Image I/O 2.5.9.0 image utility\nUsage:\n  oiiotool ...";
        assert_eq!(parse_version(text), Some("2.5.9.0".to_string()));
    }

    #[test]
    fn falls_back_to_the_whole_line_with_no_digit_token() {
        let text = "some tool, no version info here\nmore stuff";
        assert_eq!(
            parse_version(text),
            Some("some tool, no version info here".to_string())
        );
    }

    #[test]
    fn empty_output_has_no_version() {
        assert_eq!(parse_version(""), None);
        assert_eq!(parse_version("\n\n  \n"), None);
    }

    #[test]
    fn hw_encoders_from_text_finds_only_the_known_ones() {
        let text = "Encoders:\n V..... h264_nvenc  NVIDIA NVENC H.264\n \
                     V..... libx264  libx264 H.264\n V..... hevc_nvenc  NVIDIA NVENC HEVC";
        assert_eq!(hw_encoders_from_text(text), vec!["h264_nvenc".to_string()]);
    }

    #[test]
    fn hw_encoders_from_text_is_empty_when_none_are_listed() {
        assert!(hw_encoders_from_text("V..... libx264  libx264 H.264").is_empty());
    }

    #[test]
    fn detect_hw_encoders_is_always_empty_for_a_non_ffmpeg_binary() {
        assert!(detect_hw_encoders(Binary::Magick, Path::new("Z:/not/real/magick.exe")).is_empty());
    }

    #[test]
    fn notable_tokens_are_case_insensitive_and_fixed_per_binary() {
        let found = notable_tokens(Binary::Magick, "Readable formats: TIFF PSD PNG");
        assert_eq!(found, vec!["TIFF".to_string(), "PSD".to_string()]);
        assert!(notable_tokens(Binary::Ffprobe, "hevc av1 prores").is_empty());
    }
}
