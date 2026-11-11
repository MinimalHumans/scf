// SPDX-License-Identifier: Apache-2.0
/**
 * The write tools, end to end: the built server, a real host started on
 * demand, a copy of the fixture. What is pinned here is the contract —
 * nothing changes until a plan is confirmed, only an unchanged plan is
 * applied, and the host's lines (snapshot, integrity gate, journal)
 * hold — not the wording of any message.
 */

import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { openNodeDatabase } from "@minimalhumans/scf-core/node";
import {
  FIXTURE, HOST_DIR, callTool, startServer, type Server,
} from "./helpers.ts";

const SCENE12 = "06857531-3e91-41a9-95dd-3262407d8132";
const SHOT1204 = "404e480d-dde6-4b4f-9cd4-daec42d5bfa0";
const ELEANOR = "1afb7bf0-8cee-4e2f-9e8e-015f9b2aaf64";

interface PlanResult {
  status: string;
  plan: {
    planId: string; basedOn: number; blocked: boolean; destructive: boolean;
    scope: "rows" | "film";
    summary: string; risks: string[]; op: { name: string } | null;
    changes: Array<{
      kind: string; uuid?: string; label: string;
      fields?: Array<{ field: string; from: unknown; to: unknown }>;
      order?: { before: string[]; after: string[] };
    }>;
  };
  next?: string;
  snapshot?: string;
  revision?: number;
  by?: string;
  result?: unknown;
}

