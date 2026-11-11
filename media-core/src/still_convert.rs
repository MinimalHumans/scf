// SPDX-License-Identifier: Apache-2.0
//! Running oiiotool/magick to actually flatten a still image to a
//! displayable PNG/JPEG (docs/media-server-spec.md §5's `render`
//! verdict, §7's still output profile). `convert.rs`'s stills
//! counterpart — same pure-args/spawn/wait split, but no progress
//! parsing (spec §6: "oiiotool/magick report start/finish only").

use std::path::Path;
use std::process::{Child, Stdio};
use std::sync::{Arc, Mutex};

use crate::still_probe::StillSelection;

/// `max_long_edge`: the still output profile's cap (spec §7), default
/// 2048 per [`crate::cache::StillDerivedParams`] — kept as a bare u32
/// here rather than taking the whole `StillDerivedParams` struct, so
/// this module doesn't need to know about the cache crate's types.
fn oiiotool_render_args(
    input: &Path, out_tmp: &Path, selection: &StillSelection,
    width: Option<u32>, height: Option<u32>, max_long_edge: u32,
) -> Vec<String> {
    let mut args = vec![input.display().to_string()];
    if selection.multipart {
        if let Some(name) = &selection.subimage {
            args.push("--subimage".into());
            args.push(name.clone());
        }
    } else if !selection.channels.is_empty() {
        args.push("--ch".into());
        args.push(selection.channels.join(","));
    }
    // A cap, not a forced fit: `--fit` upscales a smaller image to
    // exactly fill its target box (confirmed against a real run this
    // phase), which is wrong for a source already under the cap —
    // only add it when the source is actually larger.
    let long_edge = width.unwrap_or(0).max(height.unwrap_or(0));
    if long_edge > max_long_edge {
        args.push("--fit".into());
        args.push(format!("{max_long_edge}x{max_long_edge}"));
    }
    args.push("--colorconvert".into());
    args.push("linear".into());
    args.push("sRGB".into());
    args.push("-d".into());
    args.push("uint8".into());
    // `-o:fileformatname=jpeg` (confirmed against a real run): the
    // `.part` output path has no extension for oiiotool to guess a
    // format from, the same reason `convert.rs`'s ffmpeg args force
    // `-f mp4` rather than relying on the filename.
    args.push("-o:fileformatname=jpeg".into());
    args.push(out_tmp.display().to_string());
    args
}

/// `in.ext[0]` reads the first page/frame — the "flatten to one
/// image" scope this phase gives magick-backed formats (no layer
/// picker; see the plan). `-resize 'NxN>'` is ImageMagick's own
/// "shrink to fit, never enlarge" geometry syntax (confirmed against a
/// real run), so no manual size comparison is needed here the way
/// oiiotool's `--fit` needs one above. The output is written as
/// `jpg:<path>` (confirmed against a real run) for the same reason
/// oiiotool's args force a format name: the `.part` path has no
/// extension for magick to guess a format from.
fn magick_render_args(input: &Path, out_tmp: &Path, max_long_edge: u32) -> Vec<String> {
    vec![
        format!("{}[0]", input.display()),
        "-colorspace".into(), "sRGB".into(),
        "-resize".into(), format!("{max_long_edge}x{max_long_edge}>"),
        format!("jpg:{}", out_tmp.display()),
    ]
}

/// `child` and `stderr_tail` (Phase 7) are shared the same way, and
/// for the same reason, as `convert.rs`'s `Spawned` — a caller needs
/// to clone `stderr_tail` out before `wait_still` consumes the rest.
pub struct SpawnedStill {
    pub child: Arc<Mutex<Child>>,
    pub stderr_tail: Arc<Mutex<String>>,
}

fn spawn(backend: &Path, args: &[String]) -> std::io::Result<SpawnedStill> {
    let mut child = crate::winproc::command(backend)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()?;
    let stderr = child.stderr.take().expect("stderr was piped");
    let stderr_tail = crate::proc_tail::spawn_tail_reader(stderr);
    Ok(SpawnedStill { child: Arc::new(Mutex::new(child)), stderr_tail })
}

/// What [`spawn_still_render`] needs — bundled so the call doesn't
/// carry eight loose arguments. `width`/`height` (the probe's own,
/// used only to decide whether a resize is needed — see
/// `oiiotool_render_args`) are ignored by the magick path, whose own
/// geometry syntax already handles "only shrink."
pub struct StillRenderArgs<'a> {
    pub backend_id: &'a str,
    pub backend_path: &'a Path,
    pub input: &'a Path,
    pub out_tmp: &'a Path,
    pub selection: &'a StillSelection,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub max_long_edge: u32,
}

/// Spawns the right backend for `args.backend_id` ("oiiotool" or
/// "magick").
pub fn spawn_still_render(args: StillRenderArgs<'_>) -> std::io::Result<SpawnedStill> {
    let built = if args.backend_id == "oiiotool" {
        oiiotool_render_args(
            args.input, args.out_tmp, args.selection, args.width, args.height, args.max_long_edge)
    } else {
        magick_render_args(args.input, args.out_tmp, args.max_long_edge)
    };
    spawn(args.backend_path, &built)
}

