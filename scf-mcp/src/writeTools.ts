// SPDX-License-Identifier: Apache-2.0
/**
 * writeTools.ts — the tools that change a film, and the rules they keep.
 *
 * A tool writes with no person watching, so none of these changes
 * anything on the first call. Each is PLAN, then CONFIRM, then APPLY:
 *
 *  1. Called as it stands, a tool does a dry run. It reads the rows it
 *     would touch, validates the arguments against the op table, asks
 *     the host to run the write and roll it back (so the integrity
 *     findings it would add are known, not guessed), and returns a PLAN:
 *     the exact changes, field by field, the risks, and a `planId`. The
 *     plan is deterministic — the same film and the same arguments give
 *     the same plan — and nothing has changed.
 *  2. The plan is shown to the person, who decides.
 *  3. Called again with `confirm` set to that `planId`, the tool plans
 *     AGAIN against the film as it is now. If the new plan is not the
 *     one that was approved — someone edited a row, the revision moved —
 *     it applies nothing and returns the new plan. Only an identical
 *     plan is applied, and it is applied with the revision it was
 *     planned at, so the host refuses it if the film moved in between.
 *
 * Where the client can ask the person itself (MCP elicitation), apply
 * does that too, so approval does not rest on the agent's word that it
 * asked.
 *
 * The host holds the lines the tools cannot talk their way past: a
 * snapshot of the file before an agent's first write, a refusal of any
 * write that would add an integrity finding, an expected-revision check,
 * and a journal that records which client made each change.
 *
 * Every tool takes UUIDs, as the read tools do. A reference field is
 * given as the target's uuid; the tool turns it into the row id the
 * schema stores.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  TITLE_KEYS, getOp, nextShotNumber, polymorphicTarget, readMeta, rowLabel,
  rowsIncludingCut, titleSlot, validateArgs, whereUsed,
  type EntityDef, type FieldDef, type Row, type ScfContext, type SqlValue,
} from "@minimalhumans/scf-core";
import { HostClientError } from "@minimalhumans/scf-host/client";
import {
  registry, type OpenProject, type ProjectCache,
} from "./projectCache.ts";
import { err, ok } from "./toolResult.ts";

// ── the shape of a plan ────────────────────────────────────────────

export interface FieldChange {
  field: string;
  from: SqlValue | undefined;
  to: SqlValue;
}

export interface Change {
  kind: "create" | "update" | "delete" | "reorder";
  entity: string;
  /** The row's uuid; absent for a row that does not exist yet. */
  uuid?: string;
  /** A name a person would recognise it by. */
  label: string;
  fields?: FieldChange[];
  /** For a reorder: the order before and after, by label. */
  order?: { before: string[]; after: string[] };
}

/** A row a plan reads or writes. */
interface RowKey { entity: string; id: number }

type OpCall = { name: string; args: Record<string, unknown> };

/** What a tool decides; the machinery adds the rest. */
interface Draft {
  summary: string;
  changes: Change[];
  risks: string[];
  /** The host op to run; null when there is nothing to do. */
  op: OpCall | null;
  /**
   * The existing rows this plan reads or writes. When given, the plan is
   * bound to THEM and not to the film's revision (proposal 0043): it
   * goes stale only when one of these rows changes, so two approved
   * plans about different rows can both be applied.
   */
  reads?: RowKey[];
  /** Overrides the op's own flag: a batch with no delete is not. */
  destructive?: boolean;
  /**
   * What the response shows as `op` unless `verbose`: the changed fields
   * only. The planId is still computed over `op`, the full call.
   */
  shown?: OpCall | null;
}

export interface Plan extends Draft {
  tool: string;
  film: string;
  /**
   * The revision this plan was made at, and will be applied at. Whether
   * it decides staleness is `scope`'s to say.
   */
  basedOn: number;
  /**
   * "rows": stale only when a row in `reads` changes (create, update,
   * delete, batch). "film": stale when anything in the film changes
   * (the tools that renumber or reorder around the row they address).
   */
  scope: "rows" | "film";
  /** For scope "rows": a digest of the rows in `reads` as they are now. */
  readsDigest?: string;
  /**
   * `wouldAdd`: blocking findings the host says this write would add.
   * `noted`: questions it raises without being refused — a scene link for
   * someone with no cue there, which is often right (spec §2.4.1).
   */
  integrity: { wouldAdd: string[]; noted: string[] };
  /** True when applying would be refused (it would add blocking
   *  findings). A noted question never sets it. */
  blocked: boolean;
  destructive: boolean;
  planId: string;
}

/** JSON with sorted keys, so the same plan always hashes the same. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export async function planIdOf(
    plan: Omit<Plan, "planId">): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(canonical({
      tool: plan.tool, film: plan.film,
      // A row-scoped plan is the same plan at any revision, as long as
      // the rows it touches are as they were (proposal 0043).
      ...(plan.scope === "film"
        ? { basedOn: plan.basedOn } : { reads: plan.readsDigest }),
      op: plan.op, changes: plan.changes, risks: plan.risks,
      blocked: plan.blocked,
    })));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
}

// ── reading the rows a plan is about ───────────────────────────────

function entityDef(entity: string): EntityDef {
  const e = registry.entities.get(entity);
  if (e === undefined) {
    throw new Error(`unknown entity type "${entity}". Known: ${
      [...registry.entities.keys()].sort().join(", ")}`);
  }
  return e;
}

async function rowByUuid(
    ctx: ScfContext, entity: string, uuid: string): Promise<Row> {
  entityDef(entity);
  const row = (await rowsIncludingCut(ctx.exec, entity, "uuid = ?", [uuid]))[0];
  if (row === undefined) throw new Error(`no ${entity} with uuid ${uuid}`);
  return row;
}

const labelOf = (entity: string, row: Row): string =>
  rowLabel(registry.entities.get(entity), entity, row);

/** A reference to a row an earlier create in the same batch makes. */
interface BatchRef { $ref: string }

