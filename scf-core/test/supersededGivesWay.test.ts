// SPDX-License-Identifier: Apache-2.0
/**
 * supersededGivesWay.test.ts — §12.8: a superseded asset gives way to
 * its successor (proposal 0039).
 *
 * The published fixture's one version chain (`kitchen_night_plate_v1` →
 * `v2`) leaves v1 `active` and unbound, so an implementation that
 * ignores this rule passes every published case. This is the mirror
 * `cutChangesTheAnswer.test.ts` is for §6.6.1: **superseding a bound
 * asset MUST change the answer.**
 *
 * Every case mutates a COPY of the fixture in a temp file. The fixture
 * itself is a checksummed artifact and is opened read-only everywhere
 * else.
 *
 * The subject is Eleanor, asked for `visual_identity` with no position:
 * her baseline bundle carries `eleanor_fullbody_anchor.png` (asset 45)
 * and `eleanor_fullbody_turnaround.png` (46), and her verified face
 * anchor is on `eleanor_face_anchor.png` (43). `poster01_noText.png`
 * (52) and `poster01.png` (51) are in no bundle of hers, which makes
 * them successors nothing else carries.
 */
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  loadRegistry, q13Result, type Q13Reference, type Registry,
  type ScfContext, type SqlExec,
} from "../src/index.ts";
import { openNodeDatabase } from "../src/node.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "..", "fixtures", "hollow_creek.scf");
const REGISTRY = join(HERE, "..", "registry", "registry.json");

const OLD = 45;          // eleanor_fullbody_anchor.png, in her bundle
const CARRIED = 46;      // eleanor_fullbody_turnaround.png, same bundle
const FACE = 43;         // eleanor_face_anchor.png, her verified anchor
const ELSEWHERE = 52;    // poster01_noText.png, in none of her bundles
const FURTHER = 51;      // poster01.png, likewise

let registry: Registry;
let sandbox: string;
let n = 0;

beforeAll(() => {
  registry = loadRegistry(JSON.parse(readFileSync(REGISTRY, "utf8")));
  sandbox = mkdtempSync(join(tmpdir(), "scf-superseded-"));
});
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

/** Eleanor's references on a copy of the fixture, after `change`. */
async function references(
    change: (exec: SqlExec) => Promise<unknown> = async () => {},
): Promise<{ refs: Q13Reference[]; uuidOf: (id: number) => string }> {
  n += 1;
  const path = join(sandbox, `case-${String(n)}.scf`);
  copyFileSync(FIXTURE, path);
  const db = openNodeDatabase(path, { readOnly: false });
  try {
    await change(db.exec);
    const ctx: ScfContext = { exec: db.exec, registry };
    const who = (await db.exec(
      "SELECT id, uuid FROM character WHERE id = 1"))[0]!;
    const uuids = new Map((await db.exec("SELECT id, uuid FROM asset"))
      .map((r) => [Number(r["id"]), String(r["uuid"])]));
    const result = await q13Result(
      ctx, "character", String(who["uuid"]), 1, "visual_identity",
      null, null, null, null);
    return { refs: result.result.references,
             uuidOf: (id) => uuids.get(id)! };
  } finally {
    db.close();
  }
}

const supersede = (exec: SqlExec, id: number, by: number | null) =>
  exec("UPDATE asset SET lifecycle_status = 'superseded', " +
       "superseded_by_id = ? WHERE id = ?", [by, id]);

const named = (refs: Q13Reference[], uuid: string) =>
  refs.filter((r) => r.uuid === uuid);