/// Waits for a still render to finish. No progress to report (spec
/// §6) — a render is one fast operation, not a multi-minute encode,
/// so there's nothing worth a progress bar over.
pub fn wait_still(child: Arc<Mutex<Child>>) -> Result<(), String> {
    let status = child.lock().unwrap().wait().map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("the still backend exited with {status}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn layer_selection(channels: &[&str]) -> StillSelection {
        StillSelection {
            multipart: false, subimage: None,
            channels: channels.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn a_channel_prefix_layer_selects_with_ch() {
        let sel = layer_selection(&["beauty.R", "beauty.G", "beauty.B"]);
        let args = oiiotool_render_args(
            Path::new("in.exr"), Path::new("out.part"), &sel, Some(100), Some(100), 2048);
        let i = args.iter().position(|a| a == "--ch").unwrap();
        assert_eq!(args[i + 1], "beauty.R,beauty.G,beauty.B");
    }

    #[test]
    fn a_multipart_selection_uses_subimage_not_ch() {
        let sel = StillSelection {
            multipart: true, subimage: Some("right".to_string()), channels: Vec::new(),
        };
        let args = oiiotool_render_args(
            Path::new("in.exr"), Path::new("out.part"), &sel, Some(100), Some(100), 2048);
        let i = args.iter().position(|a| a == "--subimage").unwrap();
        assert_eq!(args[i + 1], "right");
        assert!(!args.iter().any(|a| a == "--ch"));
    }

    #[test]
    fn a_source_already_under_the_cap_is_never_resized() {
        let sel = StillSelection::default();
        let args = oiiotool_render_args(
            Path::new("in.exr"), Path::new("out.part"), &sel, Some(512), Some(300), 2048);
        assert!(!args.iter().any(|a| a == "--fit"));
    }

    #[test]
    fn a_source_over_the_cap_is_fit_to_it() {
        let sel = StillSelection::default();
        let args = oiiotool_render_args(
            Path::new("in.exr"), Path::new("out.part"), &sel, Some(4000), Some(2000), 2048);
        let i = args.iter().position(|a| a == "--fit").unwrap();
        assert_eq!(args[i + 1], "2048x2048");
    }

    #[test]
    fn magick_args_read_the_first_frame_and_only_shrink() {
        let args = magick_render_args(Path::new("in.psd"), Path::new("out.part"), 2048);
        assert_eq!(args[0], "in.psd[0]");
        assert!(args.contains(&"2048x2048>".to_string()));
        assert!(args.last().unwrap().starts_with("jpg:"));
    }

    #[test]
    fn spawning_a_nonexistent_binary_is_an_io_error_not_a_panic() {
        let result = spawn_still_render(StillRenderArgs {
            backend_id: "magick", backend_path: Path::new("Z:/definitely/not/magick.exe"),
            input: Path::new("in.psd"), out_tmp: Path::new("out.part"),
            selection: &StillSelection::default(), width: Some(10), height: Some(10), max_long_edge: 2048,
        });
        assert!(result.is_err());
    }

    /// Exercises the real `magick` installed on this dev machine end
    /// to end: flatten a tiny real TIFF, confirm the output exists.
    /// Ignored by default — run with `cargo test -p media-core --
    /// --ignored`.
    #[test]
    #[ignore = "depends on this machine's installed backends"]
    fn rendering_a_real_tiff_with_magick_succeeds() {
        let statuses = crate::detect_all(&std::collections::HashMap::new());
        let Some(magick) = statuses.iter().find(|s| s.id == "magick" && s.ok)
            .and_then(|s| s.path.clone()) else {
            eprintln!("skipping: no real magick found on this machine");
            return;
        };

        let dir = std::env::temp_dir().join(format!("media-core-still-convert-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let input = dir.join("in.tiff");
        let output = dir.join("out.part");

        let status = Command::new(&magick)
            .args(["-size", "32x32", "gradient:blue-yellow"])
            .arg(&input)
            .status().unwrap();
        assert!(status.success());

        let spawned = spawn_still_render(StillRenderArgs {
            backend_id: "magick", backend_path: Path::new(&magick),
            input: &input, out_tmp: &output,
            selection: &StillSelection::default(), width: Some(32), height: Some(32), max_long_edge: 2048,
        }).unwrap();
        let result = wait_still(spawned.child);

        assert!(result.is_ok(), "{result:?}");
        assert!(output.exists());
        assert!(std::fs::metadata(&output).unwrap().len() > 0);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Exercises a real installed `oiiotool` end to end (see
    /// `still_probe.rs`'s equivalent test for how to point this at
    /// one). Ignored by default.
    #[test]
    #[ignore = "depends on this machine's installed backends"]
    fn rendering_a_real_exr_layer_with_oiiotool_succeeds() {
        let overrides = std::env::var("MEDIA_CORE_TEST_OIIOTOOL")
            .map(|p| std::collections::HashMap::from([("oiiotool".to_string(), p)]))
            .unwrap_or_default();
        let statuses = crate::detect_all(&overrides);
        let Some(oiiotool) = statuses.iter().find(|s| s.id == "oiiotool" && s.ok)
            .and_then(|s| s.path.clone()) else {
            eprintln!("skipping: no real oiiotool found (set MEDIA_CORE_TEST_OIIOTOOL)");
            return;
        };

        let dir = std::env::temp_dir().join(format!("media-core-still-convert-oiio-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let input = dir.join("in.exr");
        let output = dir.join("out.part");

        let status = Command::new(&oiiotool)
            .args(["-pattern", "constant", "4x4", "3"])
            .arg("-o").arg(&input)
            .status().unwrap();
        assert!(status.success());

        let sel = StillSelection::default();
        let spawned = spawn_still_render(StillRenderArgs {
            backend_id: "oiiotool", backend_path: Path::new(&oiiotool),
            input: &input, out_tmp: &output,
            selection: &sel, width: Some(4), height: Some(4), max_long_edge: 2048,
        }).unwrap();
        let result = wait_still(spawned.child);

        assert!(result.is_ok(), "{result:?}");
        assert!(output.exists());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
