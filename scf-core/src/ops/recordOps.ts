// SPDX-License-Identifier: Apache-2.0
/**
 * ops/recordOps.ts — create, update and delete one registry row.
 *
 * The generic write path behind the record editor and every "make me a
 * row" shortcut in the workspaces. It lives here rather than in a view
 * so that every writer — the app, the MCP — gets the same rules:
 * identity stamped at insert, only registry fields written, a shot
 * renumbered when it changes scene, and a scene's act and sequence
 * boundaries handed on before it goes.
 *
 * Each exported function is one transaction. Do not call one from inside
 * `withTransaction`: the queue is per connection and would wait on
 * itself.
 */

import { newUuid, q, withTransaction, type SqlExec, type SqlValue }
  from "../db.ts";
import { rowLabel } from "../displayName.ts";
import type { Registry } from "../registry.ts";
import { renumberForScene } from "./shootOps.ts";
import { reanchorSpansForMove } from "./structureCommit.ts";
import { captureForUndo, type UndoEntry } from "./undoDelete.ts";
import { savepointExec } from "./integrityGate.ts";

function entityDef(registry: Registry, entity: string) {
  const edef = registry.entities.get(entity);
  if (edef === undefined) throw new Error(`unknown entity: ${entity}`);
  return edef;
}

/**
 * Insert a row and return its id. Values for names that are not
 * registry fields are ignored, and null or empty values are left to the
 * column default, so a half-filled form does not store empty strings.
 *
 * `uuid` is the row's identity when the caller already has one (an
 * agent that names the row before it exists, proposal 0043); otherwise a
 * fresh one is stamped.
 */
export async function createRecord(
    exec: SqlExec, registry: Registry, entity: string,
    values: Record<string, SqlValue | undefined>,
    uuid?: string): Promise<number> {
  const edef = entityDef(registry, entity);
  const fieldNames = edef.fields.map((f) => f.name);
  const filtered = Object.entries(values).filter(
    (e): e is [string, SqlValue] =>
      fieldNames.includes(e[0]) && e[1] !== undefined &&
      e[1] !== null && e[1] !== "");
  const cols = [...filtered.map(([k]) => k), "uuid"];
  const vals: SqlValue[] = [...filtered.map(([, v]) => v), uuid ?? newUuid()];
  return withTransaction(exec, async () => {
    await exec(
      `INSERT INTO ${q(entity)} (${cols.map(q).join(", ")}) ` +
      `VALUES (${cols.map(() => "?").join(", ")})`, vals);
    const idRow = await exec("SELECT last_insert_rowid() AS id");
    return Number(idRow[0]?.["id"]);
  });
}

/**
 * Write every registry field of a row from `values` (a missing value is
 * written as null), and stamp `updated_at`.
 *
 * A shot moved to another scene is renumbered first, so the form does
 * not save "5A" onto scene 66. The scene renumbering case is the
 * opposite and leaves the number alone — see `renumberForScene`.
 */
export async function updateRecord(
    exec: SqlExec, registry: Registry, entity: string, id: number,
    values: Record<string, SqlValue | undefined>): Promise<void> {
  const edef = entityDef(registry, entity);
  const fieldNames = edef.fields.map((f) => f.name);
  await withTransaction(exec, async () => {
    const written = { ...values };
    if (entity === "shot") {
      const target = written["scene_id"];
      if (target !== null && target !== undefined && target !== "") {
        const renumbered = await renumberForScene(exec, id, Number(target));
        if (renumbered !== null) written["shot_number"] = renumbered;
      }
    }
    const sets = fieldNames.map((f) => `${q(f)} = ?`).join(", ");
    const vals: SqlValue[] = fieldNames.map((f) => written[f] ?? null);
    await exec(
      `UPDATE ${q(entity)} SET ${sets}, updated_at = datetime('now') ` +
      "WHERE id = ?", [...vals, id]);
  });
}

/**
 * Delete a row and return what is needed to put it back (null when the
 * row did not exist).
 *
 * An act or sequence is anchored to a START SCENE, so deleting that
 * scene would leave the span pointing at nothing: the row is not
 * deleted, it just stops appearing in the structure, and every scene it
 * held falls out of any act. Same answer as moving the anchor scene —
 * hand the boundary to whatever now sits where the old one did.
 */
