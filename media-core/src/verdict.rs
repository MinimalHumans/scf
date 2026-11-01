// SPDX-License-Identifier: Apache-2.0
//! Classifying a probed file into what, if anything, would need to
//! happen before the browser could show it
//! (docs/media-server-spec.md §5 step 4 "Verdict").
//!
//! Informational only in this phase: `/meta` reports a verdict, but
//! nothing acts on a `Remux`/`Transcode` one yet — there is no queue.
//! See the plan this was built from.

use crate::capabilities::Capabilities;
use crate::probe::ProbeResult;
use crate::Backends;

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Verdict {
    /// The webview can decode this as it stands.
    Passthrough,
    /// The codec is decodable; the container just needs rewrapping.
    /// Needs `ffmpeg` to actually do (not yet — see the module doc).
    Remux,
    /// The codec itself isn't decodable. Needs `ffmpeg` to actually do.
    Transcode,
    /// `Remux`/`Transcode` would be the answer, but no backend exists
    /// to do it — the honest "nothing can help with this yet."
    Unsupported,
}

/// Codecs assumed decodable when the frontend hasn't reported either
/// way yet (`Capabilities` has no entry for this exact codec/container
/// pair) — a conservative starting guess, overridden the moment a real
/// `canPlayType` report lands.
const LIKELY_DECODABLE: &[&str] = &["h264", "vp8", "vp9", "av1"];

/// Containers the browser can demux without help, given a decodable
/// codec inside. `mov` belongs here alongside `mp4`: ffprobe reports
/// the whole ISO-BMFF family (mov/mp4/m4a/3gp/3g2/mj2) under the first
/// alias in its comma-separated `format_name`, `mov` — so a perfectly
/// ordinary `.mp4` probes as container `mov` (confirmed against a real
/// file: see the plan's verification notes). WebView2/Chromium plays
/// any ISO-BMFF file the same way regardless of that label; what
/// actually gates playability is the codec check above, not this one.
const NATIVE_CONTAINERS: &[&str] = &["mov", "mp4", "webm", "ogg"];

pub fn classify(probe: &ProbeResult, caps: &Capabilities, backends: &Backends) -> Verdict {
    let Some(codec) = probe.video_codec.as_deref().or(probe.audio_codec.as_deref()) else {
        // Nothing ffprobe could identify at all — nothing to classify.
        return Verdict::Unsupported;
    };
    let container = probe.container.as_deref().unwrap_or("");
    let decodable = caps
        .can_decode(&format!("{codec}/{container}"))
        .unwrap_or_else(|| LIKELY_DECODABLE.contains(&codec));

    let needed = if decodable && NATIVE_CONTAINERS.contains(&container) {
        Verdict::Passthrough
    } else if decodable {
        Verdict::Remux
    } else {
        Verdict::Transcode
    };

    if needed != Verdict::Passthrough && backends.get("ffmpeg").is_none() {
        Verdict::Unsupported
    } else {
        needed
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn probe(video_codec: &str, container: &str) -> ProbeResult {
        ProbeResult { video_codec: Some(video_codec.to_string()),
                      container: Some(container.to_string()), ..Default::default() }
    }

    fn with_ffmpeg() -> Backends {
        let b = Backends::default();
        b.set("ffmpeg", Some(PathBuf::from("C:/bin/ffmpeg.exe")));
        b
    }

    #[test]
    fn a_decodable_codec_in_a_native_container_passes_through() {
        let v = classify(&probe("h264", "mp4"), &Capabilities::default(), &with_ffmpeg());
        assert_eq!(v, Verdict::Passthrough);
    }

    /// ffprobe reports an ordinary `.mp4`'s container as `mov` (the
    /// first alias of its ISO-BMFF family `format_name`) — confirmed
    /// against a real file, see the plan's verification notes. This
    /// must classify exactly like `mp4`, not like a foreign container.
    #[test]
    fn mov_is_the_same_iso_bmff_family_as_mp4_not_a_foreign_container() {
        let v = classify(&probe("h264", "mov"), &Capabilities::default(), &with_ffmpeg());
        assert_eq!(v, Verdict::Passthrough);
    }

    #[test]
    fn a_decodable_codec_in_a_foreign_container_needs_a_remux() {
        let v = classify(&probe("h264", "mkv"), &Capabilities::default(), &with_ffmpeg());
        assert_eq!(v, Verdict::Remux);
    }

    #[test]
    fn an_undecodable_codec_needs_a_transcode() {
        let v = classify(&probe("hevc", "mp4"), &Capabilities::default(), &with_ffmpeg());
        assert_eq!(v, Verdict::Transcode);
    }

    #[test]
    fn needing_help_with_no_ffmpeg_available_is_unsupported() {
        let v = classify(&probe("hevc", "mp4"), &Capabilities::default(), &Backends::default());
        assert_eq!(v, Verdict::Unsupported);
    }

    #[test]
    fn passthrough_never_needs_ffmpeg() {
        let v = classify(&probe("h264", "mp4"), &Capabilities::default(), &Backends::default());
        assert_eq!(v, Verdict::Passthrough);
    }

    #[test]
    fn nothing_ffprobe_could_identify_is_unsupported() {
        let v = classify(&ProbeResult::default(), &Capabilities::default(), &with_ffmpeg());
        assert_eq!(v, Verdict::Unsupported);
    }

    #[test]
    fn a_real_capability_report_overrides_the_static_guess() {
        let caps = Capabilities::default();
        caps.report(std::collections::HashMap::from([("hevc/mp4".to_string(), true)]));
        // hevc is NOT in the static LIKELY_DECODABLE list, but the
        // frontend has actually confirmed this webview can play it.
        let v = classify(&probe("hevc", "mp4"), &caps, &with_ffmpeg());
        assert_eq!(v, Verdict::Passthrough);
    }

    #[test]
    fn a_reported_false_overrides_an_optimistic_static_guess() {
        let caps = Capabilities::default();
        caps.report(std::collections::HashMap::from([("h264/mp4".to_string(), false)]));
        let v = classify(&probe("h264", "mp4"), &caps, &with_ffmpeg());
        assert_eq!(v, Verdict::Transcode);
    }
}
