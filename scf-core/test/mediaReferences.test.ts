// SPDX-License-Identifier: Apache-2.0
/**
 * mediaReferences.test.ts — references, never bytes (P6).
 *
 * Two properties carry the section: an export names what it could not
 * resolve rather than quietly dropping it, and nothing in the output is
 * ever a payload.
 */

import { describe, expect, test } from "vitest";
import type { FileLocator } from "../src/assets.ts";
import {
  mediaReferences, referencesMarkdown, summaryLine,
} from "../src/mediaReferences.ts";
import type { ResolvedMedia } from "../src/resolution.ts";

const NOTHING: FileLocator = async () => null;

function locatorOver(paths: Record<string, boolean>): FileLocator {
  return async (root, path) => {
    if (root !== "project") return undefined;
    const hit = paths[path];
    if (hit === undefined) return null;
    return { materialised: hit, sizeBytes: 100, mtime: null };
  };
}

function media(over: unknown[] = [], anchors: unknown[] = [],
               base: unknown[] = [],
               anchorAssets: unknown[] = []): ResolvedMedia {
  return {
    subject: "character", subject_id: 1, intent: "visual_identity",
    override_assets: over as ResolvedMedia["override_assets"],
    anchors: anchors as ResolvedMedia["anchors"],
    // An anchor contributes the ASSET it points at, so a caller that
    // supplies anchors without assets supplies nothing to resolve.
    anchor_assets: anchorAssets as ResolvedMedia["anchor_assets"],
    base_assets: base as ResolvedMedia["base_assets"],
    assets_most_specific_first: [] as ResolvedMedia[
      "assets_most_specific_first"],
    stands_in_for: new Map(),
    binding_verdicts: [],
    trail: [],
  };
}

describe("mediaReferences", () => {
  test("carries the address and the layer it came from", async () => {
    const out = await mediaReferences(
      media([{ id: 1, name: "face.png",
               identifier: "@project/a/face.png",
               role_in_bundle: "hero" }]),
      locatorOver({ "a/face.png": true }));

    const [ref] = out.references;
    expect(ref?.identifier).toBe("@project/a/face.png");
    expect(ref?.format).toBe("png");
    expect(ref?.role).toBe("hero");
    expect(ref?.provenance).toBe("shot override");
    expect(ref?.intent).toBe("visual_identity");
    expect(ref?.state).toBe("resolved");
  });

  test("an asset in two layers is reported at the one that won",
    async () => {
      const row = { id: 7, name: "x.png", identifier: "@project/x.png" };
      const out = await mediaReferences(
        media([row], [], [row]), locatorOver({ "x.png": true }));
      expect(out.references).toHaveLength(1);
      expect(out.references[0]?.provenance).toBe("shot override");
    });

  test("states are counted across layers", async () => {
    const out = await mediaReferences(
      media(
        [{ id: 1, name: "here", identifier: "@project/here.png" }],
        // An anchor and the asset it points at. The anchor itself has no
        // identifier — it names a place in the asset — so the asset is
        // what gets resolved.
        [{ id: 20, name: "gone anchor", asset_id: 2 }],
        [{ id: 3, name: "cloud", identifier: "@project/cloud.exr" },
         { id: 4, name: "bare", identifier: null }],
        [{ id: 2, name: "gone", identifier: "@project/gone.png" }]),
      locatorOver({ "here.png": true, "cloud.exr": false }));

    expect(out.summary.referenced).toBe(4);
    expect(out.summary.counts.resolved).toBe(1);
    expect(out.summary.counts.missing).toBe(1);
    expect(out.summary.counts.unmaterialised).toBe(1);
    // The anchor's reference carries the ASSET's name and identifier,
    // with the anchor's own name alongside.
    const anchorRef = out.references.find((r) => r.provenance === "anchor");
    expect(anchorRef?.name).toBe("gone");
    expect(anchorRef?.identifier).toBe("@project/gone.png");
    expect(anchorRef?.anchorName).toBe("gone anchor");
    expect(out.summary.counts.unaddressed).toBe(1);
  });

  test("everything unresolvable is named, not dropped", async () => {
    const out = await mediaReferences(
      media([{ id: 1, name: "gone.png", identifier: "@project/gone.png" }]),
      NOTHING);
    expect(out.summary.unresolved).toHaveLength(1);
    expect(out.summary.unresolved[0]?.name).toBe("gone.png");
  });

  test("no folder attached is a report, not a failure", async () => {
    const out = await mediaReferences(
      media([{ id: 1, name: "a", identifier: "@project/a.png" }]),
      async () => undefined);
    expect(out.references).toHaveLength(1);
    // `unaddressed` since 0.19 — the test's own name was already the
    // argument: no folder attached is a fact about the session, and
    // reporting it as out-of-root made every asset in a lone .scf look
    // like a broken path.
    expect(out.summary.counts["unaddressed"]).toBe(1);
    expect(out.summary.counts["out-of-root"]).toBe(0);
  });

  test("an empty resolution reports nothing referenced", async () => {
    const out = await mediaReferences(media(), NOTHING);
    expect(out.summary.referenced).toBe(0);
    expect(summaryLine(out.summary, true)).toBe("No assets referenced.");
  });
});

describe("markdown output", () => {
  test("leads with the tally and names what failed", async () => {
    const out = await mediaReferences(
      media([{ id: 1, name: "here", identifier: "@project/here.png" }],
            [], [{ id: 2, name: "gone", identifier: "@project/gone.png" }]),
      locatorOver({ "here.png": true }));
    const md = referencesMarkdown(out, true);

    expect(md).toContain("2 referenced · 1 resolved · 1 missing");
    expect(md).toContain("### Not resolvable");
    expect(md).toContain("@project/gone.png");
  });

  test("says so when there is no folder to resolve against", async () => {
    const out = await mediaReferences(
      media([{ id: 1, name: "a", identifier: "@project/a.png" }]),
      async () => undefined);
    expect(referencesMarkdown(out, false))
      .toContain("no project folder attached");
  });

  test("carries references and never bytes", async () => {
    const out = await mediaReferences(
      media([{ id: 1, name: "here", identifier: "@project/here.png" }]),
      locatorOver({ "here.png": true }));
    const md = referencesMarkdown(out, true);

    // The whole point of §9: an export is addresses a consumer can
    // fetch, not a payload it has to carry.
    expect(md).toContain("@project/here.png");
    expect(md).not.toContain("base64");
    expect(md).not.toContain("blob:");
    expect(md).not.toContain("data:");
  });
});
