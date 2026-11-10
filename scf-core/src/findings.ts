// SPDX-License-Identifier: Apache-2.0
/**
 * findings.ts — the finding vocabulary. Spec §9.5.
 *
 * SCF describes and does not enforce (§9.1), so every problem in a file
 * is a FINDING: reported, never a reason to refuse the data.
 *
 * Six modules produce findings, each with its own richly-typed result,
 * because the panels that consume them need the detail. This module does
 * not replace them. It adds a NORMAL FORM — one shape, one code space,
 * one severity scale — that every producer projects into and that a
 * third party can depend on. A validator whose output cannot be compared
 * between two runs, let alone two implementations, is a demonstration
 * rather than a tool.
 *
 * Three properties are deliberate:
 *
 *   Codes are dotted strings, not numbers. `identity.uuid_missing` needs
 *   no central registry to allocate and says what it is when it turns up
 *   in someone's log. A numeric code would need a table to be readable
 *   and would eventually be reused wrongly.
 *
 *   Codes are a closed union. Adding one is a deliberate act with a
 *   catalog entry naming the spec section it comes from, so a finding
 *   can never be raised that the specification does not describe.
 *
 *   Severity is about the DATA, never about acceptance. `error` means
 *   two conforming readers would disagree about what the file says. It
 *   does not mean refuse the file, and nothing in SCF ever does.
 */

import type { Registry } from "./registry.ts";
import type { Row, SqlExec } from "./db.ts";
import { auditIdentity } from "./identity.ts";
import { duplicateJunctions, junctionEntities } from "./junctions.ts";
import { relationshipFindings } from "./relationships.ts";
import {
  deriveStructure, sceneOrderHint, structureFindings,
} from "./structure.ts";
import { listAssets, orphanIds } from "./assetIndex.ts";
import { bindingCombinationProblems, unboundBundleIds } from "./bundling.ts";
import { fileIdentity } from "./fileIdentity.ts";
import { escapesRoot, parseIdentifier } from "./assets.ts";
import { presenceProblems } from "./presence.ts";
import { lineProblems } from "./lines.ts";
import { danglingReferences } from "./references.ts";

/**
 * How much the finding matters to a CONSUMER of the file.
 *
 * Distinct from readiness.ts's `Severity`, which answers a different
 * question — see the note there.
 *
 * - `error`   the data contradicts itself or the specification, and two
 *             conforming readers would resolve it differently. Not a
 *             reason to refuse anything (§9.1) — a reason to fix it
 *             before anyone relies on the answer.
 * - `warning` resolvable, and probably not what the author meant.
 * - `info`    worth reporting; nothing is wrong.
 */
export type FindingSeverity = "error" | "warning" | "info";

export const FINDING_SEVERITY_RANK: Record<FindingSeverity, number> = {
  error: 0, warning: 1, info: 2,
};

/**
 * Every finding SCF can raise. Closed on purpose — see the header.
 *
 * Grouped by area, and within an area roughly by how much it costs the
 * reader.
 */
export type FindingCode =
  // Header and schema — spec §1.2, §11.2
  | "header.application_id_absent"
  | "header.schema_version_mismatch"
  | "header.schema_version_newer"
  // Row identity — spec §6.1
  | "identity.table_absent"
  | "identity.uuid_column_absent"
  | "identity.unique_index_absent"
  | "identity.uuid_missing"
  | "identity.uuid_malformed"
  | "identity.uuid_duplicate"
  | "identity.chain_cycle"
  | "identity.chain_fork"
  | "identity.chain_asymmetric"
  | "identity.superseded_without_successor"
  | "identity.successor_without_timestamp"
  | "identity.self_parent"
  | "identity.external_id_without_namespace"
  | "vocabulary.unlisted_value"
  | "field.required_absent"
  | "junction.endpoint_absent"
  | "reference.dangling"
  | "structure.section_mismatch"
  // Link natural keys — spec §6.3, §6.4
  | "junction.duplicate_key"
  | "junction.duplicate_key_conflicting"
  // Character relationships — spec §6.5
  | "relationship.duplicate_pair"
  | "relationship.contradictory_pair"
  | "relationship.self_pair"
  | "relationship.directionality_absent"
  | "relationship.endpoint_absent"
  // Spans — spec §5.4, §5.5
  | "structure.boundary_absent"
  | "structure.boundary_dangling"
  | "structure.boundary_cut"
  | "structure.boundary_shared"
  | "structure.sequence_act_mismatch"
  | "structure.boundary_unnumbered"
  | "structure.scenes_before_first_act"
  | "structure.scene_not_in_script"
  | "structure.shadow_row_unexplained"
  // Assets — spec §8.2, §8.6
  | "asset.identifier_absent"
  | "asset.identifier_escapes_root"
  | "asset.identifier_absolute"
  | "asset.orphan"
  | "asset.bundle_unbound"
  // How bindings combine — spec §12.8.2
  | "binding.baseline_replaces"
  | "binding.replace_tie"
  // Lines, line anchors and ranges — spec §1.3.1, §3.5, §4.7
  | "line.type_unknown"
  | "line.anchor_orphaned"
  | "line.range_outside_scene"
  | "line.range_reversed"
  | "line.end_without_start"
  // Presence at a shot — spec §4.6
  | "presence.shot_subject_not_in_scene"
  | "presence.named_but_on_screen"
  | "presence.off_screen_described"
  | "presence.complete_but_empty"
  | "presence.variant_foreign"
  // Extension content — spec §10.1
  | "extension.unknown_table";

