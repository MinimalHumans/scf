// SPDX-License-Identifier: Apache-2.0
/**
 * references.ts — a reference that names no row. Spec §9.4.1,
 * `reference.dangling` (proposal 0040).
 *
 * A reference column that is null or empty is covered elsewhere: a
 * required one is `junction.endpoint_absent` or `field.required_absent`
 * (§9.1). This is the other half — the column is FILLED, and what it is
 * filled with points nowhere. Resolvers are total (§9.2), so every query
 * still answers and the link quietly is not there; nothing said so until
 * this did.
 *
 * One scan, two consumers. The §9.4 reporter merges it into one finding
 * per column; the agent write gate (ops/integrityGate.ts) keys it per
 * row, so a write that adds a dangling reference is refused. Two
 * implementations of "does this value name a row" would drift, which is
 * the failure this project keeps recording.
 *
 * Everything is read from the registry: a reference is a field with a
 * `referenceEntity`, a polymorphic one a field with a `polymorphicType`
 * sibling, resolved through `polymorphicTarget` (§12.1.2). A column
 * declared tomorrow is checked the day it is declared.
 */

import type { Row, SqlExec } from "./db.ts";
import { polymorphicTarget, type Registry } from "./registry.ts";

export interface DanglingReference {
  /** The table holding the reference. */
  entity: string;
  /** The reference column. */
  field: string;
  rowId: number;
  /** What the column holds, as stored. */
  value: string;
  /** The table it should have named a row of. */
  target: string;
}

/**
 * Columns a more specific code already covers (§9.4.1): that code is
 * raised instead, not as well. Reported twice is reported wrong.
 */
const COVERED_ELSEWHERE = new Set([
  // relationship.endpoint_absent (§6.5)
  "character_relationship.character_a_id",
  "character_relationship.character_b_id",
  // structure.boundary_dangling (§5.5)
  "act.start_scene_id",
  "sequence.start_scene_id",
]);

/**
 * The version columns (§6.1). Their chains have the `identity.*` codes,
 * including a link to a row that does not exist
 * (`identity.chain_asymmetric`).
 */
const VERSION_COLUMNS = new Set(["parent_id", "superseded_by_id"]);

const isEmpty = (v: unknown): boolean =>
  v === null || v === undefined || String(v).trim() === "";

/**
 * Every filled reference that names no row of its target, cut or not.
 *
 * A cut row is a row: a link to one is §6.6.1's business, not this
 * one's. A polymorphic column whose sibling is unset, or names no
 * registry entity, is not covered — that is a problem with the sibling,
 * not with the target. A value that is not an integer names no row.
 *
 * In table order, then column order, then row id.
 */
export async function danglingReferences(
    exec: SqlExec, registry: Registry): Promise<DanglingReference[]> {
  const ids = new Map<string, Set<number> | null>();
  const idsOf = async (table: string): Promise<Set<number> | null> => {
    const known = ids.get(table);
    if (known !== undefined) return known;
    let set: Set<number> | null;
    try {
      set = new Set((await exec(`SELECT id FROM "${table}"`))
        .map((r: Row) => Number(r["id"])));
    } catch {
      // The target table is absent from this file. Then no value names a
      // row of it, and `identity.table_absent` already says why.
      set = new Set();
    }
    ids.set(table, set);
    return set;
  };

  const out: DanglingReference[] = [];
  for (const entity of registry.entities.values()) {
    const refs = entity.fields.filter((f) =>
      (f.referenceEntity !== undefined || f.polymorphicType !== undefined) &&
      !(f.autoInjected && VERSION_COLUMNS.has(f.name)) &&
      !COVERED_ELSEWHERE.has(`${entity.name}.${f.name}`));
    if (refs.length === 0) continue;
    let rows: Row[];
    try {
      rows = await exec(`SELECT * FROM "${entity.name}" ORDER BY id`);
    } catch { continue; }
    if (rows.length === 0) continue;
    for (const f of refs) {
      for (const row of rows) {
        const v = row[f.name];
        if (isEmpty(v)) continue;
        let target: string | undefined;
        if (f.polymorphicType === undefined) {
          target = f.referenceEntity;
        } else {
          const kind = row[f.polymorphicType];
          if (isEmpty(kind)) continue;
          const t = polymorphicTarget(f, String(kind));
          if (t === null || !registry.entities.has(t)) continue;
          target = t;
        }
        if (target === undefined) continue;
        const names = typeof v === "number" && Number.isInteger(v) &&
          ((await idsOf(target))?.has(v) ?? false);
        if (names) continue;
        const id = row["id"];
        if (typeof id !== "number") continue;
        out.push({ entity: entity.name, field: f.name, rowId: id,
                   value: String(v), target });
      }
    }
  }
  return out;
}
