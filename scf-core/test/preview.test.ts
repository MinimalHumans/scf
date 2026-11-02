// SPDX-License-Identifier: Apache-2.0
/**
 * preview.test.ts — preview tiers (P5).
 *
 * The load-bearing assertion is that an unknown format lands in `named`
 * rather than `native`: handing an unknown extension to an <img>
 * produces a broken-image icon, which reads as "this asset is broken"
 * when the truth is "this tool does not know that format".
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { listAssets } from "../src/assetIndex.ts";
import { PROBEABLE, STILL_BACKEND, previewCapability } from "../src/preview.ts";
import { openNodeDatabase, type NodeDatabase } from "../src/node.ts";
import { FIXTURE_PATH } from "./setup.ts";

describe("previewCapability", () => {
  test("browser-decodable formats are native", () => {
    expect(previewCapability("png")).toMatchObject({ tier: "native",
                                                     kind: "image" });
    expect(previewCapability("mp4")).toMatchObject({ tier: "native",
                                                     kind: "video" });
    expect(previewCapability("wav")).toMatchObject({ tier: "native",
                                                     kind: "audio" });
    expect(previewCapability("md")).toMatchObject({ tier: "native",
                                                    kind: "text" });
    expect(previewCapability("pdf")).toMatchObject({ tier: "native",
                                                     kind: "pdf" });
  });

  test("case does not matter", () => {
    expect(previewCapability("PNG").tier).toBe("native");
  });

  test("production formats are decoded, not named", () => {
    // The distinction matters: 'decoded' means there IS an image in
    // there and SCF cannot get at it yet, which is a different message
    // from 'there is nothing to look at'.
    for (const ext of ["exr", "glb", "mov", "psd", "usd"]) {
      expect(previewCapability(ext).tier, ext).toBe("decoded");
      expect(previewCapability(ext).detail, ext).not.toBeNull();
    }
  });

  test("HEIC is decoded, not a generic unknown format", () => {
    // Phase 5's magick-backed still pipeline can actually show this —
    // it must stay distinct from the generic "unknown format" message
    // an unrecognized extension gets.
    expect(previewCapability("heic")).toMatchObject({ tier: "decoded" });
    expect(previewCapability("heic").detail).toContain("HEIC");
    expect(previewCapability("heif").detail).toContain("HEIC");
  });

  test("archives and model weights are named", () => {
    expect(previewCapability("zip").tier).toBe("named");
    expect(previewCapability("safetensors").tier).toBe("named");
    // A LoRA is invoked, not looked at — there is no image of it.
    expect(previewCapability("safetensors").detail)
      .toContain("invoked");
  });

  test("an unknown format is named, never native", () => {
    const cap = previewCapability("qqq");
    expect(cap.tier).toBe("named");
    expect(cap.kind).toBeNull();
    expect(cap.detail).toContain("qqq");
  });

  test("no extension is named and says why", () => {
    expect(previewCapability(null)).toMatchObject({ tier: "named",
                                                    kind: null });
  });

  test("another .scf is named, not treated as media", () => {
    expect(previewCapability("scf").detail).toContain("layers");
  });
});

describe("PROBEABLE", () => {
  test("includes native video/audio and decoded-tier containers alike",
    () => {
    // A decoded-tier .mov is exactly the case probing exists for — the
    // browser can't play it, but ffprobe can still say what it is.
    expect(PROBEABLE).toContain("mp4");
    expect(PROBEABLE).toContain("wav");
    expect(PROBEABLE).toContain("mov");
    expect(PROBEABLE).toContain("mxf");
  });

  test("still images are absent — that is Phase 5's oiiotool/magick job",
    () => {
    expect(PROBEABLE).not.toContain("exr");
    expect(PROBEABLE).not.toContain("psd");
    expect(PROBEABLE).not.toContain("tiff");
  });
});

describe("STILL_BACKEND", () => {
  test("lists exactly the decoded-tier formats Phase 5's pipeline covers",
    () => {
    for (const ext of ["exr", "dpx", "tif", "tiff", "psd", "heic", "heif"]) {
      expect(STILL_BACKEND, ext).toContain(ext);
      expect(previewCapability(ext).tier, ext).toBe("decoded");
    }
  });

  test("never overlaps PROBEABLE — the two pipelines are disjoint", () => {
    for (const ext of STILL_BACKEND) {
      expect(PROBEABLE).not.toContain(ext);
    }
  });
});

describe("the fixture's mix", () => {
  let fixture: NodeDatabase;

  beforeAll(() => {
    fixture = openNodeDatabase(FIXTURE_PATH, { readOnly: true });
  });

  afterAll(() => fixture.close());

  test("nearly half of a real project is not natively previewable",
    async () => {
      const assets = await listAssets(fixture.exec);
      const tiers = assets.map((a) => previewCapability(a.format).tier);
      // The point of the test is the MIX, not the total, and the total
      // moved a long way when the fixture's placeholder assets were
      // replaced with a real folder tree. What has to survive is that
      // some of a real project cannot be shown in a browser: three of
      // these still cannot, and no count of png files changes that.
      // 44 since 2.20: the flashback's reference sheet for Marcus at nine.
      expect(tiers.filter((t) => t === "native").length).toBe(44);
      expect(tiers.filter((t) => t === "decoded").length).toBe(4); // 2 exr, glb, tif
      expect(tiers.filter((t) => t === "named").length).toBe(1);   // zip
      expect(tiers.filter((t) => t !== "native").length)
        .toBeGreaterThanOrEqual(3);
    });
});
