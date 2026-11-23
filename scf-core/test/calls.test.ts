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
  CALLS, UnknownCallError, callFn, callNames,
} from "../src/ops/calls.ts";

const REGISTRY = fileURLToPath(new URL(
  "../registry/registry.json", import.meta.url));

describe("the window's call table", () => {
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

  test("names are namespaced and unique, and every entry is runnable", () => {
    const names = callNames();
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) {
      expect(n).toMatch(/^[a-zA-Z]+\.[a-zA-Z]+$/);
      expect(typeof CALLS[n].run).toBe("function");
    }
  });

  test("only table names can be called, never inherited properties",
      async () => {
    for (const name of ["db.exec", "constructor", "__proto__",
                        "toString", "hasOwnProperty"]) {
      await expect(callFn(session, name, [])).rejects
        .toBeInstanceOf(UnknownCallError);
    }
  });

  test("arguments must be a list", async () => {
    await expect(callFn(session, "record.create", { entity: "x" }))
      .rejects.toThrow("list");
  });

  test("a call returns the function's result and the new revision",
      async () => {
    const r = await callFn(session, "record.create",
                           ["character", { name: "A" }]);
    expect(typeof r.result).toBe("number");
    expect(r.revision).toBe(1);
  });

  test("a stale expected revision refuses and is not a write", async () => {
    await callFn(session, "record.create", ["character", { name: "A" }]);
    await expect(callFn(session, "record.create",
      ["character", { name: "B" }], { expectedRevision: 0 }))
      .rejects.toBeInstanceOf(StaleRevisionError);
    expect(session.revision).toBe(1);
  });

  test("a delete's undo entry goes back in through undo.delete",
      async () => {
    const id = (await callFn(session, "record.create",
      ["character", { name: "A" }])).result as number;
    const undo = (await callFn(session, "record.delete",
      ["character", id])).result;
    // What a client holds is JSON, not the original object.
    const sent = JSON.parse(JSON.stringify(undo)) as unknown;
    await callFn(session, "undo.delete", [sent]);
    const rows = await session.exec("SELECT name FROM character");
    expect(rows).toEqual([{ name: "A" }]);
  });

  test("moving a shot needs only ids", async () => {
    const scene = (await callFn(session, "record.create",
      ["scene", { scene_number: "1" }])).result as number;
    await callFn(session, "shoot.addShot", [scene, null]);
    await callFn(session, "shoot.addShot", [scene, null]);
    const ids = (await session.exec(
      "SELECT id FROM shot ORDER BY shot_order")).map((r) => Number(r["id"]));
    await callFn(session, "shoot.moveShot", [ids[1], -1, []]);
    const after = (await session.exec(
      "SELECT id FROM shot ORDER BY shot_order")).map((r) => Number(r["id"]));
    expect(after).toEqual([ids[1], ids[0]]);
  });

  test("script.commit links and stores lines in one transaction",
      async () => {
    const rows = [{
      uuid: "11111111-1111-4111-8111-111111111111", lineOrder: 0,
      lineType: "heading", content: "INT. KITCHEN - DAY", raw: "",
      sceneId: null, characterId: null, locationId: null, metadata: null,
    }];
    const r = await callFn(session, "script.commit", [{
      rows, titlePage: [], link: { createNew: true },
    }]);
    expect((r.result as { scenesCreated: number }).scenesCreated)
      .toBe(1);
    const stored = await session.exec(
      "SELECT content FROM screenplay_lines");
    expect(stored.map((s) => s["content"])).toEqual(["INT. KITCHEN - DAY"]);
  });

  test("script.commit reports the links it made, so a second commit " +
       "of the same lines creates nothing", async () => {
    // The window's rows cross to the host as a copy: whatever linking
    // writes onto them only reaches the caller through the result.
    const heading = "33333333-3333-4333-8333-333333333333";
    const cue = "44444444-4444-4444-8444-444444444444";
    const rows = [{
      uuid: heading, lineOrder: 0, lineType: "heading",
      content: "INT. BARN - NIGHT", raw: "",
      sceneId: null, characterId: null, locationId: null, metadata: null,
    }, {
      uuid: cue, lineOrder: 1, lineType: "character", content: "MARCUS",
      raw: "",
      sceneId: null, characterId: null, locationId: null, metadata: null,
    }];
    const first = (await callFn(session, "script.commit", [{
      rows: structuredClone(rows), titlePage: [],
      link: { createNew: true },
    }])).result as {
      scenesCreated: number;
      lines: Array<{ uuid: string; sceneId: number | null;
                     characterId: number | null }>;
    };
    expect(first.scenesCreated).toBe(1);
    const byUuid = new Map(first.lines.map((l) => [l.uuid, l]));
    expect(byUuid.get(heading)?.sceneId).not.toBeNull();
    expect(byUuid.get(cue)?.characterId).not.toBeNull();

    // What the editor sends next time: its rows with the reported links.
    const again = rows.map((r) => ({
      ...r,
      sceneId: byUuid.get(r.uuid)?.sceneId ?? null,
      characterId: byUuid.get(r.uuid)?.characterId ?? null,
    }));
    const second = (await callFn(session, "script.commit", [{
      rows: again, titlePage: [], link: { createNew: true },
    }])).result as { scenesCreated: number; charactersCreated: number };
    expect(second.scenesCreated).toBe(0);
    expect(second.charactersCreated).toBe(0);
    expect(await session.exec("SELECT id FROM scene")).toHaveLength(1);
  });

  test("a failed script.commit leaves nothing half-written", async () => {
    const bad = [{
      uuid: "22222222-2222-4222-8222-222222222222", lineOrder: 0,
      lineType: "heading", content: "INT. HALL - DAY", raw: "",
      sceneId: null, characterId: null, locationId: null, metadata: null,
    }, { not: "a row" }];
    await expect(callFn(session, "script.commit", [{
      rows: bad, titlePage: [], link: { createNew: true },
    }])).rejects.toThrow();
    expect(await session.exec("SELECT id FROM scene")).toEqual([]);
  });
});
