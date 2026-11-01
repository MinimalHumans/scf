// SPDX-License-Identifier: Apache-2.0
/**
 * thumbnailCache — resolve once per session, decode once EVER.
 *
 * Mounting the asset list costs three things per row, and without this
 * module all three repeat on every mount:
 *
 *  1. RESOLUTION. `resolveIdentifier` walks `getDirectoryHandle` /
 *     `getFileHandle` from the root and calls `getFile()`. Forty rows
 *     is forty round trips through the browser's file system layer, and
 *     on Windows with an antivirus filter in the path each one is
 *     expensive. This is most of the lag.
 *  2. DECODE. A full-size plate decoded to a bitmap to be drawn into a
 *     28-pixel box.
 *  3. The object URL, whose grace period is tuned for a React remount
 *     and is far too short for "switch tabs and come back".
 *
 * A generated thumbnail is a few kilobytes of WebP — small enough to
 * hold in memory by the hundred and to persist, so a reload does not
 * pay for the decode either. After the first visit the list touches no
 * files at all.
 *
 * Keyed on path + mtime + size, so a file edited outside the app
 * regenerates rather than showing a stale picture. Persisted to
 * IndexedDB, which is browser storage and not the user's folder —
 * conventions §9's read-only rule is about the project directory.
 *
 * Everything here is best-effort. A cache that fails must cost a
 * repeated decode, never a blank thumbnail: every persistence path
 * swallows its errors and falls through to generating.
 */

import { resolveIdentifier, type Resolution } from "@scf-core/assets.ts";
import { regionFits, type RegionBox } from "@scf-core/anchors.ts";
import { fileAt, makeLocator } from "./assetLocator.ts";

/**
 * Generated at twice the largest display size (88px), so one raster
 * serves all three sizes and still looks right on a HiDPI screen.
 * Square, because every place a thumbnail appears is a square slot.
 */
const THUMB_PX = 176;

/** WebP for alpha at a fraction of PNG's size. Chromium-only app, so
 *  the format is not in question. */
const THUMB_TYPE = "image/webp";
const THUMB_QUALITY = 0.82;

/** ~8KB each, so this is a few megabytes at the ceiling. Bounded
 *  because a real project holds thousands of assets and an unbounded
 *  map of them is a leak with a nicer name. */
const MEMORY_LIMIT = 500;

const DB_NAME = "scf-thumbnails";
const STORE = "thumbs";

/* ── Persistence ──────────────────────────────────────────────────
 * A separate database from `scf-session`, not a second store in it.
 * Bumping that database's version to add a store would run an upgrade
 * on every existing session, and a thumbnail cache is not worth
 * putting the file handle that reopens someone's project at risk.
 */

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
    req.onsuccess = () => { resolve(req.result); };
    req.onerror = () => { reject(req.error ?? new Error("indexedDB")); };
  });
}

