// SPDX-License-Identifier: Apache-2.0
/**
 * ops/integrityGate.ts — a write may not leave the file worse than it
 * found it.
 *
 * The editor reports integrity findings and never blocks on them
 * (conventions §1: findings, not enforcement) because a person is
 * looking at them. An agent is not, so a write made on its behalf is
 * held to one rule: it must not add a BLOCKING finding the file did not
 * already have. Findings the file already carried are not the write's
 * fault and do not block it.
 *
 * What blocks is a reference left pointing at nothing: a line anchor
 * whose line is gone (§3.5), or a reference column naming no row
 * (§9.4.1, `reference.dangling`, proposal 0040). Both are unambiguously
 * a file made worse.
 *
 * What does NOT block is a scene link for someone with no cue there. A
 * presence link is authored, not derived from the screenplay (§2.4.1,
 * proposal 0041): a character can be in a scene and say nothing, and the
 * format says so. That stays a question, returned beside the findings as
 * `noted` so the plan can put it to a person, and never a refusal.
 *
 * How it is done. The write runs inside one outer transaction on the
 * session's connection. The ops open transactions of their own, which
 * cannot nest, so while the gate is open their BEGIN/COMMIT/ROLLBACK are
 * turned into savepoints on the same connection — an op keeps its own
 * all-or-nothing behaviour, and the gate keeps the final say. After the
 * op, the findings are scanned again; any key that was not there before
 * rolls the whole thing back and names what the write would have caused.
 *
 * "Not there before" is by identity, not by count: a write that fixes
 * one finding and causes another leaves the total unchanged and is
 * still refused.
 */

import type { Row, SqlExec } from "../db.ts";
import type { ScfContext } from "../resolution.ts";
import { danglingReferences } from "../references.ts";
import { scanIntegrity } from "./integrity.ts";

export interface GateFinding {
  kind: "detached_tag" | "orphan_beat" | "orphan_anchor" |
    "dangling_reference";
  /** Stable across scans: `kind` plus the row it is about. */
  key: string;
  description: string;
}

/**
 * A question a write raises without being refused for it: a scene link
 * the script does not show a cue for (§2.4.1).
 */
export interface GateNote {
  kind: "unjustified_link";
  /** Stable across scans, as a finding's key is. */
  key: string;
  description: string;
}

interface GateScan {
  blocking: Map<string, GateFinding>;
  noted: Map<string, GateNote>;
}

export class IntegrityGateError extends Error {
  readonly added: GateFinding[];
  constructor(added: GateFinding[]) {
    super(`this change would add ${String(added.length)} integrity ` +
          `finding(s): ${added.map((f) => f.description).join("; ")}`);
    this.name = "IntegrityGateError";
    this.added = added;
  }
}

/** Every blocking finding the file has now, keyed by identity. */
export async function currentFindings(
    ctx: ScfContext): Promise<Map<string, GateFinding>> {
  return (await scanForGate(ctx)).blocking;
}

/** Every question the file raises now, keyed by identity. */
export async function currentNotes(
    ctx: ScfContext): Promise<Map<string, GateNote>> {
  return (await scanForGate(ctx)).noted;
}