/** A value as the op carries it. */
type Stored = SqlValue | BatchRef;

const isRef = (v: unknown): v is BatchRef =>
  typeof v === "object" && v !== null && "$ref" in v;

/** How a value reads in a plan: a batch reference as "$name". */
const shownValue = (v: Stored): SqlValue => isRef(v) ? `$${v.$ref}` : v;

/** Where a write is planned: inside a batch, and what it reads. */
interface Within {
  /** The refs earlier creates in the batch declared, to their entity. */
  refs?: ReadonlyMap<string, string>;
  /** Collects the existing rows the write's references resolve to. */
  reads?: RowKey[];
}

const UUID_LIKE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Turn what the caller wrote into what the schema stores, refusing what
 * it would silently lose: an unknown field, a value outside a closed
 * vocabulary, a reference to nothing.
 *
 * A polymorphic reference (§12.1.2) is resolved too: the table it points
 * into is read from its `polymorphicType` sibling — in this call's values,
 * else on the row being updated (`existing`) — through
 * `polymorphicTarget`. These were once passed through untouched, so a
 * uuid given for `asset_relationship.entity_id` was stored as TEXT
 * in an integer column: a link to nothing that no gate reported.
 */
async function normalise(
    ctx: ScfContext, edef: EntityDef,
    input: Record<string, Value>,
    existing?: Row,
    within: Within = {},
): Promise<Record<string, Stored>> {
  const byName = new Map(edef.fields.map((f) => [f.name, f]));
  const out: Record<string, Stored> = {};
  for (const [name, raw] of Object.entries(input)) {
    const field = byName.get(name);
    if (field === undefined) {
      throw new Error(
        `${edef.name} has no field "${name}". Fields: ${
          [...byName.keys()].join(", ")}`);
    }
    const isReference = field.referenceEntity !== undefined ||
      field.polymorphicType !== undefined;
    const targetOf = (): string | undefined =>
      field.polymorphicType === undefined
        ? field.referenceEntity
        : polymorphicTargetOf(edef, field, input, existing);
    // "$name" in a reference field: a row an earlier create in the same
    // batch makes (proposal 0043). No reference column holds a string
    // that starts with "$", so the marker cannot be mistaken.
    if (within.refs !== undefined && isReference &&
        typeof raw === "string" && raw.startsWith("$")) {
      const ref = raw.slice(1);
      const refEntity = within.refs.get(ref);
      if (refEntity === undefined) {
        throw new Error(`${name}: "${raw}" names no earlier create in ` +
                        "this batch (give it `ref` there)");
      }
      const target = targetOf();
      if (target !== refEntity) {
        throw new Error(`${name}: "${raw}" is a ${refEntity}, and ${
          edef.name}.${name} points at ${target ?? "nothing"} here`);
      }
      out[name] = { $ref: ref };
      continue;
    }
    let value: SqlValue = toStored(field, raw);
    const targetEntity = targetOf();
    if (value !== null && targetEntity !== undefined &&
        typeof value === "string" && UUID_LIKE.test(value)) {
      const target = (await rowsIncludingCut(
        ctx.exec, targetEntity, "uuid = ?", [value]))[0];
      if (target === undefined) {
        throw new Error(`${name}: no ${targetEntity} with uuid ${value}`);
      }
      value = Number(target["id"]);
      within.reads?.push({ entity: targetEntity, id: value });
    } else if (typeof value === "string" && value !== "" &&
               (field.referenceEntity !== undefined ||
                field.polymorphicType !== undefined) &&
               !/^\d+$/.test(value)) {
      // Anything else written into a reference column would be stored as
      // given and point at nothing.
      throw new Error(`${name}: give the target's uuid, not "${value}"`);
    }
    assertInVocabulary(field, value);
    out[name] = value;
  }
  return out;
}

/**
 * The table a polymorphic column points into for this write, or throws
 * when the sibling naming it is unset or names a kind the column does not
 * cover — a uuid cannot be resolved without knowing where to look.
 */
function polymorphicTargetOf(
    edef: EntityDef, field: FieldDef,
    input: Record<string, Value>,
    existing: Row | undefined): string {
  const sibling = field.polymorphicType!;
  const kind = sibling in input ? input[sibling] : existing?.[sibling];
  if (kind === null || kind === undefined || kind === "") {
    throw new Error(
      `${field.name}: set ${sibling} too, so the uuid can be resolved`);
  }
  const target = polymorphicTarget(field, String(kind));
  if (target === null || !registry.entities.has(target)) {
    throw new Error(
      `${field.name}: ${sibling} "${String(kind)}" names no entity type ` +
      `${edef.name}.${field.name} can point into`);
  }
  return target;
}

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

