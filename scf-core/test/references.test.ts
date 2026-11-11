// SPDX-License-Identifier: Apache-2.0
/**
 * Spec §9.1, §9.4.1 — `reference.dangling` (proposal 0040).
 *
 * A reference column that is filled and names no row. The neighbouring
 * conditions each have a code of their own and must keep it: an EMPTY
 * required reference is `junction.endpoint_absent`, a relationship's
 * endpoints are `relationship.endpoint_absent`, a span's start is
 * `structure.boundary_dangling`, and a version chain's links are the
 * `identity.*` codes. Reported twice is reported wrong, so each of those
 * is pinned here as NOT raising this one.
 */
import { afterEach, afterAll, beforeAll, describe, expect, test } from "vitest";
import { initDatabase } from "../src/db.ts";
import { collectFindings, type Finding } from "../src/findings.ts";
import { danglingReferences } from "../src/references.ts";
import { openNodeDatabase, type NodeDatabase } from "../src/node.ts";
import { openFixture, registry, type Fixture } from "./setup.ts";

let fixture: Fixture;
beforeAll(() => { fixture = openFixture(); });
afterAll(() => { fixture.close(); });

let scratch: NodeDatabase | null = null;
afterEach(() => { scratch?.close(); scratch = null; });

const fresh = async (): Promise<NodeDatabase> => {
  const d = openNodeDatabase(":memory:");
  await initDatabase(d.exec, registry);
  return d;
};

const dangling = async (d: NodeDatabase): Promise<Finding[]> =>
  (await collectFindings(d.exec, registry)).findings
    .filter((f) => f.code === "reference.dangling");

