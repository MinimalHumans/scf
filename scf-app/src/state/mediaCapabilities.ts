// SPDX-License-Identifier: Apache-2.0
/**
 * mediaCapabilities.ts — reports what this webview can actually
 * decode, once per session (docs/media-server-spec.md §5's verdict
 * step; Phase 3 of the media server).
 *
 * `canPlayType` over `MediaCapabilities.decodingInfo`: synchronous, no
 * fake `MediaDecodingConfiguration` object to build, and a yes/no/maybe
 * answer is all the verdict engine needs until real transcoding exists
 * to make quality trade-offs worth asking `decodingInfo` for.
 */

import { invoke } from "@tauri-apps/api/core";

/** `key` is what media-core's `Capabilities` registry is keyed by:
 *  `"<codec>/<container>"`. A small, fixed list — enough to tell the
 *  common "fine" codecs from the common "needs help" ones; not every
 *  codec profile in existence. */
const COMBOS: { key: string; kind: "video" | "audio"; type: string }[] = [
  { key: "h264/mp4", kind: "video", type: 'video/mp4; codecs="avc1.640028"' },
  { key: "hevc/mp4", kind: "video", type: 'video/mp4; codecs="hvc1.1.6.L93.B0"' },
  { key: "av1/mp4", kind: "video", type: 'video/mp4; codecs="av01.0.04M.08"' },
  { key: "vp9/webm", kind: "video", type: 'video/webm; codecs="vp09.00.10.08"' },
  { key: "vp8/webm", kind: "video", type: 'video/webm; codecs="vp8"' },
  { key: "aac/mp4", kind: "audio", type: 'audio/mp4; codecs="mp4a.40.2"' },
  { key: "flac/flac", kind: "audio", type: "audio/flac" },
];

function canPlay(kind: "video" | "audio", type: string): boolean {
  const el = document.createElement(kind);
  const answer = el.canPlayType(type);
  return answer === "probably" || answer === "maybe";
}

let reported: Promise<void> | null = null;

/**
 * Builds the report and sends it, the first time this is called in the
 * session; every call after that shares the same (in-flight or already
 * resolved) promise. Safe to call from anywhere that's about to ask
 * `/meta` for a verdict — it doesn't need to be sent any earlier than
 * that, since a verdict computed before it lands just uses the static
 * fallback guess (`media-core`'s `verdict.rs`).
 */
export function reportMediaCapabilities(): Promise<void> {
  reported ??= (async () => {
    const report: Record<string, boolean> = {};
    for (const combo of COMBOS) report[combo.key] = canPlay(combo.kind, combo.type);
    await invoke("media_report_capabilities", { report });
  })();
  return reported;
}