export interface FindingSpec {
  severity: FindingSeverity;
  /** One line, stable, safe to show in a UI grouping header. */
  title: string;
  /** The specification section this finding comes from. */
  spec: string;
}

/**
 * The catalog. Severity lives HERE rather than at the point a finding is
 * raised, so that a producer cannot quietly disagree with another about
 * how bad the same condition is.
 */
export const FINDING_CATALOG: Record<FindingCode, FindingSpec> = {
  "header.application_id_absent": {
    severity: "info",
    title: "File header carries no SCF application id",
    spec: "§1.2",
  },
  "header.schema_version_mismatch": {
    severity: "warning",
    title: "Header user_version disagrees with _scf_meta.schema_version",
    spec: "§1.2",
  },
  "header.schema_version_newer": {
    severity: "info",
    title: "File was written by a newer schema version than this reader knows",
    spec: "§11.2",
  },

  "identity.table_absent": {
    severity: "info",
    title: "Registry table not present in this file",
    spec: "§1.3",
  },
  "identity.uuid_column_absent": {
    severity: "error",
    title: "Table carries no uuid column",
    spec: "§6.1",
  },
  "identity.unique_index_absent": {
    severity: "warning",
    title: "Table has no unique index on uuid",
    spec: "§6.1",
  },
  "identity.uuid_missing": {
    severity: "error",
    title: "Rows without a uuid",
    spec: "§6.1",
  },
  "identity.uuid_malformed": {
    severity: "error",
    title: "Rows whose uuid is not uuid-shaped",
    spec: "§6.1",
  },
  "identity.uuid_duplicate": {
    severity: "error",
    title: "Rows sharing a uuid within one table",
    spec: "§6.1",
  },
  "identity.chain_cycle": {
    severity: "error",
    title: "Version chain contains a cycle",
    spec: "§6.1",
  },
  "identity.chain_fork": {
    severity: "warning",
    title: "Two rows claim the same predecessor",
    spec: "§6.1",
  },
  "identity.chain_asymmetric": {
    severity: "warning",
    title: "Version chain links disagree with each other",
    spec: "§6.1",
  },
  "identity.superseded_without_successor": {
    severity: "warning",
    title: "Row marked superseded with nothing succeeding it",
    spec: "§6.1",
  },
  "identity.successor_without_timestamp": {
    severity: "info",
    title: "Row names a successor and carries no superseded_at",
    spec: "§6.1",
  },
  "identity.self_parent": {
    severity: "error",
    title: "Row is its own predecessor",
    spec: "§6.1",
  },
  "identity.external_id_without_namespace": {
    severity: "warning",
    title: "External id carries no namespace",
    spec: "§6.1",
  },

  "field.required_absent": {
    severity: "info",
    title: "Required value absent",
    spec: "§9.1",
  },
  "junction.endpoint_absent": {
    severity: "warning",
    title: "Link row missing a required endpoint",
    spec: "§9.1",
  },
  "reference.dangling": {
    severity: "warning",
    title: "Reference names no row",
    spec: "§9.1",
  },

  "structure.section_mismatch": {
    severity: "info",
    title: "Section line disagrees with the span it names",
    spec: "§1.3.1",
  },

  "vocabulary.unlisted_value": {
    severity: "info",
    title: "Value outside an open vocabulary's known set",
    spec: "§2.4",
  },

  "junction.duplicate_key": {
    severity: "warning",
    title: "Link rows sharing a natural key",
    spec: "§6.4",
  },
  "junction.duplicate_key_conflicting": {
    severity: "error",
    title: "Link rows sharing a natural key and disagreeing on content",
    spec: "§6.4",
  },

  "relationship.duplicate_pair": {
    severity: "warning",
    title: "One relationship entered twice",
    spec: "§6.5",
  },
  "relationship.contradictory_pair": {
    severity: "error",
    title: "One pair described as both mutual and directed",
    spec: "§6.5",
  },
  "relationship.self_pair": {
    severity: "warning",
    title: "Relationship names one character twice",
    spec: "§6.5",
  },
  "relationship.directionality_absent": {
    severity: "warning",
    title: "Relationship carries no directionality",
    spec: "§6.5",
  },
  "relationship.endpoint_absent": {
    severity: "error",
    title: "Relationship points at a character not in this file",
    spec: "§6.5",
  },

  "structure.boundary_absent": {
    severity: "warning",
    title: "Span has no start scene",
    spec: "§5.5",
  },
  "structure.boundary_dangling": {
    severity: "warning",
    title: "Span starts at a scene that is not present",
    spec: "§5.5",
  },
  "structure.boundary_cut": {
    severity: "warning",
    title: "Span starts at a cut scene",
    spec: "§5.5",
  },
  "structure.boundary_shared": {
    severity: "warning",
    title: "Two spans of the same kind start at one scene",
    spec: "§5.5",
  },
  "structure.sequence_act_mismatch": {
    severity: "info",
    title: "Sequence crosses an act boundary",
    spec: "§5.3",
  },
  "structure.boundary_unnumbered": {
    severity: "info",
    title: "Span starts at an unnumbered scene",
    spec: "§5.5",
  },
  "structure.scenes_before_first_act": {
    severity: "info",
    title: "Scenes precede the first act boundary",
    spec: "§5.5",
  },
  "structure.shadow_row_unexplained": {
    severity: "warning",
    title: "scene_sequence rows no span boundary explains",
    spec: "§5.4",
  },
  "structure.scene_not_in_script": {
    severity: "info",
    title: "Scene has no heading in the screenplay",
    spec: "§4.1",
  },

  "asset.identifier_absent": {
    severity: "warning",
    title: "Asset row carries no identifier",
    spec: "§8.2",
  },
  "asset.identifier_escapes_root": {
    severity: "error",
    title: "Asset identifier escapes its root",
    spec: "§8.2",
  },
  "asset.identifier_absolute": {
    severity: "warning",
    title: "Asset identifier is absolute and therefore non-portable",
    spec: "§8.2",
  },
  "asset.orphan": {
    severity: "info",
    title: "Asset referenced by nothing",
    spec: "§8.6",
  },
  "asset.bundle_unbound": {
    severity: "info",
    title: "Bundle reaches no subject",
    spec: "§8.6",
  },

  "binding.baseline_replaces": {
    severity: "warning",
    title: "Baseline binding replaces, excluding every lower binding",
    spec: "§12.8.2",
  },
  "binding.replace_tie": {
    severity: "info",
    title: "Replacing binding tied on precedence; the tie is not replaced",
    spec: "§12.8.2",
  },

  "line.type_unknown": {
    severity: "error",
    title: "Screenplay line has a line_type outside the published set",
    spec: "§1.3.1",
  },
  "line.anchor_orphaned": {
    severity: "warning",
    title: "Line anchor names no line of the screenplay",
    spec: "§3.5",
  },
  "line.range_outside_scene": {
    severity: "warning",
    title: "Line range names a line outside its own scene",
    spec: "§4.7",
  },
  "line.range_reversed": {
    severity: "warning",
    title: "Line range ends before it starts",
    spec: "§4.7",
  },
  "line.end_without_start": {
    severity: "warning",
    title: "Line range has an end and no start",
    spec: "§4.7",
  },

  "presence.shot_subject_not_in_scene": {
    severity: "warning",
    title: "Shot names a subject its scene does not link",
    spec: "§4.6",
  },
  "presence.named_but_on_screen": {
    severity: "warning",
    title: "Shot puts on screen a subject its scene only names",
    spec: "§4.6",
  },
  "presence.off_screen_described": {
    severity: "warning",
    title: "Off-screen subject has facing or focus set",
    spec: "§4.6",
  },
  "presence.complete_but_empty": {
    severity: "info",
    title: "Shot's frame is marked complete and records no subject",
    spec: "§4.6",
  },
  "presence.variant_foreign": {
    severity: "warning",
    title: "Scene link names a variant of another subject",
    spec: "§4.8",
  },

  "extension.unknown_table": {
    severity: "info",
    title: "Table not defined by the registry",
    spec: "§10.1",
  },
};

