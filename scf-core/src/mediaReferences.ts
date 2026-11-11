// SPDX-License-Identifier: Apache-2.0
/**
 * mediaReferences.ts — what a query says about the assets it reaches (P6).
 *
 * The rule (conventions §9): a query never returns bytes. Q13 already
 * returned asset ROWS, which was close but not the same thing — a row
 * is whatever columns the table happens to have, and a consumer reading
 * one has to know the schema to find the address. What travels instead
 * is a reference: identifier, format, the role it plays, the intent it
 * was resolved under, where in the cascade it came from, and whether
 * anything is actually there.
 *
 * The second half is the report. An export that silently omits three
 * unresolvable references is worse than one that admits it, and this is
 * the same principle §2 applies everywhere else: derivations stay total
 * and report findings rather than throwing.
 *
 * The locator is injected, so a report can be produced with no
 * filesystem at all — which is the normal case for a session opened
 * without a project folder, and the case every test here uses.
 */

import {
  resolveIdentifier, type FileLocator, type ResolutionState,
} from "./assets.ts";
import type { Row } from "./db.ts";
import type { ResolvedMedia } from "./resolution.ts";

/** Where in the cascade a reference was picked up. */
export type Provenance = "shot override" | "anchor" | "bundle";

export interface AssetReference {
  /**
   * Row id of the ASSET. Local to a file (§6.2) — carried for the app's
   * own use, never for an exported result.
   */
  id: number;
  /**
   * The asset's identity (§6.1). This is what a canonical query result
   * carries; resolving a row id to a uuid outside this function was how
   * an anchor came to be reported as an unrelated asset.
   */
  uuid: string | null;
  name: string | null;
  identifier: string | null;
  /**
   * For an anchor, the anchor's own name — the label a person gave the
   * reference. Null for anything else.
   */
  anchorName: string | null;
  format: string | null;
  /** `role_in_bundle`, where the cascade carried one. */
  role: string | null;
  intent: string;
  provenance: Provenance;
  state: ResolutionState;
  /** Why, for anything that is not `resolved`. */
  detail: string | null;
  sizeBytes: number | null;
  /**
   * The asset's `lifecycle_status`, unset read as `active` (§12.8). A
   * `deprecated`, `archived` or `draft` asset stays in force; this is
   * what lets a consumer see that and choose.
   */
  lifecycleStatus: string;
  /**
   * The uuid of the superseded asset this reference stands in for,
   * where §12.8 replaced one with its successor. Null otherwise.
   */
  supersedes: string | null;
}

export interface ResolutionSummary {
  referenced: number;
  counts: Record<ResolutionState, number>;
  /** Identifiers that did not resolve, named so a reader can act. */
  unresolved: { name: string | null; identifier: string | null;
                state: ResolutionState }[];
}

export interface MediaReferences {
  references: AssetReference[];
  summary: ResolutionSummary;
}

function str(row: Row, key: string): string | null {
  const v = row[key];
  return v === null || v === undefined || v === "" ? null : String(v);
}

const EMPTY = (): Record<ResolutionState, number> => ({
  resolved: 0, missing: 0, unmaterialised: 0, "out-of-root": 0,
  unaddressed: 0,
});

/**
 * Turn a media resolution into references, with their state.
 *
 * Deduplicated by asset id, keeping the FIRST occurrence: the cascade
 * returns most-specific-first, so an asset that appears both as a shot
 * override and in the base bundle is reported at the override, which is
 * the layer that actually won.
 */
