// SPDX-License-Identifier: Apache-2.0
/**
 * thumbnailCache.test.ts — the two ways a cache is wrong.
 *
 * It can be too eager, and answer from a stale entry after the thing it
 * described has changed. In this module that has two shapes, and both
 * are silent: a resolution held across a folder being attached leaves
 * every asset reading `unaddressed` forever, and a thumbnail held
 * across a file being edited shows the old picture indefinitely. Or it
 * can be too shy, and rebuild work it already has, which is what the
 * module exists to avoid.
 *
 * No view is imported (the app rule: anything under ui/ spawns the SQL
 * worker). `indexedDB` is absent here, so every persistence path throws
 * and is swallowed, which also exercises the degraded case: no
 * IndexedDB must mean memory-only, never a blank thumbnail.
 */

import { afterEach, beforeEach, describe, expect, test, vi }
  from "vitest";

const io = vi.hoisted(() => ({
  resolves: 0, files: 0, draws: 0, file: true as boolean,
}));

vi.mock("@scf-core/assets.ts", async (orig) => ({
  ...(await orig() as object),
  resolveIdentifier: async (raw: string | null) => {
    io.resolves += 1;
    await Promise.resolve();
    return { identifier: raw === null ? null : { root: "project", path: raw },
             state: "resolved", format: "png", sizeBytes: 10,
             mtime: "2026-01-01", detail: null };
  },
}));

vi.mock("../src/files/assetLocator.ts", () => ({
  makeLocator: () => async () => null,
  fileAt: async () => {
    io.files += 1;
    return io.file ? new Uint8Array([1, 2, 3]) : null;
  },
}));

const { PREVIEW_WIDTHS, TILE_THUMB_PX, clearResolutions,
        clearStoredThumbnails, galleryPreviewFor, previewWidthFor,
        resolveCached, thumbnailFor } =
  await import("../src/files/thumbnailCache.ts");

const ROOT = "/projects/p";
const RES = (mtime: string, sizeBytes: number) => ({
  identifier: { root: "project", path: "a.png" }, state: "resolved",
  format: "png", sizeBytes, mtime, detail: null,
} as never);

beforeEach(async () => {
  io.resolves = 0; io.files = 0; io.draws = 0; io.file = true;
  clearResolutions();
  // Module-level caches outlive a test file, so a run that did not
  // reset them would measure the previous test's leftovers. Three of
  // these tests passed for that reason before the reset was added.
  await clearStoredThumbnails();
  // Enough of a canvas to let generation complete headlessly. The
  // drawing itself is the browser's job; what is under test is which
  // inputs reach it and how often.
  (globalThis as Record<string, unknown>)["createImageBitmap"] =
    async () => {
      io.draws += 1;
      return { width: 100, height: 100, close: () => undefined };
    };
  (globalThis as Record<string, unknown>)["document"] = {
    createElement: () => ({
      width: 0, height: 0,
      getContext: () => ({ drawImage: () => undefined }),
      toDataURL: () => `data:image/webp;base64,#${io.draws}`,
    }),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as Record<string, unknown>)["createImageBitmap"];
  delete (globalThis as Record<string, unknown>)["document"];
});

describe("resolveCached", () => {
  test("forty rows for one asset make one traversal", async () => {
    await Promise.all(Array.from({ length: 40 },
      () => resolveCached(ROOT, "@project/a.png", 1)));
    expect(io.resolves).toBe(1);
  });

  test("a second visit to the tab makes none", async () => {
    await resolveCached(ROOT, "@project/a.png", 1);
    await resolveCached(ROOT, "@project/a.png", 1);
    expect(io.resolves).toBe(1);
  });

  // The one that matters. A folder attached mid-session is exactly when
  // every cached `unaddressed` stops being true, and it is signalled by
  // environmentRevision moving.
  test("a new environment epoch invalidates everything", async () => {
    await resolveCached(ROOT, "@project/a.png", 1);
    await resolveCached(ROOT, "@project/a.png", 2);
    expect(io.resolves).toBe(2);
  });

  test("distinct identifiers are distinct entries", async () => {
    await resolveCached(ROOT, "@project/a.png", 1);
    await resolveCached(ROOT, "@project/b.png", 1);
    expect(io.resolves).toBe(2);
  });

  test("clearResolutions forces a re-resolve at the same epoch",
       async () => {
    await resolveCached(ROOT, "@project/a.png", 1);
    clearResolutions();
    await resolveCached(ROOT, "@project/a.png", 1);
    expect(io.resolves).toBe(2);
  });
});

