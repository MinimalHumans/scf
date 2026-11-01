// SPDX-License-Identifier: Apache-2.0
//! ffprobe-based technical probing (docs/media-server-spec.md §5 step
//! 3 "Probe"), video/audio only — see the plan: still images (EXR/
//! TIFF/PSD via oiiotool/magick) are Phase 5's job, not this one's.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    /// The short container name, e.g. `mov` from ffprobe's comma-
    /// separated `"mov,mp4,m4a,3gp,3g2,mj2"` (the first alias is the
    /// closest thing to a canonical name).
    pub container: Option<String>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub duration_secs: Option<f64>,
    pub fps: Option<f64>,
}

/// Spawns `ffprobe -show_format -show_streams` and parses its JSON.
/// `Err` for a spawn failure, a non-zero exit (ffprobe's usual response
/// to "this isn't a media file"), or output that doesn't parse as JSON
/// — never a panic.
pub fn probe(ffprobe_path: &Path, file: &Path) -> Result<ProbeResult, String> {
    let output = Command::new(ffprobe_path)
        .args(["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams"])
        .arg(file)
        .output()
        .map_err(|e| format!("could not run ffprobe: {e}"))?;
    if !output.status.success() {
        return Err("ffprobe could not read this file".to_string());
    }
    let json: Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("could not parse ffprobe's output: {e}"))?;
    Ok(parse_probe_json(&json))
}

fn str_field<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

fn stream_of_type<'a>(streams: Option<&'a Vec<Value>>, kind: &str) -> Option<&'a Value> {
    streams?.iter().find(|s| str_field(s, "codec_type") == Some(kind))
}

/// `"24000/1001"` -> `23.976...`. `None` for a zero or unparseable
/// denominator — ffprobe reports `"0/0"` for a stream with no frame
/// rate (an audio-only file, say), not an error.
fn parse_fraction(s: &str) -> Option<f64> {
    let (num, den) = s.split_once('/')?;
    let num: f64 = num.parse().ok()?;
    let den: f64 = den.parse().ok()?;
    if den == 0.0 { return None; }
    Some(num / den)
}

fn parse_probe_json(json: &Value) -> ProbeResult {
    let streams = json.get("streams").and_then(Value::as_array);
    let video = stream_of_type(streams, "video");
    let audio = stream_of_type(streams, "audio");
    let format = json.get("format");

    let container = format
        .and_then(|f| str_field(f, "format_name"))
        .map(|s| s.split(',').next().unwrap_or(s).to_string());

    let duration_secs = format
        .and_then(|f| str_field(f, "duration"))
        .and_then(|s| s.parse::<f64>().ok())
        .or_else(|| video.and_then(|v| str_field(v, "duration"))
                          .and_then(|s| s.parse::<f64>().ok()));

    ProbeResult {
        container,
        video_codec: video.and_then(|v| str_field(v, "codec_name")).map(str::to_string),
        audio_codec: audio.and_then(|v| str_field(v, "codec_name")).map(str::to_string),
        width: video.and_then(|v| v.get("width")).and_then(Value::as_u64).map(|n| n as u32),
        height: video.and_then(|v| v.get("height")).and_then(Value::as_u64).map(|n| n as u32),
        duration_secs,
        fps: video.and_then(|v| str_field(v, "r_frame_rate")).and_then(parse_fraction),
    }
}

type Signature = (u64, u64);

fn signature(path: &Path) -> Option<Signature> {
    let meta = std::fs::metadata(path).ok()?;
    let mtime = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_secs();
    Some((meta.len(), mtime))
}

/// `probe`, cached in memory by `(size, mtime)` — the same signature
/// heuristic the frontend's thumbnail cache already uses. Not the
/// spec's eventual content-hash persistent cache (Phase 4's job); this
/// only needs to survive one session.
#[derive(Clone, Default)]
pub struct ProbeCache {
    inner: Arc<Mutex<HashMap<PathBuf, (Signature, ProbeResult)>>>,
}

impl ProbeCache {
    pub fn probe(&self, ffprobe_path: &Path, file: &Path) -> Result<ProbeResult, String> {
        let sig = signature(file).ok_or_else(|| "could not read the file's size/time".to_string())?;
        if let Some((cached_sig, result)) = self.inner.lock().unwrap().get(file) {
            if *cached_sig == sig {
                return Ok(result.clone());
            }
        }
        let result = probe(ffprobe_path, file)?;
        self.inner.lock().unwrap().insert(file.to_path_buf(), (sig, result.clone()));
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn canned(json: &str) -> ProbeResult {
        parse_probe_json(&serde_json::from_str(json).unwrap())
    }

    #[test]
    fn parses_a_typical_h264_mp4() {
        let result = canned(r#"{
            "streams": [
                {"codec_type":"video","codec_name":"h264","width":1920,"height":1080,
                 "r_frame_rate":"24000/1001","duration":"135.500000"},
                {"codec_type":"audio","codec_name":"aac","duration":"135.500000"}
            ],
            "format": {"format_name":"mov,mp4,m4a,3gp,3g2,mj2","duration":"135.500000"}
        }"#);
        assert_eq!(result.container.as_deref(), Some("mov"));
        assert_eq!(result.video_codec.as_deref(), Some("h264"));
        assert_eq!(result.audio_codec.as_deref(), Some("aac"));
        assert_eq!(result.width, Some(1920));
        assert_eq!(result.height, Some(1080));
        assert_eq!(result.duration_secs, Some(135.5));
        assert!((result.fps.unwrap() - 23.976).abs() < 0.001);
    }

    #[test]
    fn a_video_with_no_audio_stream_has_no_audio_codec() {
        let result = canned(r#"{
            "streams": [
                {"codec_type":"video","codec_name":"vp9","width":640,"height":480,
                 "r_frame_rate":"30/1"}
            ],
            "format": {"format_name":"webm"}
        }"#);
        assert_eq!(result.video_codec.as_deref(), Some("vp9"));
        assert_eq!(result.audio_codec, None);
        assert_eq!(result.fps, Some(30.0));
    }

    #[test]
    fn an_audio_only_file_has_no_video_fields() {
        let result = canned(r#"{
            "streams": [
                {"codec_type":"audio","codec_name":"flac"}
            ],
            "format": {"format_name":"flac","duration":"212.0"}
        }"#);
        assert_eq!(result.video_codec, None);
        assert_eq!(result.width, None);
        assert_eq!(result.fps, None);
        assert_eq!(result.duration_secs, Some(212.0));
    }

    #[test]
    fn missing_fields_degrade_to_none_not_a_panic() {
        let result = canned("{}");
        assert_eq!(result, ProbeResult::default());
    }

    #[test]
    fn zero_over_zero_frame_rate_is_not_a_fps() {
        assert_eq!(parse_fraction("0/0"), None);
        assert_eq!(parse_fraction("garbage"), None);
    }

    #[test]
    fn probing_a_file_that_does_not_exist_is_an_error_not_a_panic() {
        let cache = ProbeCache::default();
        let result = cache.probe(
            Path::new("ffprobe"), Path::new("Z:/definitely/not/real.mp4"));
        assert!(result.is_err());
    }
}