async function scanForGate(ctx: ScfContext): Promise<GateScan> {
  // The lines on disk are the document: this runs on the host, where no
  // editor holds a newer one.
  const live = new Set((await ctx.exec(
    "SELECT uuid FROM screenplay_lines WHERE uuid IS NOT NULL"))
    .map((r: Row) => String(r["uuid"])));
  const report = await scanIntegrity(ctx.exec, live, ctx.registry);
  const out = new Map<string, GateFinding>();
  const add = (f: GateFinding): void => { out.set(f.key, f); };
  for (const t of report.detachedTags) {
    add({ kind: "detached_tag",
          key: `detached_tag:${String(t.id)}:${String(t.propId)}`,
          description: `prop tag "${t.taggedText}" (${t.propName}) lost ` +
                       "its line" });
  }
  for (const b of report.orphanBeats) {
    add({ kind: "orphan_beat", key: `orphan_beat:${String(b.id)}`,
          description: `beat "${b.name}" lost its line` });
  }
  for (const a of report.orphanAnchors) {
    add({ kind: "orphan_anchor",
          key: `orphan_anchor:${a.entity}.${a.field}:${String(a.rowId)}`,
          description: `${a.entity} ${String(a.rowId)} points at a line ` +
                       "that is gone" });
  }
  for (const d of await danglingReferences(ctx.exec, ctx.registry)) {
    add({ kind: "dangling_reference",
          // The value is part of the identity: re-pointing a dangling
          // reference at another row that is not there is a new finding.
          key: `dangling_reference:${d.entity}.${d.field}:` +
               `${String(d.rowId)}:${d.value}`,
          description: `${d.entity} ${String(d.rowId)}: ${d.field} names ` +
                       `no ${d.target} (${d.value})` });
  }
  const noted = new Map<string, GateNote>();
  for (const l of report.unjustifiedLinks) {
    const n: GateNote = { kind: "unjustified_link",
          // Who and where, not just the row: re-pointing a link at
          // someone else keeps its id and is a different finding.
          key: `unjustified_link:${String(l.id)}:` +
               `${String(l.sceneId)}:${String(l.characterId)}`,
          description: `${l.characterName} has no cue in scene ` +
                       `${l.sceneNumber ?? l.sceneName}` };
    noted.set(n.key, n);
  }
  return { blocking: out, noted };
}

const addedTo = <F extends { key: string }>(
    before: Map<string, F>, after: Map<string, F>): F[] =>
  [...after.values()].filter((f) => !before.has(f.key));

/**
 * A connection whose transaction statements are savepoints. Everything
 * else passes straight through, so row ids, last_insert_rowid() and
 * reads inside the write all behave as on the real connection.
 */
function savepointExec(base: SqlExec): SqlExec {
  let depth = 0;
  return async (sql, params) => {
    const s = sql.trim().replace(/;$/, "").toUpperCase();
    if (s === "BEGIN IMMEDIATE" || s === "BEGIN") {
      depth += 1;
      return base(`SAVEPOINT gate_${String(depth)}`);
    }
    if (s === "COMMIT") {
      const d = depth;
      depth -= 1;
      return base(`RELEASE gate_${String(d)}`);
    }
    if (s === "ROLLBACK") {
      const d = depth;
      depth -= 1;
      await base(`ROLLBACK TO gate_${String(d)}`);
      return base(`RELEASE gate_${String(d)}`);
    }
    return base(sql, params);
  };
}

/**
 * Run `run` and keep its changes only if it added no blocking finding.
 * Must be called from inside `Session.write` (it owns the connection
 * while it runs) and never from inside another transaction.
 */
export async function withIntegrityGate<T>(
    ctx: ScfContext,
    run: (inner: ScfContext) => Promise<T>): Promise<T> {
  await ctx.exec("BEGIN IMMEDIATE");
  try {
    const before = await currentFindings(ctx);
    const inner: ScfContext = {
      exec: savepointExec(ctx.exec), registry: ctx.registry,
    };
    const out = await run(inner);
    const added = addedTo(before, await currentFindings(ctx));
    if (added.length > 0) throw new IntegrityGateError(added);
    await ctx.exec("COMMIT");
    return out;
  } catch (e) {
    try {
      await ctx.exec("ROLLBACK");
    } catch {
      // the original error is the one that matters
    }
    throw e;
  }
}

/**
 * What `run` would do, without doing it: its result, the blocking
 * findings it would add, and the questions it would raise (`noted`).
 * Always rolled back. Must be called from `Session.write`
 * with `counts: false`, so the revision does not move.
 */
export async function dryRunThroughGate<T>(
    ctx: ScfContext,
    run: (inner: ScfContext) => Promise<T>): Promise<{
      result: T; added: GateFinding[]; noted: GateNote[] }> {
  await ctx.exec("BEGIN IMMEDIATE");
  try {
    const before = await scanForGate(ctx);
    const result = await run({
      exec: savepointExec(ctx.exec), registry: ctx.registry });
    const after = await scanForGate(ctx);
    return {
      result,
      added: addedTo(before.blocking, after.blocking),
      noted: addedTo(before.noted, after.noted),
    };
  } finally {
    try {
      await ctx.exec("ROLLBACK");
    } catch {
      // nothing was changed; there is nothing to lose
    }
  }
}
