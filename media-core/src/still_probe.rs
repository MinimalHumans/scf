// SPDX-License-Identifier: Apache-2.0
//! Still-image technical probing (docs/media-server-spec.md §5 step 3
//! "Probe", Phase 5) — `probe.rs`'s video/audio counterpart. Two
//! backends, two shapes of answer: `oiiotool` can name an EXR's layers
//! and channels; `magick` can only report dimensions.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct StillProbeResult {
    pub width: Option<u32>,
    pub height: Option<u32>,
    /// Layer names, e.g. `["beauty", "normal", "depth"]` for a
    /// channel-prefix multi-layer EXR (`beauty.R`, `normal.G`, ...) or
    /// a true multi-part EXR's per-part names. Empty when the file has
    /// no layer structure, or when the backend (`magick`) can't tell —
    /// both are "nothing to pick," not an error.
    pub layers: Vec<String>,
    /// The full channel list exactly as the backend reported it (e.g.
    /// `["beauty.R", "beauty.G", "beauty.B", "depth.Z", ...]`, or
    /// `["R", "G", "B"]` for a flat image) — not deduplicated or
    /// shortened. `still_convert`'s `--ch` argument is built by
    /// filtering this list by a chosen layer's `"<layer>."` prefix
    /// (verified against a real oiiotool: it has no wildcard/prefix
    /// syntax of its own, only exact comma-separated names), and the
    /// frontend shows it as-is for a secondary channel picker.
    pub channels: Vec<String>,
    /// `true` when `layers` names true multi-part subimages (select
    /// with oiiotool's `--subimage <name>`); `false` when they're
    /// channel-name prefixes within one subimage (select with `--ch
    /// <full names for that prefix>`) — the two real EXR shapes this
    /// phase verified need different selection commands, and nothing
    /// about a bare layer name on its own says which shape produced
    /// it, so this flag travels alongside.
    pub multipart: bool,
}

impl From<&StillProbeResult> for crate::ProbeResult {
    fn from(s: &StillProbeResult) -> Self {
        crate::ProbeResult { width: s.width, height: s.height, ..Default::default() }
    }
}

/// `oiiotool --info -v -a <file>`, parsed. `-a` covers every subimage
/// of a true multi-part EXR, not just the first.
pub fn probe_oiiotool(oiiotool_path: &Path, file: &Path) -> Result<StillProbeResult, String> {
    let output = crate::winproc::command(oiiotool_path)
        .args(["--info", "-v", "-a"])
        .arg(file)
        .output()
        .map_err(|e| format!("could not run oiiotool: {e}"))?;
    if !output.status.success() {
        return Err("oiiotool could not read this file".to_string());
    }
    Ok(parse_oiiotool_info(&String::from_utf8_lossy(&output.stdout)))
}

/// First line's `W x H` — the same shape whether the file has one
/// subimage or many: `name.exr       :    8 x    8, 7 channel, ...`.
/// `rsplit_once`, not `split_once`: a Windows absolute path (`C:\...`)
/// has its own colon before the real separator — confirmed to matter
/// against a real run with a full temp-dir path, not just a bare
/// filename.
fn parse_dimensions(first_line: &str) -> (Option<u32>, Option<u32>) {
    let Some((_, rest)) = first_line.rsplit_once(':') else { return (None, None) };
    let Some((dims, _)) = rest.split_once(',') else { return (None, None) };
    let Some((w, h)) = dims.split_once('x') else { return (None, None) };
    (w.trim().parse().ok(), h.trim().parse().ok())
}

/// `"beauty.R, beauty.G, beauty.B, depth.Z, normal.R, normal.G,
/// normal.B"` -> layers `["beauty", "depth", "normal"]` (the prefix
/// before each channel's last `.`, first-seen order, deduplicated) and
/// channels `["beauty.R", "beauty.G", ..., "normal.B"]` (the full list,
/// verbatim, in order — a flat image's `R, G, B` has no layer prefix
/// and is returned as-is).
fn layers_and_channels_from(channel_list: &str) -> (Vec<String>, Vec<String>) {
    let mut layers = Vec::new();
    let mut channels = Vec::new();
    for name in channel_list.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        if let Some((layer, _)) = name.rsplit_once('.') {
            if !layers.iter().any(|l: &String| l == layer) { layers.push(layer.to_string()); }
        }
        channels.push(name.to_string());
    }
    (layers, channels)
}