/** JSON text, parsed, or undefined when it is not JSON. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * What the caller gave, in the shape the field's `fieldType` stores, or
 * a refusal when the two disagree. The transport accepts any JSON value
 * (arrays and objects included); it is the registry, here, that decides
 * whether this field can hold it — a string where a list belongs would
 * otherwise be stored as text no reader could take for a list.
 *
 * - `string_list` (spec §2.5): an array of strings, stored as its JSON
 *   text; `[]` is nothing. JSON text already holding such an array is
 *   accepted as it is.
 * - `json`: an array or object, stored as its JSON text; a string must
 *   already be JSON text.
 * - `multiselect`: an array of strings, stored as the comma-separated
 *   text the editor writes; a string is taken as that text.
 * - `integer` / `float`: a number, or a string that is one.
 * - `boolean`: true/false, or 1/0.
 * - a reference: a uuid or an id, resolved by `normalise`.
 * - every other field holds one value: an array or object is refused.
 */
function toStored(field: FieldDef, raw: Value): SqlValue {
  if (raw === null) return null;
  const refuse = (want: string): never => {
    throw new Error(
      `${field.name} is a ${field.fieldType} field and takes ${want}, ` +
      `not ${JSON.stringify(raw)}`);
  };
  const structured = typeof raw === "object";
  // A reference — a polymorphic one's column is typed `integer` — takes
  // a uuid or an id; `normalise` resolves it. It holds one value.
  if (field.referenceEntity !== undefined ||
      field.polymorphicType !== undefined) {
    if (structured) refuse("a uuid");
    return raw as SqlValue;
  }
  switch (field.fieldType) {
    case "string_list": {
      const list = typeof raw === "string" ? parseJson(raw) : raw;
      if (!isStringArray(list)) {
        refuse(`an array of strings, e.g. ${
          JSON.stringify([typeof raw === "string" ? raw : "value"])}`);
      }
      return (list as string[]).length === 0 ? null : JSON.stringify(list);
    }
    case "json": {
      if (structured) return JSON.stringify(raw);
      if (typeof raw === "string" &&
          (raw === "" || parseJson(raw) !== undefined)) return raw;
      return refuse("an array or object (or its JSON text)");
    }
    case "multiselect": {
      if (isStringArray(raw)) return raw.length === 0 ? null : raw.join(", ");
      if (typeof raw === "string") return raw;
      return refuse("an array of strings, or comma-separated text");
    }
    case "integer":
    case "float": {
      const n = typeof raw === "number" ? raw
        : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
      if (!Number.isFinite(n) ||
          (field.fieldType === "integer" && !Number.isInteger(n))) {
        refuse(field.fieldType === "integer" ? "a whole number" : "a number");
      }
      return n;
    }
    case "boolean": {
      if (typeof raw === "boolean") return raw ? 1 : 0;
      if (raw === 0 || raw === 1) return raw;
      return refuse("true or false");
    }
    default: {
      if (structured) refuse("a single value");
      return typeof raw === "boolean" ? (raw ? 1 : 0) : raw as SqlValue;
    }
  }
}

function assertInVocabulary(field: FieldDef, value: SqlValue): void {
  if (value === null || value === "" || field.options === undefined ||
      field.options.length === 0 || field.open === true) return;
  // A multiselect holds several values, comma-separated: each is checked.
  const values = field.fieldType === "multiselect"
    ? String(value).split(",").map((v) => v.trim()).filter((v) => v !== "")
    : [String(value)];
  for (const v of values) {
    if (!field.options.includes(v)) {
      throw new Error(
        `${field.name}: "${v}" is not one of ${field.options.join(", ")}`);
    }
  }
}

const same = (a: SqlValue | undefined, b: SqlValue | undefined): boolean =>
  String(a ?? "") === String(b ?? "");

// ── the machinery ──────────────────────────────────────────────────

/** A message an agent can act on, for the host's refusals. */
function explain(e: unknown): Error {
  if (!(e instanceof HostClientError)) {
    return e instanceof Error ? e : new Error(String(e));
  }
  switch (e.code) {
    case "stale_revision":
      return new Error(
        "The film changed after this plan was made, so nothing was " +
        "written. Call the tool again without `confirm` for a fresh plan.");
    case "integrity_gate":
      return new Error(
        `Refused: ${e.message}. Nothing was written. Fix the cause (for ` +
        "instance by pointing the reference at a row that exists) and " +
        "plan again.");
    case "external_change":
      return new Error(
        "The file was changed by another program while it was open, so " +
        "nothing was written. Open it again in the SCF editor to reload " +
        "it, then plan again.");
    case "read_only":
      return new Error("This server is read-only; nothing can be written.");
    default:
      return new Error(e.message);
  }
}

/** A film written by an older schema is upgraded by the editor, not here. */
async function requireCurrentSchema(p: OpenProject): Promise<void> {
  let meta: Record<string, string>;
  try {
    meta = await readMeta(p.ctx.exec);
  } catch {
    throw new Error(
      "this does not look like an SCF file (it has no metadata)");
  }
  if (meta["schema_version"] !== registry.schemaVersion) {
    throw new Error(
      `this film is schema ${meta["schema_version"] ?? "unknown"} and the ` +
      `tools write schema ${registry.schemaVersion}. Open it once in the ` +
      "SCF editor to upgrade it, then try again.");
  }
}

