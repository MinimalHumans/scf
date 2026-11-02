// SPDX-License-Identifier: Apache-2.0
//! Running ffmpeg to actually produce a preview
//! (docs/media-server-spec.md §5's remux/transcode verdicts, §7's
//! output profiles). Video/audio only — stills are Phase 5.
//!
//! Spawning and waiting are split so a caller (media-server's queue)
//! can hold onto the running child to cancel it from a different task
//! than the one reading its progress output.

use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

use crate::DerivedParams;

fn remux_args(input: &Path, out_tmp: &Path) -> Vec<String> {
    vec![
        "-y".into(), "-v".into(), "quiet".into(), "-progress".into(), "pipe:1".into(),
        "-i".into(), input.display().to_string(),
        "-c".into(), "copy".into(),
        "-movflags".into(), "+faststart".into(),
        "-f".into(), "mp4".into(),
        out_tmp.display().to_string(),
    ]
}

/// Phase 8: the args that select and configure the video encoder —
/// `params.hardware_encoder`'s id (already confirmed present in this
/// machine's `ffmpeg -encoders` output, by `Backends::
/// best_hw_encoder`) when set, the software default otherwise. Each
/// hardware encoder takes its quality/rate-control flags under a
/// different name than libx264's `-crf`; these are the closest
/// equivalent for each, not independently tuned per vendor.
fn encoder_args(params: &DerivedParams) -> Vec<String> {
    match params.hardware_encoder.as_deref() {
        Some(enc @ "h264_nvenc") => vec![
            "-c:v".into(), enc.into(), "-preset".into(), "p4".into(),
            "-cq".into(), params.crf.to_string(),
        ],
        Some(enc @ "h264_qsv") => vec![
            "-c:v".into(), enc.into(), "-global_quality".into(), params.crf.to_string(),
        ],
        Some(enc @ "h264_amf") => vec![
            "-c:v".into(), enc.into(), "-rc".into(), "cqp".into(),
            "-qp_i".into(), params.crf.to_string(), "-qp_p".into(), params.crf.to_string(),
        ],
        Some(enc @ "h264_videotoolbox") => vec![
            "-c:v".into(), enc.into(), "-q:v".into(), params.crf.to_string(),
        ],
        _ => vec![
            "-c:v".into(), "libx264".into(), "-preset".into(), "veryfast".into(),
            "-crf".into(), params.crf.to_string(),
        ],
    }
}

fn transcode_args(input: &Path, out_tmp: &Path, params: &DerivedParams) -> Vec<String> {
    let mut args = vec![
        "-y".into(), "-v".into(), "quiet".into(), "-progress".into(), "pipe:1".into(),
        "-i".into(), input.display().to_string(),
    ];
    args.extend(encoder_args(params));
    args.extend([
        "-vf".into(), format!("scale='min({},iw)':-2", params.resolution_cap),
        "-pix_fmt".into(), "yuv420p".into(),
        // Fragmented, not faststart (Phase 8, spec §6 "Video delivery
        // before completion"): faststart's moov-to-front shuffle only
        // happens once the whole file is written, so a partial file is
        // not a valid MP4 until then. Fragments make every already-
        // written keyframe's worth of output independently playable
        // the moment it lands on disk — what lets `media-server`'s
        // `serve.rs` hand a still-running job's `.part` file straight
        // to the browser.
        "-movflags".into(), "+frag_keyframe+empty_moov+default_base_moof".into(),
        "-c:a".into(), "aac".into(),
        "-f".into(), "mp4".into(),
        out_tmp.display().to_string(),
    ]);
    args
}

/// A spawned ffmpeg conversion. `child` is shared so a caller can kill
/// it concurrently with [`wait_with_progress`] reading its output —
/// plain `Child::kill()` (`TerminateProcess` on Windows, `SIGKILL` on
/// Unix) is enough here: unlike a shell pipeline, `ffmpeg -c copy`/
/// `-c:v libx264` with a built-in encoder spawns no child processes of
/// its own to leak, so there is nothing a process-group kill would
/// catch that a direct kill doesn't.
///
/// `stderr_tail` (Phase 7) is shared too, for the same reason: a
/// caller that wants it on failure (`media-server`'s queue, for the
/// dashboard's failures list) needs to have cloned the `Arc` out
/// *before* handing `self` to [`wait_with_progress`], which consumes
/// it.
pub struct Spawned {
    pub child: Arc<Mutex<Child>>,
    pub stderr_tail: Arc<Mutex<String>>,
    stdout: std::process::ChildStdout,
}

