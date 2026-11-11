// SPDX-License-Identifier: Apache-2.0
/**
 * ops/opTable.ts — the named write operations a client may ask for.
 *
 * A client of the host (the window, the MCP, a script) never sends SQL
 * to change a file. It sends an intent — a name and plain-data
 * arguments — and the host looks the name up here, validates the
 * arguments, and runs the op against the session. One table serves
 * every client, so a tool and a button cannot disagree about what
 * "delete a scene" does.
 *
 * Nothing here touches a transport. `callOp` takes a `Session` and
 * plain data and returns plain data, so the same call works in-process,
 * over a socket, or through Tauri's `invoke()`.
 *
 * Arguments are described by a small schema rather than a library: the
 * same description validates a call and becomes the JSON Schema of an
 * MCP tool. Results must be JSON-serialisable.
 *
 * Ops registered here are the ones whose arguments are plain data. An
 * op that takes a live object (a media tile, an undo entry) is exposed
 * by adding a plain-data wrapper, not by loosening the schema.
 */

import type { SqlValue } from "../db.ts";
import type { Session } from "../session.ts";
export { StaleRevisionError } from "../session.ts";
import type { ScfContext } from "../resolution.ts";
import {
  applyBatch, createRecord, deleteRecord, isBatchRef, updateRecord,
  type BatchOp,
} from "./recordOps.ts";
import {
  addBeat, addShot, moveShotInScene, removeBeat, removeShot, setShotCut,
} from "./shootOps.ts";
import {
  dryRunThroughGate, withIntegrityGate, type GateFinding, type GateNote,
} from "./integrityGate.ts";
import { setTitleKey } from "./titlePageOps.ts";

// ── argument schema ────────────────────────────────────────────────

export type ArgType =
  | { kind: "integer" }
  | { kind: "string" }
  | { kind: "boolean" }
  | { kind: "ids" }
  | { kind: "values" }
  /** A list of record writes (proposal 0043); see `checkBatch`. */
  | { kind: "batch" };

export interface ArgSpec {
  type: ArgType;
  description: string;
  optional?: boolean;
  /** Accept `null` as a value (for an optional reference). */
  nullable?: boolean;
}

export type ArgsSpec = Readonly<Record<string, ArgSpec>>;

/** Thrown for a call that is malformed; never for a failed write. */
export class OpArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpArgumentError";
  }
}

export class UnknownOpError extends Error {
  constructor(name: string) {
    super(`unknown operation: ${name}`);
    this.name = "UnknownOpError";
  }
}

export interface OpDef {
  readonly name: string;
  readonly summary: string;
  /**
   * Removes data the caller cannot trivially get back. A client that
   * offers a confirm step (the MCP does) keys on this.
   */
  readonly destructive: boolean;
  readonly args: ArgsSpec;
  run(ctx: ScfContext, args: Record<string, unknown>): Promise<unknown>;
}

function isSqlValue(v: unknown): v is SqlValue {
  return v === null || typeof v === "string" || typeof v === "number" ||
    typeof v === "bigint";
}

function checkOne(name: string, spec: ArgSpec, v: unknown): unknown {
  if (v === null && spec.nullable === true) return null;
  const bad = (what: string): never => {
    throw new OpArgumentError(`${name}: expected ${what}`);
  };
  switch (spec.type.kind) {
    case "integer":
      return Number.isInteger(v) ? v : bad("an integer");
    case "string":
      return typeof v === "string" ? v : bad("a string");
    case "boolean":
      return typeof v === "boolean" ? v : bad("true or false");
    case "ids":
      return Array.isArray(v) && v.every((x) => Number.isInteger(x))
        ? v : bad("a list of integers");
    case "values": {
      if (typeof v !== "object" || v === null || Array.isArray(v)) {
        return bad("an object of field values");
      }
      for (const [k, x] of Object.entries(v)) {
        if (x !== undefined && !isSqlValue(x)) {
          bad(`a plain value for field ${k}`);
        }
      }
      return v;
    }
    case "batch":
      return checkBatch(name, v);
  }
}

const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A batch: a list of `{kind, entity, ...}`. A create takes `values` and
 * optionally `ref` and `uuid`; an update `id` and `values`; a delete
 * `id`. A value is a plain value or `{ $ref }`, naming a row an earlier
 * create in the batch made. Unknown keys are refused, as at top level.
 */
