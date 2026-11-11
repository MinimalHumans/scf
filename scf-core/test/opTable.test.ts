// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { openNodeDatabase } from "../src/node.ts";
import { initDatabase } from "../src/db.ts";
import { loadRegistry, type RegistryJson } from "../src/registry.ts";
import { createSession, StaleRevisionError, type Session }
  from "../src/session.ts";
import {
  OpArgumentError, UnknownOpError, argsJsonSchema, callOp, listOps,
} from "../src/ops/opTable.ts";
import { IntegrityGateError } from "../src/ops/integrityGate.ts";

const REGISTRY = fileURLToPath(new URL(
  "../registry/registry.json", import.meta.url));

describe("op table", () => {
  let session: Session;

  beforeEach(async () => {
    const registry = loadRegistry(JSON.parse(
      await readFile(REGISTRY, "utf8")) as RegistryJson);
    const db = openNodeDatabase(":memory:");
    await initDatabase(db.exec, registry);
    session = createSession(registry, {
      exec: db.exec, persist: () => Promise.resolve(true),
      close: () => Promise.resolve(),
    });
  });

  const count = async (table: string): Promise<number> =>
    Number((await session.exec(
      `SELECT COUNT(*) AS n FROM ${table}`))[0]!["n"]);

  test("a call runs the op and reports the new revision", async () => {
    const r = await callOp(session, "record.create", {
      entity: "character", values: { name: "ELEANOR" },
    });
    expect(typeof r.result).toBe("number");
    expect(r.revision).toBe(1);
    expect(await count("character")).toBe(1);
  });

  test("an unknown op is refused", async () => {
    await expect(callOp(session, "record.explode", {}))
      .rejects.toBeInstanceOf(UnknownOpError);
  });

  test("bad arguments are refused before anything is written", async () => {
    for (const args of [
      { entity: "character" },                        // missing values
      { entity: 7, values: {} },                      // wrong type
      { entity: "character", values: {}, extra: 1 }, // unknown name
      { entity: "character", values: { a: { b: 1 } } }, // not a value
      "character",                                    // not an object
    ]) {
      await expect(callOp(session, "record.create", args))
        .rejects.toBeInstanceOf(OpArgumentError);
    }
    expect(session.revision).toBe(0);
  });

  test("a stale expected revision is refused and is not a write",
      async () => {
    await callOp(session, "record.create",
                 { entity: "character", values: { name: "A" } });
    await expect(callOp(session, "record.create",
      { entity: "character", values: { name: "B" } },
      { expectedRevision: 0 })).rejects.toBeInstanceOf(StaleRevisionError);
    expect(await count("character")).toBe(1);
    expect(session.revision).toBe(1);
  });

  test("a matching expected revision is accepted", async () => {
    await callOp(session, "record.create",
                 { entity: "character", values: { name: "A" } });
    await callOp(session, "record.create",
      { entity: "character", values: { name: "B" } },
      { expectedRevision: 1 });
    expect(await count("character")).toBe(2);
  });

  test("two calls with the same expected revision cannot both win",
      async () => {
    const make = (name: string) => callOp(session, "record.create",
      { entity: "character", values: { name } }, { expectedRevision: 0 });
    const settled = await Promise.allSettled([make("A"), make("B")]);
    expect(settled.map((s) => s.status).sort())
      .toEqual(["fulfilled", "rejected"]);
    expect(await count("character")).toBe(1);
  });

  test("a read-only session refuses every op", async () => {
    const registry = session.registry;
    const db = openNodeDatabase(":memory:");
    await initDatabase(db.exec, registry);
    const ro = createSession(registry, {
      exec: db.exec, persist: () => Promise.resolve(true),
      close: () => Promise.resolve(),
    }, { readOnly: true });
    await expect(callOp(ro, "record.create",
      { entity: "character", values: { name: "A" } })).rejects.toThrow(
      /read-only/);
  });

  test("shots: add, move, cut, remove through the table", async () => {
    const scene = (await callOp(session, "record.create",
      { entity: "scene", values: { scene_number: "1" } })).result as number;
    await callOp(session, "shot.add", { sceneId: scene });
    await callOp(session, "shot.add", { sceneId: scene });
    const ids = (await session.exec(
      "SELECT id FROM shot ORDER BY shot_order")).map((r) => Number(r["id"]));
    expect(ids).toHaveLength(2);

    await callOp(session, "shot.move", { id: ids[1], delta: -1 });
    const order = (await session.exec(
      "SELECT id FROM shot ORDER BY shot_order")).map((r) => Number(r["id"]));
    expect(order).toEqual([ids[1], ids[0]]);

    await callOp(session, "shot.setCut", { id: ids[0], cut: true });
    expect((await session.exec("SELECT lifecycle_status AS s FROM shot " +
      "WHERE id = ?", [ids[0]!]))[0]!["s"]).toBe("cut");

    await callOp(session, "shot.remove", { id: ids[0] });
    expect(await count("shot")).toBe(1);
  });

  test("shot.move rejects a step that is not one place", async () => {
    await expect(callOp(session, "shot.move", { id: 1, delta: 5 }))
      .rejects.toBeInstanceOf(OpArgumentError);
  });

  test("delete returns an undo entry that is plain data", async () => {
    const id = (await callOp(session, "record.create",
      { entity: "character", values: { name: "A" } })).result as number;
    const r = await callOp(session, "record.delete",
                           { entity: "character", id });
    expect(JSON.parse(JSON.stringify(r.result))).toEqual(r.result);
    expect(await count("character")).toBe(0);
  });

  test("title-page keys can be set and cleared", async () => {
    await callOp(session, "titlePage.setKey",
                 { key: "Author", value: "Ada" });
    expect(await count("screenplay_title_page")).toBe(1);
    await callOp(session, "titlePage.setKey", { key: "Author", value: "" });
    expect(await count("screenplay_title_page")).toBe(0);
  });

  test("every op describes itself as a JSON Schema", () => {
    for (const op of listOps()) {
      const schema = argsJsonSchema(op);
      expect(schema["type"]).toBe("object");
      expect(Object.keys(schema["properties"] as object).sort())
        .toEqual(Object.keys(op.args).sort());
    }
    const names = listOps().map((o) => o.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("the integrity gate", () => {
  let session: Session;

  beforeEach(async () => {
    const registry = loadRegistry(JSON.parse(
      await readFile(REGISTRY, "utf8")) as RegistryJson);
    const db = openNodeDatabase(":memory:");
    await initDatabase(db.exec, registry);
    session = createSession(registry, {
      exec: db.exec, persist: () => Promise.resolve(true),
      close: () => Promise.resolve(),
    });
  });

  /** A scene with a heading and an action line, and one character who
   *  has no cue there: linking them is a silent presence, which is a
   *  question and not a refusal (spec §2.4.1, proposal 0041). */
  async function scriptedScene(): Promise<{ scene: number; person: number }> {
    const scene = (await callOp(session, "record.create", {
      entity: "scene", values: { scene_number: "1" } })).result as number;
    const person = (await callOp(session, "record.create", {
      entity: "character", values: { name: "ELEANOR" } })).result as number;
    await session.exec(
      "INSERT INTO screenplay_lines (uuid, line_order, line_type, content, " +
      "scene_id) VALUES ('h1', 0, 'heading', 'INT. HALL - DAY', ?)", [scene]);
    await session.exec(
      "INSERT INTO screenplay_lines (uuid, line_order, line_type, content) " +
      "VALUES ('a1', 1, 'action', 'Rain.')");
    return { scene, person };
  }

  const link = (scene: number, person: number) => ({
    entity: "scene_character",
    values: { scene_id: scene, character_id: person },
  });
  /** No character has this id: a link to it points at nothing (§9.4.1,
   *  `reference.dangling`), which is what the gate refuses. */
  const NOBODY = 9001;

  test("without the gate the same write goes through", async () => {
    const { scene, person } = await scriptedScene();
    await callOp(session, "record.create", link(scene, person));
    const n = await session.exec("SELECT COUNT(*) AS n FROM scene_character");
    expect(n[0]!["n"]).toBe(1);
  });

  test("a write that adds a finding is refused and leaves nothing",
      async () => {
    const { scene, person } = await scriptedScene();
    void person;
    const err = await callOp(session, "record.create", link(scene, NOBODY),
      { integrityGate: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IntegrityGateError);
    expect((err as IntegrityGateError).added[0]!.kind)
      .toBe("dangling_reference");
    expect(await session.exec("SELECT id FROM scene_character")).toEqual([]);
    // The connection is usable afterwards, and not stuck in a transaction.
    await callOp(session, "record.create", {
      entity: "character", values: { name: "MARCUS" } },
      { integrityGate: true });
  });

  test("findings the file already had do not block an unrelated write",
      async () => {
    const { scene } = await scriptedScene();
    await callOp(session, "record.create", link(scene, NOBODY));
    // The file now carries one finding. Adding a character is fine.
    const r = await callOp(session, "record.create", {
      entity: "character", values: { name: "MARCUS" } },
      { integrityGate: true });
    expect(typeof r.result).toBe("number");
  });

  test("a write that fixes one finding and makes another is refused",
      async () => {
    const { scene } = await scriptedScene();
    const made = (await callOp(session, "record.create",
      link(scene, NOBODY))).result as number;
    // Re-pointing the link at another row that is not there keeps the
    // total at one.
    await expect(callOp(session, "record.update", {
      entity: "scene_character", id: made,
      values: { scene_id: scene, character_id: NOBODY + 1 } },
      { integrityGate: true })).rejects.toBeInstanceOf(IntegrityGateError);
    const row = await session.exec(
      "SELECT character_id AS c FROM scene_character WHERE id = ?", [made]);
    expect(row[0]!["c"]).toBe(NOBODY);
  });

  test("a silent presence link is applied through the gate, and a dry " +
      "run notes it as a question", async () => {
    const { scene, person } = await scriptedScene();
    const dry = await callOp(session, "record.create", link(scene, person),
      { dryRun: true });
    expect(dry.dryRun!.added).toEqual([]);
    expect(dry.dryRun!.noted.map((n) => n.kind)).toEqual(["unjustified_link"]);
    expect(dry.dryRun!.noted[0]!.description).toContain("ELEANOR");
    await callOp(session, "record.create", link(scene, person),
      { integrityGate: true });
    const n = await session.exec("SELECT COUNT(*) AS n FROM scene_character");
    expect(n[0]!["n"]).toBe(1);
  });

  test("a polymorphic reference to nothing is refused, and one whose " +
      "kind is unset is not the gate's business", async () => {
    const theme = (await callOp(session, "record.create", {
      entity: "theme", values: { name: "Guilt" } })).result as number;
    const dangling = {
      entity: "thematic_connection",
      values: { theme_id: theme, entity_type: "character",
                entity_id: NOBODY },
    };
    const err = await callOp(session, "record.create", dangling,
      { integrityGate: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IntegrityGateError);
    expect((err as IntegrityGateError).added[0]!.description)
      .toContain("entity_id names no character");
    // A uuid stored as text in the integer column names no row either.
    const asText = await callOp(session, "record.create", {
      entity: "thematic_connection",
      values: { theme_id: theme, entity_type: "character",
                entity_id: "3f2b1c9e-0000-4000-8000-000000000001" } },
      { integrityGate: true }).catch((e: unknown) => e);
    expect(asText).toBeInstanceOf(IntegrityGateError);
    expect(await session.exec("SELECT id FROM thematic_connection"))
      .toEqual([]);
  });

  test("a dry run reports the finding, changes nothing, and keeps the " +
      "revision", async () => {
    const { scene } = await scriptedScene();
    const at = session.revision;
    const r = await callOp(session, "record.create", link(scene, NOBODY),
      { dryRun: true });
    expect(r.dryRun!.added.map((f) => f.kind)).toEqual(["dangling_reference"]);
    expect(session.revision).toBe(at);
    expect(await session.exec("SELECT id FROM scene_character")).toEqual([]);
    // And a clean one reports nothing to add.
    const clean = await callOp(session, "record.create", {
      entity: "character", values: { name: "MARCUS" } }, { dryRun: true });
    expect(clean.dryRun!.added).toEqual([]);
    expect(await session.exec(
      "SELECT id FROM character WHERE name = 'MARCUS'")).toEqual([]);
  });

  test("an op that fails on its own still rolls back and releases",
      async () => {
    await expect(callOp(session, "record.create", {
      entity: "nope", values: {} }, { integrityGate: true })).rejects
      .toThrow("unknown entity");
    await callOp(session, "record.create", {
      entity: "character", values: { name: "OK" } },
      { integrityGate: true });
  });
});
