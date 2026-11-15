// SPDX-License-Identifier: Apache-2.0
//! Running oiiotool/magick to actually flatten a still image to a
//! displayable PNG/JPEG (docs/media-server-spec.md §5's `render`
//! verdict, §7's still output profile). `convert.rs`'s stills
//! counterpart — same pure-args/spawn/wait split, but no progress
//! parsing (spec §6: "oiiotool/magick report start/finish only").

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::{Arc, Mutex, OnceLock};

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
    let mut args = vec![format!("{}[0]", input.display())];
    // magick's EXR reader labels scene-linear pixel data "sRGB" (checked
    // against ImageMagick 7.1.2: a linear 0.18 comes out as 46/255
    // through a bare `-colorspace sRGB`, which is a no-op on a file
    // already tagged sRGB, instead of the correct 118/255). Re-tagging
    // it linear first makes the sRGB conversion actually happen. Other
    // formats carry their own correct tag, so they're left alone.
    if has_extension(input, "exr") {
        args.push("-set".into());
        args.push("colorspace".into());
        args.push("RGB".into());
    }
    args.extend([
        "-colorspace".into(), "sRGB".into(),
        "-resize".into(), format!("{max_long_edge}x{max_long_edge}>"),
        format!("jpg:{}", out_tmp.display()),
    ]);
    args
}

fn has_extension(path: &Path, ext: &str) -> bool {
    path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case(ext))
}

