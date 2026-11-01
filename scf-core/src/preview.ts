// SPDX-License-Identifier: Apache-2.0
/**
 * preview.ts — what can actually be shown (P5).
 *
 * Three tiers, and the third is a real tier rather than a failure.
 * Three of the eight assets in the Hollow Creek fixture are in it, and
 * an asset browser that treats "cannot preview" as an error state would
 * be wrong about nearly half a real project.
 *
 *   native   — the browser decodes it. An <img>, <video> or <audio>
 *              element and an object URL, nothing more.
 *   decoded  — real content that needs a decoder SCF does not ship
 *              (exr, tiff, glb, mov). Named so the UI can say "not
 *              yet" rather than "no", and so the work is scoped when
 *              somebody wants it.
 *   named    — nothing to depict. Archives, caches, model weights.
 *              A LoRA is not media: you do not look at it, you invoke
 *              it, and there is no image of it to fail to render.
 *
 * Sidecar thumbnails are ruled out by the read-only rule (conventions
 * §9): something would have to write them, and it will not be SCF.
 * Tier 2 therefore means an in-memory decoder or nothing.
 *
 * Format is derived from the identifier and is only ever a hint about
 * BYTES. It says nothing about purpose — that lives on the link.
 */

export type PreviewTier = "native" | "decoded" | "named";

/** What kind of element renders it, once the bytes are in hand. */
export type PreviewKind = "image" | "video" | "audio" | "text" | "pdf";

export interface PreviewCapability {
  tier: PreviewTier;
  kind: PreviewKind | null;
  /** One sentence for tiers 2 and 3, null for native. */
  detail: string | null;
}

const IMAGE = ["png", "jpg", "jpeg", "webp", "gif", "svg", "avif", "bmp",
               "ico"];
const VIDEO = ["mp4", "webm", "ogv"];
const AUDIO = ["wav", "mp3", "ogg", "oga", "flac", "m4a", "aac"];
const TEXT = ["txt", "md", "json", "csv", "tsv", "xml", "yaml", "yml",
              "fountain", "srt", "vtt", "log", "glsl", "hlsl", "py", "js",
              "ts", "usda"];

/** Real content, no decoder in the browser. */
const DECODED: Record<string, string> = {
  exr: "OpenEXR needs a decoder the browser does not have",
  dpx: "DPX needs a decoder the browser does not have",
  tif: "multi-page and high-bit-depth TIFF are not decodable here",
  tiff: "multi-page and high-bit-depth TIFF are not decodable here",
  psd: "layered Photoshop files need a decoder",
  glb: "a 3D model needs a viewer, not an image element",
  gltf: "a 3D model needs a viewer, not an image element",
  fbx: "a 3D model needs a viewer, not an image element",
  obj: "a 3D model needs a viewer, not an image element",
  abc: "an Alembic cache needs a viewer",
  usd: "a USD stage needs a viewer",
  usdc: "a USD stage needs a viewer",
  usdz: "a USD stage needs a viewer",
  mov: "QuickTime is often ProRes or DNx, which the browser cannot decode",
  mxf: "MXF is a professional container the browser cannot decode",
  r3d: "REDCODE needs its own decoder",
  ari: "ARRIRAW needs its own decoder",
  aif: "AIFF is inconsistently supported; treat it as undecodable",
  aiff: "AIFF is inconsistently supported; treat it as undecodable",
};

/** Nothing to depict — not a failure, just not an image of anything. */
const NAMED: Record<string, string> = {
  zip: "an archive — its contents are not assets until they are extracted",
  rar: "an archive",
  "7z": "an archive",
  tar: "an archive",
  gz: "an archive",
  safetensors: "model weights — a generator, not a depiction: it is " +
               "invoked rather than looked at",
  ckpt: "model weights — invoked rather than looked at",
  pt: "model weights — invoked rather than looked at",
  pth: "model weights — invoked rather than looked at",
  bin: "opaque binary",
  scf: "another SCF file — see layers in conventions §9",
  blend: "a Blender scene, openable only in Blender",
  ma: "a Maya scene, openable only in Maya",
  mb: "a Maya scene, openable only in Maya",
  nk: "a Nuke script",
  hip: "a Houdini scene",
  aep: "an After Effects project",
  drp: "a Resolve project",
};

/**
 * Worth asking the media server's `/meta` route about (docs/
 * media-server-spec.md §5's probe step, Phase 3) — video and audio
 * containers `ffprobe` can read regardless of whether the browser can
 * play them. Orthogonal to the tiers above: a `decoded`-tier `.mov` is
 * exactly the case probing exists for, so this list is not a subset of
 * `VIDEO`/`AUDIO`. Still images (EXR, TIFF, PSD) are Phase 5's job —
 * `oiiotool`/`magick`, not `ffprobe` — and are deliberately absent.
 */
export const PROBEABLE = [
  ...VIDEO, ...AUDIO,
  "mov", "mxf", "mkv", "avi", "wmv", "m4v", "mts", "r3d", "ari",
  "aif", "aiff",
];

/**
 * What can be done with these bytes, from the identifier alone.
 *
 * An unknown extension is `named` rather than `native`: guessing and
 * handing an unknown format to an <img> produces a broken-image icon,
 * which reads as "this asset is broken" when the truth is "this tool
 * does not know that format".
 */
export function previewCapability(
  format: string | null,
): PreviewCapability {
  if (format === null) {
    return { tier: "named", kind: null,
             detail: "no extension to read, so the format is unknown" };
  }
  const ext = format.toLowerCase();

  if (IMAGE.includes(ext)) return { tier: "native", kind: "image",
                                    detail: null };
  if (VIDEO.includes(ext)) return { tier: "native", kind: "video",
                                    detail: null };
  if (AUDIO.includes(ext)) return { tier: "native", kind: "audio",
                                    detail: null };
  if (TEXT.includes(ext)) return { tier: "native", kind: "text",
                                   detail: null };
  if (ext === "pdf") return { tier: "native", kind: "pdf", detail: null };

  const decoded = DECODED[ext];
  if (decoded !== undefined) {
    return { tier: "decoded", kind: null, detail: decoded };
  }
  const named = NAMED[ext];
  if (named !== undefined) {
    return { tier: "named", kind: null, detail: named };
  }
  return { tier: "named", kind: null,
           detail: `.${ext} is not a format this editor can display` };
}

/** Text previews are truncated: a 40MB log should not enter the DOM. */
export const TEXT_PREVIEW_LIMIT = 64 * 1024;

/** Above this, even a native image is offered rather than shown. */
export const LARGE_FILE_BYTES = 32 * 1024 * 1024;