describe("the write tools", () => {
  let dir: string;
  let film: string;
  let server: Server;

  beforeAll(async () => {
    server = await startServer([]);
  }, 60_000);
  afterAll(() => { server.kill(); });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "scf-mcp-write-"));
    film = join(dir, "film.scf");
    copyFileSync(FIXTURE, film);
    expect((await callTool(server, "open", { scfPath: film })).isError)
      .toBe(false);
  }, 60_000);
  afterAll(() => { /* per-test dirs are removed with the OS tmp */ });

  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await callTool(server, name, args);
    return { ...r, plan: r.json as PlanResult };
  };
  const names = async (): Promise<string[]> =>
    ((await callTool(server, "list", { entityType: "character" }))
      .json as Array<{ label: string }>).map((c) => c.label);

  test("a plan changes nothing, and is the same plan every time",
      async () => {
    const args = { entityType: "character", uuid: ELEANOR,
                   values: { summary: "A new summary." } };
    const a = await call("update_row", args);
    const b = await call("update_row", args);
    expect(a.plan.status).toBe("planned");
    expect(a.plan.plan.planId).toBe(b.plan.plan.planId);
    const change = a.plan.plan.changes[0]!;
    expect(change.kind).toBe("update");
    expect(change.fields).toEqual([
      expect.objectContaining({ field: "summary", to: "A new summary." })]);
    expect(a.plan.plan.op?.name).toBe("record.update");
    // Nothing was written: the film is as it was.
    const after = await call("update_row", args);
    expect(after.plan.plan.basedOn).toBe(a.plan.plan.basedOn);
    const journal = await callTool(server, "recent_changes");
    expect((journal.json as { changes: unknown[] }).changes).toEqual([]);
  }, 120_000);

  test("confirming the plan applies it, attributed to this client",
      async () => {
    const args = { entityType: "character", uuid: ELEANOR,
                   values: { summary: "Rewritten by the agent." } };
    const planned = await call("update_row", args);
    const applied = await call("update_row",
      { ...args, confirm: planned.plan.plan.planId });
    expect(applied.plan.status).toBe("applied");
    expect(applied.plan.by).toBe("mcp: smoke");
    expect(applied.plan.revision).toBeGreaterThan(planned.plan.plan.basedOn);

    const row = (await callTool(server, "list",
      { entityType: "character" })).json as Array<{
        uuid: string; fields: Record<string, unknown> }>;
    expect(row.find((r) => r.uuid === ELEANOR)!.fields["summary"])
      .toBe("Rewritten by the agent.");

    const journal = (await callTool(server, "recent_changes")).json as {
      changes: Array<{ by: string; name: string; ok: boolean }> };
    expect(journal.changes).toEqual([expect.objectContaining(
      { by: "mcp: smoke", name: "record.update", ok: true })]);
  }, 120_000);

  test("fields the plan did not mention are left as they were", async () => {
    const before = (await callTool(server, "list", { entityType: "character" }))
      .json as Array<{ uuid: string; fields: Record<string, unknown> }>;
    const was = before.find((r) => r.uuid === ELEANOR)!.fields;
    const args = { entityType: "character", uuid: ELEANOR,
                   values: { summary: "Only this." } };
    const planned = await call("update_row", args);
    await call("update_row", { ...args, confirm: planned.plan.plan.planId });
    const after = (await callTool(server, "list", { entityType: "character" }))
      .json as Array<{ uuid: string; fields: Record<string, unknown> }>;
    const now = after.find((r) => r.uuid === ELEANOR)!.fields;
    for (const [k, v] of Object.entries(was)) {
      if (k !== "summary") expect(now[k]).toEqual(v);
    }
  }, 120_000);

  test("a wrong planId applies nothing and hands back the current plan",
      async () => {
    const args = { entityType: "character", uuid: ELEANOR,
                   values: { summary: "Never written." } };
    const r = await call("update_row", { ...args, confirm: "not-the-plan" });
    expect(r.plan.status).toBe("plan_changed");
    expect(r.plan.plan.planId).not.toBe("not-the-plan");
    expect(((await callTool(server, "recent_changes")).json as
      { changes: unknown[] }).changes).toEqual([]);
  }, 120_000);

  test("two approved plans about different rows both apply, in turn " +
       "(proposal 0043)", async () => {
    const mine = { entityType: "character", uuid: ELEANOR,
                   values: { summary: "Mine." } };
    const theirs = { entityType: "character",
                     values: { name: "INTERLOPER" } };
    const a = await call("update_row", mine);
    const b = await call("create_row", theirs);
    expect(a.plan.plan.scope).toBe("rows");
    // Both approved; the first applied moves the film's revision...
    const first = await call("create_row",
      { ...theirs, confirm: b.plan.plan.planId });
    expect(first.plan.status).toBe("applied");
    // ...and the second, about a row the first did not touch, still holds.
    const second = await call("update_row",
      { ...mine, confirm: a.plan.plan.planId });
    expect(second.plan.status).toBe("applied");
    const row = ((await callTool(server, "list", { entityType: "character" }))
      .json as Array<{ uuid: string; fields: Record<string, unknown> }>)
      .find((c) => c.uuid === ELEANOR)!;
    expect(row.fields["summary"]).toBe("Mine.");
    expect(await names()).toContain("INTERLOPER");
  }, 180_000);

  test("a plan whose row changed since it was made is not applied",
      async () => {
    const mine = { entityType: "character", uuid: ELEANOR,
                   values: { summary: "Mine." } };
    const planned = await call("update_row", mine);
    // Someone else changes the same row, in a field the plan leaves alone.
    const other = { entityType: "character", uuid: ELEANOR,
                    values: { backstory: "Theirs." } };
    const theirs = await call("update_row", other);
    await call("update_row",
      { ...other, confirm: theirs.plan.plan.planId });
    const r = await call("update_row",
      { ...mine, confirm: planned.plan.plan.planId });
    expect(r.plan.status).toBe("plan_changed");
    const row = ((await callTool(server, "list", { entityType: "character" }))
      .json as Array<{ uuid: string; fields: Record<string, unknown> }>)
      .find((c) => c.uuid === ELEANOR)!;
    expect(row.fields["summary"]).not.toBe("Mine.");
    expect(row.fields["backstory"]).toBe("Theirs.");
  }, 180_000);

  test("a film-scoped tool still goes stale when the film moves",
      async () => {
    const args = { key: "Author", value: "Someone" };
    const planned = await call("set_title_page_key", args);
    expect(planned.plan.plan.scope).toBe("film");
    const other = await call("create_row",
      { entityType: "character", values: { name: "INTERLOPER" } });
    await call("create_row", { entityType: "character",
      values: { name: "INTERLOPER" }, confirm: other.plan.plan.planId });
    const r = await call("set_title_page_key",
      { ...args, confirm: planned.plan.plan.planId });
    expect(r.plan.status).toBe("plan_changed");
  }, 180_000);

  test("write_batch: assets, links to them by $ref and shot updates are " +
       "one plan, one confirm, all or nothing", async () => {
    const SHOT = SHOT1204;
    const batch = { ops: [
      { op: "create", entityType: "asset", ref: "f1",
        values: { name: "1204_board.png", identifier: "@project/1204_board.png",
                  tags: ["storyboard"] } },
      { op: "create", entityType: "asset_relationship",
        values: { asset_id: "$f1", entity_type: "shot", entity_id: SHOT,
                  relationship_type: "storyboard" } },
      { op: "create", entityType: "asset", ref: "f2",
        uuid: "00000000-0000-4000-8000-0000000ba7c2",
        values: { name: "1204_alt.png", identifier: "@project/1204_alt.png" } },
      { op: "create", entityType: "asset_relationship",
        values: { asset_id: "$f2", entity_type: "shot", entity_id: SHOT,
                  relationship_type: "storyboard" } },
      { op: "update", entityType: "shot", uuid: SHOT,
        values: { description: "Boarded in a batch." } },
    ] };
    const planned = await call("write_batch", batch);
    expect(planned.isError).toBe(false);
    const plan = planned.plan.plan;
    expect(plan.op?.name).toBe("record.batch");
    expect(plan.changes.map((c) => c.kind))
      .toEqual(["create", "create", "create", "create", "update"]);
    expect(plan.destructive).toBe(false);
    expect(plan.blocked).toBe(false);
    // Staleness bookkeeping stays out of the response.
    expect(plan).not.toHaveProperty("reads");
    expect(plan).not.toHaveProperty("shown");
    // The plan shows the reference as written, and only the changed
    // field of the shot, not the whole row.
    expect(plan.changes[1]!.fields).toContainEqual(
      { field: "asset_id", to: "$f1" });
    const shown = (plan.op as unknown as { args: { ops: Array<{
      values?: Record<string, unknown> }> } }).args.ops;
    expect(shown[4]!.values).toEqual({ description: "Boarded in a batch." });
    const full = await call("write_batch", { ...batch, verbose: true });
    expect(Object.keys((full.plan.plan.op as unknown as { args: { ops: Array<{
      values: Record<string, unknown> }> } }).args.ops[4]!.values).length)
      .toBeGreaterThan(1);
    expect(full.plan.plan.planId).toBe(plan.planId);

    const applied = await call("write_batch",
      { ...batch, confirm: plan.planId });
    expect(applied.plan.status).toBe("applied");
    const made = applied.plan.result as Array<{
      kind: string; ref?: string; uuid?: string }>;
    expect(made.filter((m) => m.kind === "create")).toHaveLength(4);
    expect(made[2]).toMatchObject(
      { ref: "f2", uuid: "00000000-0000-4000-8000-0000000ba7c2" });
    const links = ((await callTool(server, "where_used",
      { entityType: "asset", uuid: made[0]!.uuid })).json as
      { usedBy: unknown[] }).usedBy;
    expect(links.length).toBeGreaterThan(0);
    // One entry in the journal: the batch, not five writes.
    const journal = (await callTool(server, "recent_changes")).json as {
      changes: Array<{ name: string; ok: boolean }> };
    expect(journal.changes).toEqual([expect.objectContaining(
      { name: "record.batch", ok: true })]);
  }, 180_000);

  test("write_batch refuses a bad op while planning, and a failing op " +
       "writes nothing", async () => {
    for (const ops of [
      // A $ref nothing earlier declares.
      [{ op: "create", entityType: "asset_relationship",
         values: { asset_id: "$nope", entity_type: "shot",
                   entity_id: SHOT1204 } }],
      // A $ref to the wrong kind of row.
      [{ op: "create", entityType: "character", ref: "c",
         values: { name: "X" } },
       { op: "create", entityType: "asset_relationship",
         values: { asset_id: "$c", entity_type: "shot",
                   entity_id: SHOT1204 } }],
      // The same row twice.
      [{ op: "update", entityType: "character", uuid: ELEANOR,
         values: { summary: "a" } },
       { op: "delete", entityType: "character", uuid: ELEANOR }],
      // A list field given a string.
      [{ op: "create", entityType: "asset",
         values: { name: "x.png", tags: "shot" } }],
    ]) {
      const r = await call("write_batch", { ops });
      expect(r.isError, JSON.stringify(ops)).toBe(true);
    }
    const before = await names();
    // A batch the integrity gate refuses as a whole: the character in op
    // 1 is not created either.
    const ops = [
      { op: "create", entityType: "character", values: { name: "HALF" } },
      { op: "create", entityType: "scene_character",
        values: { scene_id: SCENE12, character_id: 9001 } },
    ];
    const planned = await call("write_batch", { ops });
    expect(planned.plan.plan.blocked).toBe(true);
    const r = await call("write_batch",
      { ops, confirm: planned.plan.plan.planId });
    expect(r.isError).toBe(true);
    expect(await names()).toEqual(before);
  }, 180_000);

  test("a batch with a delete is destructive and says what points at it",
      async () => {
    const r = await call("write_batch", { ops: [
      { op: "delete", entityType: "character", uuid: ELEANOR }] });
    expect(r.plan.plan.destructive).toBe(true);
    expect(r.plan.plan.risks.join(" ")).toMatch(/op 1 .*point at it/);
  }, 120_000);

  test("create_row keeps a uuid it is given, and refuses one in use",
      async () => {
    const uuid = "00000000-0000-4000-8000-00000000c0de";
    const args = { entityType: "character", values: { name: "NAMED" }, uuid };
    const planned = await call("create_row", args);
    const done = await call("create_row",
      { ...args, confirm: planned.plan.plan.planId });
    expect(done.plan.status).toBe("applied");
    expect((await callTool(server, "find",
      { entityType: "character", label: "NAMED" })).text).toContain(uuid);
    expect((await call("create_row", { entityType: "character",
      values: { name: "AGAIN" }, uuid: ELEANOR })).isError).toBe(true);
  }, 180_000);

  test("bad requests are caught while planning, before anything runs",
      async () => {
    const unknownField = await call("create_row", {
      entityType: "character", values: { not_a_field: "x" } });
    expect(unknownField.isError).toBe(true);
    expect(unknownField.text).toContain("not_a_field");

    const badEntity = await call("create_row",
      { entityType: "nope", values: {} });
    expect(badEntity.isError).toBe(true);

    const noRow = await call("delete_row", {
      entityType: "character", uuid: "00000000-0000-4000-8000-000000000000" });
    expect(noRow.isError).toBe(true);
  }, 120_000);

  test("a delete is destructive, says what points at the row, and needs " +
      "its plan confirmed", async () => {
    const made = await call("create_row",
      { entityType: "character", values: { name: "TEMPORARY" } });
    const applied = await call("create_row", { entityType: "character",
      values: { name: "TEMPORARY" }, confirm: made.plan.plan.planId });
    expect(applied.plan.status).toBe("applied");
    const uuid = ((await callTool(server, "find",
      { entityType: "character", label: "TEMPORARY" })).json as
      Array<{ uuid: string }>)[0]!.uuid;

    const plan = await call("delete_row", { entityType: "character", uuid });
    expect(plan.plan.plan.destructive).toBe(true);
    expect(plan.plan.plan.risks.join(" ")).toContain("snapshot");
    expect(await names()).toContain("TEMPORARY");        // still there

    const done = await call("delete_row",
      { entityType: "character", uuid, confirm: plan.plan.plan.planId });
    expect(done.plan.status).toBe("applied");
    expect(await names()).not.toContain("TEMPORARY");

    // A row with a lot pointing at it says so.
    const eleanor = await call("delete_row",
      { entityType: "character", uuid: ELEANOR });
    expect(eleanor.plan.plan.risks.join(" ")).toMatch(/point at it/);
  }, 240_000);

  test("the first change takes a snapshot of what was there; later ones " +
      "do not", async () => {
    const make = async (name: string) => {
      const p = await call("create_row",
        { entityType: "character", values: { name } });
      return call("create_row", { entityType: "character", values: { name },
        confirm: p.plan.plan.planId });
    };
    const first = await make("ONE");
    expect(first.plan.status).toBe("applied");
    const snapshot = first.plan.snapshot!;
    expect(snapshot.startsWith(HOST_DIR)).toBe(true);
    expect(existsSync(snapshot)).toBe(true);
    const db = openNodeDatabase(snapshot, { readOnly: true });
    const inSnapshot = (await db.exec("SELECT name FROM character"))
      .map((r) => r["name"]);
    db.close();
    expect(inSnapshot).not.toContain("ONE");
    expect(inSnapshot).toContain("Eleanor Cade");

    const second = await make("TWO");
    expect(second.plan.snapshot).toBeUndefined();
  }, 240_000);

  test("a change that would add an integrity finding is blocked in the " +
      "plan and refused at apply", async () => {
    const made = await call("create_row",
      { entityType: "character", values: { name: "NO CUE HERE" } });
    await call("create_row", { entityType: "character",
      values: { name: "NO CUE HERE" }, confirm: made.plan.plan.planId });
    const who = ((await callTool(server, "find",
      { entityType: "character", label: "NO CUE HERE" })).json as
      Array<{ uuid: string }>)[0]!.uuid;

    // A link to a character row that does not exist points at nothing
    // (`reference.dangling`, spec §9.4.1). A row id is accepted as given,
    // so this is the gate's to catch.
    const args = { entityType: "scene_character",
      values: { scene_id: SCENE12, character_id: 9001 } };
    const plan = await call("create_row", args);
    expect(plan.plan.plan.blocked).toBe(true);
    expect(plan.plan.plan.risks.join(" ")).toContain("names no character");
    expect(plan.plan.next).toContain("refused");

    const forced = await call("create_row",
      { ...args, confirm: plan.plan.plan.planId });
    expect(forced.isError).toBe(true);
    // Nothing points at the new character: no link was made.
    const used = (await callTool(server, "where_used",
      { entityType: "character", uuid: who })).json as { usedBy: unknown[] };
    expect(used.usedBy).toEqual([]);
  }, 240_000);

  test("someone present and silent can be linked: the plan asks, and " +
      "does not refuse", async () => {
    const made = await call("create_row",
      { entityType: "character", values: { name: "SILENT WITNESS" } });
    await call("create_row", { entityType: "character",
      values: { name: "SILENT WITNESS" }, confirm: made.plan.plan.planId });
    const who = ((await callTool(server, "find",
      { entityType: "character", label: "SILENT WITNESS" })).json as
      Array<{ uuid: string }>)[0]!.uuid;

    const args = { entityType: "scene_character",
      values: { scene_id: SCENE12, character_id: who } };
    const plan = await call("create_row", args);
    expect(plan.plan.plan.blocked).toBe(false);
    expect(plan.plan.plan.risks.join(" ")).toContain("SILENT WITNESS");
    expect(plan.plan.plan.risks.join(" ")).toContain("without a cue");

    const applied = await call("create_row",
      { ...args, confirm: plan.plan.plan.planId });
    expect(applied.isError).toBe(false);
    expect(applied.plan.status).toBe("applied");
    const used = (await callTool(server, "where_used",
      { entityType: "character", uuid: who })).json as { usedBy: unknown[] };
    expect(used.usedBy).toHaveLength(1);
  }, 240_000);

  test("shots: add, move, cut and restore, each as a plan first",
      async () => {
    const add = await call("add_shot", { sceneUuid: SCENE12 });
    expect(add.plan.plan.changes[0]!.kind).toBe("create");
    const number = add.plan.plan.changes[0]!.fields!
      .find((f) => f.field === "shot_number")!.to as string;
    await call("add_shot", { sceneUuid: SCENE12,
      confirm: add.plan.plan.planId });
    const found = (await callTool(server, "find",
      { entityType: "shot", label: number })).json as Array<{ uuid: string }>;
    expect(found).toHaveLength(1);

    const move = await call("move_shot",
      { shotUuid: found[0]!.uuid, direction: "earlier" });
    const order = move.plan.plan.changes[0]!.order!;
    expect(order.after[order.after.length - 2]).toBe(
      order.before[order.before.length - 1]);
    await call("move_shot", { shotUuid: found[0]!.uuid,
      direction: "earlier", confirm: move.plan.plan.planId });

    const cut = await call("set_shot_cut",
      { shotUuid: SHOT1204, cut: true });
    expect(cut.plan.plan.changes[0]!.fields).toEqual([
      expect.objectContaining({ field: "lifecycle_status", to: "cut" })]);
    await call("set_shot_cut", { shotUuid: SHOT1204, cut: true,
      confirm: cut.plan.plan.planId });
    const again = await call("set_shot_cut",
      { shotUuid: SHOT1204, cut: true });
    expect(again.plan.plan.op).toBeNull();          // already cut
    expect(again.plan.next).toContain("nothing");
  }, 300_000);

  test("the title page can be set, and an unchanged value is a no-op",
      async () => {
    const plan = await call("set_title_page_key",
      { key: "Author", value: "Test Author" });
    await call("set_title_page_key", { key: "Author", value: "Test Author",
      confirm: plan.plan.plan.planId });
    const again = await call("set_title_page_key",
      { key: "author", value: "Test Author" });
    expect(again.plan.plan.op).toBeNull();
  }, 180_000);

  test("a polymorphic reference given as a uuid is stored as the row id",
      async () => {
    const ASSET = "f9dfae2d-2cc7-42af-b2ac-d9089025a444"; // id 2
    const valuesOf = (r: Awaited<ReturnType<typeof call>>) =>
      (r.plan.plan.op as unknown as
        { args: { values: Record<string, unknown> } }).args.values;

    // create: the sibling is in the same call.
    const created = await call("create_row", {
      entityType: "asset_relationship",
      values: { asset_id: ASSET, entity_type: "character",
                entity_id: ELEANOR, relationship_type: "reference" },
    });
    expect(created.isError).toBe(false);
    expect(valuesOf(created)).toMatchObject({ asset_id: 2, entity_id: 1 });

    // A uuid of the wrong kind, an unset sibling, and a bare string are
    // refused rather than stored as text pointing at nothing.
    for (const values of [
      { asset_id: ASSET, entity_type: "prop", entity_id: ELEANOR },
      { asset_id: ASSET, entity_id: ELEANOR },
      { asset_id: ASSET, entity_type: "character", entity_id: "Eleanor" },
    ]) {
      const r = await call("create_row",
        { entityType: "asset_relationship", values });
      expect(r.isError).toBe(true);
    }

    // update: the sibling comes from the row when the call leaves it out.
    const COSTUME_LINK = "00000000-0000-4000-8000-0000000b0009";
    const wrongKind = await call("update_row", { entityType:
      "asset_relationship", uuid: COSTUME_LINK,
      values: { entity_id: ELEANOR } });
    expect(wrongKind.isError).toBe(true);
    const retargeted = await call("update_row", { entityType:
      "asset_relationship", uuid: COSTUME_LINK,
      values: { entity_type: "character", entity_id: ELEANOR } });
    expect(retargeted.isError).toBe(false);
    expect(valuesOf(retargeted)).toMatchObject(
      { entity_type: "character", entity_id: 1 });
  }, 180_000);

  test("list and json values pass the transport and are stored as the " +
       "registry says; the wrong shape is refused", async () => {
    const valuesOf = (r: Awaited<ReturnType<typeof call>>) =>
      (r.plan.plan.op as unknown as
        { args: { values: Record<string, unknown> } }).args.values;

    // A string_list takes an array, stored as its JSON text (§2.5).
    const created = await call("create_row", { entityType: "asset",
      values: { name: "probe.png", identifier: "@project/probe.png",
                tags: ["shot", "1A"] } });
    expect(created.isError).toBe(false);
    expect(created.plan.status).toBe("planned");
    expect(valuesOf(created)).toMatchObject({ tags: '["shot","1A"]' });

    // A bare string where a list belongs, a list of non-strings, and a
    // list in a single-value field are refused while planning.
    for (const values of [
      { name: "probe.png", tags: "shot" },
      { name: "probe.png", tags: [1, 2] },
      { name: "probe.png", description: ["not", "a", "paragraph"] },
      { name: "probe.png", size_bytes: "big" },
    ]) {
      const r = await call("create_row", { entityType: "asset", values });
      expect(r.isError, JSON.stringify(values)).toBe(true);
    }

    // update_row: an array replaces the list; the plan shows both.
    const PLATE = "16961c0a-8df6-475c-80f5-6eb4abfc7137";
    const retagged = await call("update_row", { entityType: "asset",
      uuid: PLATE, values: { tags: ["location", "kitchen"] } });
    expect(retagged.isError).toBe(false);
    expect(retagged.plan.plan.changes[0]!.fields).toEqual([{
      field: "tags", from: '["location","kitchen","night"]',
      to: '["location","kitchen"]' }]);
    const same = await call("update_row", { entityType: "asset",
      uuid: PLATE, values: { tags: ["location", "kitchen", "night"] } });
    expect(same.plan.plan.op).toBeNull();
    expect((await call("update_row", { entityType: "asset", uuid: PLATE,
      values: { tags: "night" } })).isError).toBe(true);

    // A json field takes an array or object; a multiselect an array.
    const DECISION = "0af0d54c-ff7e-4710-a9d9-ee3971cf1097";
    const json = await call("update_row", { entityType: "creative_decision",
      uuid: DECISION, values: { affected_entities: { scene: ["12"] } } });
    expect(json.isError).toBe(false);
    expect(valuesOf(json)).toMatchObject(
      { affected_entities: '{"scene":["12"]}' });
    const OVERRIDE = "5e52f62a-8e0d-4787-aee2-fd3a3a8e518c";
    const multi = await call("update_row", { entityType:
      "character_shot_override", uuid: OVERRIDE,
      values: { override_types: ["aging", "prosthetic"] } });
    expect(multi.isError).toBe(false);
    expect(valuesOf(multi)).toMatchObject(
      { override_types: "aging, prosthetic" });
  }, 180_000);

  test("the advertised schema for values admits what the tools accept",
      async () => {
    const listed = await server.send("tools/list") as {
      tools: Array<{ name: string; inputSchema: {
        properties: Record<string, { additionalProperties?: unknown }> } }>;
    };
    for (const name of ["create_row", "update_row"]) {
      const tool = listed.tools.find((t) => t.name === name)!;
      const value = JSON.stringify(
        tool.inputSchema.properties["values"]!.additionalProperties);
      expect(value, name).toContain('"array"');
      expect(value, name).toContain('"object"');
      expect(value, name).toContain('"string"');
    }
  });

  test("a film from an older schema is refused with a way forward",
      async () => {
    const old = join(dir, "old.scf");
    copyFileSync(FIXTURE, old);
    const db = openNodeDatabase(old);
    await db.exec(
      "UPDATE _scf_meta SET value = '1.0' WHERE key = 'schema_version'");
    db.close();
    await callTool(server, "open", { scfPath: old });
    const r = await call("create_row",
      { entityType: "character", values: { name: "X" } });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("SCF editor");
  }, 120_000);
});