function checkBatch(name: string, v: unknown): BatchOp[] {
  if (!Array.isArray(v) || v.length === 0) {
    throw new OpArgumentError(`${name}: expected a non-empty list of ops`);
  }
  const refs = new Set<string>();
  return v.map((raw, i): BatchOp => {
    const at = `${name}[${String(i)}]`;
    const bad = (what: string): never => {
      throw new OpArgumentError(`${at}: ${what}`);
    };
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return bad("expected an object");
    }
    const o = raw as Record<string, unknown>;
    const allowed: Record<string, readonly string[]> = {
      create: ["kind", "entity", "values", "ref", "uuid"],
      update: ["kind", "entity", "id", "values"],
      delete: ["kind", "entity", "id"],
    };
    const kind = o["kind"];
    if (typeof kind !== "string" || !Object.hasOwn(allowed, kind)) {
      return bad("kind: expected create, update or delete");
    }
    for (const key of Object.keys(o)) {
      if (!allowed[kind]!.includes(key)) bad(`unknown key: ${key}`);
    }
    if (typeof o["entity"] !== "string") bad("entity: expected a string");
    const entity = o["entity"] as string;
    const values = (): Record<string, SqlValue | { $ref: string }> => {
      const vs = o["values"];
      if (typeof vs !== "object" || vs === null || Array.isArray(vs)) {
        return bad("values: expected an object of field values");
      }
      for (const [k, x] of Object.entries(vs)) {
        if (isBatchRef(x)) {
          if (!refs.has(x.$ref)) {
            bad(`values.${k}: "${x.$ref}" is not a ref an earlier ` +
                "create in this batch declares");
          }
        } else if (x !== undefined && !isSqlValue(x)) {
          bad(`values.${k}: expected a plain value or { $ref }`);
        }
      }
      return vs as Record<string, SqlValue | { $ref: string }>;
    };
    if (kind === "create") {
      const ref = o["ref"];
      const uuid = o["uuid"];
      if (ref !== undefined &&
          (typeof ref !== "string" || ref === "" || refs.has(ref))) {
        bad("ref: expected a name not already used in this batch");
      }
      if (uuid !== undefined &&
          (typeof uuid !== "string" || !UUID_SHAPE.test(uuid))) {
        bad("uuid: expected a uuid");
      }
      const vs = values();
      if (typeof ref === "string") refs.add(ref);
      return { kind, entity, values: vs,
               ...(typeof ref === "string" ? { ref } : {}),
               ...(typeof uuid === "string" ? { uuid } : {}) };
    }
    if (!Number.isInteger(o["id"])) bad("id: expected an integer");
    const id = o["id"] as number;
    return kind === "update"
      ? { kind, entity, id, values: values() }
      : { kind: "delete", entity, id };
  });
}

/**
 * Check `raw` against `spec`. Unknown names are rejected rather than
 * dropped: a misspelt argument that is silently ignored writes the wrong
 * thing and reports success.
 */
export function validateArgs(
    spec: ArgsSpec, raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new OpArgumentError("arguments must be an object");
  }
  const given = raw as Record<string, unknown>;
  for (const key of Object.keys(given)) {
    if (!Object.hasOwn(spec, key)) {
      throw new OpArgumentError(`unknown argument: ${key}`);
    }
  }
  const out: Record<string, unknown> = {};
  for (const [key, s] of Object.entries(spec)) {
    const v = given[key];
    if (v === undefined) {
      if (s.optional !== true) {
        throw new OpArgumentError(`missing argument: ${key}`);
      }
      continue;
    }
    out[key] = checkOne(key, s, v);
  }
  return out;
}