/** The rows a plan touches, as they are now, hashed. */
async function digestRows(p: OpenProject, keys: RowKey[]): Promise<string> {
  const seen = new Set<string>();
  const rows: unknown[] = [];
  for (const k of keys) {
    const tag = `${k.entity}:${String(k.id)}`;
    if (seen.has(tag)) continue;
    seen.add(tag);
    const row = (await rowsIncludingCut(
      p.ctx.exec, k.entity, "id = ?", [k.id]))[0] ?? null;
    rows.push([tag, row]);
  }
  const digest = await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(canonical(rows)));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
}

/**
 * A plan as a response shows it: the slim op unless `verbose`. `reads`
 * is bookkeeping for staleness (its digest is what counts), so it is not
 * shown; `readsDigest` and `scope` say all an agent needs.
 */
function present(plan: Plan, verbose: boolean):
    Omit<Plan, "shown" | "reads"> {
  const { shown, reads: _reads, ...rest } = plan;
  return verbose || shown === undefined ? rest : { ...rest, op: shown };
}

async function makePlan(
    p: OpenProject, tool: string, draft: Draft): Promise<Plan> {
  let wouldAdd: string[] = [];
  let noted: string[] = [];
  let destructive = false;
  if (draft.op !== null) {
    // Validated here, as the host would, so a bad argument is a plan-time
    // error and not a surprise at apply.
    const op = getOp(draft.op.name);
    validateArgs(op.args, draft.op.args);
    destructive = draft.destructive ?? op.destructive;
    // The host runs it and rolls it back: what it would add is known.
    const dry = await p.host.op(draft.op.name, draft.op.args, {
      dryRun: true, expectedRevision: p.revision,
    }).catch((e: unknown) => { throw explain(e); });
    wouldAdd = (dry.dryRun?.added ?? []).map((f) => f.description).sort();
    noted = (dry.dryRun?.noted ?? []).map((f) => f.description).sort();
  }
  const risks = [...draft.risks];
  if (destructive) {
    risks.unshift("This deletes data. It can be restored only from the " +
                  "snapshot the host takes before the first agent change.");
  }
  if (wouldAdd.length > 0) {
    risks.push(`Would add integrity findings: ${wouldAdd.join("; ")}`);
  }
  if (noted.length > 0) {
    // One line however many there are: a pass that links a silent
    // character to thirty scenes should not bury the other risks.
    risks.push(
      "Linked without a cue in the script. That is right for someone " +
      "present and silent, and wrong for someone who is not there; " +
      `confirm which: ${noted.join("; ")}`);
  }
  const scoped = draft.reads !== undefined;
  const base: Omit<Plan, "planId"> = {
    ...draft, risks, tool, film: p.scfPath, basedOn: p.revision,
    scope: scoped ? "rows" : "film",
    ...(scoped ? { readsDigest: await digestRows(p, draft.reads!) } : {}),
    integrity: { wouldAdd, noted }, blocked: wouldAdd.length > 0,
    destructive,
  };
  return { ...base, planId: await planIdOf(base) };
}

interface Applied {
  status: "applied";
  summary: string;
  changes: Change[];
  revision: number;
  snapshot?: string;
  by: string;
  result: unknown;
}

/** Ask the person directly, where the client lets a server do that. */
async function personApproves(
    server: McpServer, plan: Plan, elicit: boolean): Promise<boolean> {
  if (!elicit) return true;
  if (server.server.getClientCapabilities()?.elicitation === undefined) {
    return true;                       // the planId is the confirmation
  }
  const answer = await server.server.elicitInput({
    message: `${plan.summary}${plan.destructive ? " (this deletes data)" : ""}`,
    requestedSchema: {
      type: "object",
      properties: {
        apply: { type: "boolean", title: "Apply this change?",
                 default: false },
      },
      required: ["apply"],
    },
  });
  return answer.action === "accept" && answer.content?.["apply"] === true;
}

/**
 * `A` is the shape of the arguments as the zod schema describes them;
 * the schema is what validates them at runtime, and each tool annotates
 * `A` beside it.
 */
function register<A extends object>(
    on: WriteToolsOn, name: string, description: string,
    shape: z.ZodRawShape,
    build: (p: OpenProject, input: A) => Promise<Draft>,
): void {
  const { server, cache } = on;
  server.registerTool(name, {
    description:
      `${description}\n\nThis tool CHANGES the film, so it works in two ` +
      "steps. Called as it stands it only PLANS: it changes nothing and " +
      "returns the exact changes, the risks and a `planId`. Show the " +
      "plan to the person you are working with and wait for their " +
      "approval. Then call the tool again with the same arguments plus " +
      "`confirm` set to that `planId`: it re-checks the film, and " +
      "applies the change only if the plan is unchanged.",
    inputSchema: {
      ...shape,
      confirm: z.string().optional().describe(
        "The `planId` of a plan the person has approved. Omit to plan."),
      verbose: z.boolean().optional().describe(
        "Show the full op in the plan (every field an update writes " +
        "back), not only the fields that change."),
    },
  }, async (input) => {
    try {
      const { confirm, verbose = false, ...args } =
        input as { confirm?: string; verbose?: boolean } & A;
      return ok(await cache.withProject(async (p) => {
        if (p.readOnly) throw new Error("this film was opened read-only");
        await requireCurrentSchema(p);
        const full = await makePlan(
          p, name, await build(p, args as unknown as A));
        const plan = present(full, verbose);

        if (confirm === undefined) {
          return {
            status: "planned" as const, plan,
            next: plan.op === null
              ? "There is nothing to do."
              : plan.blocked
                ? "This would be refused as it stands; change the " +
                  "request."
                : `Show this plan to the user. If they approve, call ` +
                  `${name} again with the same arguments and confirm: ` +
                  `"${plan.planId}".`,
          };
        }
        if (plan.op === null) {
          return { status: "nothing_to_do" as const, plan };
        }
        if (confirm !== full.planId) {
          return {
            status: "plan_changed" as const, plan,
            message: "The film or the request is no longer what the " +
              "approved plan described, so nothing was written. This is " +
              "the current plan; it needs approving again.",
          };
        }
        if (plan.blocked) {
          throw new Error("this change would add integrity findings, so " +
                          "it is not applied");
        }
        if (!await personApproves(server, plan, on.elicit)) {
          return { status: "declined" as const, plan };
        }
        const written = await p.host.op(full.op!.name, full.op!.args, {
          expectedRevision: plan.basedOn, integrityGate: true,
        }).catch((e: unknown) => { throw explain(e); });
        const done: Applied = {
          status: "applied", summary: plan.summary, changes: plan.changes,
          revision: written.revision,
          ...(written.snapshot === undefined
            ? {} : { snapshot: written.snapshot }),
          by: cache.agentName(), result: written.result,
        };
        return done;
      }));
    } catch (e) {
      return err(explain(e));
    }
  });
}