export interface Finding {
  code: FindingCode;
  severity: FindingSeverity;
  /** Table the finding is about, or null when it is file-wide. */
  table: string | null;
  /**
   * Rows at fault. Empty when the finding is about a table or the file
   * rather than particular rows. Several ids where the finding is
   * inherently about a set — two rows sharing a key, say.
   */
  rowIds: number[];
  /** One sentence, written for a person. */
  message: string;
  /** How many occurrences this finding stands for. Usually 1. */
  count: number;
}

export interface FindingReport {
  schemaVersion: string | null;
  findings: Finding[];
  counts: Record<FindingSeverity, number>;
  /** True when nothing at `error` was found. */
  clean: boolean;
}

const spec = (code: FindingCode): FindingSpec => FINDING_CATALOG[code];

function make(code: FindingCode, message: string,
              opts: { table?: string | null; rowIds?: number[];
                      count?: number } = {}): Finding {
  return {
    code,
    severity: spec(code).severity,
    table: opts.table ?? null,
    rowIds: opts.rowIds ?? [],
    message,
    count: opts.count ?? 1,
  };
}

/**
 * Deterministic order: severity, then code, then table, then first row
 * id. Two runs over one file must produce byte-identical output or the
 * report cannot be diffed, which is most of what a validator is for.
 */