export async function mediaReferences(
  media: ResolvedMedia, locate: FileLocator,
): Promise<MediaReferences> {
  // An anchor is an entity_anchor row, not an asset: it NAMES a place in
  // an asset ("Eleanor face anchor") and points at the asset with
  // `asset_id`. Reporting the anchor row as the reference gave a
  // reference with no identifier, which can never resolve — and any
  // caller that then looked the row id up in the asset table got an
  // unrelated asset that happened to share it.
  //
  // Q13 asks which ASSETS are in force, so an anchor contributes the
  // asset it anchors, keeping its own name alongside.
  const anchorPairs: Array<[Row, Row]> = [];
  media.anchors.forEach((anchor, i) => {
    const asset = media.anchor_assets[i];
    if (asset !== null && asset !== undefined) {
      anchorPairs.push([asset, anchor]);
    }
  });

  const layers: [Provenance, Array<[Row, Row | null]>][] = [
    ["shot override", media.override_assets.map((r): [Row, Row | null] =>
      [r, null])],
    ["anchor", anchorPairs.map(([a, an]): [Row, Row | null] => [a, an])],
    ["bundle", media.base_assets.map((r): [Row, Row | null] => [r, null])],
  ];

  const references: AssetReference[] = [];
  const seen = new Set<number>();
  const counts = EMPTY();
  const unresolved: ResolutionSummary["unresolved"] = [];

  for (const [provenance, entries] of layers) {
    for (const [row, anchor] of entries) {
      const id = Number(row["id"]);
      if (seen.has(id)) continue;
      seen.add(id);

      const replaced = media.stands_in_for.get(row);
      const identifier = str(row, "identifier");
      const resolution = await resolveIdentifier(identifier, locate);
      counts[resolution.state] += 1;

      const name = str(row, "name");
      if (resolution.state !== "resolved") {
        unresolved.push({ name, identifier, state: resolution.state });
      }

      references.push({
        id,
        uuid: typeof row["uuid"] === "string" && row["uuid"] !== ""
          ? row["uuid"] : null,
        name, identifier,
        anchorName: anchor === null ? null : str(anchor, "name"),
        format: resolution.format,
        role: str(row, "role_in_bundle"),
        intent: media.intent,
        provenance,
        state: resolution.state,
        detail: resolution.detail,
        sizeBytes: resolution.sizeBytes,
        lifecycleStatus: str(row, "lifecycle_status") ?? "active",
        supersedes: replaced === undefined ? null : str(replaced, "uuid"),
      });
    }
  }

  return {
    references,
    summary: { referenced: references.length, counts, unresolved },
  };
}

/**
 * The report line every export carries.
 *
 * Written so it reads the same whether everything resolved or nothing
 * did: a session with no project folder attached is a normal state, not
 * an error, and "0 of 8 resolved — no project folder attached" is a
 * useful sentence where a thrown exception would not be.
 */
export function summaryLine(
  summary: ResolutionSummary, hasRoot: boolean,
): string {
  if (summary.referenced === 0) return "No assets referenced.";
  const parts = [`${summary.referenced} referenced`,
                 `${summary.counts.resolved} resolved`];
  if (summary.counts.missing > 0) {
    parts.push(`${summary.counts.missing} missing`);
  }
  if (summary.counts.unmaterialised > 0) {
    parts.push(`${summary.counts.unmaterialised} not downloaded`);
  }
  if (summary.counts["out-of-root"] > 0) {
    parts.push(`${summary.counts["out-of-root"]} outside the project`);
  }
  if (summary.counts.unaddressed > 0) {
    // "unresolvable", not "with no identifier". Since 0.19 an unmapped
    // root is unaddressed too (spec §8.3), and most of these do have an
    // identifier — the session just has nowhere to resolve it. The
    // trailing "no project folder attached" already says which case it
    // is when that is the reason.
    parts.push(`${summary.counts.unaddressed} unresolvable`);
  }
  const line = parts.join(" · ");
  return hasRoot ? line : `${line} — no project folder attached`;
}

/** Markdown for the references section of an export. */
export function referencesMarkdown(
  refs: MediaReferences, hasRoot: boolean,
): string {
  const lines = refs.references.map((r) => {
    const bits = [r.identifier ?? "(no identifier)"];
    if (r.role !== null) bits.push(r.role);
    bits.push(r.provenance);
    if (r.lifecycleStatus !== "active") bits.push(r.lifecycleStatus);
    if (r.supersedes !== null) bits.push("replaces an earlier version");
    if (r.state !== "resolved") bits.push(r.state);
    return `- ${r.name ?? `#${r.id}`} — ${bits.join(" · ")}`;
  });

  let out = `\n## References\n\n${summaryLine(refs.summary, hasRoot)}\n`;
  if (lines.length > 0) out += `\n${lines.join("\n")}\n`;
  if (refs.summary.unresolved.length > 0) {
    out += `\n### Not resolvable\n\n${
      refs.summary.unresolved.map((u) =>
        `- ${u.name ?? "unnamed"} — ${u.identifier ?? "no identifier"} ` +
        `(${u.state})`).join("\n")}\n`;
  }
  return out;
}
