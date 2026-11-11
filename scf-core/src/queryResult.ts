// SPDX-License-Identifier: Apache-2.0
/**
 * queryResult.ts — the canonical queries' normative answers. Spec §12.
 *
 * The sixteen canonical queries are part of the format: they are the
 * questions SCF exists to answer, and shipping them is the guidance the
 * format is for. What is normative is the RESULT STRUCTURE, not any
 * rendering of it — markdown is a convenience, and an implementation
 * that produces the right answer in a different presentation is
 * conforming.
 *
 * This module lives in scf-core rather than beside the runners in the
 * app for that reason. The app renders; the core answers.
 *
 * THREE RULES MAKE A RESULT PORTABLE:
 *
 *   Rows are referenced by `uuid`, never by row id. Row ids are local to
 *   a file (§6.2) and a writer may renumber them; a uuid survives export
 *   and re-import (§6.1). An expectation carrying `character #1` is
 *   pinned to one file's accidents.
 *
 *   Volatile and framework columns are dropped: `id`, `created_at`,
 *   `updated_at`. They differ between two files that say the same thing,
 *   so including them would fail a comparison for reasons unrelated to
 *   correctness.
 *
 *   Reference columns are RESOLVED to uuids: `scene_id` becomes
 *   `scene_uuid`. A result that carried the number would be describing
 *   the file rather than the story.
 *
 * Field names are the registry's own column names. A result is made of
 * registry fields, so inventing a second vocabulary for them would
 * create exactly the drift this format keeps designing against.
 */

import type { Row, SqlExec } from "./db.ts";
import type { Registry } from "./registry.ts";
import { q } from "./db.ts";

/** Columns that never appear in a result. See the header. */
const DROPPED = new Set(["id", "created_at", "updated_at"]);

export interface ProjectedRow {
  /** The row's identity (§6.1). Null only if the row carries none. */
  uuid: string | null;
  /** Authored fields, registry names, nulls and empties omitted. */
  fields: Record<string, unknown>;
}

/**
 * Resolves a row id in some table to that row's uuid. Built once per
 * query rather than per row: a cascade of eight layers pointing at the
 * same scene should not be eight queries.
 */
export interface UuidLookup {
  (entity: string, rowId: number | null): string | null;
}

/**
 * Every reference column an entity declares, as column → target entity.
 *
 * DERIVED FROM THE REGISTRY, never written by hand. A hand-written map
 * per query drifts silently: `scene.location_id` resolved in one query
 * and dropped in another, two reference columns on the same motif row
 * treated differently, and nothing able to notice.
 *
 * §2.3 says to prefer rules the registry implies over hand-maintained
 * lists. This is that rule applied to §12.1.2.
 */
/**
 * Marks a column as a POLYMORPHIC reference in a reference map.
 *
 * A reference map normally says "this column points at that entity".
 * A polymorphic column points at whichever table a sibling column names
 * at run time, so there is no entity to record — and it must still be
 * dropped from a projected row, because it holds a bare row id.
 *
 * Carried in the same map rather than in a second argument so that the
 * registry stays the only thing that decides, in one function, rather
 * than at fifty-nine call sites.
 */
export const POLYMORPHIC = "\u0000polymorphic";

/**
 * Marks a `string_list` column (spec §2.5): a JSON array of strings,
 * projected AS an array rather than as the text that holds it. A
 * consumer parsing JSON out of a JSON document was the old behaviour
 * and nobody wanted it.
 */
export const STRING_LIST = "\u0000string_list";

/**
 * Per-column projection roles, derived from the registry: an entity
 * name for a reference, `POLYMORPHIC` for a polymorphic reference, and
 * `STRING_LIST` for a list column. Called `referencesOf` until schema
 * 2.15, when a second role joined it and the old name stopped saying
 * what the map held.
 */
export function columnRoles(registry: Registry, entity: string):
    Record<string, string> {
  const def = registry.entities.get(entity);
  if (def === undefined) return {};
  const out: Record<string, string> = {};
  for (const field of def.fields) {
    if (field.polymorphicType !== undefined && field.polymorphicType !== "") {
      out[field.name] = POLYMORPHIC;
    } else if (field.referenceEntity !== undefined
               && field.referenceEntity !== "") {
      out[field.name] = field.referenceEntity;
    } else if (field.fieldType === "string_list") {
      out[field.name] = STRING_LIST;
    }
  }
  return out;
}

/**
 * A lookup covering every entity any reference column can point at, so
 * a projection can never fail for want of an index that was not asked
 * for. Built once per query.
 */