/** The JSON Schema of an op's arguments, for MCP tool listings. */
export function argsJsonSchema(op: OpDef): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, s] of Object.entries(op.args)) {
    const base: Record<string, unknown> = (() => {
      switch (s.type.kind) {
        case "integer": return { type: "integer" };
        case "string": return { type: "string" };
        case "boolean": return { type: "boolean" };
        case "ids": return { type: "array", items: { type: "integer" } };
        case "values": return {
          type: "object",
          additionalProperties: { type: ["string", "number", "null"] },
        };
        case "batch": {
          const value = { anyOf: [
            { type: ["string", "number", "null"] },
            { type: "object", properties: { $ref: { type: "string" } },
              required: ["$ref"], additionalProperties: false },
          ] };
          return {
            type: "array", minItems: 1,
            items: { type: "object", properties: {
              kind: { enum: ["create", "update", "delete"] },
              entity: { type: "string" }, id: { type: "integer" },
              ref: { type: "string" }, uuid: { type: "string" },
              values: { type: "object", additionalProperties: value },
            }, required: ["kind", "entity"], additionalProperties: false },
          };
        }
      }
    })();
    properties[key] = {
      ...base, description: s.description,
      ...(s.nullable === true && typeof base["type"] === "string"
        ? { type: [base["type"], "null"] } : {}),
    };
    if (s.optional !== true) required.push(key);
  }
  return { type: "object", properties, required,
           additionalProperties: false };
}

// ── the table ──────────────────────────────────────────────────────

const int = (description: string, extra: Partial<ArgSpec> = {}): ArgSpec =>
  ({ type: { kind: "integer" }, description, ...extra });
const str = (description: string, extra: Partial<ArgSpec> = {}): ArgSpec =>
  ({ type: { kind: "string" }, description, ...extra });

const ENTITY = str("Entity name from the registry, e.g. \"character\".");

function define(op: OpDef): OpDef {
  return op;
}

const OPS: readonly OpDef[] = [
  define({
    name: "record.create",
    summary: "Create one row and return its id.",
    destructive: false,
    args: {
      entity: ENTITY,
      values: { type: { kind: "values" },
                description: "Field values; unknown fields are ignored." },
      uuid: str("The new row's uuid, when the caller has one; otherwise " +
                "a fresh one is stamped.", { optional: true }),
    },
    run: (ctx, a) => {
      const uuid = a["uuid"] as string | undefined;
      if (uuid !== undefined && !UUID_SHAPE.test(uuid)) {
        throw new OpArgumentError("uuid: expected a uuid");
      }
      return createRecord(
        ctx.exec, ctx.registry, a["entity"] as string,
        a["values"] as Record<string, SqlValue>, uuid);
    },
  }),
  define({
    name: "record.batch",
    summary: "Create, update and delete several rows in one transaction: " +
             "all of them or none. A create may name its row (ref) for " +
             "later ops to point at as { $ref }.",
    // A batch may delete; whether this one does is the caller's to say.
    destructive: true,
    args: {
      ops: { type: { kind: "batch" },
             description: "The writes, in order. Each is {kind: create, " +
               "entity, values, ref?, uuid?}, {kind: update, entity, id, " +
               "values} (every field, as record.update) or {kind: delete, " +
               "entity, id}." },
    },
    run: (ctx, a) => applyBatch(ctx.exec, ctx.registry, a["ops"] as BatchOp[]),
  }),
  define({
    name: "record.update",
    summary: "Write every registry field of a row from the given values.",
    destructive: false,
    args: {
      entity: ENTITY, id: int("Row id."),
      values: { type: { kind: "values" },
                description: "All field values; a missing one is cleared." },
    },
    run: async (ctx, a) => {
      await updateRecord(
        ctx.exec, ctx.registry, a["entity"] as string, a["id"] as number,
        a["values"] as Record<string, SqlValue>);
      return null;
    },
  }),
  define({
    name: "record.delete",
    summary: "Delete a row. Returns what is needed to restore it.",
    destructive: true,
    args: { entity: ENTITY, id: int("Row id.") },
    run: (ctx, a) => deleteRecord(
      ctx.exec, ctx.registry, a["entity"] as string, a["id"] as number),
  }),
  define({
    name: "shot.add",
    summary: "Add a shot to a scene, numbered after its siblings.",
    destructive: false,
    args: {
      sceneId: int("Scene row id."),
      beatId: int("Story beat to attach it to.",
                  { optional: true, nullable: true }),
    },
    run: async (ctx, a) => {
      await addShot(ctx.exec, a["sceneId"] as number,
                    (a["beatId"] ?? null) as number | null);
      return null;
    },
  }),
  define({
    name: "shot.setCut",
    summary: "Cut a shot, or restore one. The row and its number are kept.",
    destructive: false,
    args: {
      id: int("Shot row id."),
      cut: { type: { kind: "boolean" }, description: "True to cut." },
    },
    run: async (ctx, a) => {
      await setShotCut(ctx.exec, a["id"] as number, a["cut"] as boolean);
      return null;
    },
  }),
  define({
    name: "shot.move",
    summary: "Move a shot one place up (-1) or down (1) in its scene.",
    destructive: false,
    args: {
      id: int("Shot row id."),
      delta: int("-1 for earlier, 1 for later."),
      hidden: { type: { kind: "ids" }, optional: true,
                description: "Shot ids to step over (e.g. cut shots)." },
    },
    run: async (ctx, a) => {
      const delta = a["delta"] as number;
      if (delta !== -1 && delta !== 1) {
        throw new OpArgumentError("delta: expected -1 or 1");
      }
      await moveShotInScene(ctx.exec, a["id"] as number, delta,
                            (a["hidden"] ?? []) as number[]);
      return null;
    },
  }),
  define({
    name: "shot.remove",
    summary: "Delete a shot.",
    destructive: true,
    args: { id: int("Shot row id.") },
    run: async (ctx, a) => {
      await removeShot(ctx.exec, a["id"] as number);
      return null;
    },
  }),
  define({
    name: "beat.add",
    summary: "Add a story beat to a scene.",
    destructive: false,
    args: { sceneId: int("Scene row id.") },
    run: async (ctx, a) => {
      await addBeat(ctx.exec, a["sceneId"] as number);
      return null;
    },
  }),
  define({
    name: "beat.remove",
    summary: "Delete a story beat. Its shots stay on the scene.",
    destructive: true,
    args: { id: int("Story beat row id.") },
    run: async (ctx, a) => {
      await removeBeat(ctx.exec, a["id"] as number);
      return null;
    },
  }),
  define({
    name: "titlePage.setKey",
    summary: "Set one title-page key; an empty value removes it.",
    destructive: false,
    args: {
      key: str("Title-page key, e.g. \"Author\"."),
      value: str("New value."),
    },
    run: async (ctx, a) => {
      await setTitleKey(ctx.exec, a["key"] as string, a["value"] as string);
      return null;
    },
  }),
];

