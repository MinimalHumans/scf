// SPDX-License-Identifier: Apache-2.0
/**
 * Spec §12.15 — `relationships` on the dossier (proposal 0041).
 *
 * `character_relationship` is about both of its characters equally, so
 * the derived group walk never finds it and until this member existed
 * neither Q01 nor Q02 said who a relationship was with. Hollow Creek's
 * four relationships exercise both sides and both directionalities. None
 * of them has a cut, absent or repeated other party, so those three
 * rules are checked here on a COPY of the fixture; the fixture itself is
 * a checksummed artifact and is opened read-only everywhere else.
 */
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  loadRegistry, q01Result, q02Result, queryMarkdown, type Q01Result,
  type Registry, type ScfContext, type SqlExec,
} from "../src/index.ts";
import { openNodeDatabase } from "../src/node.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "..", "fixtures", "hollow_creek.scf");
const REGISTRY = join(HERE, "..", "registry", "registry.json");

const ELEANOR = 1;
const MARCUS = 2;
const ADA = 3;
const SHAW = 4;
const ROURKE = 5;         // cut in the fixture

let registry: Registry;
let sandbox: string;
let n = 0;

beforeAll(() => {
  registry = loadRegistry(JSON.parse(readFileSync(REGISTRY, "utf8")));
  sandbox = mkdtempSync(join(tmpdir(), "scf-dossier-"));
});
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

async function onCopy<T>(
    change: (exec: SqlExec) => Promise<unknown>,
    ask: (ctx: ScfContext) => Promise<T>): Promise<T> {
  n += 1;
  const path = join(sandbox, `case-${String(n)}.scf`);
  copyFileSync(FIXTURE, path);
  const db = openNodeDatabase(path, { readOnly: false });
  try {
    await change(db.exec);
    return await ask({ exec: db.exec, registry });
  } finally {
    db.close();
  }
}

const uuidOf = async (exec: SqlExec, table: string, id: number) =>
  String((await exec(`SELECT uuid FROM "${table}" WHERE id = ?`,
                     [id]))[0]!["uuid"]);

const dossier = async (
    ctx: ScfContext, kind: string, id: number): Promise<Q01Result> =>
  (await q01Result(ctx, kind, await uuidOf(ctx.exec, kind, id), id)).result;

/** `name/side/directionality`, the readable shape of an entry. */
const shape = (d: Q01Result): string[] =>
  d.relationships.map((r) =>
    `${String(r.other?.fields["name"] ?? null)}/${r.side}/` +
    `${String(r.relationship.fields["directionality"])}`);