export async function uuidLookupForAll(
    exec: SqlExec, registry: Registry): Promise<UuidLookup> {
  const targets = new Set<string>();
  for (const entity of registry.order) {
    targets.add(entity);
    for (const target of Object.values(columnRoles(registry, entity))) {
      // POLYMORPHIC is a marker, not a table. Left in this set it
      // becomes a SELECT against a table named after a NUL byte, whose
      // error the catch below swallows — wasteful, and it makes the
      // catch cover a case it was not written for.
      if (target !== POLYMORPHIC && target !== STRING_LIST) {
        targets.add(target);
      }
    }
  }
  return uuidLookupFor(exec, [...targets].sort());
}

export async function uuidLookupFor(
    exec: SqlExec, entities: readonly string[]): Promise<UuidLookup> {
  const byEntity = new Map<string, Map<number, string>>();
  for (const entity of entities) {
    const map = new Map<number, string>();
    try {
      for (const r of await exec(`SELECT id, uuid FROM ${q(entity)}`)) {
        const id = Number(r["id"]);
        const uuid = r["uuid"];
        if (Number.isFinite(id) && typeof uuid === "string" && uuid !== "") {
          map.set(id, uuid);
        }
      }
    } catch {
      // Table absent. Total, per §9.2 — a missing table is a finding,
      // not a reason for a query to fail.
    }
    byEntity.set(entity, map);
  }
  return (entity, rowId) =>
    rowId === null ? null : byEntity.get(entity)?.get(rowId) ?? null;
}

const empty = (v: unknown): boolean =>
  v === null || v === undefined || v === "";

/**
 * Project a row into its portable form (§12.1.2).
 *
 * `references` maps a column to the entity it points at, so `scene_id`
 * can become `scene_uuid`. A reference that cannot be resolved is
 * dropped rather than emitted raw: a bare row id in a result is the
 * defect this module exists to prevent.
 *
 * A column the REGISTRY declares polymorphic — a reference whose target
 * table is chosen per row by a sibling column — is dropped too, marked
 * in the reference map by `POLYMORPHIC`. The query lifts the resolved
 * target alongside the projected row (§12.11).
 *
 * DROP BY DECLARATION, NEVER BY NAME. Dropping every column ending
 * `_id` is a much larger set: it takes `external_id`, a declared and
 * authored field on ten entities, and any ordinary reference whose
 * target is a screenplay table rather than a registry entity.
 *
 * No artifact catches that. The fixture authors no `external_id` and its
 * `clip` table is empty, and §12.1.2 omits empty fields, so a correct
 * implementation and a data-losing one produce byte-identical output on
 * all sixteen published results.
 */
export function projectRow(
    row: Row,
    references: Readonly<Record<string, string>> = {},
    lookup: UuidLookup = () => null): ProjectedRow {
  const fields: Record<string, unknown> = {};
  for (const key of Object.keys(row).sort()) {
    if (DROPPED.has(key) || key === "uuid") continue;
    const value = row[key];

    const entity = references[key];
    if (entity === POLYMORPHIC) continue;
    if (entity === STRING_LIST) {
      if (empty(value)) continue;
      // A malformed list is CONTENT, not a crash: carried as the text
      // it holds rather than dropped (§9.2).
      let parsed: unknown = null;
      try { parsed = JSON.parse(String(value)); } catch { parsed = null; }
      if (Array.isArray(parsed)) {
        if (parsed.length === 0) continue;
        fields[key] = parsed;
      } else {
        fields[key] = value;
      }
      continue;
    }
    if (entity !== undefined) {
      const target = empty(value) ? null : Number(value);
      const uuid = lookup(entity, Number.isFinite(target) ? target : null);
      if (uuid !== null) fields[`${key.slice(0, -3)}_uuid`] = uuid;
      continue;
    }

    if (empty(value)) continue;
    fields[key] = value;
  }
  const uuid = row["uuid"];
  return {
    uuid: typeof uuid === "string" && uuid !== "" ? uuid : null,
    fields,
  };
}

/**
 * The envelope every canonical query result carries (§12.1.1).
 *
 * `parameters` records what was ASKED, resolved to uuids, so a result
 * is self-describing: a reader handed one can tell which question it
 * answers without being told.
 */
export interface QueryResult<T> {
  query: string;
  resultFormat: string;
  schemaVersion: string;
  parameters: Record<string, string | null>;
  result: T;
}

/** Bumped when the envelope changes, not when SCF does. */
export const QUERY_RESULT_FORMAT = "1.1";

export function envelope<T>(
    query: string, registry: Registry,
    parameters: Record<string, string | null>, result: T): QueryResult<T> {
  return {
    query,
    resultFormat: QUERY_RESULT_FORMAT,
    schemaVersion: registry.schemaVersion,
    parameters,
    result,
  };
}