fn spawn(ffmpeg: &Path, args: &[String]) -> std::io::Result<Spawned> {
    let mut child = Command::new(ffmpeg)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let stdout = child.stdout.take().expect("stdout was piped");
    let stderr = child.stderr.take().expect("stderr was piped");
    let stderr_tail = crate::proc_tail::spawn_tail_reader(stderr);
    Ok(Spawned { child: Arc::new(Mutex::new(child)), stderr_tail, stdout })
}

/// `ffmpeg -c copy` — the codec is already decodable, only the
/// container needs rewrapping (spec §5 "remux": "Treated as cheap").
pub fn spawn_remux(ffmpeg: &Path, input: &Path, out_tmp: &Path) -> std::io::Result<Spawned> {
    spawn(ffmpeg, &remux_args(input, out_tmp))
}

/// H.264/yuv420p/faststart, capped to `params.resolution_cap` on the
/// long edge, at `params.crf` — spec §7 "Output profiles" defaults
/// (1080p cap, a CRF setting), not yet user-configurable (the plan's
/// decision 7).
pub fn spawn_transcode(
    ffmpeg: &Path, input: &Path, out_tmp: &Path, params: &DerivedParams,
) -> std::io::Result<Spawned> {
    spawn(ffmpeg, &transcode_args(input, out_tmp, params))
}