describe("a read-only server", () => {
  let server: Server;
  beforeAll(async () => {
    server = await startServer(["--read-only", "--scf", FIXTURE]);
  }, 60_000);
  afterAll(() => { server.kill(); });

  test("offers no write tool, still offers the journal, and says so",
      async () => {
    const tools = ((await server.send("tools/list")) as
      { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    for (const w of ["create_row", "update_row", "delete_row", "add_shot",
                     "set_shot_cut", "move_shot", "set_title_page_key",
                     "write_batch"]) {
      expect(tools).not.toContain(w);
    }
    expect(tools).toContain("recent_changes");
    const opened = await callTool(server, "open", { scfPath: FIXTURE });
    expect((opened.json as { writable: boolean }).writable).toBe(false);
  }, 120_000);
});

describe("a client that can ask the person", () => {
  let dir: string;
  let film: string;
  const asked: string[] = [];
  let answer: "accept" | "decline" = "decline";
  let server: Server;

  beforeAll(async () => {
    server = await startServer([], undefined, (message) => {
      asked.push(message);
      return answer === "accept"
        ? { action: "accept", content: { apply: true } }
        : { action: "decline" };
    });
    dir = mkdtempSync(join(tmpdir(), "scf-mcp-elicit-"));
    film = join(dir, "film.scf");
    copyFileSync(FIXTURE, film);
    await callTool(server, "open", { scfPath: film });
  }, 60_000);
  afterAll(() => {
    server.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  test("the person is asked at apply, and a no writes nothing", async () => {
    const args = { entityType: "character", values: { name: "ASKED ABOUT" } };
    const plan = (await callTool(server, "create_row", args)).json as
      PlanResult;
    answer = "decline";
    const declined = (await callTool(server, "create_row",
      { ...args, confirm: plan.plan.planId })).json as PlanResult;
    expect(declined.status).toBe("declined");
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("ASKED ABOUT");
    const names = ((await callTool(server, "list",
      { entityType: "character" })).json as Array<{ label: string }>)
      .map((c) => c.label);
    expect(names).not.toContain("ASKED ABOUT");

    answer = "accept";
    const done = (await callTool(server, "create_row",
      { ...args, confirm: plan.plan.planId })).json as PlanResult;
    expect(done.status).toBe("applied");
    expect(asked).toHaveLength(2);
  }, 240_000);
});