const BY_NAME: ReadonlyMap<string, OpDef> =
  new Map(OPS.map((op) => [op.name, op]));

export function listOps(): readonly OpDef[] {
  return OPS;
}

export function getOp(name: string): OpDef {
  const op = BY_NAME.get(name);
  if (op === undefined) throw new UnknownOpError(name);
  return op;
}

export interface CallOptions {
  /**
   * The revision the caller last read. When given, the call is refused
   * if the session has moved on, so a client acting on stale reads
   * cannot overwrite a change it never saw.
   */
  expectedRevision?: number;
  /**
   * Refuse (and roll back) a write that adds a blocking integrity
   * finding the file did not already have. For callers with no person watching.
   */
  integrityGate?: boolean;
  /**
   * Run it, report what it would do, and roll it back: nothing changes
   * and the revision does not move.
   */
  dryRun?: boolean;
}

export interface OpResult {
  /** The op's return value (JSON-serialisable). */
  result: unknown;
  /** The session's revision after the write. */
  revision: number;
  /** For a dry run: the blocking findings the write would add, and the
   *  questions it would raise without being refused (`noted`). */
  dryRun?: { added: GateFinding[]; noted: GateNote[] };
}

/**
 * Run one named op against a session.
 *
 * Validation and the revision check happen before anything is written
 * (the check is in the session's write queue; see `Session.write`).
 */
export async function callOp(
    session: Session, name: string, rawArgs: unknown,
    options: CallOptions = {}): Promise<OpResult> {
  const op = getOp(name);
  const args = validateArgs(op.args, rawArgs ?? {});
  if (options.dryRun === true) {
    const dry = await session.write(
      (ctx) => dryRunThroughGate(ctx, (inner) => op.run(inner, args)),
      { counts: false,
        ...(options.expectedRevision === undefined
          ? {} : { expectedRevision: options.expectedRevision }) });
    return { result: dry.result ?? null, revision: session.revision,
             dryRun: { added: dry.added, noted: dry.noted } };
  }
  const result = await session.write(
    (ctx) => options.integrityGate === true
      ? withIntegrityGate(ctx, (inner) => op.run(inner, args))
      : op.run(ctx, args),
    options.expectedRevision === undefined
      ? {} : { expectedRevision: options.expectedRevision });
  return { result: result ?? null, revision: session.revision };
}