const U = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("reference.dangling", () => {
  test("the conformance fixture has none", async () => {
    expect(await danglingReferences(fixture.ctx.exec, registry)).toEqual([]);
  });

  test("an ordinary reference to a row that is not there", async () => {
    scratch = await fresh();
    await scratch.exec("INSERT INTO scene (name, scene_number, uuid) " +
                       "VALUES ('INT. KITCHEN', '1', ?)", [U(1)]);
    await scratch.exec(
      "INSERT INTO scene_character (scene_id, character_id, uuid) " +
      "VALUES (1, 404, ?)", [U(2)]);
    const found = await dangling(scratch);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      severity: "warning", table: "scene_character", rowIds: [1], count: 1 });
    // The column is filled, so it is not the empty-endpoint finding.
    expect((await collectFindings(scratch.exec, registry)).findings
      .map((f) => f.code)).not.toContain("junction.endpoint_absent");
  });

  test("one finding per column, carrying every row", async () => {
    scratch = await fresh();
    await scratch.exec("INSERT INTO scene (name, scene_number, uuid) " +
                       "VALUES ('INT. KITCHEN', '1', ?)", [U(1)]);
    for (const n of [2, 3]) {
      await scratch.exec(
        "INSERT INTO scene_character (scene_id, character_id, uuid) " +
        "VALUES (1, ?, ?)", [400 + n, U(n)]);
    }
    const found = await dangling(scratch);
    expect(found).toHaveLength(1);
    expect(found[0]!.rowIds).toEqual([1, 2]);
    expect(found[0]!.count).toBe(2);
  });

  test("a polymorphic reference is resolved through its sibling",
      async () => {
    scratch = await fresh();
    await scratch.exec("INSERT INTO theme (name, uuid) VALUES ('Guilt', ?)",
                       [U(1)]);
    await scratch.exec("INSERT INTO character (name, uuid) VALUES " +
                       "('ELEANOR', ?)", [U(2)]);
    // Character 1 exists; prop 1 does not. Same id, different table.
    await scratch.exec(
      "INSERT INTO thematic_connection (theme_id, entity_type, entity_id, " +
      "uuid) VALUES (1, 'character', 1, ?)", [U(3)]);
    await scratch.exec(
      "INSERT INTO thematic_connection (theme_id, entity_type, entity_id, " +
      "uuid) VALUES (1, 'prop', 1, ?)", [U(4)]);
    const found = await danglingReferences(scratch.exec, registry);
    expect(found).toEqual([{
      entity: "thematic_connection", field: "entity_id", rowId: 2,
      value: "1", target: "prop" }]);
  });

  test("a polymorphic target declared by map is honoured", async () => {
    scratch = await fresh();
    await scratch.exec("INSERT INTO character (name, uuid) VALUES " +
                       "('ELEANOR', ?)", [U(1)]);
    // subject_variant_id points into character_variant, never into the
    // table subject_type names (§12.1.2). Character 1 exists; no
    // character_variant does.
    await scratch.exec(
      "INSERT INTO entity_anchor (name, subject_type, subject_id, " +
      "subject_variant_id, uuid) VALUES ('Face', 'character', 1, 1, ?)",
      [U(2)]);
    expect(await danglingReferences(scratch.exec, registry)).toEqual([{
      entity: "entity_anchor", field: "subject_variant_id", rowId: 1,
      value: "1", target: "character_variant" }]);
  });

  test("a uuid stored as text in a reference column names no row",
      async () => {
    scratch = await fresh();
    await scratch.exec("INSERT INTO character (name, uuid) VALUES " +
                       "('ELEANOR', ?)", [U(1)]);
    await scratch.exec("INSERT INTO asset (name, identifier, uuid) VALUES " +
                       "('sheet', '@project/sheet.png', ?)", [U(2)]);
    await scratch.exec(
      "INSERT INTO asset_relationship (asset_id, entity_type, entity_id, " +
      "relationship_type, uuid) VALUES (1, 'character', ?, 'reference', ?)",
      [U(1), U(3)]);
    const found = await danglingReferences(scratch.exec, registry);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      entity: "asset_relationship", field: "entity_id", value: U(1) });
  });

  test("a reference to a cut row is not dangling: the row exists",
      async () => {
    scratch = await fresh();
    await scratch.exec("INSERT INTO scene (name, scene_number, uuid) " +
                       "VALUES ('INT. KITCHEN', '1', ?)", [U(1)]);
    await scratch.exec(
      "INSERT INTO character (name, lifecycle_status, uuid) " +
      "VALUES ('ROURKE', 'cut', ?)", [U(2)]);
    await scratch.exec(
      "INSERT INTO scene_character (scene_id, character_id, uuid) " +
      "VALUES (1, 1, ?)", [U(3)]);
    expect(await danglingReferences(scratch.exec, registry)).toEqual([]);
  });

  test("a polymorphic column whose sibling is unset, or names no " +
      "entity, is not this finding", async () => {
    scratch = await fresh();
    await scratch.exec("INSERT INTO theme (name, uuid) VALUES ('Guilt', ?)",
                       [U(1)]);
    await scratch.exec(
      "INSERT INTO thematic_connection (theme_id, entity_type, entity_id, " +
      "uuid) VALUES (1, NULL, 404, ?)", [U(2)]);
    await scratch.exec("INSERT INTO asset (name, identifier, uuid) VALUES " +
                       "('sheet', '@project/sheet.png', ?)", [U(3)]);
    await scratch.exec(
      "INSERT INTO asset_relationship (asset_id, entity_type, entity_id, " +
      "relationship_type, uuid) VALUES (1, 'charcter', 404, 'reference', ?)",
      [U(4)]);
    expect(await danglingReferences(scratch.exec, registry)).toEqual([]);
  });

  test("columns with a more specific code keep it, and only it",
      async () => {
    scratch = await fresh();
    await scratch.exec("INSERT INTO character (name, uuid) VALUES " +
                       "('ELEANOR', ?)", [U(1)]);
    await scratch.exec(
      "INSERT INTO character_relationship (character_a_id, " +
      "character_b_id, directionality, uuid) VALUES (1, 404, 'mutual', ?)",
      [U(2)]);
    await scratch.exec(
      "INSERT INTO act (name, act_number, start_scene_id, uuid) " +
      "VALUES ('One', 1, 404, ?)", [U(3)]);
    // A version chain naming a row that does not exist is the identity
    // codes' business (`identity.chain_asymmetric`).
    await scratch.exec(
      "INSERT INTO asset (name, identifier, parent_id, superseded_by_id, " +
      "uuid) VALUES ('plate', '@project/plate.exr', 404, 405, ?)", [U(4)]);
    expect(await danglingReferences(scratch.exec, registry)).toEqual([]);
    const codes = (await collectFindings(scratch.exec, registry)).findings
      .map((f) => f.code);
    expect(codes).toContain("relationship.endpoint_absent");
    expect(codes).toContain("structure.boundary_dangling");
    expect(codes).not.toContain("reference.dangling");
  });

  test("an optional reference is covered as a required one is",
      async () => {
    scratch = await fresh();
    await scratch.exec("INSERT INTO scene (name, scene_number, uuid) " +
                       "VALUES ('INT. KITCHEN', '1', ?)", [U(1)]);
    await scratch.exec(
      "INSERT INTO shot (scene_id, shot_number, story_beat_id, uuid) " +
      "VALUES (1, '1', 404, ?)", [U(2)]);
    const found = await danglingReferences(scratch.exec, registry);
    expect(found.map((d) => `${d.entity}.${d.field}`))
      .toEqual(["shot.story_beat_id"]);
  });
});