// ── the tools ──────────────────────────────────────────────────────

/**
 * Any JSON value. Whether a field can hold it is the registry's call,
 * made in `toStored` with a message that names the field — not the
 * transport's, which could only say "invalid input" (and once refused
 * every array, so `asset.tags` could not be written at all).
 */
type Value = string | number | boolean | null | unknown[] |
  { [k: string]: unknown };
const VALUE = z.union([
  z.string(), z.number(), z.boolean(), z.null(),
  z.array(z.unknown()), z.record(z.string(), z.unknown()),
]).describe(
  "A string, number, boolean or null; an array of strings for a " +
  "string_list or multiselect field (e.g. tags: [\"shot\"]); an array " +
  "or object for a json field.");
const VALUES = z.record(z.string(), VALUE);

/** What the write tools are registered on, and with. */
export interface WriteToolsOn {
  server: McpServer;
  cache: ProjectCache;
  /**
   * Ask the person through the client before applying, where it can
   * (SCF_MCP_ELICIT=0 turns this off, for tests).
   */
  elicit: boolean;
}

// ── one row's write, as a single tool or a batch op plans it ────────

/** One write in `record.batch`'s form. */
type BatchWrite =
  | { kind: "create"; entity: string; values: Record<string, Stored>;
      ref?: string; uuid?: string }
  | { kind: "update"; entity: string; id: number;
      values: Record<string, Stored> }
  | { kind: "delete"; entity: string; id: number };

/** What planning one write decides. */
interface Piece {
  summary: string;
  change: Change;
  risks: string[];
  /** Existing rows it reads or writes (proposal 0043). */
  reads: RowKey[];
  /** The write, in full. */
  write: BatchWrite;
  /** The write as a plan shows it: an update's changed fields only. */
  shown: BatchWrite;
}

const fieldChanges = (values: Record<string, Stored>): FieldChange[] =>
  Object.entries(values).filter(([, v]) => v !== null && v !== "")
    .map(([field, to]) => ({ field, from: undefined, to: shownValue(to) }));

async function planCreate(
    p: OpenProject, entityType: string, values: Record<string, Value>,
    opts: { refs?: ReadonlyMap<string, string>; ref?: string;
            uuid?: string } = {}): Promise<Piece> {
  const edef = entityDef(entityType);
  const reads: RowKey[] = [];
  const clean = await normalise(p.ctx, edef, values, undefined,
    { ...(opts.refs === undefined ? {} : { refs: opts.refs }), reads });
  if (opts.uuid !== undefined) {
    if (!UUID_LIKE.test(opts.uuid)) {
      throw new Error(`uuid: "${opts.uuid}" is not a uuid`);
    }
    const taken = (await rowsIncludingCut(
      p.ctx.exec, entityType, "uuid = ?", [opts.uuid]))[0];
    if (taken !== undefined) {
      throw new Error(`uuid: a ${entityType} already has ${opts.uuid}`);
    }
  }
  const named = clean[edef.nameField];
  const label = named === undefined || isRef(named)
    ? `new ${entityType}` : String(named);
  const write: BatchWrite = {
    kind: "create", entity: entityType, values: clean,
    ...(opts.ref === undefined ? {} : { ref: opts.ref }),
    ...(opts.uuid === undefined ? {} : { uuid: opts.uuid }),
  };
  return {
    summary: `Create ${entityType} "${label}"`,
    change: { kind: "create", entity: entityType, label,
              ...(opts.uuid === undefined ? {} : { uuid: opts.uuid }),
              fields: fieldChanges(clean) },
    risks: [], reads, write, shown: write,
  };
}