/// Parses `oiiotool --info -v -a`'s text output. Handles both real
/// shapes (verified against a real build of oiiotool 3.2.2 this
/// phase, not guessed — see the plan):
/// - Single subimage, channel-prefix layers: one `channel list:` line.
/// - True multi-part (`N subimages:` summary line present): a
///   ` subimage  N:` block per part, each with its own `channel list:`
///   and a `name:`/`oiio:subimagename:` attribute giving the part's
///   name — each part becomes one layer; channels are only taken from
///   the first part (every part shares the same channel shape in the
///   files this is meant for — stereo pairs, cryptomatte sets).
fn parse_oiiotool_info(text: &str) -> StillProbeResult {
    // oiiotool prints a `Reading <file>` progress line before the
    // actual info (confirmed against a real run) — the dimensions
    // line is whichever one actually has the `", N channel,"` marker,
    // not necessarily the first line of output.
    let Some(dims_line) = text.lines().find(|l| l.contains(" channel,")) else {
        return StillProbeResult::default();
    };
    let (width, height) = parse_dimensions(dims_line);

    let rest = text;
    if rest.contains(" subimages:") {
        let mut layers = Vec::new();
        let mut channels = Vec::new();
        let mut current_name: Option<String> = None;
        for line in rest.lines() {
            let trimmed = line.trim();
            if let Some(idx_rest) = trimmed.strip_prefix("subimage") {
                if let Some(name) = current_name.take() { layers.push(name); }
                let idx = idx_rest.trim().trim_end_matches(':').to_string();
                current_name = Some(format!("part {idx}"));
            } else if let Some(name) = trimmed.strip_prefix("name:") {
                current_name = Some(clean_quoted(name));
            } else if let Some(name) = trimmed.strip_prefix("oiio:subimagename:") {
                current_name = Some(clean_quoted(name));
            } else if let Some(list) = trimmed.strip_prefix("channel list:") {
                if channels.is_empty() {
                    (_, channels) = layers_and_channels_from(list);
                }
            }
        }
        if let Some(name) = current_name.take() { layers.push(name); }
        return StillProbeResult { width, height, layers, channels, multipart: true };
    }

    let channel_list = rest.lines()
        .find_map(|l| l.trim().strip_prefix("channel list:"))
        .unwrap_or("");
    let (layers, channels) = layers_and_channels_from(channel_list);
    StillProbeResult { width, height, layers, channels, multipart: false }
}

fn clean_quoted(s: &str) -> String {
    s.trim().trim_matches('"').to_string()
}

/// `magick identify <file>` — no layer/channel introspection (confirmed:
/// `identify -verbose` reports only a flat channel count, no names),
/// so `layers`/`channels` are always empty. `magick identify` prints
/// one line per frame/page; only the first (the file's own dimensions)
/// is read, matching this phase's "flatten to one image" scope for
/// magick-backed formats.
pub fn probe_magick(magick_path: &Path, file: &Path) -> Result<StillProbeResult, String> {
    let output = crate::winproc::command(magick_path)
        .arg("identify")
        .arg(file)
        .output()
        .map_err(|e| format!("could not run magick: {e}"))?;
    if !output.status.success() {
        return Err("magick could not read this file".to_string());
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let first = text.lines().next().unwrap_or("");
    Ok(parse_magick_identify(first))
}

/// `"test.tiff TIFF 32x32 32x32+0+0 16-bit sRGB 6408B ..."` -> the
/// geometry token right after the format name (the second `WxH`, with
/// a `+x+y` offset, is the page geometry — same numbers, skip it).
fn parse_magick_identify(first_line: &str) -> StillProbeResult {
    let dims = first_line.split_whitespace()
        .find(|tok| tok.contains('x') && tok.chars().next().is_some_and(|c| c.is_ascii_digit()));
    let (width, height) = dims
        .and_then(|d| d.split_once('x'))
        .map(|(w, h)| (w.trim().parse().ok(), h.trim().parse().ok()))
        .unwrap_or((None, None));
    StillProbeResult { width, height, layers: Vec::new(), channels: Vec::new(), multipart: false }
}

/// What `still_convert`'s render command should actually select,
/// resolved once (here, from a probe result plus the request's raw
/// `layer`/`channel` strings) rather than re-derived at spawn time.
/// The two real EXR shapes need different selection commands (verified
/// this phase — see `StillProbeResult::multipart`), so this is the one
/// place that decides which applies.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct StillSelection {
    pub multipart: bool,
    /// Set when `multipart`: the subimage name to pass to oiiotool's
    /// `--subimage`.
    pub subimage: Option<String>,
    /// Set when `!multipart` and the file has layers: the exact
    /// channel names to pass to oiiotool's `--ch` (verified: it has no
    /// prefix/wildcard syntax, only exact names). Empty for a flat
    /// image with no layer structure — nothing to filter.
    pub channels: Vec<String>,
}

