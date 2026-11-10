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

/** What a tool decides; the machinery adds the rest. */
interface Draft {
  summary: string;
  changes: Change[];
  risks: string[];
  /** The host op to run; null when there is nothing to do. */
  op: { name: string; args: Record<string, unknown> } | null;
}

export interface Plan extends Draft {
  tool: string;
  film: string;
  /** The revision this plan was made at, and will be applied at. */
  basedOn: number;
  /** Integrity findings the host says this write would add. */
  integrity: { wouldAdd: string[] };
  /** True when applying would be refused (it would add findings). */
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
      tool: plan.tool, film: plan.film, basedOn: plan.basedOn,
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
    input: Record<string, string | number | boolean | null>,
    existing?: Row,
): Promise<Record<string, SqlValue>> {
  const byName = new Map(edef.fields.map((f) => [f.name, f]));
  const out: Record<string, SqlValue> = {};
  for (const [name, raw] of Object.entries(input)) {
    const field = byName.get(name);
    if (field === undefined) {
      throw new Error(
        `${edef.name} has no field "${name}". Fields: ${
          [...byName.keys()].join(", ")}`);
    }
    let value: SqlValue = typeof raw === "boolean" ? (raw ? 1 : 0) : raw;
    const targetEntity = field.polymorphicType === undefined
      ? field.referenceEntity
      : polymorphicTargetOf(edef, field, input, existing);
    if (value !== null && targetEntity !== undefined &&
        typeof value === "string" && UUID_LIKE.test(value)) {
      const target = (await rowsIncludingCut(
        ctx.exec, targetEntity, "uuid = ?", [value]))[0];
      if (target === undefined) {
        throw new Error(`${name}: no ${targetEntity} with uuid ${value}`);
      }
      value = Number(target["id"]);
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
    input: Record<string, string | number | boolean | null>,
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

function assertInVocabulary(field: FieldDef, value: SqlValue): void {
  if (value === null || value === "" || field.options === undefined ||
      field.options.length === 0 || field.open === true) return;
  if (!field.options.includes(String(value))) {
    throw new Error(
      `${field.name}: "${String(value)}" is not one of ${
        field.options.join(", ")}`);
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
        "instance by also adding the script line the link needs) and plan " +
        "again.");
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

async function makePlan(
    p: OpenProject, tool: string, draft: Draft): Promise<Plan> {
  let wouldAdd: string[] = [];
  let destructive = false;
  if (draft.op !== null) {
    // Validated here, as the host would, so a bad argument is a plan-time
    // error and not a surprise at apply.
    const op = getOp(draft.op.name);
    validateArgs(op.args, draft.op.args);
    destructive = op.destructive;
    // The host runs it and rolls it back: what it would add is known.
    const dry = await p.host.op(draft.op.name, draft.op.args, {
      dryRun: true, expectedRevision: p.revision,
    }).catch((e: unknown) => { throw explain(e); });
    wouldAdd = (dry.dryRun?.added ?? []).map((f) => f.description).sort();
  }
  const risks = [...draft.risks];
  if (destructive) {
    risks.unshift("This deletes data. It can be restored only from the " +
                  "snapshot the host takes before the first agent change.");
  }
  if (wouldAdd.length > 0) {
    risks.push(`Would add integrity findings: ${wouldAdd.join("; ")}`);
  }
  const base: Omit<Plan, "planId"> = {
    ...draft, risks, tool, film: p.scfPath, basedOn: p.revision,
    integrity: { wouldAdd }, blocked: wouldAdd.length > 0, destructive,
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
    },
  }, async (input) => {
    try {
      const { confirm, ...args } = input as { confirm?: string } & A;
      return ok(await cache.withProject(async (p) => {
        if (p.readOnly) throw new Error("this film was opened read-only");
        await requireCurrentSchema(p);
        const plan = await makePlan(
          p, name, await build(p, args as unknown as A));

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
        if (confirm !== plan.planId) {
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
        const written = await p.host.op(plan.op.name, plan.op.args, {
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

type Value = string | number | boolean | null;
const VALUE = z.union([z.string(), z.number(), z.boolean(), z.null()]);
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

export function registerWriteTools(on: WriteToolsOn): void {
  register(on, "create_row",
    "Create one row of an entity type. Give the fields to set; unset " +
    "fields take their defaults. A reference field takes the target's " +
    "uuid. Unknown fields and values outside a closed vocabulary are " +
    "refused, not ignored.",
    {
      entityType: z.string().describe(
        "Registry entity name, e.g. \"character\", \"scene\", \"prop\"."),
      values: VALUES.describe("Field name → value."),
    },
    async (p, { entityType, values }: {
      entityType: string; values: Record<string, Value> }) => {
      const edef = entityDef(entityType);
      const clean = await normalise(p.ctx, edef, values);
      const set = Object.entries(clean).filter(
        ([, v]) => v !== null && v !== "");
      const label = String(clean[edef.nameField] ?? `new ${entityType}`);
      return {
        summary: `Create ${entityType} "${label}"`,
        changes: [{
          kind: "create", entity: entityType, label,
          fields: set.map(([field, to]) => ({ field, from: undefined, to })),
        }],
        risks: [],
        op: { name: "record.create",
              args: { entity: entityType, values: clean } },
      };
    });

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
      const edef = entityDef(entityType);
      const row = await rowByUuid(p.ctx, entityType, uuid);
      const patch = await normalise(p.ctx, edef, values, row);
      const fields: FieldChange[] = Object.entries(patch)
        .filter(([f, to]) => !same(row[f], to))
        .map(([field, to]) => ({ field, from: row[field], to }));
      const label = labelOf(entityType, row);
      if (fields.length === 0) {
        return { summary: `${entityType} "${label}" already has those ` +
                          "values", changes: [], risks: [], op: null };
      }
      // The op writes every registry field, so the untouched ones are
      // sent back as they are.
      const merged: Record<string, SqlValue> = {};
      for (const f of edef.fields) merged[f.name] = row[f.name] ?? null;
      for (const c of fields) merged[c.field] = c.to;
      return {
        summary: `Change ${entityType} "${label}": ${
          fields.map((f) => f.field).join(", ")}`,
        changes: [{ kind: "update", entity: entityType, uuid, label, fields }],
        risks: [],
        op: { name: "record.update",
              args: { entity: entityType, id: Number(row["id"]),
                      values: merged } },
      };
    });

  register(on, "delete_row",
    "Delete one row, by uuid. DESTRUCTIVE. The plan lists what points at " +
    "the row (it is left pointing at nothing) so the consequence is " +
    "visible before anything is removed.",
    {
      entityType: z.string().describe("Registry entity name."),
      uuid: z.string().describe("The row's uuid."),
    },
    async (p, { entityType, uuid }: { entityType: string; uuid: string }) => {
      const row = await rowByUuid(p.ctx, entityType, uuid);
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
      return {
        summary: `Delete ${entityType} "${label}"`,
        changes: [{ kind: "delete", entity: entityType, uuid, label }],
        risks,
        op: { name: "record.delete",
              args: { entity: entityType, id: Number(row["id"]) } },
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