// Code-point order, as §9.4 states: a locale's collation is not a
// property of the file.
const byCodePoint = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) =>
    FINDING_SEVERITY_RANK[a.severity] - FINDING_SEVERITY_RANK[b.severity] ||
    byCodePoint(a.code, b.code) ||
    byCodePoint(a.table ?? "", b.table ?? "") ||
    (a.rowIds[0] ?? 0) - (b.rowIds[0] ?? 0));
}

const IDENTITY_CODES: Record<string, FindingCode> = {
  "table-absent": "identity.table_absent",
  "no-uuid-column": "identity.uuid_column_absent",
  "no-unique-index": "identity.unique_index_absent",
  "missing-uuid": "identity.uuid_missing",
  "malformed-uuid": "identity.uuid_malformed",
  "duplicate-uuid": "identity.uuid_duplicate",
  "chain-cycle": "identity.chain_cycle",
  "chain-fork": "identity.chain_fork",
  "chain-asymmetric": "identity.chain_asymmetric",
  "superseded-without-successor": "identity.superseded_without_successor",
  "successor-without-timestamp": "identity.successor_without_timestamp",
  "self-parent": "identity.self_parent",
  "external-id-without-namespace": "identity.external_id_without_namespace",
};

const RELATIONSHIP_CODES: Record<string, FindingCode> = {
  "duplicate-pair": "relationship.duplicate_pair",
  "contradictory-pair": "relationship.contradictory_pair",
  "self-pair": "relationship.self_pair",
  "missing-directionality": "relationship.directionality_absent",
  "missing-endpoint": "relationship.endpoint_absent",
};

const STRUCTURE_CODES: Record<string, FindingCode> = {
  "no-boundary": "structure.boundary_absent",
  "dangling-boundary": "structure.boundary_dangling",
  "shared-boundary": "structure.boundary_shared",
  "act-mismatch": "structure.sequence_act_mismatch",
  "unnumbered-boundary": "structure.boundary_unnumbered",
  "scenes-before-first-act": "structure.scenes_before_first_act",
  "not-in-script": "structure.scene_not_in_script",
};

/**
 * Run every producer and project the results into the normal form.
 *
 * This is the engine a validator sits on. It is deliberately a library
 * function taking a `SqlExec`, so the same code serves a CLI, the
 * editor's panels, and a test — one implementation of "what is wrong
 * with this file", not three that drift.
 */