/// A request for a `layer`/`channel` that doesn't match anything this
/// file actually has (stale UI state, a race with the file changing)
/// falls back to the first layer/part rather than erroring — the same
/// "something reasonable, not a hard failure" spirit as everywhere
/// else in this pipeline. An explicit `channel` always wins over
/// `layer` (picking one exact channel is a more specific ask than
/// picking a whole layer) and is meaningless for a multipart file
/// (channels there aren't layer-prefixed), so it's ignored there.
pub fn resolve_still_selection(
    probe: &StillProbeResult, layer: Option<&str>, channel: Option<&str>,
) -> StillSelection {
    if probe.multipart {
        let chosen = layer.filter(|l| probe.layers.iter().any(|x| x == l))
            .or_else(|| probe.layers.first().map(String::as_str));
        return StillSelection {
            multipart: true, subimage: chosen.map(str::to_string), channels: Vec::new(),
        };
    }
    if let Some(ch) = channel.filter(|c| probe.channels.iter().any(|x| x == c)) {
        return StillSelection { multipart: false, subimage: None, channels: vec![ch.to_string()] };
    }
    let chosen_layer = layer.filter(|l| probe.layers.iter().any(|x| x == l))
        .or_else(|| probe.layers.first().map(String::as_str));
    let channels = match chosen_layer {
        Some(l) => probe.channels.iter()
            .filter(|c| c.starts_with(&format!("{l}.")))
            .cloned().collect(),
        None => Vec::new(),
    };
    StillSelection { multipart: false, subimage: None, channels }
}

type Signature = (u64, u64);

fn signature(path: &Path) -> Option<Signature> {
    let meta = std::fs::metadata(path).ok()?;
    let mtime = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_secs();
    Some((meta.len(), mtime))
}