/** Null when the row already has those values. */
async function planUpdate(
    p: OpenProject, entityType: string, uuid: string,
    values: Record<string, Value>,
    opts: { refs?: ReadonlyMap<string, string> } = {}):
    Promise<Piece | null> {
  const edef = entityDef(entityType);
  const row = await rowByUuid(p.ctx, entityType, uuid);
  const id = Number(row["id"]);
  const reads: RowKey[] = [{ entity: entityType, id }];
  const patch = await normalise(p.ctx, edef, values, row,
    { ...(opts.refs === undefined ? {} : { refs: opts.refs }), reads });
  const changed = Object.entries(patch)
    .filter(([f, to]) => isRef(to) || !same(row[f], to));
  if (changed.length === 0) return null;
  // The op writes every registry field, so the untouched ones are sent
  // back as they are.
  const merged: Record<string, Stored> = {};
  for (const f of edef.fields) merged[f.name] = row[f.name] ?? null;
  for (const [f, to] of changed) merged[f] = to;
  const label = labelOf(entityType, row);
  return {
    summary: `Change ${entityType} "${label}": ${
      changed.map(([f]) => f).join(", ")}`,
    change: { kind: "update", entity: entityType, uuid, label,
              fields: changed.map(([field, to]) =>
                ({ field, from: row[field], to: shownValue(to) })) },
    risks: [], reads,
    write: { kind: "update", entity: entityType, id, values: merged },
    shown: { kind: "update", entity: entityType, id,
             values: Object.fromEntries(changed) },
  };
}

async function planDelete(
    p: OpenProject, entityType: string, uuid: string): Promise<Piece> {
  const row = await rowByUuid(p.ctx, entityType, uuid);
  const id = Number(row["id"]);
  const label = labelOf(entityType, row);
  const usage = await whereUsed(p.ctx, entityType, uuid);
  const risks = usage.length === 0 ? [] : [
    `${String(usage.length)} row(s) point at it and will be left ` +
    `pointing at nothing: ${usage.slice(0, 10).map(
      (u) => `${u.entity} "${u.label}"`).join(", ")}${
      usage.length > 10 ? ", …" : ""}`,
  ];
  if (entityType === "scene") {
    risks.push("A scene's screenplay lines are not removed by this; " +
               "remove a scene with its script in the editor.");
  }
  const write: BatchWrite = { kind: "delete", entity: entityType, id };
  return {
    summary: `Delete ${entityType} "${label}"`,
    change: { kind: "delete", entity: entityType, uuid, label },
    risks, reads: [{ entity: entityType, id }], write, shown: write,
  };
}

/** A single-row piece as its own op (record.create/update/delete). */
function asOp(w: BatchWrite): OpCall {
  switch (w.kind) {
    case "create":
      return { name: "record.create", args: {
        entity: w.entity, values: w.values,
        ...(w.uuid === undefined ? {} : { uuid: w.uuid }) } };
    case "update":
      return { name: "record.update",
               args: { entity: w.entity, id: w.id, values: w.values } };
    case "delete":
      return { name: "record.delete", args: { entity: w.entity, id: w.id } };
  }
}

const single = (piece: Piece): Draft => ({
  summary: piece.summary, changes: [piece.change], risks: piece.risks,
  op: asOp(piece.write), shown: asOp(piece.shown), reads: piece.reads,
});