describe("thumbnailFor", () => {
  test("drawn once, then served from memory", async () => {
    const a = await thumbnailFor(ROOT, "a.png", RES("t1", 10), null);
    const b = await thumbnailFor(ROOT, "a.png", RES("t1", 10), null);
    expect(a?.dataUrl).toBe(b?.dataUrl);
    expect(io.files).toBe(1);
    expect(io.draws).toBe(1);
  });

  test("concurrent callers share one generation", async () => {
    const all = await Promise.all(Array.from({ length: 12 },
      () => thumbnailFor(ROOT, "a.png", RES("t1", 10), null)));
    expect(io.draws).toBe(1);
    expect(new Set(all.map((t) => t?.dataUrl)).size).toBe(1);
  });

  // A file edited outside the app must not keep showing the old
  // picture. mtime and size are both in the key because either can move
  // without the other on a copied or restored file.
  test("a changed mtime regenerates", async () => {
    await thumbnailFor(ROOT, "a.png", RES("t1", 10), null);
    await thumbnailFor(ROOT, "a.png", RES("t2", 10), null);
    expect(io.draws).toBe(2);
  });

  test("a changed size regenerates", async () => {
    await thumbnailFor(ROOT, "a.png", RES("t1", 10), null);
    await thumbnailFor(ROOT, "a.png", RES("t1", 99), null);
    expect(io.draws).toBe(2);
  });

  test("a cropped thumbnail is a different entry from the full frame",
       async () => {
    const full = await thumbnailFor(ROOT, "a.png", RES("t1", 10), null);
    const crop = await thumbnailFor(ROOT, "a.png", RES("t1", 10),
                                    { x: 0, y: 0, w: 50, h: 50 });
    // Two generations, counted by file reads. NOT by decodes: the crop
    // path decodes twice on purpose — once at full size to learn the
    // source dimensions and check the box against them, then once more
    // for the region itself. That is the cost of a region being in
    // source pixels with nothing recording which file it was measured
    // on, and it is paid once ever because the result persists.
    expect(io.files).toBe(2);
    expect(io.draws).toBe(3);
    expect(crop?.dataUrl).not.toBe(full?.dataUrl);
    expect(crop?.regionApplied).toBe(true);
  });

  // A tile draws the picture several times larger than a slot. Serving
  // it the slot's raster is what made tiles look soft.
  test("a tile-sized thumbnail is a different entry from the slot's",
       async () => {
    const slot = await thumbnailFor(ROOT, "a.png", RES("t1", 10), null);
    const tile = await thumbnailFor(ROOT, "a.png", RES("t1", 10), null,
                                    TILE_THUMB_PX);
    expect(io.files).toBe(2);
    expect(tile?.dataUrl).not.toBe(slot?.dataUrl);
    await thumbnailFor(ROOT, "a.png", RES("t1", 10), null, TILE_THUMB_PX);
    expect(io.files).toBe(2);
  });

  // A box measured against a different file. Reported, not clamped —
  // the caller shows "region does not fit" rather than presenting a
  // corner of this image as the thing the anchor names.
  test("a region that does not fit falls back and says so", async () => {
    const t = await thumbnailFor(ROOT, "a.png", RES("t1", 10),
                                 { x: 0, y: 0, w: 4000, h: 4000 });
    expect(t?.regionApplied).toBe(false);
  });

  test("a missing file is null, and not cached as an answer", async () => {
    io.file = false;
    expect(await thumbnailFor(ROOT, "a.png", RES("t1", 10), null))
      .toBeNull();
    io.file = true;
    expect(await thumbnailFor(ROOT, "a.png", RES("t1", 10), null))
      .not.toBeNull();
  });

  test("no IndexedDB is memory-only, not broken", async () => {
    // `indexedDB` is undefined in this environment, so every persistence
    // path threw and was swallowed above. The thumbnails still arrived.
    expect(globalThis.indexedDB).toBeUndefined();
    expect(await thumbnailFor(ROOT, "a.png", RES("t1", 10), null))
      .not.toBeNull();
  });
});

describe("previews sized for where they are drawn", () => {
  test("the width covers the drawn size in device pixels", () => {
    // 250 CSS pixels on a 1x display fits the smallest preset.
    expect(previewWidthFor(250, 1)).toBe(340);
    // The same column on a 150% display needs 375 device pixels, which
    // the smallest preset would have to be stretched to cover.
    expect(previewWidthFor(250, 1.5)).toBe(500);
    // A column that has stretched well past its minimum, at 2x.
    expect(previewWidthFor(420, 2)).toBe(1140);
  });

  test("it is always a preset, however large or odd the request", () => {
    for (const [css, dpr] of [[1, 1], [333, 1.25], [5000, 3], [0, 0],
                              [200, Number.NaN]] as const) {
      expect(PREVIEW_WIDTHS).toContain(previewWidthFor(css, dpr));
    }
    expect(previewWidthFor(5000, 3))
      .toBe(PREVIEW_WIDTHS[PREVIEW_WIDTHS.length - 1]);
  });

  test("each width is its own entry, generated once", async () => {
    const small = await galleryPreviewFor(ROOT, "a.png", RES("t1", 10), 340);
    const large = await galleryPreviewFor(ROOT, "a.png", RES("t1", 10), 760);
    expect(io.files).toBe(2);
    expect(large?.dataUrl).not.toBe(small?.dataUrl);
    await galleryPreviewFor(ROOT, "a.png", RES("t1", 10), 760);
    expect(io.files).toBe(2);
  });
});