export async function collectFindings(
    exec: SqlExec, registry: Registry): Promise<FindingReport> {
  const out: Finding[] = [];

  // --- header and schema version (§1.2, §11.2) ---
  const identity = await fileIdentity(exec);
  let storedVersion: string | null = null;
  try {
    const rows = await exec(
      "SELECT value FROM _scf_meta WHERE key = 'schema_version'");
    const v = rows[0]?.["value"];
    storedVersion = v === undefined || v === null ? null : String(v);
  } catch { storedVersion = null; }

  if (!identity.isScf) {
    out.push(make("header.application_id_absent",
      "No SCF application id in the file header; identification by " +
      "content only."));
  }
  if (identity.headerSchemaVersion !== null && storedVersion !== null &&
      identity.headerSchemaVersion !== storedVersion) {
    out.push(make("header.schema_version_mismatch",
      `Header says schema ${identity.headerSchemaVersion}, ` +
      `_scf_meta says ${storedVersion}. _scf_meta is authoritative.`));
  }
  if (storedVersion !== null && storedVersion !== registry.schemaVersion) {
    const [fileMajor = 0, fileMinor = 0] = storedVersion.split(".").map(Number);
    const [ourMajor = 0, ourMinor = 0] =
      registry.schemaVersion.split(".").map(Number);
    if (fileMajor > ourMajor ||
        (fileMajor === ourMajor && fileMinor > ourMinor)) {
      out.push(make("header.schema_version_newer",
        `File is schema ${storedVersion}; this reader knows ` +
        `${registry.schemaVersion}. Unrecognised content is ignored.`));
    }
  }

  // --- row identity (§6.1) ---
  const audit = await auditIdentity(exec, registry);
  for (const f of audit.findings) {
    const code = IDENTITY_CODES[f.kind];
    if (code === undefined) continue;
    out.push(make(code, f.detail, {
      table: f.table,
      rowIds: f.ids ?? (f.id === null ? [] : [f.id]),
      count: f.count,
    }));
  }

  // --- required values (§9.1) ---
  //
  // `required` means a row is INCOMPLETE without the value, never that
  // a writer may refuse it (§9.1, §5.5). Two codes because §9.4 takes a
  // severity from the catalog, so one code cannot carry both: a link
  // with a missing endpoint connects nothing, which is worse than an
  // unfinished row.
  const junctionNames = new Set(junctionEntities(registry).map((e) => e.name));
  for (const entity of registry.entities.values()) {
    const required = entity.fields.filter(
      (f) => f.required && !f.autoInjected);
    if (required.length === 0) continue;
    let rowsOf: Row[];
    try {
      rowsOf = await exec(`SELECT * FROM "${entity.name}"`);
    } catch { continue; }
    const isLink = junctionNames.has(entity.name);
    for (const f of required) {
      // `character_relationship`'s endpoints have their own, more
      // specific finding (§6.5). Reported twice is reported wrong.
      if (entity.name === "character_relationship" &&
          (f.name === "character_a_id" || f.name === "character_b_id")) {
        continue;
      }
      const ids: number[] = [];
      for (const row of rowsOf) {
        const v = row[f.name];
        if (v === null || v === undefined || String(v).trim() === "") {
          const id = row["id"];
          if (typeof id === "number") ids.push(id);
        }
      }
      if (ids.length === 0) continue;
      out.push(make(
        isLink ? "junction.endpoint_absent" : "field.required_absent",
        isLink
          ? `${entity.name}.${f.name} is absent on ${ids.length} row(s): ` +
            `a link with a missing end connects nothing.`
          : `${entity.name}.${f.name} is absent on ${ids.length} row(s). ` +
            `The row is incomplete, not invalid — nothing is rejected on ` +
            `write (§9.1).`,
        { table: entity.name, rowIds: ids, count: ids.length }));
    }
  }

  // --- references to nothing (§9.1) ---
  //
  // The other half of the block above: the column is filled, and what
  // it is filled with names no row. One finding per column, as the
  // required-value findings are. The columns a more specific code
  // covers are left to that code (references.ts).
  {
    const byColumn = new Map<string, { entity: string; field: string;
      target: string; ids: number[] }>();
    for (const d of await danglingReferences(exec, registry)) {
      const key = `${d.entity}.${d.field}`;
      const at = byColumn.get(key) ??
        { entity: d.entity, field: d.field, target: d.target, ids: [] };
      at.ids.push(d.rowId);
      byColumn.set(key, at);
    }
    for (const c of byColumn.values()) {
      out.push(make("reference.dangling",
        `${c.entity}.${c.field} holds a value naming no row on ` +
        `${String(c.ids.length)} row(s): the reference is filled and ` +
        "points nowhere, so every query resolves it to nothing (§9.2).",
        { table: c.entity, rowIds: c.ids, count: c.ids.length }));
    }
  }

  // --- open vocabularies (§2.4) ---
  //
  // An unlisted value on an open field is the value, not an error — but
  // it is worth seeing, because the tail of one is how a maintainer
  // learns which value to promote into the known set. Derived from the
  // registry's `open` flag, so a field opened later needs no code here.
  for (const entity of registry.entities.values()) {
    const openFields = entity.fields.filter(
      (f) => f.open === true && f.options !== undefined);
    if (openFields.length === 0) continue;
    let rowsOf: Row[];
    try {
      rowsOf = await exec(`SELECT * FROM "${entity.name}"`);
    } catch { continue; }
    for (const f of openFields) {
      const known = new Set(f.options ?? []);
      const seen = new Map<string, number[]>();
      for (const row of rowsOf) {
        const raw = row[f.name];
        if (raw === null || raw === undefined || String(raw).trim() === "") {
          continue;
        }
        // A multiselect holds several values in one column. The storage
        // shape is not specified, so this splits on commas and reports
        // what it finds rather than guessing harder.
        const values = f.fieldType === "multiselect"
          ? String(raw).split(",").map((v) => v.trim()).filter((v) => v !== "")
          : [String(raw).trim()];
        const id = row["id"];
        for (const v of values) {
          if (known.has(v)) continue;
          const ids = seen.get(v) ?? [];
          if (typeof id === "number") ids.push(id);
          seen.set(v, ids);
        }
      }
      for (const [value, ids] of [...seen].sort(
          (a, b) => a[0].localeCompare(b[0]))) {
        out.push(make("vocabulary.unlisted_value",
          `${entity.name}.${f.name} carries "${value}", which is not among ` +
          `its known values. Open vocabulary: this is the value, not an ` +
          `error.`, { table: entity.name, rowIds: ids, count: ids.length }));
      }
    }
  }

  // --- link natural keys (§6.4) ---
  for (const dup of await duplicateJunctions(exec, registry)) {
    out.push(make(
      dup.contentDiffers
        ? "junction.duplicate_key_conflicting" : "junction.duplicate_key",
      dup.message, { table: dup.entity, rowIds: dup.rowIds }));
  }

  // --- character relationships (§6.5) ---
  for (const f of await relationshipFindings(exec, registry)) {
    const code = RELATIONSHIP_CODES[f.kind];
    if (code === undefined) continue;
    out.push(make(code, f.message, {
      table: "character_relationship", rowIds: f.rowIds,
    }));
  }

  // --- spans (§5.5) ---
  const scenes = await exec("SELECT * FROM scene");
  const acts = await exec("SELECT * FROM act");
  const sequences = await exec("SELECT * FROM sequence");
  const headings = await exec(
    "SELECT scene_id, line_order FROM screenplay_lines " +
    "WHERE line_type = 'heading'");
  const hint = sceneOrderHint(headings);
  const structure = deriveStructure(scenes, acts, sequences, hint);
  for (const f of structureFindings(structure, acts, sequences, hint)) {
    const code = STRUCTURE_CODES[f.code];
    if (code === undefined) continue;
    const rowIds = f.rowIds ?? (f.rowId === null ? [] : [f.rowId]);
    out.push(make(code, f.message, {
      table: f.entity, rowIds, count: Math.max(1, rowIds.length),
    }));
  }

  // A span whose start scene is CUT. The derivation above runs over
  // every scene, cut ones included (§9.5), so it sees the span anchored
  // and says nothing; but a cut scene takes part in no span (§6.6.1),
  // so in every answer about the film the span covers nothing and its
  // scenes belong to the span before it (§5.5). That re-parenting is
  // silent unless this says so. A cut span is not in the film either,
  // and is not reported.
  const cutScenes = new Set(scenes
    .filter((s) => s["lifecycle_status"] === "cut")
    .map((s) => Number(s["id"])));
  for (const [rowsOf, table] of [[acts, "act"],
                                 [sequences, "sequence"]] as const) {
    for (const r of rowsOf) {
      if (r["lifecycle_status"] === "cut") continue;
      const start = r["start_scene_id"];
      if (start === null || start === undefined ||
          !cutScenes.has(Number(start))) continue;
      out.push(make("structure.boundary_cut",
        `${String(r["name"] ?? table)} starts at a cut scene, so it ` +
        "covers no scene and its scenes stay with the span before it " +
        "(§5.5). Move its start to a scene in the film.",
        { table, rowIds: [Number(r["id"])] }));
    }
  }

  // --- bound section lines (§1.3.1) ---
  //
  // A section line MAY bind to the span it names. The RECORD answers
  // queries; the line is the authoring handle. Between commits the two
  // legitimately differ, so this is info rather than an error — but a
  // line that has drifted from its entity is how an editor renames the
  // wrong act, and nothing said so before schema 2.15.
  const sections = await exec(
    "SELECT id, line_order, content, metadata FROM screenplay_lines " +
    "WHERE line_type = 'section' ORDER BY line_order");
  const headingRows = await exec(
    "SELECT scene_id, line_order FROM screenplay_lines " +
    "WHERE line_type = 'heading' ORDER BY line_order");
  const spanRows: Record<string, Row[]> = { act: acts, sequence: sequences };
  for (const line of sections) {
    let meta: unknown = line["metadata"];
    if (typeof meta === "string") {
      try { meta = JSON.parse(meta); } catch { meta = null; }
    }
    if (meta === null || typeof meta !== "object") continue;
    const ref = (meta as Record<string, unknown>)["structureRef"];
    if (ref === null || typeof ref !== "object") continue;
    const { kind, uuid, id } = ref as Record<string, unknown>;
    if (kind !== "act" && kind !== "sequence") continue;
    const candidates = spanRows[kind] ?? [];
    const target = typeof uuid === "string" && uuid !== ""
      ? candidates.find((r) => String(r["uuid"] ?? "").toLowerCase() ===
                               uuid.toLowerCase())
      : candidates.find((r) => Number(r["id"]) === Number(id));
    const lineId = typeof line["id"] === "number" ? [line["id"]] : [];
    if (target === undefined) {
      out.push(make("structure.section_mismatch",
        `A section line binds to a ${kind} that is not in the file.`,
        { table: "screenplay_lines", rowIds: lineId }));
      continue;
    }
    const label = /^\s*#+\s*(.*)$/.exec(String(line["content"] ?? ""))?.[1]
      ?.trim() ?? "";
    const name = String(target["name"] ?? "").trim();
    if (label !== "" && name !== "" && label !== name) {
      out.push(make("structure.section_mismatch",
        `The section line reads "${label}" and the ${kind} it names is ` +
        `"${name}". The record answers queries (§1.3.1).`,
        { table: "screenplay_lines", rowIds: lineId }));
    }
    const order = Number(line["line_order"] ?? 0);
    const below = headingRows.find((h) => Number(h["line_order"] ?? 0) > order
                                          && h["scene_id"] !== null);
    const boundary = target["start_scene_id"];
    if (below !== undefined && boundary !== null && boundary !== undefined &&
        Number(below["scene_id"]) !== Number(boundary)) {
      out.push(make("structure.section_mismatch",
        `The section line for "${name}" sits above a different scene ` +
        `than its start_scene_id names. The record is the boundary ` +
        `(§5.1); the line is the handle.`,
        { table: "screenplay_lines", rowIds: lineId }));
    }
  }

  // --- shadow rows (§5.4) ---
  //
  // §5.4 requires these to be counted and reported as a finding, which
  // means the code has to exist in the catalog and the detection has to
  // live here rather than inside the editor's commit path — otherwise
  // the one tool a third party runs never mentions them.
  //
  // Reported, never deleted: silently dropping someone's authored links
  // to satisfy a derivation is not a migration.
  try {
    const explained = new Set<string>();
    for (const span of structure.sequences) {
      for (const sceneId of span.sceneIds) {
        explained.add(`${String(sceneId)}:${String(span.id)}`);
      }
    }
    const orphaned = (await exec(
      "SELECT id, scene_id, sequence_id FROM scene_sequence"))
      .filter((r) => !explained.has(
        `${String(Number(r["scene_id"]))}:${String(Number(r["sequence_id"]))}`));
    if (orphaned.length > 0) {
      out.push(make("structure.shadow_row_unexplained",
        `${String(orphaned.length)} scene_sequence row(s) are explained ` +
        "by no sequence boundary; the boundary is the truth and these " +
        "are its shadow (§5.4).",
        { table: "scene_sequence",
          rowIds: orphaned.map((r) => Number(r["id"])).sort((a, b) => a - b),
          count: orphaned.length }));
    }
  } catch { /* table absent: not a finding */ }

  // --- assets (§8.2, §8.6) ---
  const assets = await listAssets(exec);
  const orphans = await orphanIds(exec, registry);
  for (const a of assets) {
    const id = a.identifier ?? "";
    if (id.trim() === "") {
      out.push(make("asset.identifier_absent",
        `Asset ${String(a.id)} has no identifier.`,
        { table: "asset", rowIds: [a.id] }));
      continue;
    }
    const parsed = parseIdentifier(id);
    if (parsed === null) {
      out.push(make("asset.identifier_absent",
        `Asset ${String(a.id)} has an identifier that does not parse.`,
        { table: "asset", rowIds: [a.id] }));
    } else if (escapesRoot(parsed.path)) {
      out.push(make("asset.identifier_escapes_root",
        `Asset identifier "${id}" contains a '..' segment and cannot ` +
        "be resolved.", { table: "asset", rowIds: [a.id] }));
    } else if (parsed.root === null) {
      out.push(make("asset.identifier_absolute",
        `Asset identifier "${id}" is absolute; it will not travel with ` +
        "the file.", { table: "asset", rowIds: [a.id] }));
    }
  }
  for (const id of orphans) {
    out.push(make("asset.orphan",
      `Asset ${String(id)} is referenced by nothing.`,
      { table: "asset", rowIds: [id] }));
  }

  // --- bundles nothing binds (§8.6) ---
  // One level above an orphan, and invisible to it: every asset in
  // such a bundle IS referenced, and none of them resolves for any
  // subject at any position. Info, not a warning — a bundle can be
  // assembled before anyone decides what it is for, and SCF reports
  // rather than enforces (§9.2).
  try {
    const unbound = await unboundBundleIds(exec, registry);
    for (const row of await exec("SELECT id, name FROM \"bundle\"")) {
      const id = Number(row["id"]);
      if (!unbound.has(id)) continue;
      const name = row["name"] === null || row["name"] === undefined
        ? String(id) : String(row["name"]);
      out.push(make("asset.bundle_unbound",
        `Bundle "${name}" is bound to no character, prop or location, ` +
        "so no query returns its assets.",
        { table: "bundle", rowIds: [id] }));
    }
  } catch {
    // A file without the bundle tables has no such finding to make.
  }

  // --- how bindings combine (§12.8.2) ---
  for (const p of await bindingCombinationProblems(exec, registry)) {
    out.push(make(p.code, p.message,
                  { table: p.table, rowIds: [p.rowId] }));
  }

  // --- line types, anchors and ranges (§1.3.1, §3.5, §4.7) ---
  for (const p of await lineProblems({ exec, registry })) {
    out.push(make(p.code, p.message,
                  { table: p.table, rowIds: [p.rowId] }));
  }

  // --- presence at a shot (§4.6) ---
  try {
    for (const p of await presenceProblems({ exec, registry })) {
      out.push(make(p.code, p.message,
                    { table: p.table, rowIds: [p.rowId] }));
    }
  } catch {
    // A file written before 2.17 has no shot presence tables; nothing to
    // report, and `identity.table_absent` already says they are missing.
  }

  // --- unknown tables (§10.1) ---
  // registry.knownTables, not a set assembled here: "what SCF owns" is
  // a fact about the format and belongs where the format is declared.
  // Assembling it at the call site is how the two title-page tables
  // came to be reported as third-party content in the first place.
  const known = registry.knownTables;
  const tables = await exec(
    "SELECT name FROM sqlite_master WHERE type = 'table' " +
    "AND name NOT LIKE 'sqlite_%'");
  for (const t of tables) {
    const name = String(t["name"]);
    if (known.has(name)) continue;
    out.push(make("extension.unknown_table",
      `Table "${name}" is not defined by the registry; it is preserved ` +
      "and otherwise ignored.", { table: name }));
  }

  const findings = sortFindings(out);
  const counts: Record<FindingSeverity, number> = {
    error: 0, warning: 0, info: 0,
  };
  for (const f of findings) counts[f.severity] += 1;

  return {
    schemaVersion: storedVersion,
    findings,
    counts,
    clean: counts.error === 0,
  };
}