async function readStored(key: string): Promise<string | null> {
  try {
    const db = await openDb();
    try {
      return await new Promise<string | null>((resolve, reject) => {
        const req = db.transaction(STORE, "readonly")
          .objectStore(STORE).get(key);
        req.onsuccess = () => {
          resolve(typeof req.result === "string" ? req.result : null);
        };
        req.onerror = () => { reject(req.error); };
      });
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  // Deliberately not awaited. Nothing downstream needs the write to
  // have landed, and making the first paint wait on IndexedDB would
  // reintroduce the lag this module exists to remove.
  void (async () => {
    try {
      const db = await openDb();
      try {
        db.transaction(STORE, "readwrite").objectStore(STORE)
          .put(value, key);
      } finally {
        db.close();
      }
    } catch { /* best effort */ }
  })();
}

/** Drop the persisted rasters. Exposed for a user-facing reset; not
 *  called on close, since surviving a reload is the point. */
export async function clearStoredThumbnails(): Promise<void> {
  memory.clear();
  try {
    const db = await openDb();
    try {
      db.transaction(STORE, "readwrite").objectStore(STORE).clear();
    } finally {
      db.close();
    }
  } catch { /* best effort */ }
}

/* ── Resolution, memoised ─────────────────────────────────────────── */

let resolutionEpoch = -1;
const resolutions = new Map<string, Promise<Resolution>>();

/**
 * `resolveIdentifier`, once per identifier per environment.
 *
 * The promise itself is cached, not its value, so forty rows appearing
 * together make one traversal rather than forty. Cleared whenever
 * `environmentRevision` moves — a folder attached, a permission
 * regranted — because that is exactly when a previous answer of
 * `unaddressed` stops being true.
 */
export function resolveCached(
  root: string | null,
  identifier: string | null,
  epoch: number,
): Promise<Resolution> {
  if (epoch !== resolutionEpoch) {
    resolutionEpoch = epoch;
    resolutions.clear();
  }
  const key = identifier ?? "";
  let hit = resolutions.get(key);
  if (hit === undefined) {
    hit = resolveIdentifier(identifier, makeLocator(root));
    resolutions.set(key, hit);
  }
  return hit;
}

/** Forget every resolution. Called when the root changes under a live
 *  session, where a cached answer describes the previous folder. */
export function clearResolutions(): void {
  resolutions.clear();
  resolutionEpoch = -1;
}

/* ── Thumbnails ───────────────────────────────────────────────────── */

export interface Thumbnail {
  dataUrl: string;
  /** False when a region was asked for and not used — the box did not
   *  fit the image that actually loaded. The caller says so rather than
   *  showing a full frame that looks like a deliberate choice. */
  regionApplied: boolean;
}

const memory = new Map<string, Thumbnail>();
const inFlight = new Map<string, Promise<Thumbnail | null>>();

function remember(key: string, value: Thumbnail): void {
  // Map iteration is insertion-ordered, so deleting and re-inserting on
  // read makes this an LRU without a second structure.
  memory.delete(key);
  memory.set(key, value);
  while (memory.size > MEMORY_LIMIT) {
    const oldest = memory.keys().next();
    if (oldest.done === true) break;
    memory.delete(oldest.value);
  }
}

/**
 * The cache key, and why the folder's name is in it.
 *
 * `path` is RELATIVE to the project root, so `assets/hero.png` in one
 * project and in another are the same string. Path plus mtime plus size
 * is the standard file-identity heuristic, and a collision across two
 * projects is almost always two copies of one file — but "almost
 * always" is the wrong standard when being wrong means showing one
 * film's frame under another film's asset.
 *
 * The root's path, combined with the full relative path, mtime and
 * size, is a heuristic rather than a proof — the same class the rest
 * of asset resolution rests on.
 */
function keyFor(root: string | null, path: string,
                r: Resolution, region: RegionBox | null): string {
  const stamp = `${r.mtime ?? "?"}:${r.sizeBytes ?? "?"}`;
  const box = region === null
    ? "full" : `${region.x},${region.y},${region.w},${region.h}`;
  return `${root ?? "-"}|${path}|${stamp}|${THUMB_PX}|${box}`;
}

/**
 * Draw one thumbnail, from the file's own bytes.
 *
 * Cover-cropped to a square: the alternative is letterboxing, and a
 * grid of thumbnails with different bars around them is much harder to
 * scan than a grid of squares.
 *
 * When there is no region, `resizeWidth` lets the decoder downscale AS
 * it decodes, so an 8K plate never exists as a full bitmap. A region
 * has to be measured against the source, so that case decodes fully
 * once — and then never again, which is what persisting the result is
 * for.
 */
async function draw(
  bytes: Uint8Array, region: RegionBox | null,
): Promise<Thumbnail | null> {
  const blob = new Blob([new Uint8Array(bytes)]);
  let source: ImageBitmap | null = null;
  let regionApplied = false;
  try {
    if (region === null) {
      source = await createImageBitmap(blob, {
        resizeWidth: THUMB_PX, resizeQuality: "high",
      });
    } else {
      const full = await createImageBitmap(blob);
      if (regionFits(region, full.width, full.height)) {
        source = await createImageBitmap(
          full, region.x, region.y, region.w, region.h,
          { resizeWidth: THUMB_PX, resizeQuality: "high" });
        regionApplied = true;
        full.close();
      } else {
        // A box measured on a different file. Showing the whole frame
        // is the honest answer; clamping would present a corner of this
        // image as the thing the anchor names.
        source = await createImageBitmap(blob, {
          resizeWidth: THUMB_PX, resizeQuality: "high",
        });
        full.close();
      }
    }

    const canvas = document.createElement("canvas");
    canvas.width = THUMB_PX;
    canvas.height = THUMB_PX;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return null;

    const scale = Math.max(THUMB_PX / source.width,
                           THUMB_PX / source.height);
    const w = source.width * scale;
    const h = source.height * scale;
    ctx.drawImage(source, (THUMB_PX - w) / 2, (THUMB_PX - h) / 2, w, h);
    return { dataUrl: canvas.toDataURL(THUMB_TYPE, THUMB_QUALITY),
             regionApplied };
  } catch {
    // A corrupt or unsupported image is not an error worth surfacing —
    // the caller falls back to the format chip, which is what it would
    // show for a file it could never have drawn.
    return null;
  } finally {
    source?.close();
  }
}

/**
 * A thumbnail for a resolved asset: memory, then IndexedDB, then the
 * file. Null when there is nothing drawable.
 *
 * Concurrent callers for the same key share one generation. Without
 * that, a list of duplicates of one plate decodes it once per row on
 * the first visit.
 */
export async function thumbnailFor(
  root: string | null,
  path: string,
  resolution: Resolution,
  region: RegionBox | null,
): Promise<Thumbnail | null> {
  const key = keyFor(root, path, resolution, region);

  const cached = memory.get(key);
  if (cached !== undefined) {
    remember(key, cached);
    return cached;
  }

  const running = inFlight.get(key);
  if (running !== undefined) return running;

  const job = (async (): Promise<Thumbnail | null> => {
    const stored = await readStored(key);
    if (stored !== null) {
      // `regionApplied` is not persisted: a stored raster under a region
      // key IS the cropped one, because a failed fit is stored under the
      // full-frame key it fell back to.
      const value = { dataUrl: stored, regionApplied: region !== null };
      remember(key, value);
      return value;
    }

    const bytes = await fileAt(root, path);
    if (bytes === null) return null;
    const drawn = await draw(bytes, region);
    if (drawn === null) return null;

    const finalKey = drawn.regionApplied || region === null
      ? key : keyFor(root, path, resolution, null);
    remember(finalKey, drawn);
    writeStored(finalKey, drawn.dataUrl);
    return drawn;
  })().finally(() => inFlight.delete(key));

  inFlight.set(key, job);
  return job;
}

/* ── Gallery previews ─────────────────────────────────────────────
 * The masonry wall shows each picture at its own shape (each tile
 * spans rows by its own aspect ratio), so these are resized, never
 * cover-cropped to a square like `thumbnailFor`'s.
 *
 * Three fixed sizes, matching the gallery's own column tiers, rather
 * than one per window width: a continuously-sized cache turns every
 * resize into a new entry, and makes "how much space is this using"
 * an unanswerable question (the same reasoning as the media server's
 * fixed preview presets, docs/media-server-spec.md).
 */

export type GalleryTier = "s" | "m" | "l";

/** Twice the CSS column width (`GalleryView.tsx`'s `COLUMN_PX`), for
 *  HiDPI. */
const GALLERY_PX: Record<GalleryTier, number> = { s: 340, m: 500, l: 760 };

export interface GalleryPreview {
  dataUrl: string;
  width: number;
  height: number;
}

const galleryMemory = new Map<string, GalleryPreview>();
const galleryInFlight = new Map<string, Promise<GalleryPreview | null>>();

function rememberGallery(key: string, value: GalleryPreview): void {
  galleryMemory.delete(key);
  galleryMemory.set(key, value);
  while (galleryMemory.size > MEMORY_LIMIT) {
    const oldest = galleryMemory.keys().next();
    if (oldest.done === true) break;
    galleryMemory.delete(oldest.value);
  }
}

function galleryKeyFor(
  root: string | null, path: string, r: Resolution, tier: GalleryTier,
): string {
  const stamp = `${r.mtime ?? "?"}:${r.sizeBytes ?? "?"}`;
  return `gl|${root ?? "-"}|${path}|${stamp}|${tier}`;
}

/** Downscaled to the tier's width, aspect kept, never cropped. The
 *  decoder downscales AS it decodes (`resizeWidth`), so a large plate
 *  never exists as a full bitmap. */
async function drawGallery(
  bytes: Uint8Array, maxPx: number,
): Promise<GalleryPreview | null> {
  const blob = new Blob([new Uint8Array(bytes)]);
  let source: ImageBitmap | null = null;
  try {
    source = await createImageBitmap(blob, {
      resizeWidth: maxPx, resizeQuality: "high",
    });
    const canvas = document.createElement("canvas");
    canvas.width = source.width;
    canvas.height = source.height;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return null;
    ctx.drawImage(source, 0, 0);
    return {
      dataUrl: canvas.toDataURL(THUMB_TYPE, THUMB_QUALITY),
      width: source.width, height: source.height,
    };
  } catch {
    // A corrupt or unsupported image; the caller falls back the same
    // way `thumbnailFor`'s callers do.
    return null;
  } finally {
    source?.close();
  }
}

/**
 * A gallery preview for a resolved image asset: memory, then
 * IndexedDB, then the file. Null when there is nothing drawable.
 *
 * Width and height travel with the persisted entry (JSON rather than
 * a bare data URL) so a cache hit sizes the masonry tile without
 * decoding anything.
 */
export async function galleryPreviewFor(
  root: string | null,
  path: string,
  resolution: Resolution,
  tier: GalleryTier,
): Promise<GalleryPreview | null> {
  const key = galleryKeyFor(root, path, resolution, tier);

  const cached = galleryMemory.get(key);
  if (cached !== undefined) {
    rememberGallery(key, cached);
    return cached;
  }

  const running = galleryInFlight.get(key);
  if (running !== undefined) return running;

  const job = (async (): Promise<GalleryPreview | null> => {
    const stored = await readStored(key);
    if (stored !== null) {
      try {
        const value = JSON.parse(stored) as GalleryPreview;
        rememberGallery(key, value);
        return value;
      } catch {
        // Fall through and regenerate rather than fail on a corrupt
        // or pre-this-change entry.
      }
    }

    const bytes = await fileAt(root, path);
    if (bytes === null) return null;
    const drawn = await drawGallery(bytes, GALLERY_PX[tier]);
    if (drawn === null) return null;

    rememberGallery(key, drawn);
    writeStored(key, JSON.stringify(drawn));
    return drawn;
  })().finally(() => galleryInFlight.delete(key));

  galleryInFlight.set(key, job);
  return job;
}