/// Whether this ffmpeg lists the `zscale` filter (libzimg) — the
/// precise linear->sRGB transfer function. `ffmpeg -filters` is run at
/// most once per binary path per process.
fn ffmpeg_has_zscale(ffmpeg: &Path) -> bool {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, bool>>> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    if let Some(&known) = cache.lock().unwrap().get(ffmpeg) {
        return known;
    }
    let found = crate::winproc::command(ffmpeg)
        .args(["-hide_banner", "-filters"])
        .output()
        .map(|o| filters_list_has_zscale(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or(false);
    cache.lock().unwrap().insert(ffmpeg.to_path_buf(), found);
    found
}

/// A `-filters` line looks like ` .S zscale            V->V       ...`.
fn filters_list_has_zscale(listing: &str) -> bool {
    listing.lines().any(|l| l.split_whitespace().nth(1) == Some("zscale"))
}

/// One frame of the file's default layer (ffmpeg's EXR decoder has no
/// layer picker here), scaled down to the long-edge cap while still in
/// float so the resample happens in linear light, then converted
/// linear -> sRGB and written as a JPEG. `min(cap, iw)` never enlarges.
/// The `format=gbrp` step pins the converted result to 8-bit RGB before
/// the YUV conversion JPEG needs; without it zscale gets negotiated
/// straight into YUV while still carrying its RGB matrix and refuses.
///
/// The transfer is libzimg's exact one when the build has it (`min=gbr`
/// describes the decoded planes as full-range RGB — without it zscale
/// refuses with "no path between colorspaces", checked against the
/// gyan.dev essentials build), otherwise a 1/2.2 gamma via `lutrgb`,
/// which measured within one 8-bit code value of the exact curve.
fn ffmpeg_render_args(input: &Path, out_tmp: &Path, max_long_edge: u32, has_zscale: bool) -> Vec<String> {
    let to_srgb = if has_zscale {
        "zscale=min=gbr:pin=bt709:tin=linear:rin=full:t=iec61966-2-1:m=gbr:p=bt709:r=full"
    } else {
        "lutrgb=r='clip(pow(val/maxval,1/2.2)*maxval,0,maxval)':\
         g='clip(pow(val/maxval,1/2.2)*maxval,0,maxval)':\
         b='clip(pow(val/maxval,1/2.2)*maxval,0,maxval)'"
    };
    let filter = format!(
        "format=gbrpf32le,\
         scale=w='min({cap},iw)':h='min({cap},ih)':force_original_aspect_ratio=decrease,\
         {to_srgb},format=gbrp,format=yuvj420p",
        cap = max_long_edge,
    );
    vec![
        "-nostdin".into(), "-v".into(), "error".into(), "-y".into(),
        "-i".into(), input.display().to_string(),
        "-frames:v".into(), "1".into(),
        "-vf".into(), filter,
        "-c:v".into(), "mjpeg".into(), "-q:v".into(), "3".into(),
        // The `.part` path has no extension to pick a muxer from, and no
        // `%d` for image2 to number frames with.
        "-f".into(), "image2".into(), "-update".into(), "1".into(),
        out_tmp.display().to_string(),
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

/// Spawns the right backend for `args.backend_id` ("oiiotool",
/// "ffmpeg", or otherwise "magick").
pub fn spawn_still_render(args: StillRenderArgs<'_>) -> std::io::Result<SpawnedStill> {
    let built = match args.backend_id {
        "oiiotool" => oiiotool_render_args(
            args.input, args.out_tmp, args.selection, args.width, args.height, args.max_long_edge),
        "ffmpeg" => ffmpeg_render_args(
            args.input, args.out_tmp, args.max_long_edge, ffmpeg_has_zscale(args.backend_path)),
        _ => magick_render_args(args.input, args.out_tmp, args.max_long_edge),
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
    fn magick_retags_an_exr_as_linear_before_converting_but_not_other_formats() {
        let exr = magick_render_args(Path::new("in.EXR"), Path::new("out.part"), 2048);
        let set = exr.iter().position(|a| a == "-set").expect("exr gets a re-tag");
        assert_eq!(&exr[set..set + 3], ["-set", "colorspace", "RGB"]);
        assert!(set < exr.iter().position(|a| a == "-colorspace").unwrap());

        let psd = magick_render_args(Path::new("in.psd"), Path::new("out.part"), 2048);
        assert!(!psd.iter().any(|a| a == "-set"));
    }

    fn filter_of(args: &[String]) -> &str {
        let i = args.iter().position(|a| a == "-vf").unwrap();
        &args[i + 1]
    }

    #[test]
    fn ffmpeg_renders_a_single_capped_frame_to_a_jpeg_part_file() {
        let args = ffmpeg_render_args(Path::new("in.exr"), Path::new("out.part"), 2048, true);
        let i = args.iter().position(|a| a == "-frames:v").unwrap();
        assert_eq!(args[i + 1], "1");
        assert!(filter_of(&args).contains("min(2048,iw)"));
        assert!(args.windows(2).any(|w| w == ["-c:v", "mjpeg"]));
        assert!(args.windows(2).any(|w| w == ["-f", "image2"]));
        assert_eq!(args.last().unwrap(), "out.part");
    }

    #[test]
    fn ffmpeg_uses_zscale_when_available_and_a_gamma_otherwise() {
        let exact = ffmpeg_render_args(Path::new("in.exr"), Path::new("o"), 2048, true);
        assert!(filter_of(&exact).contains("zscale=") && !filter_of(&exact).contains("lutrgb"));
        let gamma = ffmpeg_render_args(Path::new("in.exr"), Path::new("o"), 2048, false);
        assert!(filter_of(&gamma).contains("lutrgb") && !filter_of(&gamma).contains("zscale"));
    }

    #[test]
    fn a_filters_listing_is_scanned_for_the_zscale_filter_by_name() {
        let with = " T. blend  VV->V  Blend\n .S zscale            V->V       Apply resizing\n";
        let without = " .. scale  V->V  Scale\n .. zscaleish  V->V  not it\n";
        assert!(filters_list_has_zscale(with));
        assert!(!filters_list_has_zscale(without));
    }

    /// A flat scene-linear 0.18 float EXR, written by ffmpeg from raw
    /// float32 planes (no colour management anywhere in its creation).
    /// 0.18 linear is 0.461 in sRGB, i.e. 118/255.
    fn write_flat_linear_exr(ffmpeg: &Path, dir: &Path) -> PathBuf {
        let raw = dir.join("flat.raw");
        let exr = dir.join("flat.exr");
        let pixel = 0.18f32.to_le_bytes();
        let bytes: Vec<u8> = (0..64 * 32 * 3).flat_map(|_| pixel).collect();
        std::fs::write(&raw, bytes).unwrap();
        let status = Command::new(ffmpeg)
            .args(["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gbrpf32le", "-s", "64x32", "-i"])
            .arg(&raw)
            .args(["-frames:v", "1", "-c:v", "exr", "-pix_fmt", "gbrpf32le"])
            .arg(&exr)
            .status().unwrap();
        assert!(status.success());
        exr
    }

    /// First pixel of a rendered JPEG, as an 8-bit grey value, via ffmpeg.
    fn grey_value_of(ffmpeg: &Path, image: &Path) -> u8 {
        let out = Command::new(ffmpeg)
            .args(["-v", "error", "-f", "mjpeg", "-i"]).arg(image)
            .args(["-vf", "scale=1:1,format=gray", "-f", "rawvideo", "-"])
            .output().unwrap();
        out.stdout[0]
    }

    /// The real-install check behind the linear -> sRGB claims above:
    /// each fallback converter must turn linear 0.18 into roughly 118,
    /// not leave it dark (46) or double-convert it. Ignored by default.
    #[test]
    #[ignore = "depends on this machine's installed backends"]
    fn real_ffmpeg_and_magick_render_a_linear_exr_to_the_right_brightness() {
        let statuses = crate::detect_all(&HashMap::new());
        let path_of = |id: &str| statuses.iter().find(|s| s.id == id && s.ok)
            .and_then(|s| s.path.clone()).map(PathBuf::from);
        let Some(ffmpeg) = path_of("ffmpeg") else { eprintln!("skipping: no ffmpeg"); return };

        let dir = std::env::temp_dir().join(format!("media-core-still-exr-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let exr = write_flat_linear_exr(&ffmpeg, &dir);

        let mut backends = vec![("ffmpeg", ffmpeg.clone())];
        if let Some(magick) = path_of("magick") { backends.push(("magick", magick)); }
        for (id, backend) in backends {
            let out = dir.join(format!("{id}.part"));
            let spawned = spawn_still_render(StillRenderArgs {
                backend_id: id, backend_path: &backend, input: &exr, out_tmp: &out,
                selection: &StillSelection::default(), width: Some(64), height: Some(32),
                max_long_edge: 2048,
            }).unwrap();
            let result = wait_still(spawned.child);
            assert!(result.is_ok(), "{id}: {result:?}");
            let value = grey_value_of(&ffmpeg, &out);
            assert!((112..=124).contains(&value), "{id} rendered linear 0.18 as {value}/255, expected ~118");
        }
        let _ = std::fs::remove_dir_all(&dir);
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