export async function deleteRecord(
    exec: SqlExec, registry: Registry, entity: string,
    id: number): Promise<UndoEntry | null> {
  return withTransaction(exec, async () => {
    const existing = await exec(
      `SELECT * FROM ${q(entity)} WHERE id = ?`, [id]);
    const undo = await captureForUndo(
      exec, registry, entity, id,
      existing[0] === undefined
        ? entity : rowLabel(registry.entities.get(entity), entity,
                            existing[0]));
    if (entity === "scene") {
      const headings = await exec(
        "SELECT scene_id FROM screenplay_lines " +
        "WHERE line_type = 'heading' AND scene_id IS NOT NULL " +
        "ORDER BY line_order");
      const order: number[] = [];
      for (const row of headings) {
        const sceneId = Number(row["scene_id"]);
        if (!order.includes(sceneId)) order.push(sceneId);
      }
      await reanchorSpansForMove(exec, id, order);
    }
    await exec(`DELETE FROM ${q(entity)} WHERE id = ?`, [id]);
    return undo;
  });
}

// ── batches ────────────────────────────────────────────────────────

/** A reference to a row created earlier in the same batch. */
export interface BatchRef { $ref: string }

export type BatchValue = SqlValue | BatchRef;

/**
 * One write in a batch. A create may name its row (`ref`) so that later
 * creates and updates can point at it with `{ $ref }` before it has an
 * id; update and delete address rows that already exist.
 */
export type BatchOp =
  | { kind: "create"; entity: string; ref?: string; uuid?: string;
      values: Record<string, BatchValue> }
  | { kind: "update"; entity: string; id: number;
      values: Record<string, BatchValue> }
  | { kind: "delete"; entity: string; id: number };

/** What a batch did, one entry per op, in order. */
export interface BatchOutcome {
  kind: BatchOp["kind"];
  entity: string;
  id: number;
  ref?: string;
  /** For a create: the new row's uuid. */
  uuid?: string;
}

export const isBatchRef = (v: unknown): v is BatchRef =>
  typeof v === "object" && v !== null && !Array.isArray(v) &&
  typeof (v as Record<string, unknown>)["$ref"] === "string" &&
  Object.keys(v).length === 1;

/**
 * Run several record writes as ONE transaction: all of them, or none
 * (proposal 0043). Each runs through the same function its single-row
 * op does, so a batch and a button cannot disagree about a write.
 *
 * Every op runs on a savepoint connection of its own name, so the
 * per-connection transaction queue in `withTransaction` sees a different
 * key and does not wait on the batch that holds it.
 */
export async function applyBatch(
    exec: SqlExec, registry: Registry,
    ops: readonly BatchOp[]): Promise<BatchOutcome[]> {
  return withTransaction(exec, async () => {
    const inner = savepointExec(exec, "batch");
    const made = new Map<string, number>();
    const resolve = (values: Record<string, BatchValue>,
                     at: number): Record<string, SqlValue> => {
      const out: Record<string, SqlValue> = {};
      for (const [k, v] of Object.entries(values)) {
        if (isBatchRef(v)) {
          const id = made.get(v.$ref);
          if (id === undefined) {
            throw new Error(`op ${String(at + 1)}: ${k} refers to ` +
                            `"${v.$ref}", which no earlier create names`);
          }
          out[k] = id;
        } else {
          out[k] = v;
        }
      }
      return out;
    };
    const outcomes: BatchOutcome[] = [];
    for (const [at, op] of ops.entries()) {
      switch (op.kind) {
        case "create": {
          if (op.ref !== undefined && made.has(op.ref)) {
            throw new Error(`op ${String(at + 1)}: ref "${op.ref}" is ` +
                            "already used in this batch");
          }
          const id = await createRecord(
            inner, registry, op.entity, resolve(op.values, at), op.uuid);
          const row = await inner(
            `SELECT uuid FROM ${q(op.entity)} WHERE id = ?`, [id]);
          if (op.ref !== undefined) made.set(op.ref, id);
          outcomes.push({
            kind: "create", entity: op.entity, id,
            ...(op.ref === undefined ? {} : { ref: op.ref }),
            uuid: String(row[0]?.["uuid"]),
          });
          break;
        }
        case "update":
          await updateRecord(
            inner, registry, op.entity, op.id, resolve(op.values, at));
          outcomes.push({ kind: "update", entity: op.entity, id: op.id });
          break;
        case "delete":
          await deleteRecord(inner, registry, op.entity, op.id);
          outcomes.push({ kind: "delete", entity: op.entity, id: op.id });
          break;
      }
    }
    return outcomes;
  });
}