describe("§12.8 — a superseded asset gives way to its successor", () => {
  test("the fixture as published: every reference is active and stands " +
      "in for nothing", async () => {
    const { refs, uuidOf } = await references();
    expect(named(refs, uuidOf(OLD))).toHaveLength(1);
    expect(named(refs, uuidOf(CARRIED))).toHaveLength(1);
    expect(named(refs, uuidOf(FACE))).toHaveLength(1);
    for (const r of refs) {
      expect(r.lifecycleStatus).toBe("active");
      expect(r.supersedes).toBeNull();
    }
  });

  test("superseding a bound asset changes the answer: its successor is " +
      "named in its place, in its role", async () => {
    const before = await references();
    const role = named(before.refs, before.uuidOf(OLD))[0]!.role;
    const { refs, uuidOf } = await references(
      (exec) => supersede(exec, OLD, ELSEWHERE));
    expect(named(refs, uuidOf(OLD))).toEqual([]);
    const standIn = named(refs, uuidOf(ELSEWHERE));
    expect(standIn).toHaveLength(1);
    expect(standIn[0]!.supersedes).toBe(uuidOf(OLD));
    expect(standIn[0]!.provenance).toBe("bundle");
    expect(standIn[0]!.role).toBe(role);
    expect(standIn[0]!.lifecycleStatus).toBe("active");
    expect(refs).toHaveLength(before.refs.length);
  });

  test("a successor another layer already carries appears once",
      async () => {
    const before = await references();
    const { refs, uuidOf } = await references(
      (exec) => supersede(exec, OLD, CARRIED));
    expect(named(refs, uuidOf(OLD))).toEqual([]);
    expect(named(refs, uuidOf(CARRIED))).toHaveLength(1);
    expect(refs).toHaveLength(before.refs.length - 1);
  });

  test("the chain is followed to its end, not one step", async () => {
    const { refs, uuidOf } = await references(async (exec) => {
      await supersede(exec, OLD, ELSEWHERE);
      await supersede(exec, ELSEWHERE, FURTHER);
    });
    expect(named(refs, uuidOf(OLD))).toEqual([]);
    expect(named(refs, uuidOf(ELSEWHERE))).toEqual([]);
    const last = named(refs, uuidOf(FURTHER));
    expect(last).toHaveLength(1);
    // It names the asset the layer brought, not the step before it.
    expect(last[0]!.supersedes).toBe(uuidOf(OLD));
  });

  test("an anchor's asset gives way too, and keeps the anchor's name",
      async () => {
    const before = await references();
    const anchorName = named(before.refs, before.uuidOf(FACE))[0]!.anchorName;
    expect(anchorName).not.toBeNull();
    const { refs, uuidOf } = await references(
      (exec) => supersede(exec, FACE, ELSEWHERE));
    expect(named(refs, uuidOf(FACE))).toEqual([]);
    const standIn = named(refs, uuidOf(ELSEWHERE))[0]!;
    expect(standIn.provenance).toBe("anchor");
    expect(standIn.anchorName).toBe(anchorName);
    expect(standIn.supersedes).toBe(uuidOf(FACE));
  });

  test("a cut successor is excluded like any cut row, and the reference " +
      "is dropped, not walked back", async () => {
    const before = await references();
    const { refs, uuidOf } = await references(async (exec) => {
      await supersede(exec, OLD, ELSEWHERE);
      await exec("UPDATE asset SET lifecycle_status = 'cut' WHERE id = ?",
                 [ELSEWHERE]);
    });
    expect(named(refs, uuidOf(OLD))).toEqual([]);
    expect(named(refs, uuidOf(ELSEWHERE))).toEqual([]);
    expect(refs).toHaveLength(before.refs.length - 1);
  });

  test("superseded with no successor stays, and says what it is",
      async () => {
    const { refs, uuidOf } = await references(
      (exec) => supersede(exec, OLD, null));
    const still = named(refs, uuidOf(OLD));
    expect(still).toHaveLength(1);
    expect(still[0]!.lifecycleStatus).toBe("superseded");
    expect(still[0]!.supersedes).toBeNull();
  });

  test("a successor that is not in the file, and a cycle, both leave " +
      "the reference as it is: the resolver is total", async () => {
    const dangling = await references(
      (exec) => supersede(exec, OLD, 99_999));
    expect(named(dangling.refs, dangling.uuidOf(OLD))).toHaveLength(1);
    const cycle = await references(async (exec) => {
      await supersede(exec, OLD, ELSEWHERE);
      await supersede(exec, ELSEWHERE, OLD);
    });
    expect(named(cycle.refs, cycle.uuidOf(OLD))).toHaveLength(1);
    expect(named(cycle.refs, cycle.uuidOf(ELSEWHERE))).toEqual([]);
  });

  test("an active row with a successor is untouched: the rule keys on " +
      "the status, the author's explicit claim", async () => {
    const { refs, uuidOf } = await references((exec) => exec(
      "UPDATE asset SET superseded_by_id = ? WHERE id = ?",
      [ELSEWHERE, OLD]));
    expect(named(refs, uuidOf(OLD))).toHaveLength(1);
    expect(named(refs, uuidOf(ELSEWHERE))).toEqual([]);
  });

  test("deprecated, archived and draft stay in force, labelled",
      async () => {
    for (const status of ["deprecated", "archived", "draft"]) {
      const { refs, uuidOf } = await references((exec) => exec(
        "UPDATE asset SET lifecycle_status = ? WHERE id = ?",
        [status, OLD]));
      const still = named(refs, uuidOf(OLD));
      expect(still).toHaveLength(1);
      expect(still[0]!.lifecycleStatus).toBe(status);
    }
  });
});