/// Reads `-progress pipe:1`'s `key=value` lines, calling `on_progress`
/// with a 0.0-1.0 fraction whenever `out_time_ms` appears (ffmpeg's own
/// long-standing misnomer: despite the name, this field is
/// microseconds, not milliseconds — confirmed against a real build
/// during this phase's verification) and `duration_secs` is known; then
/// waits for the process to exit. `Err` names the exit status, never a
/// panic — ffmpeg failing is a normal, expected outcome for some input,
/// not a bug in this code.
pub fn wait_with_progress(
    spawned: Spawned, duration_secs: Option<f64>, mut on_progress: impl FnMut(f64),
) -> Result<(), String> {
    use std::io::{BufRead, BufReader};
    let reader = BufReader::new(spawned.stdout);
    for line in reader.lines().map_while(Result::ok) {
        if let Some(value) = line.strip_prefix("out_time_ms=") {
            if let (Ok(us), Some(duration)) = (value.trim().parse::<i64>(), duration_secs) {
                if duration > 0.0 {
                    on_progress(((us as f64 / 1_000_000.0) / duration).clamp(0.0, 1.0));
                }
            }
        }
    }
    let status = spawned.child.lock().unwrap().wait().map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("ffmpeg exited with {status}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remux_copies_the_codec_and_only_rewraps_the_container() {
        let args = remux_args(Path::new("in.mov"), Path::new("out.part"));
        assert!(args.contains(&"copy".to_string()));
        assert!(args.contains(&"in.mov".to_string()));
        assert!(args.contains(&"out.part".to_string()));
        assert!(!args.iter().any(|a| a == "libx264"));
    }

    #[test]
    fn transcode_bakes_in_the_resolution_cap_and_crf() {
        let params = DerivedParams { resolution_cap: 720, crf: 28, ..Default::default() };
        let args = transcode_args(Path::new("in.mp4"), Path::new("out.part"), &params);
        assert!(args.iter().any(|a| a.contains("min(720,iw)")));
        assert!(args.contains(&"28".to_string()));
        assert!(args.contains(&"libx264".to_string()));
    }

    /// Phase 8: no hardware encoder configured means libx264, exactly
    /// as every earlier phase already assumed.
    #[test]
    fn transcode_without_a_hardware_encoder_uses_libx264() {
        let params = DerivedParams { resolution_cap: 1080, crf: 23, ..Default::default() };
        let args = transcode_args(Path::new("in.mp4"), Path::new("out.part"), &params);
        assert!(args.contains(&"libx264".to_string()));
        assert!(!args.iter().any(|a| a.contains("nvenc")));
    }

    #[test]
    fn transcode_with_a_hardware_encoder_uses_it_instead_of_libx264() {
        let params = DerivedParams {
            resolution_cap: 1080, crf: 23,
            hardware_encoder: Some("h264_nvenc".to_string()), ..Default::default()
        };
        let args = transcode_args(Path::new("in.mp4"), Path::new("out.part"), &params);
        assert!(args.contains(&"h264_nvenc".to_string()));
        assert!(!args.contains(&"libx264".to_string()));
        assert!(args.contains(&"-cq".to_string()));
    }

    /// Phase 8's progressive delivery depends on the output being
    /// fragmented, and specifically *not* carrying `+faststart` (which
    /// needs the whole file before it's a valid MP4 at all).
    #[test]
    fn transcode_output_is_fragmented_not_faststart() {
        let params = DerivedParams { resolution_cap: 1080, crf: 23, ..Default::default() };
        let args = transcode_args(Path::new("in.mp4"), Path::new("out.part"), &params);
        let movflags = args.iter().find(|a| a.contains("frag_keyframe"))
            .expect("movflags should include frag_keyframe");
        assert!(movflags.contains("empty_moov"));
        assert!(!movflags.contains("faststart"));
    }

    #[test]
    fn spawning_a_nonexistent_binary_is_an_io_error_not_a_panic() {
        let result = spawn_remux(
            Path::new("Z:/definitely/not/ffmpeg.exe"),
            Path::new("in.mov"), Path::new("out.part"));
        assert!(result.is_err());
    }

    /// Exercises the real `ffmpeg` on this machine end to end: remux a
    /// tiny real video, confirm it succeeds and progress reaches
    /// completion. Ignored by default (CI has no ffmpeg) — run with
    /// `cargo test -p media-core -- --ignored`.
    #[test]
    #[ignore = "depends on this machine's installed backends"]
    fn remuxing_a_real_file_succeeds_and_reports_progress_to_completion() {
        let statuses = crate::detect_all(&std::collections::HashMap::new());
        let Some(ffmpeg) = statuses.iter().find(|s| s.id == "ffmpeg" && s.ok)
            .and_then(|s| s.path.clone()) else {
            eprintln!("skipping: no real ffmpeg found on this machine");
            return;
        };

        let dir = std::env::temp_dir().join(format!("media-core-convert-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let input = dir.join("in.mp4");
        let output = dir.join("out.part");

        let status = Command::new(&ffmpeg)
            .args(["-y", "-f", "lavfi", "-i", "testsrc=size=64x64:rate=5:duration=1", "-pix_fmt", "yuv420p"])
            .arg(&input)
            .status()
            .unwrap();
        assert!(status.success());

        let mut last_progress = 0.0;
        let spawned = spawn_remux(Path::new(&ffmpeg), &input, &output).unwrap();
        let result = wait_with_progress(spawned, Some(1.0), |p| last_progress = p);

        assert!(result.is_ok(), "{result:?}");
        assert!(output.exists());
        assert!(last_progress > 0.5, "progress only reached {last_progress}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Phase 8, end to end: if this machine's real `ffmpeg` actually
    /// lists a hardware encoder, transcode with it for real and
    /// confirm it produces real output — not just that the right args
    /// get built (the other hardware-encoder tests above are pure
    /// argument checks; this is the one place anything here actually
    /// drives a GPU encoder). Ignored by default — run with `cargo
    /// test -p media-core -- --ignored`.
    #[test]
    #[ignore = "depends on this machine's installed backends and GPU"]
    fn transcoding_with_a_real_hardware_encoder_succeeds_when_one_is_available() {
        let statuses = crate::detect_all(&std::collections::HashMap::new());
        let Some(ffmpeg_status) = statuses.iter().find(|s| s.id == "ffmpeg" && s.ok) else {
            eprintln!("skipping: no real ffmpeg found on this machine");
            return;
        };
        let Some(encoder) = ffmpeg_status.hw_encoders.first().cloned() else {
            eprintln!("skipping: this machine's ffmpeg reports no known hardware encoder");
            return;
        };
        let ffmpeg = ffmpeg_status.path.clone().unwrap();

        let dir = std::env::temp_dir()
            .join(format!("media-core-convert-hwenc-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let input = dir.join("in.mp4");
        let output = dir.join("out.part");

        let status = Command::new(&ffmpeg)
            .args(["-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=5:duration=1", "-pix_fmt", "yuv420p"])
            .arg(&input)
            .status()
            .unwrap();
        assert!(status.success());

        let params = DerivedParams {
            resolution_cap: 1080, crf: 23, hardware_encoder: Some(encoder.clone()), ..Default::default()
        };
        let spawned = spawn_transcode(Path::new(&ffmpeg), &input, &output, &params).unwrap();
        let result = wait_with_progress(spawned, Some(1.0), |_| {});

        assert!(result.is_ok(), "{encoder}: {result:?}");
        assert!(output.exists());
        assert!(std::fs::metadata(&output).unwrap().len() > 0);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