export function registerWriteTools(on: WriteToolsOn): void {
  register(on, "create_row",
    "Create one row of an entity type. Give the fields to set; unset " +
    "fields take their defaults. A reference field takes the target's " +
    "uuid. Unknown fields and values outside a closed vocabulary are " +
    "refused, not ignored. To create several rows, or a row and the " +
    "links to it, in one approval, use write_batch.",
    {
      entityType: z.string().describe(
        "Registry entity name, e.g. \"character\", \"scene\", \"prop\"."),
      values: VALUES.describe("Field name → value."),
      uuid: z.string().optional().describe(
        "The new row's uuid, if you want to name it yourself; it must " +
        "not be in use. Omit for a fresh one."),
    },
    async (p, { entityType, values, uuid }: {
      entityType: string; values: Record<string, Value>; uuid?: string }) =>
      single(await planCreate(p, entityType, values,
        uuid === undefined ? {} : { uuid })));

  register(on, "update_row",
    "Change some fields of one existing row, by uuid. Only the fields " +
    "you give change; the rest are kept. The plan shows each field's " +
    "current and new value. A reference field takes the target's uuid.",
    {
      entityType: z.string().describe("Registry entity name."),
      uuid: z.string().describe("The row's uuid, e.g. from find or list."),
      values: VALUES.describe("Only the fields to change."),
    },
    async (p, { entityType, uuid, values }: {
      entityType: string; uuid: string; values: Record<string, Value> }) => {
      const piece = await planUpdate(p, entityType, uuid, values);
      if (piece === null) {
        const row = await rowByUuid(p.ctx, entityType, uuid);
        return { summary: `${entityType} "${labelOf(entityType, row)}" ` +
                          "already has those values",
                 changes: [], risks: [], op: null,
                 reads: [{ entity: entityType, id: Number(row["id"]) }] };
      }
      return single(piece);
    });

  register(on, "delete_row",
    "Delete one row, by uuid. DESTRUCTIVE. The plan lists what points at " +
    "the row (it is left pointing at nothing) so the consequence is " +
    "visible before anything is removed.",
    {
      entityType: z.string().describe("Registry entity name."),
      uuid: z.string().describe("The row's uuid."),
    },
    async (p, { entityType, uuid }: { entityType: string; uuid: string }) =>
      single(await planDelete(p, entityType, uuid)));

  register(on, "write_batch",
    "Create, update and delete several rows, across entity types, as ONE " +
    "plan with ONE planId, applied in one transaction: every op is " +
    "written or none is. Use it whenever a task makes more than one " +
    "change, so the person approves the whole set once.\n\n" +
    "Each op is {op: \"create\", entityType, values, ref?, uuid?}, " +
    "{op: \"update\", entityType, uuid, values} or {op: \"delete\", " +
    "entityType, uuid}. Ops run in order and are checked exactly as " +
    "create_row, update_row and delete_row check them.\n\n" +
    "In-batch references: give a create a `ref` (any name), and a later " +
    "op can put \"$<ref>\" in a reference field to point at that new " +
    "row, e.g. create an asset with ref \"frame\", then an " +
    "asset_relationship with asset_id \"$frame\". The result lists each " +
    "created row's ref, id and uuid. An existing row may appear in only " +
    "one op.\n\n" +
    "Like the single-row tools, a batch plan goes stale only if a row it " +
    "reads or writes changes before it is confirmed; changes elsewhere " +
    "in the film do not invalidate it.",
    {
      ops: z.array(z.object({
        op: z.enum(["create", "update", "delete"]),
        entityType: z.string().describe("Registry entity name."),
        uuid: z.string().optional().describe(
          "update/delete: the row's uuid. create: an optional uuid for " +
          "the new row."),
        ref: z.string().optional().describe(
          "create only: a name later ops use as \"$name\" in a " +
          "reference field."),
        values: VALUES.optional().describe(
          "create/update: field name → value."),
      })).min(1).describe("The writes, in order."),
    },
    async (p, { ops }: { ops: Array<{
      op: "create" | "update" | "delete"; entityType: string;
      uuid?: string; ref?: string; values?: Record<string, Value> }> }) => {
      const refs = new Map<string, string>();
      const touched = new Set<string>();
      const pieces: Piece[] = [];
      const risks: string[] = [];
      for (const [i, o] of ops.entries()) {
        const where = `op ${String(i + 1)} (${o.op} ${o.entityType})`;
        try {
          if (o.op !== "create" && o.ref !== undefined) {
            throw new Error("only a create takes a ref");
          }
          if (o.op !== "delete" && o.values === undefined) {
            throw new Error("give values");
          }
          if (o.uuid !== undefined) {
            if (touched.has(o.uuid)) {
              throw new Error(`${o.uuid} is already in another op of ` +
                              "this batch");
            }
            touched.add(o.uuid);
          }
          let piece: Piece | null;
          if (o.op === "create") {
            if (o.ref !== undefined && (o.ref === "" || refs.has(o.ref))) {
              throw new Error(`ref "${o.ref}" is empty or already used`);
            }
            piece = await planCreate(p, o.entityType, o.values!, {
              refs, ...(o.ref === undefined ? {} : { ref: o.ref }),
              ...(o.uuid === undefined ? {} : { uuid: o.uuid }) });
            if (o.ref !== undefined) refs.set(o.ref, o.entityType);
          } else {
            if (o.uuid === undefined) throw new Error("give the row's uuid");
            piece = o.op === "update"
              ? await planUpdate(p, o.entityType, o.uuid, o.values!, { refs })
              : await planDelete(p, o.entityType, o.uuid);
          }
          if (piece === null) continue;      // already has those values
          pieces.push(piece);
          for (const r of piece.risks) risks.push(`${where}: ${r}`);
        } catch (e) {
          throw new Error(`${where}: ${
            e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (pieces.length === 0) {
        return { summary: "Every row already has those values",
                 changes: [], risks: [], op: null, reads: [] };
      }
      const listed = pieces.slice(0, 5).map((x) => x.summary).join("; ");
      return {
        summary: `${String(pieces.length)} change(s): ${listed}${
          pieces.length > 5 ? "; …" : ""}`,
        changes: pieces.map((x) => x.change),
        risks,
        op: { name: "record.batch",
              args: { ops: pieces.map((x) => x.write) } },
        shown: { name: "record.batch",
                 args: { ops: pieces.map((x) => x.shown) } },
        reads: pieces.flatMap((x) => x.reads),
        destructive: pieces.some((x) => x.write.kind === "delete"),
      };
    });

  register(on, "add_shot",
    "Add a shot to a scene, optionally under a story beat. It is " +
    "numbered after the scene's existing shots; the plan says which " +
    "number it will get.",
    {
      sceneUuid: z.string().describe("The scene's uuid."),
      beatUuid: z.string().optional().describe(
        "The story beat's uuid, if the shot belongs under one."),
    },
    async (p, { sceneUuid, beatUuid }: {
      sceneUuid: string; beatUuid?: string }) => {
      const scene = await rowByUuid(p.ctx, "scene", sceneUuid);
      const beat = beatUuid === undefined
        ? null : await rowByUuid(p.ctx, "story_beat", beatUuid);
      const siblings = await rowsIncludingCut(
        p.ctx.exec, "shot", "scene_id = ?", [Number(scene["id"])]);
      const number = nextShotNumber(
        (scene["scene_number"] ?? null) as string | number | null,
        siblings.map((s) => (s["shot_number"] ?? null) as string | null));
      return {
        summary: `Add shot ${number} to ${labelOf("scene", scene)}`,
        changes: [{
          kind: "create", entity: "shot", label: `shot ${number}`,
          fields: [
            { field: "shot_number", from: undefined, to: number },
            { field: "scene", from: undefined,
              to: labelOf("scene", scene) },
            ...(beat === null ? [] : [{
              field: "story_beat", from: undefined,
              to: labelOf("story_beat", beat) }]),
          ],
        }],
        risks: [],
        op: { name: "shot.add",
              args: { sceneId: Number(scene["id"]),
                      beatId: beat === null ? null : Number(beat["id"]) } },
      };
    });

  register(on, "set_shot_cut",
    "Cut a shot from the film, or put it back. A cut shot keeps its row, " +
    "its number and its media, and can be restored.",
    {
      shotUuid: z.string().describe("The shot's uuid."),
      cut: z.boolean().describe("true to cut, false to restore."),
    },
    async (p, { shotUuid, cut }: { shotUuid: string; cut: boolean }) => {
      const shot = await rowByUuid(p.ctx, "shot", shotUuid);
      const from = String(shot["lifecycle_status"] ?? "");
      const to = cut ? "cut" : "active";
      const label = labelOf("shot", shot);
      if ((from === "cut") === cut) {
        return { summary: `${label} is already ${cut ? "cut" : "in the film"}`,
                 changes: [], risks: [], op: null };
      }
      return {
        summary: `${cut ? "Cut" : "Restore"} ${label}`,
        changes: [{ kind: "update", entity: "shot", uuid: shotUuid, label,
                    fields: [{ field: "lifecycle_status", from, to }] }],
        risks: [],
        op: { name: "shot.setCut",
              args: { id: Number(shot["id"]), cut } },
      };
    });

  register(on, "move_shot",
    "Move a shot one place earlier or later in its scene's order. The " +
    "shot's NUMBER does not change — a crew holds paper with it — only " +
    "its position in the list.",
    {
      shotUuid: z.string().describe("The shot's uuid."),
      direction: z.enum(["earlier", "later"]),
    },
    async (p, { shotUuid, direction }: {
      shotUuid: string; direction: "earlier" | "later" }) => {
      const shot = await rowByUuid(p.ctx, "shot", shotUuid);
      const siblings = (await rowsIncludingCut(
        p.ctx.exec, "shot", "scene_id = ?", [Number(shot["scene_id"])]))
        .sort((a, b) => Number(a["shot_order"] ?? 0) -
                        Number(b["shot_order"] ?? 0) ||
                        Number(a["id"]) - Number(b["id"]));
      const i = siblings.findIndex((s) => s["id"] === shot["id"]);
      const j = direction === "earlier" ? i - 1 : i + 1;
      const label = labelOf("shot", shot);
      if (j < 0 || j >= siblings.length) {
        return { summary: `${label} is already ${
          direction === "earlier" ? "first" : "last"}`,
                 changes: [], risks: [], op: null };
      }
      const names = siblings.map((s) => labelOf("shot", s));
      const after = [...names];
      [after[i], after[j]] = [after[j]!, after[i]!];
      return {
        summary: `Move ${label} ${direction}`,
        changes: [{ kind: "reorder", entity: "shot", uuid: shotUuid, label,
                    order: { before: names, after } }],
        risks: [],
        op: { name: "shot.move",
              args: { id: Number(shot["id"]),
                      delta: direction === "earlier" ? -1 : 1 } },
      };
    });

  register(on, "set_title_page_key",
    "Set one key of the screenplay's title page (Title, Credit, Author, " +
    "Source, Draft date, Contact, Copyright, Notes). An empty value " +
    "removes the key.",
    {
      key: z.string().describe("The key, e.g. \"Author\"."),
      value: z.string().describe("The new value; empty removes the key."),
    },
    async (p, { key, value }: { key: string; value: string }) => {
      const stored = await p.ctx.exec(
        "SELECT id, key, value, sort_order FROM screenplay_title_page");
      const def = TITLE_KEYS.find((t) => [t.key, ...(t.aliases ?? [])]
        .some((n) => n.toLowerCase() === key.trim().toLowerCase()))
        ?? { key };
      const existing = titleSlot(stored, def);
      const from = existing === undefined
        ? undefined : String(existing["value"] ?? "");
      if ((from ?? "") === value) {
        return { summary: `${def.key} is already that`, changes: [],
                 risks: [], op: null };
      }
      const removing = value.trim() === "";
      return {
        summary: removing ? `Remove title-page ${def.key}`
          : `Set title-page ${def.key}`,
        changes: [{
          kind: removing ? "delete" : existing === undefined
            ? "create" : "update",
          entity: "screenplay_title_page", label: def.key,
          fields: [{ field: "value", from, to: value }],
        }],
        risks: [],
        op: { name: "titlePage.setKey", args: { key, value } },
      };
    });
}

/** Read-only: the host's record of who changed this film, and how. */
export function registerJournalTool(
    server: McpServer, cache: ProjectCache): void {
  server.registerTool("recent_changes", {
    description: "The most recent writes to the open film, newest last, " +
      "with which client made each — the editor window, or an MCP client " +
      "such as this one. Use it to see what changed since you last " +
      "looked, or to attribute a change you did not make.",
    inputSchema: {
      limit: z.number().int().min(1).max(200).optional().describe(
        "How many entries (default 50)."),
    },
  }, async ({ limit }) => {
    try {
      return ok(await cache.withProject(async (p) => ({
        film: p.scfPath, revision: p.revision,
        changes: await p.host.journal(limit),
      })));
    } catch (e) {
      return err(e);
    }
  });
}