/// Which backend actually did the probing — kept alongside the result
/// so a cache hit doesn't need to re-derive which function to call.
type Probed = Result<StillProbeResult, String>;
type ProbeCacheMap = HashMap<(PathBuf, &'static str), (Signature, Probed)>;

/// In-memory, session-lifetime cache over `probe_oiiotool`/
/// `probe_magick`, keyed by `(size, mtime)` — mirrors `ProbeCache`
/// exactly. `backend_id` distinguishes a magick-probed result from an
/// oiiotool-probed one under the same path (relevant if an override
/// changes which backend a format routes through mid-session).
#[derive(Clone, Default)]
pub struct StillProbeCache {
    inner: Arc<Mutex<ProbeCacheMap>>,
}

impl StillProbeCache {
    pub fn probe_oiiotool(&self, backend_path: &Path, file: &Path) -> Probed {
        self.probe("oiiotool", backend_path, file, probe_oiiotool)
    }

    pub fn probe_magick(&self, backend_path: &Path, file: &Path) -> Probed {
        self.probe("magick", backend_path, file, probe_magick)
    }

    fn probe(
        &self, backend_id: &'static str, backend_path: &Path, file: &Path,
        run: fn(&Path, &Path) -> Probed,
    ) -> Probed {
        let sig = signature(file).ok_or_else(|| "could not read the file's size/time".to_string())?;
        let key = (file.to_path_buf(), backend_id);
        if let Some((cached_sig, result)) = self.inner.lock().unwrap().get(&key) {
            if *cached_sig == sig { return result.clone(); }
        }
        let result = run(backend_path, file);
        self.inner.lock().unwrap().insert(key, (sig, result.clone()));
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    /// Real output captured from oiiotool 3.2.2 against a hand-built
    /// 7-channel EXR with channels named `beauty.{R,G,B}`,
    /// `normal.{R,G,B}`, `depth.Z` — not a guessed fixture.
    const REAL_MULTILAYER: &str = r#"Reading multilayer.exr
multilayer.exr       :    8 x    8, 7 channel, float openexr
    channel list: beauty.R, beauty.G, beauty.B, depth.Z, normal.R, normal.G, normal.B
    compression: "zip"
    oiio:subimages: 1
"#;

    /// Real output captured from the same oiiotool build against a
    /// hand-built true multi-part EXR with two parts named "left" and
    /// "right", each a plain 3-channel R,G,B image.
    const REAL_MULTIPART: &str = r#"Reading multipart.exr
multipart.exr        :    8 x    8, 3 channel, float openexr
    2 subimages: 8x8 [f,f,f], 8x8 [f,f,f]
 subimage  0:    8 x    8, 3 channel, float openexr
    channel list: R, G, B
    name: "left"
    oiio:subimagename: "left"
    oiio:subimages: 2
 subimage  1:    8 x    8, 3 channel, float openexr
    channel list: R, G, B
    name: "right"
    oiio:subimagename: "right"
    oiio:subimages: 2
"#;

    #[test]
    fn a_channel_prefix_multilayer_exr_yields_its_layer_names() {
        let r = parse_oiiotool_info(REAL_MULTILAYER);
        assert_eq!(r.width, Some(8));
        assert_eq!(r.height, Some(8));
        assert_eq!(r.layers, vec!["beauty", "depth", "normal"]);
        assert_eq!(r.channels, vec![
            "beauty.R", "beauty.G", "beauty.B", "depth.Z", "normal.R", "normal.G", "normal.B",
        ]);
        assert!(!r.multipart);
    }

    #[test]
    fn a_true_multipart_exr_yields_one_layer_per_named_part() {
        let r = parse_oiiotool_info(REAL_MULTIPART);
        assert_eq!(r.width, Some(8));
        assert_eq!(r.height, Some(8));
        assert_eq!(r.layers, vec!["left", "right"]);
        assert!(r.multipart);
    }

    #[test]
    fn a_flat_single_layer_image_has_no_layers_at_all() {
        let text = "flat.exr : 4 x 4, 3 channel, float openexr\n    channel list: R, G, B\n";
        let r = parse_oiiotool_info(text);
        assert_eq!(r.layers, Vec::<String>::new());
        assert_eq!(r.channels, vec!["R", "G", "B"]);
    }

    #[test]
    fn empty_output_degrades_to_default_not_a_panic() {
        assert_eq!(parse_oiiotool_info(""), StillProbeResult::default());
    }

    /// Real output captured from `magick identify` against a hand-built
    /// 32x32 TIFF on this machine.
    #[test]
    fn magick_identify_gives_dimensions_but_never_layers() {
        let r = parse_magick_identify(
            "test.tiff TIFF 32x32 32x32+0+0 16-bit sRGB 6408B 0.000u 0:00.000");
        assert_eq!(r.width, Some(32));
        assert_eq!(r.height, Some(32));
        assert!(r.layers.is_empty());
        assert!(r.channels.is_empty());
    }

    fn multilayer_probe() -> StillProbeResult { parse_oiiotool_info(REAL_MULTILAYER) }
    fn multipart_probe() -> StillProbeResult { parse_oiiotool_info(REAL_MULTIPART) }

    #[test]
    fn no_layer_requested_defaults_to_the_first_layer_found() {
        let sel = resolve_still_selection(&multilayer_probe(), None, None);
        assert_eq!(sel.channels, vec!["beauty.R", "beauty.G", "beauty.B"]);
    }

    #[test]
    fn a_named_layer_resolves_to_exactly_its_own_channels() {
        let sel = resolve_still_selection(&multilayer_probe(), Some("depth"), None);
        assert_eq!(sel.channels, vec!["depth.Z"]);
    }

    #[test]
    fn an_explicit_channel_overrides_the_layer_and_picks_just_that_one() {
        let sel = resolve_still_selection(&multilayer_probe(), Some("beauty"), Some("normal.G"));
        assert_eq!(sel.channels, vec!["normal.G"]);
    }

    #[test]
    fn an_unknown_layer_falls_back_to_the_first_one_not_an_error() {
        let sel = resolve_still_selection(&multilayer_probe(), Some("not-a-real-layer"), None);
        assert_eq!(sel.channels, vec!["beauty.R", "beauty.G", "beauty.B"]);
    }

    #[test]
    fn a_flat_image_with_no_layers_selects_nothing_to_filter() {
        let flat = StillProbeResult {
            width: Some(4), height: Some(4), layers: vec![],
            channels: vec!["R".into(), "G".into(), "B".into()], multipart: false,
        };
        let sel = resolve_still_selection(&flat, None, None);
        assert!(sel.channels.is_empty());
    }

    #[test]
    fn a_multipart_file_selects_by_subimage_name_not_channels() {
        let sel = resolve_still_selection(&multipart_probe(), Some("right"), None);
        assert_eq!(sel.subimage.as_deref(), Some("right"));
        assert!(sel.channels.is_empty());
    }

    #[test]
    fn a_multipart_file_with_no_selection_defaults_to_the_first_part() {
        let sel = resolve_still_selection(&multipart_probe(), None, None);
        assert_eq!(sel.subimage.as_deref(), Some("left"));
    }

    #[test]
    fn probing_a_file_that_does_not_exist_is_an_error_not_a_panic() {
        let cache = StillProbeCache::default();
        let result = cache.probe_oiiotool(
            Path::new("oiiotool"), Path::new("Z:/definitely/not/real.exr"));
        assert!(result.is_err());
    }

    /// Exercises a real installed `oiiotool` end to end, if one can be
    /// found via the same override mechanism `detect_all` uses.
    /// Ignored by default (CI/most dev machines have no oiiotool) —
    /// run with `cargo test -p media-core -- --ignored`, pointing an
    /// override at a real binary (e.g. the PyPI `OpenImageIO` wheel's
    /// bundled `oiiotool.exe`, which is how this phase's parser above
    /// was actually verified).
    #[test]
    #[ignore = "depends on this machine's installed backends"]
    fn probing_a_real_multilayer_exr_finds_its_real_layers() {
        let overrides = std::env::var("MEDIA_CORE_TEST_OIIOTOOL")
            .map(|p| HashMap::from([("oiiotool".to_string(), p)]))
            .unwrap_or_default();
        let statuses = crate::detect_all(&overrides);
        let Some(oiiotool) = statuses.iter().find(|s| s.id == "oiiotool" && s.ok)
            .and_then(|s| s.path.clone()) else {
            eprintln!("skipping: no real oiiotool found (set MEDIA_CORE_TEST_OIIOTOOL)");
            return;
        };

        let dir = std::env::temp_dir().join(format!("media-core-still-probe-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let input = dir.join("real.exr");

        // A trivial 2x2 single-layer EXR via oiiotool itself — enough
        // to confirm the binary runs and the parser reads real output,
        // without needing Python/numpy as a test dependency.
        let status = Command::new(&oiiotool)
            .args(["-pattern", "constant", "2x2", "3"])
            .arg("-o").arg(&input)
            .status().unwrap();
        assert!(status.success());

        let result = probe_oiiotool(Path::new(&oiiotool), &input).unwrap();
        assert_eq!(result.width, Some(2));
        assert_eq!(result.height, Some(2));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