describe("§12.15 — relationships in the dossier", () => {
  test("Eleanor's three, all from side a, in row order", async () => {
    const d = await onCopy(async () => {},
      (ctx) => dossier(ctx, "character", ELEANOR));
    expect(shape(d)).toEqual([
      "Marcus Cade/a/mutual", "Ada Cade/a/a_to_b", "Reverend Shaw/a/mutual"]);
  });

  test("the same relationship read from the other end is side b",
      async () => {
    const d = await onCopy(async () => {},
      (ctx) => dossier(ctx, "character", MARCUS));
    expect(shape(d)).toEqual(["Eleanor Cade/b/mutual", "Ada Cade/a/a_to_b"]);
    const ada = await onCopy(async () => {},
      (ctx) => dossier(ctx, "character", ADA));
    expect(shape(ada)).toEqual(
      ["Eleanor Cade/b/a_to_b", "Marcus Cade/b/a_to_b"]);
  });

  test("a row never carries a row id for either end (§12.1.2)",
      async () => {
    const d = await onCopy(async () => {},
      (ctx) => dossier(ctx, "character", ELEANOR));
    for (const r of d.relationships) {
      expect(Object.keys(r.relationship.fields))
        .not.toContain("character_a_id");
      expect(r.relationship.fields["character_b_id_uuid"] ??
             r.relationship.fields["character_b_uuid"]).toBeDefined();
    }
  });

  test("any other kind of subject carries an empty list, never an " +
      "absent member", async () => {
    const d = await onCopy(async () => {},
      (ctx) => dossier(ctx, "location", 1));
    expect(d.relationships).toEqual([]);
  });

  test("a relationship to a cut character is absent (§6.6.1)",
      async () => {
    const d = await onCopy(
      (exec) => exec(
        "INSERT INTO character_relationship (character_a_id, " +
        "character_b_id, relationship_type, directionality, uuid) " +
        "VALUES (?, ?, 'authority', 'a_to_b', " +
        "'00000000-0000-4000-8000-00000000c001')", [ROURKE, ELEANOR]),
      (ctx) => dossier(ctx, "character", ELEANOR));
    expect(d.relationships).toHaveLength(3);
    expect(shape(d).join(" ")).not.toContain("Rourke");
  });

  test("cutting the other party changes the answer", async () => {
    const d = await onCopy(
      (exec) => exec("UPDATE character SET lifecycle_status = 'cut' " +
                     "WHERE id = ?", [SHAW]),
      (ctx) => dossier(ctx, "character", ELEANOR));
    expect(shape(d)).toEqual(["Marcus Cade/a/mutual", "Ada Cade/a/a_to_b"]);
  });

  test("a cut relationship is absent like any cut row", async () => {
    const d = await onCopy(
      (exec) => exec("UPDATE character_relationship SET lifecycle_status " +
                     "= 'cut' WHERE id = 1"),
      (ctx) => dossier(ctx, "character", ELEANOR));
    expect(shape(d)).toEqual(["Ada Cade/a/a_to_b", "Reverend Shaw/a/mutual"]);
  });

  test("one whose other end names no row is kept, with other null " +
      "(§9.2)", async () => {
    const d = await onCopy(
      (exec) => exec("UPDATE character_relationship SET character_b_id = " +
                     "9001 WHERE id = 4"),
      (ctx) => dossier(ctx, "character", ELEANOR));
    expect(d.relationships).toHaveLength(3);
    expect(d.relationships[2]!.other).toBeNull();
    expect(d.relationships[2]!.side).toBe("a");
  });

  test("a relationship naming the subject twice appears once, as side " +
      "a, with other the subject", async () => {
    const d = await onCopy(
      (exec) => exec("UPDATE character_relationship SET character_b_id = " +
                     "? WHERE id = 4", [ELEANOR]),
      (ctx) => dossier(ctx, "character", ELEANOR));
    expect(shape(d)).toEqual([
      "Marcus Cade/a/mutual", "Ada Cade/a/a_to_b", "Eleanor Cade/a/mutual"]);
  });

  test("Q02 carries them in its dossier, and each relationship state " +
      "names one of them", async () => {
    await onCopy(async () => {}, async (ctx) => {
      const scenes = await ctx.exec(
        "SELECT id, uuid FROM scene WHERE lifecycle_status IS NOT 'cut' " +
        "ORDER BY id");
      const known = new Set<string>();
      let states = 0;
      for (const s of scenes) {
        const r = (await q02Result(
          ctx, "character", await uuidOf(ctx.exec, "character", ELEANOR),
          ELEANOR, String(s["uuid"]), Number(s["id"]), null, null)).result;
        expect(r.dossier.relationships).toHaveLength(3);
        for (const e of r.dossier.relationships) {
          if (e.relationship.uuid !== null) known.add(e.relationship.uuid);
        }
        for (const st of r.relationshipStates) {
          states += 1;
          expect(known.has(String(
            st.fields["character_relationship_uuid"]))).toBe(true);
        }
      }
      expect(states).toBeGreaterThan(0);
    });
  });

  test("the markdown reads the direction from the subject's own end",
      async () => {
    await onCopy(async () => {}, async (ctx) => {
      const eleanor = await q01Result(
        ctx, "character", await uuidOf(ctx.exec, "character", ELEANOR),
        ELEANOR);
      const md = queryMarkdown("Q01", eleanor, registry);
      expect(md).toContain("Relationships");
      expect(md).toContain("- Marcus Cade: family");
      expect(md).toContain("from this character to them");
      const ada = await q01Result(
        ctx, "character", await uuidOf(ctx.exec, "character", ADA), ADA);
      expect(queryMarkdown("Q01", ada, registry))
        .toContain("from them to this character");
    });
  });
});
