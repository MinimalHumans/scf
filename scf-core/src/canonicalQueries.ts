// SPDX-License-Identifier: Apache-2.0
/**
 * canonicalQueries.ts — normative result builders for all sixteen
 * canonical queries. Spec §12.
 *
 * One envelope (§12.1.1) and one projection rule (§12.1.2) serve every
 * query, which is what makes a result portable between them.
 *
 * These WRAP the resolvers rather than reimplementing them. A second
 * description of "what is in force at scene 12" is a second answer.
 */

import type { ScfContext } from "./resolution.ts";
import {
  resolveDescription, resolveDirection, resolveMedia,
  type TrailExclusionCode,
} from "./resolution.ts";
import { mediaReferences } from "./mediaReferences.ts";
import { presenceAtScene, type Presence } from "./presence.ts";
import { projectScreenplayLines, sceneScriptLines }
  from "./screenplay/sceneScript.ts";
import { readinessReport } from "./readiness.ts";
import { byRelatedOrder } from "./relatedOrder.ts";
import { LINE_TYPES } from "./fountain/types.ts";
import type { FileLocator } from "./assets.ts";
import {
  columnRoles, envelope, projectRow, uuidLookupForAll,
  type ProjectedRow, type QueryResult, type UuidLookup,
} from "./queryResult.ts";

// ---------------------------------------------------------------------------
// Q05 — Voice direction
// ---------------------------------------------------------------------------

export interface Q05Result {
  modality: string;
  /**
   * The character's standing description. Null when none is authored —
   * a well-defined absence (§9.2), and the case the readiness report
   * exists to warn about, not an error.
   */
  baseline: ProjectedRow | null;
  /** States in force at this position, oldest first (§4.5 pattern 2). */
  states: ProjectedRow[];
  /**
   * States merged oldest-first, so a later state overrides an earlier
   * one key by key. The merged view is derived and carries no identity.
   */
  modulations: Record<string, unknown>;
  /** Beats authored for this character in this scene, in beat order. */
  beats: ProjectedRow[];
}

// No hand-written reference maps. `columnRoles(registry, entity)`
// derives them from the registry's own `referenceEntity` declarations,
// and `uuidLookupForAll` indexes every entity any of them can point at.
// Hand-maintained per-query maps drift apart — see columnRoles.
const refs = (ctx: ScfContext, entity: string): Record<string, string> =>
  columnRoles(ctx.registry, entity);

export async function q05Result(
    ctx: ScfContext, characterUuid: string, sceneUuid: string,
    characterId: number, sceneId: number,
): Promise<QueryResult<Q05Result>> {
  return descriptionResult("Q05", "vocal", ctx, characterUuid, sceneUuid,
                           characterId, sceneId);
}

/**
 * Q06 — Physical direction (§12.6).
 *
 * The same query as Q05 with a different modality, and it is worth
 * saying so in one function rather than two: the shape of the answer is
 * identical, and two copies would be two places for it to change.
 */
export async function q06Result(
    ctx: ScfContext, characterUuid: string, sceneUuid: string,
    characterId: number, sceneId: number,
): Promise<QueryResult<Q05Result>> {
  return descriptionResult("Q06", "physical", ctx, characterUuid,
                           sceneUuid, characterId, sceneId);
}

async function descriptionResult(
    query: string, modality: string,
    ctx: ScfContext, characterUuid: string, sceneUuid: string,
    characterId: number, sceneId: number,
): Promise<QueryResult<Q05Result>> {
  const resolved = await resolveDescription(
    ctx, characterId, await positionInFilm(ctx, sceneId) ?? sceneId,
    modality);
  const lookup = await uuidLookupForAll(ctx.exec, ctx.registry);

  return envelope(query, ctx.registry,
    { character: characterUuid, scene: sceneUuid },
    {
      modality: resolved.modality,
      baseline: resolved.profile === null
        ? null : projectRow(resolved.profile, refs(ctx, modality === "vocal"
            ? "vocal_profile" : "physical_character_profile"), lookup),
      states: resolved.states.map(
        (s) => projectRow(s, refs(ctx, "performance_state"), lookup)),
      modulations: resolved.modulations,
      beats: resolved.beats.map((b) => projectRow(b, refs(ctx, "performance_beat"), lookup)),
    });
}

// ---------------------------------------------------------------------------
// Q07 — Look resolution
// ---------------------------------------------------------------------------

export interface Q07Layer {
  /** The registry entity this layer came from. */
  entity: string;
  row: ProjectedRow;
}

export interface Q07Result {
  /**
   * The cascade's leaf (§7.1). Not derivable from the data — it is what
   * the query IS, and it changes when a shot is supplied.
   */
  leaf: string;
  /** Root first; the last layer is the opinion in force (§7.4). */
  layers: Q07Layer[];
}

/** §12.3.2 — the leaf depends on whether a shot was given. */
export const Q07_SCENE_LEAF = "scene_color_palette";
export const Q07_SHOT_LEAF = "shot_design";

export async function q07Result(
    ctx: ScfContext, sceneUuid: string, sceneId: number,
    shotUuid: string | null, shotId: number | null,
): Promise<QueryResult<Q07Result>> {
  const position = await sceneOfPosition(ctx, sceneId, shotId);
  return directionResult(
    "Q07", shotId === null ? Q07_SCENE_LEAF : Q07_SHOT_LEAF,
    ctx, sceneUuid, position ?? sceneId, shotUuid,
    position === NOWHERE ? null : shotId);
}

/** Q08 — Soundscape (§12.7). */
export const Q08_LEAF = "scene_music_design";

/**
 * Q08 takes no shot: sound is authored at the scene, and there is no
 * shot-level sound entity to be a leaf. §12.7 says so rather than
 * leaving an implementer to discover it by finding nothing.
 */
export async function q08Result(
    ctx: ScfContext, sceneUuid: string, sceneId: number,
): Promise<QueryResult<Q07Result>> {
  return directionResult("Q08", Q08_LEAF, ctx, sceneUuid,
                         await positionInFilm(ctx, sceneId) ?? sceneId,
                         null, null);
}

async function directionResult(
    query: string, leaf: string,
    ctx: ScfContext, sceneUuid: string, sceneId: number,
    shotUuid: string | null, shotId: number | null,
): Promise<QueryResult<Q07Result>> {
  const layers = await resolveDirection(ctx, leaf, sceneId, shotId);

  const lookup = await uuidLookupForAll(ctx.exec, ctx.registry);

  // Each layer projects by its OWN entity's column roles, like every
  // other result. A hand-written map here resolved four reference names
  // and knew nothing of `string_list`, so a palette's colours came out
  // as JSON text in Q07 and as an array in Q00 (§2.5).
  return envelope(query, ctx.registry,
    { scene: sceneUuid, shot: shotUuid },
    {
      leaf,
      layers: layers.map(([entity, row]) => ({
        entity, row: projectRow(row, refs(ctx, entity), lookup),
      })),
    });
}

// ---------------------------------------------------------------------------
// Composition — Q03 and Q12
//
// Q05 and Q07 wrap `resolveDescription` and `resolveDirection`, which
// already compose in the core. Q03 and Q12 compose HERE rather than in
// the app's runner, so that "who is present at a position and what is
// true of them" is derived once: the core composes ROWS, the runner
// renders them, the result projects them. One derivation, two
// consumers.
// ---------------------------------------------------------------------------

import { q } from "./db.ts";
import type { Row, SqlValue } from "./db.ts";
import {
  characterArcStateAt, excludeCut, motifStateAt, propStateAt,
  NOWHERE, byBeatOrder, positionInFilm, relationshipStateAt, rows, rowsIncludingCut,
  sceneOfPosition,
  sceneOrder, selectLocationVariant, statesInForce, variantInForce,
} from "./resolution.ts";
import { actOf, deriveStructure, sceneOrderHint, sequenceOf } from
  "./structure.ts";

const asId = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export interface Q03Composition {
  scene: Row | null;
  characters: Array<{
    character: Row; presence: Presence; variant: Row | null;
    states: Row[]; costumes: Row[];
  }>;
  props: Array<{
    prop: Row; presence: Presence; variant: Row | null; state: Row | null;
  }>;
  motifs: Row[];
}

/** Everything true at one position. Rows, not a result. */
export async function composeQ03(
    ctx: ScfContext, sceneId: number): Promise<Q03Composition> {
  sceneId = await positionInFilm(ctx, sceneId) ?? sceneId; // §12.1.7
  const order = await sceneOrder(ctx);
  const scene = (await rows(ctx.exec, "scene", "id = ?", [sceneId]))[0]
    ?? null;

  const atScene = await presenceAtScene(ctx, sceneId);
  const characters: Q03Composition["characters"] = [];
  for (const link of await rows(ctx.exec, "scene_character",
                                "scene_id = ?", [sceneId])) {
    const cid = asId(link["character_id"]);
    if (cid === null) continue;
    const character = (await rows(ctx.exec, "character", "id = ?",
                                  [cid]))[0];
    if (character === undefined) continue;
    characters.push({
      character,
      presence: atScene.character.get(cid) ?? "seen",
      variant: await variantInForce(ctx, "character", cid, sceneId),
      states: await statesInForce(ctx, cid, sceneId, null, order),
      // In the row order of the costume_scene links (§12.4), stated:
      // a join's order is the query plan's otherwise.
      costumes: excludeCut(await ctx.exec(
        "SELECT c.* FROM costume_scene cs JOIN costume c " +
        "ON c.id = cs.costume_id WHERE cs.scene_id = ? " +
        "AND c.character_id = ? ORDER BY cs.id", [sceneId, cid])),
    });
  }

  const props: Q03Composition["props"] = [];
  for (const link of await rows(ctx.exec, "scene_prop", "scene_id = ?",
                                [sceneId])) {
    const pid = asId(link["prop_id"]);
    if (pid === null) continue;
    const prop = (await rows(ctx.exec, "prop", "id = ?", [pid]))[0];
    if (prop === undefined) continue;
    props.push({
      prop, presence: atScene.prop.get(pid) ?? "seen",
      variant: await variantInForce(ctx, "prop", pid, sceneId),
      state: await propStateAt(ctx, pid, sceneId, order),
    });
  }

  // The junction carries no lifecycle_status and cannot; the motif can.
  // Selecting m.name rather than m.* means the filter needs the column,
  // so it is selected explicitly and dropped after.
  const motifs = excludeCut(await ctx.exec(
    "SELECT m.name, m.lifecycle_status, a.domain, a.id " +
    "FROM motif_appearance a " +
    "JOIN motif m ON m.id = a.motif_id WHERE a.scene_id = ? " +
    "ORDER BY a.id", [sceneId]))
    .map(({ lifecycle_status: _drop, ...rest }) => rest);

  return { scene, characters, props, motifs };
}

export interface Q12Composition {
  a: Row | null;
  b: Row | null;
  characters: Array<{
    character: Row; presenceA: Presence | null; presenceB: Presence | null;
    variantA: string | null; variantB: string | null;
    statesA: string[]; statesB: string[];
  }>;
  relationships: Array<{
    relationship: Row; stageA: string | null; stageB: string | null;
  }>;
  props: Array<{
    prop: Row; presenceA: Presence | null; presenceB: Presence | null;
    variantA: string | null; variantB: string | null;
    whereA: string | null; whereB: string | null;
  }>;
}

/**
 * The variant in force (§4.8) by NAME, for Q12 — which reports what
 * changes between two positions as labels, as it does states and stages.
 */
async function variantName(ctx: ScfContext, subject: string, id: number,
                           sceneId: number): Promise<string | null> {
  const v = await variantInForce(ctx, subject, id, sceneId);
  return v === null ? null : String(v["name"]);
}

/** The state diff between two positions. Rows, not a result. */
export async function composeQ12(
    ctx: ScfContext, a: number, b: number): Promise<Q12Composition> {
  // §12.1.7: a cut side is an empty position, diffed like any other.
  a = await positionInFilm(ctx, a) ?? a;
  b = await positionInFilm(ctx, b) ?? b;
  const order = await sceneOrder(ctx);
  const sceneA = (await rows(ctx.exec, "scene", "id = ?", [a]))[0] ?? null;
  const sceneB = (await rows(ctx.exec, "scene", "id = ?", [b]))[0] ?? null;
  const atA = await presenceAtScene(ctx, a);
  const atB = await presenceAtScene(ctx, b);

  const characters: Q12Composition["characters"] = [];
  // Both positions' links pooled in row-id order, each character at its
  // first (§12.5). DISTINCT alone leaves the order to the query plan.
  for (const c of await ctx.exec(
      "SELECT character_id FROM scene_character " +
      "WHERE scene_id IN (?, ?) GROUP BY character_id ORDER BY MIN(id)",
      [a, b])) {
    const cid = asId(c["character_id"]);
    if (cid === null) continue;
    const character = (await rows(ctx.exec, "character", "id = ?",
                                  [cid]))[0];
    if (character === undefined) continue;
    characters.push({
      character,
      presenceA: atA.character.get(cid) ?? null,
      presenceB: atB.character.get(cid) ?? null,
      variantA: await variantName(ctx, "character", cid, a),
      variantB: await variantName(ctx, "character", cid, b),
      statesA: (await statesInForce(ctx, cid, a, null, order))
        .map((s) => String(s["name"])),
      statesB: (await statesInForce(ctx, cid, b, null, order))
        .map((s) => String(s["name"])),
    });
  }

  const relationships: Q12Composition["relationships"] = [];
  for (const rel of await rows(ctx.exec, "character_relationship")) {
    const rid = asId(rel["id"]);
    if (rid === null) continue;
    const sa = await relationshipStateAt(ctx, rid, a, order);
    const sb = await relationshipStateAt(ctx, rid, b, order);
    if (sa === null && sb === null) continue;
    relationships.push({
      relationship: rel,
      stageA: sa === null ? null : String(sa["stage_label"] ?? ""),
      stageB: sb === null ? null : String(sb["stage_label"] ?? ""),
    });
  }

  const props: Q12Composition["props"] = [];
  for (const prop of await rows(ctx.exec, "prop")) {
    const pid = asId(prop["id"]);
    if (pid === null) continue;
    const pa = await propStateAt(ctx, pid, a, order);
    const pb = await propStateAt(ctx, pid, b, order);
    if (pa === null && pb === null) continue;
    props.push({
      prop,
      presenceA: atA.prop.get(pid) ?? null,
      presenceB: atB.prop.get(pid) ?? null,
      variantA: await variantName(ctx, "prop", pid, a),
      variantB: await variantName(ctx, "prop", pid, b),
      whereA: pa === null ? null : String(pa["whereabouts"] ?? ""),
      whereB: pb === null ? null : String(pb["whereabouts"] ?? ""),
    });
  }

  return { a: sceneA, b: sceneB, characters, relationships, props };
}

// ---------------------------------------------------------------------------
// Q03 — World state (§12.4)
// ---------------------------------------------------------------------------

export interface Q03Result {
  scene: ProjectedRow | null;
  characters: Array<{
    character: ProjectedRow;
    /** Seen, heard or named at this position, §2.4.1. */
    presence: Presence;
    /** The variant in force here (§4.8), or null. */
    variant: ProjectedRow | null;
    states: ProjectedRow[];
    costumes: ProjectedRow[];
  }>;
  props: Array<{
    prop: ProjectedRow; presence: Presence; variant: ProjectedRow | null;
    state: ProjectedRow | null;
  }>;
  motifs: Array<{ name: string; domain: string | null }>;
}


export async function q03Result(
    ctx: ScfContext, sceneUuid: string, sceneId: number,
): Promise<QueryResult<Q03Result>> {
  const c = await composeQ03(ctx, sceneId);
  const lookup = await uuidLookupForAll(ctx.exec, ctx.registry);

  return envelope("Q03", ctx.registry, { scene: sceneUuid }, {
    scene: c.scene === null ? null : projectRow(c.scene, refs(ctx, "scene"), lookup),
    characters: c.characters.map((x) => ({
      character: projectRow(x.character, refs(ctx, "character"), lookup),
      presence: x.presence,
      variant: x.variant === null
        ? null : projectRow(x.variant, refs(ctx, "character_variant"), lookup),
      states: x.states.map((s) => projectRow(s, refs(ctx, "performance_state"), lookup)),
      costumes: x.costumes.map((s) => projectRow(s, refs(ctx, "costume"), lookup)),
    })),
    props: c.props.map((x) => ({
      prop: projectRow(x.prop, refs(ctx, "prop"), lookup),
      presence: x.presence,
      variant: x.variant === null
        ? null : projectRow(x.variant, refs(ctx, "prop_variant"), lookup),
      state: x.state === null
        ? null : projectRow(x.state, refs(ctx, "prop_state"), lookup),
    })),
    // Motifs arrive from a join, not a table, so they carry no identity
    // of their own here — name and domain are the whole fact.
    motifs: c.motifs.map((m) => ({
      name: String(m["name"]),
      domain: m["domain"] === null || m["domain"] === undefined
        ? null : String(m["domain"]),
    })),
  });
}

// ---------------------------------------------------------------------------
// Q12 — Continuity (§12.5)
// ---------------------------------------------------------------------------

export interface Q12Result {
  from: ProjectedRow | null;
  to: ProjectedRow | null;
  characters: Array<{
    character: ProjectedRow;
    /** Presence at each position (§2.4.1); null where not linked there. */
    presenceFrom: Presence | null; presenceTo: Presence | null;
    /** The variant in force at each position (§4.8), by name; or null. */
    variantFrom: string | null; variantTo: string | null;
    statesFrom: string[]; statesTo: string[];
  }>;
  relationships: Array<{
    relationship: ProjectedRow;
    stageFrom: string | null; stageTo: string | null;
  }>;
  props: Array<{
    prop: ProjectedRow;
    presenceFrom: Presence | null; presenceTo: Presence | null;
    variantFrom: string | null; variantTo: string | null;
    whereFrom: string | null; whereTo: string | null;
  }>;
}


export async function q12Result(
    ctx: ScfContext, fromUuid: string, toUuid: string,
    fromId: number, toId: number,
): Promise<QueryResult<Q12Result>> {
  const c = await composeQ12(ctx, fromId, toId);
  const lookup = await uuidLookupForAll(ctx.exec, ctx.registry);

  return envelope("Q12", ctx.registry, { from: fromUuid, to: toUuid }, {
    from: c.a === null ? null : projectRow(c.a, refs(ctx, "scene"), lookup),
    to: c.b === null ? null : projectRow(c.b, refs(ctx, "scene"), lookup),
    characters: c.characters.map((x) => ({
      character: projectRow(x.character, refs(ctx, "character"), lookup),
      presenceFrom: x.presenceA, presenceTo: x.presenceB,
      variantFrom: x.variantA, variantTo: x.variantB,
      statesFrom: x.statesA, statesTo: x.statesB,
    })),
    relationships: c.relationships.map((x) => ({
      relationship: projectRow(x.relationship, refs(ctx, "character_relationship"), lookup),
      stageFrom: x.stageA, stageTo: x.stageB,
    })),
    props: c.props.map((x) => ({
      prop: projectRow(x.prop, refs(ctx, "prop"), lookup),
      presenceFrom: x.presenceA, presenceTo: x.presenceB,
      variantFrom: x.variantA, variantTo: x.variantB,
      whereFrom: x.whereA, whereTo: x.whereB,
    })),
  });
}

// ---------------------------------------------------------------------------
// Q13 — Media resolution (§12.8)
// ---------------------------------------------------------------------------

export interface Q13Reference {
  /** The asset's identity. Never its row id — §12.1.2. */
  uuid: string | null;
  name: string | null;
  /** For an anchor, the anchor's own name. Null otherwise. */
  anchorName: string | null;
  identifier: string | null;
  format: string | null;
  role: string | null;
  intent: string;
  provenance: string;
  state: string;
  /** Why, for anything not `resolved`. */
  detail: string | null;
  sizeBytes: number | null;
  /** The asset's `lifecycle_status`, unset read as `active` (§12.8). */
  lifecycleStatus: string;
  /** The superseded asset this one stands in for, by uuid, or null. */
  supersedes: string | null;
}

/**
 * One layer the cascade considered (§12.8): a binding, an anchor or a
 * shot override, by identity, with the bundle it brings and, when it
 * did not contribute, why. `excluded.reason` is prose and is not
 * compared (conformance.md §6.1); everything else is.
 */
export interface Q13TrailEntry {
  layer: "binding" | "anchor" | "shot override";
  uuid: string | null;
  name: string | null;
  bundle: { uuid: string | null; name: string | null } | null;
  excluded: { by: TrailExclusionCode; value: string | null;
              reason: string } | null;
}

export interface Q13Result {
  /**
   * The subject's KIND — "character", "location", "prop" — not its uuid.
   * Named `subjectKind` and not `subject` because the envelope's
   * `subject` IS a uuid (§12.1.1), four lines away.
   *
   * It stays in the body rather than moving wholly to the envelope
   * because §12.16 nests this result WITHOUT its envelope, and the
   * nested copy has to remain self-describing.
   */
  subjectKind: string;
  intent: string;
  /**
   * The cascade trail, BROADEST FIRST — spec §12.8, matching §7.4's
   * root-first convention. Runs opposite to `references` below, which
   * is most specific first so the opinion in force is at the top.
   */
  trail: Q13TrailEntry[];
  references: Q13Reference[];
  /** How many references landed in each resolution state (§8.3). */
  counts: Record<string, number>;
  /**
   * Whether the answering session had a root mapping at all. Without
   * one every reference is `unaddressed` (§0.3, §8.3), and that is a
   * fact about the session, not about the file.
   */
  rootMapped: boolean;
}

const str = (v: unknown): string | null =>
  v === null || v === undefined || v === "" ? null : String(v);

/** Resolves nothing. The state of a `.scf` opened on its own (§0.3). */
const NO_ROOT: FileLocator = async () => undefined;

export async function q13Result(
    ctx: ScfContext, subject: string, subjectUuid: string,
    subjectId: number, intent: string,
    sceneUuid: string | null, sceneId: number | null,
    shotUuid: string | null, shotId: number | null,
    locate: FileLocator = NO_ROOT, rootMapped = false,
): Promise<QueryResult<Q13Result>> {
  // §12.1.7: a shot asked without a scene is a position, at its own
  // scene. The envelope still records what was asked (§12.1.1).
  const position = await sceneOfPosition(ctx, sceneId, shotId);
  const media = await resolveMedia(ctx, subject, subjectId, intent,
                                   position,
                                   position === NOWHERE ? null : shotId);
  const refs = await mediaReferences(media, locate);

  // `subjectType` and `intent` belong in the ENVELOPE, not only in the
  // body: §12.1.1 says parameters record what was asked, and both were
  // asked and both change the answer. `intent` especially — it is a
  // literal that also appears in the RESULT, so leaving it out of the
  // envelope means reading the answer to learn the question.
  return envelope("Q13", ctx.registry, {
    subjectType: subject, subject: subjectUuid,
    intent, scene: sceneUuid, shot: shotUuid,
  }, {
    subjectKind: subject,
    intent,
    trail: media.trail.map((t) => ({
      layer: t.layer,
      uuid: str(t.row["uuid"]),
      name: str(t.row["name"]),
      bundle: t.bundle === null ? null
        : { uuid: str(t.bundle["uuid"]), name: str(t.bundle["name"]) },
      excluded: t.excluded === null ? null : { ...t.excluded },
    })),
    references: refs.references.map((r) => ({
      // The uuid comes from the reference itself, never from looking
      // its row id up in a table. An anchor's row id resolved against
      // `asset` returns an unrelated asset sharing that id — and a
      // well-formed uuid, so portability tests pass anyway.
      uuid: r.uuid,
      anchorName: r.anchorName,
      name: r.name,
      identifier: r.identifier,
      format: r.format,
      role: r.role,
      intent: r.intent,
      provenance: r.provenance,
      state: r.state,
      detail: r.detail,
      sizeBytes: r.sizeBytes,
      lifecycleStatus: r.lifecycleStatus,
      supersedes: r.supersedes,
    })),
    counts: { ...refs.summary.counts },
    rootMapped,
  });
}

// ---------------------------------------------------------------------------
// Q14 — Readiness (§12.9)
// ---------------------------------------------------------------------------

export interface Q14Result {
  /** The query this report is about, e.g. "Q05". */
  target: string;
  targetName: string;
  findings: Array<{ severity: string; entity: string; message: string }>;
  counts: Record<string, number>;
}

/**
 * A Q14 subject of any kind (§12.9): what Q02 and Q13 are asked about —
 * Q13's a costume too (§12.8).
 * `character` remains the parameter for the character-only targets.
 */
export interface Q14Subject {
  type: "character" | "prop" | "location" | "costume";
  uuid: string;
  id: number;
}

export async function q14Result(
    ctx: ScfContext, target: string,
    characterUuid: string | null, characterId: number | null,
    sceneUuid: string | null, sceneId: number | null,
    shotUuid: string | null, shotId: number | null,
    subject: Q14Subject | null = null, intent: string | null = null,
): Promise<QueryResult<Q14Result>> {
  // A character given as `character` is the subject of a Q02 or Q13
  // asked without `subject`, so the old form keeps answering.
  const subjectKind = subject?.type
    ?? (characterId !== null ? "character" : undefined);
  const subjectId = subject?.id ?? characterId ?? undefined;
  const report = await readinessReport(ctx, target, {
    character_id: characterId ?? undefined,
    scene_id: sceneId ?? undefined,
    shot_id: shotId ?? undefined,
    subject: subjectKind,
    subject_id: subjectId,
    intent: intent ?? undefined,
  });

  // `report.params` carries the row ids it was called with. They do not
  // travel (§6.2), so the envelope carries the uuids instead and the
  // raw params are dropped rather than passed through.
  return envelope("Q14", ctx.registry, {
    target, character: characterUuid,
    subjectType: subject?.type ?? null, subject: subject?.uuid ?? null,
    intent, scene: sceneUuid, shot: shotUuid,
  }, {
    target: report.query,
    targetName: report.meta.name,
    findings: report.findings.map((f) => ({
      severity: f.severity, entity: f.entity, message: f.message,
    })),
    counts: { ...report.counts },
  });
}

// ---------------------------------------------------------------------------
// Q09 — Motif manifest (§12.10)
// ---------------------------------------------------------------------------

/**
 * Above this many motifs in one scene, a manifest reports density.
 *
 * It is a HEURISTIC and the result says so: it is not a finding, not a
 * constraint, and not a claim that the scene is wrong. §9.1 — SCF
 * describes. The number lives here rather than in the app because the
 * flag is part of the answer, and two thresholds would be two answers.
 */
export const MOTIF_DENSITY_THRESHOLD = 3;

export interface Q09Result {
  scene: ProjectedRow | null;
  manifest: Array<{
    motif: ProjectedRow | null;
    appearance: ProjectedRow;
    /** The motif's evolved state at this position, by pattern 3. */
    state: ProjectedRow | null;
  }>;
  /** Related motifs NOT placed here — candidates, never obligations. */
  candidates: ProjectedRow[];
  dense: boolean;
  densityThreshold: number;
}


export async function q09Result(
    ctx: ScfContext, sceneUuid: string, sceneId: number,
): Promise<QueryResult<Q09Result>> {
  sceneId = await positionInFilm(ctx, sceneId) ?? sceneId; // §12.1.7
  const order = await sceneOrder(ctx);
  const scene = (await rows(ctx.exec, "scene", "id = ?", [sceneId]))[0]
    ?? null;
  const appearances = await rows(ctx.exec, "motif_appearance",
                                 "scene_id = ?", [sceneId]);
  const lookup = await uuidLookupForAll(ctx.exec, ctx.registry);

  const manifest: Array<{ motif: Row | null; appearance: Row;
                          state: Row | null }> = [];
  const present = new Set<number>();
  for (const appearance of appearances) {
    const mid = asId(appearance["motif_id"]);
    const motif = mid === null
      ? null : (await rows(ctx.exec, "motif", "id = ?", [mid]))[0] ?? null;
    if (mid !== null) present.add(mid);
    manifest.push({
      motif, appearance,
      state: mid === null
        ? null : await motifStateAt(ctx, mid, sceneId, order),
    });
  }

  // If the door is in frame, the chime is a candidate. A related motif
  // already placed here is not a candidate — it is present.
  const candidates: Row[] = [];
  for (const { motif } of manifest) {
    const related = asId(motif?.["related_motif_id"]);
    if (related === null || present.has(related)) continue;
    const r = (await rows(ctx.exec, "motif", "id = ?", [related]))[0];
    if (r !== undefined && !candidates.some((c) => c["id"] === r["id"])) {
      candidates.push(r);
    }
  }

  return envelope("Q09", ctx.registry, { scene: sceneUuid }, {
    scene: scene === null ? null : projectRow(scene, refs(ctx, "scene"), lookup),
    manifest: manifest.map((m) => ({
      motif: m.motif === null
        ? null : projectRow(m.motif, refs(ctx, "motif"), lookup),
      appearance: projectRow(m.appearance, refs(ctx, "motif_appearance"), lookup),
      state: m.state === null
        ? null : projectRow(m.state, refs(ctx, "motif_state"), lookup),
    })),
    candidates: candidates.map((c) => projectRow(c, refs(ctx, "motif"), lookup)),
    dense: manifest.length > MOTIF_DENSITY_THRESHOLD,
    densityThreshold: MOTIF_DENSITY_THRESHOLD,
  });
}

// ---------------------------------------------------------------------------
// Q10 — Thematic accounting (§12.11)
// ---------------------------------------------------------------------------

export interface Q10Result {
  theme: ProjectedRow | null;
  carriers: Array<{
    connection: ProjectedRow;
    /** What carries the theme: an entity kind and that row's uuid. */
    targetEntity: string;
    targetUuid: string | null;
    targetName: string | null;
    /** Scenes this carrier reaches, in story order, as uuids. */
    sceneUuids: string[];
  }>;
  /**
   * Every scene in story order with how many carriers reach it. The
   * zeroes are the point: this query answers "where is this theme NOT",
   * and a spine that only listed the hits could not say.
   */
  spine: Array<{ sceneUuid: string; sceneNumber: string | null;
                 carriers: number }>;
}


/**
 * The scenes a subject is PLACED IN, read from the registry rather than
 * from a list of entity kinds (§12.11).
 *
 * Two shapes place a subject, and only these two:
 *
 *   a LINK entity (registry `subject: link`) declaring both `scene_id`
 *   and `<subject>_id` — scene_character, scene_prop, motif_appearance,
 *   costume_scene;
 *
 *   `scene` declaring a reference to the subject — `scene.location_id`.
 *
 * A link ASSERTS presence; that is what a link is. Everything else that
 * happens to name both a scene and a subject DESCRIBES the subject
 * there — `performance_beat`, `prop_state`, `makeup_hair_design` — and
 * describing a subject in a scene is not the same claim as placing it.
 * The distinction is the registry's own `subject` field, so a new
 * placement junction is covered the day it is declared and a new design
 * entity is not (conventions §2).
 *
 * Cut rows are excluded by `rows()` (§6.6.1), and a cut SCENE is
 * dropped by the caller's story-order filter.
 */
async function placedAt(
    ctx: ScfContext, subjectEntity: string, subjectId: number,
): Promise<number[]> {
  const column = `${subjectEntity}_id`;
  const out: number[] = [];

  const sceneDef = ctx.registry.entities.get("scene");
  if (sceneDef?.fields.some(
    (f) => f.name === column && f.referenceEntity === subjectEntity)) {
    for (const scene of await rows(ctx.exec, "scene", `${q(column)} = ?`,
                                   [subjectId])) {
      const sid = asId(scene["id"]);
      if (sid !== null) out.push(sid);
    }
  }

  for (const name of ctx.registry.order) {
    const def = ctx.registry.entities.get(name);
    if (def === undefined || def.subject !== "link") continue;
    const names = new Set(def.fields.map((f) => f.name));
    if (!names.has("scene_id") || !names.has(column)) continue;
    for (const link of await rows(ctx.exec, name, `${q(column)} = ?`,
                                  [subjectId])) {
      const sid = asId(link["scene_id"]);
      if (sid !== null) out.push(sid);
    }
  }
  return out;
}

export async function q10Result(
    ctx: ScfContext, themeUuid: string, themeId: number,
): Promise<QueryResult<Q10Result>> {
  const order = await sceneOrder(ctx);
  const theme = (await rows(ctx.exec, "theme", "id = ?", [themeId]))[0]
    ?? null;

  const scenes = (await rows(ctx.exec, "scene"))
    .filter((s) => order.has(asId(s["id"]) ?? -1))
    .sort((a, b) => (order.get(asId(a["id"]) ?? -1) ?? 0) -
                    (order.get(asId(b["id"]) ?? -1) ?? 0));

  const lookup = await uuidLookupForAll(ctx.exec, ctx.registry);

  const counts = new Map<number, number>();
  const carriers: Q10Result["carriers"] = [];

  for (const connection of await rows(ctx.exec, "thematic_connection",
                                      "theme_id = ?", [themeId])) {
    const targetEntity = String(connection["entity_type"] ?? "");
    const targetId = asId(connection["entity_id"]);
    let targetName: string | null = null;
    const sceneIds: number[] = [];

    if (targetId !== null && ctx.registry.entities.has(targetEntity)) {
      // §6.6.1: a link whose endpoint is cut joins nothing, so a
      // connection to a cut row is not a carrier at all — dropped, not
      // kept with no scenes. An ABSENT target is different: the
      // connection is still in the film, dangling, and stays (§12.11).
      const cut = (await rowsIncludingCut(ctx.exec, targetEntity, "id = ?",
                                          [targetId]))[0];
      if (cut !== undefined && excludeCut([cut]).length === 0) continue;
      const target = (await rows(ctx.exec, targetEntity, "id = ?",
                                 [targetId]))[0];
      targetName = target?.["name"] === undefined || target["name"] === null
        ? null : String(target["name"]);

      if (targetEntity === "scene") {
        sceneIds.push(targetId);
      } else if (targetEntity === "act" || targetEntity === "sequence") {
        // A span carries the theme at every scene of its DERIVED
        // membership (§5.1), so a scene moved between acts moves its
        // count with it and nothing is stored twice.
        const structure = await spanMembership(ctx);
        const of = targetEntity === "act"
          ? structure.actOfScene : structure.sequenceOfScene;
        for (const [sid, spanId] of of) {
          if (spanId === targetId) sceneIds.push(sid);
        }
      } else {
        sceneIds.push(...await placedAt(ctx, targetEntity, targetId));
      }
    }

    // A carrier reaching a cut scene reaches nowhere (§6.6.1), so the
    // spine and the count agree.
    const reached = sceneIds.filter((sid) => order.has(sid));
    for (const sid of reached) counts.set(sid, (counts.get(sid) ?? 0) + 1);

    carriers.push({
      connection: projectRow(connection, refs(ctx, "thematic_connection"), lookup),
      targetEntity,
      targetUuid: lookup(targetEntity, targetId),
      targetName,
      sceneUuids: [...reached]
        .sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
        .map((sid) => lookup("scene", sid) ?? "")
        .filter((u) => u !== ""),
    });
  }

  return envelope("Q10", ctx.registry, { theme: themeUuid }, {
    theme: theme === null ? null : projectRow(theme, refs(ctx, "theme"), lookup),
    carriers,
    spine: scenes.map((s) => {
      const sid = asId(s["id"]) ?? -1;
      return {
        sceneUuid: String(s["uuid"] ?? ""),
        sceneNumber: s["scene_number"] === null ||
                     s["scene_number"] === undefined
          ? null : String(s["scene_number"]),
        carriers: counts.get(sid) ?? 0,
      };
    }),
  });
}

// ---------------------------------------------------------------------------
// Q00 — Brief (§12.12)
// ---------------------------------------------------------------------------

/**
 * The project-level layers a brief reports, in the order it reports
 * them. Broadest first, matching §7.4 — a brief reads as an
 * explanation, not as a ranked answer.
 *
 * A fixed list rather than a derived one, and deliberately so: this is
 * an editorial choice about what a brief IS, not a fact the registry
 * knows. Adding an entity here is a change to §12.12.
 */
export const Q00_LAYERS = [
  "project", "project_vision", "project_tone", "visual_identity",
  "project_color_palette", "cinematographic_philosophy", "sonic_identity",
  "look_development", "costume_design_philosophy", "technical_specs",
] as const;

export interface Q00Result {
  layers: Array<{ entity: string; row: ProjectedRow }>;
  themes: ProjectedRow[];
  /**
   * The film's key art: assets related to the project row as `poster`,
   * projected, in §8.6's order. The first is the poster; any after it
   * are alternatives. Empty when none is related (proposal 0038).
   */
  posters: ProjectedRow[];
}

export async function q00Result(
    ctx: ScfContext): Promise<QueryResult<Q00Result>> {
  const lookup = await uuidLookupForAll(ctx.exec, ctx.registry);
  const layers: Q00Result["layers"] = [];
  let projectId: SqlValue = null;
  for (const entity of Q00_LAYERS) {
    const row = (await rows(ctx.exec, entity))[0];
    // An unauthored layer is absent, not present and empty (§12.3.2's
    // rule, applied here for the same reason).
    if (row === undefined) continue;
    if (entity === "project") projectId = row["id"] ?? null;
    layers.push({ entity, row: projectRow(row, refs(ctx, entity), lookup) });
  }
  const posters: ProjectedRow[] = [];
  if (projectId !== null && ctx.registry.entities.has("asset_relationship")) {
    const links = await rows(ctx.exec, "asset_relationship",
      "entity_type = 'project' AND entity_id = ? " +
      "AND relationship_type = 'poster'", [projectId]);
    for (const link of links.sort(byRelatedOrder)) {
      const asset = (await rows(ctx.exec, "asset", "id = ?",
                                [link["asset_id"] ?? null]))[0];
      if (asset !== undefined) {
        posters.push(projectRow(asset, refs(ctx, "asset"), lookup));
      }
    }
  }
  return envelope("Q00", ctx.registry, {}, {
    layers,
    themes: (await rows(ctx.exec, "theme"))
      .map((t) => projectRow(t, refs(ctx, "theme"), lookup)),
    posters,
  });
}

// ---------------------------------------------------------------------------
// Q11 — Audience state (§12.13)
// ---------------------------------------------------------------------------

export interface Q11Result {
  scene: ProjectedRow | null;
  /** What the audience knows here, if authored. */
  information: ProjectedRow | null;
  identification: {
    row: ProjectedRow;
    primary: ProjectedRow | null;
    secondary: ProjectedRow | null;
  } | null;
  emotionalBeats: Array<{ beat: ProjectedRow; arc: ProjectedRow | null }>;
  toneMarkers: ProjectedRow[];
  /** The emotional-design cascade, root first (§7.4). */
  emotionalCascade: Array<{ entity: string; row: ProjectedRow }>;
}

export async function q11Result(
    ctx: ScfContext, sceneUuid: string, sceneId: number,
): Promise<QueryResult<Q11Result>> {
  sceneId = await positionInFilm(ctx, sceneId) ?? sceneId; // §12.1.7
  const lookup = await uuidLookupForAll(ctx.exec, ctx.registry);
  const one = async (entity: string, id: number | null): Promise<Row | null> =>
    id === null ? null
      : (await rows(ctx.exec, entity, "id = ?", [id]))[0] ?? null;

  /**
   * A table a file does not contain yields nothing, rather than
   * throwing. §9.2 — resolvers stay total, and an older file that
   * predates an entity is not an error.
   */
  const maybe = async (entity: string, where: string,
                       params: SqlValue[]): Promise<Row[]> => {
    try { return await rows(ctx.exec, entity, where, params); }
    catch { return []; }
  };

  const scene = await one("scene", sceneId);
  const information = (await maybe("information_strategy",
                                   "scene_id = ?", [sceneId]))[0] ?? null;

  const identRow = (await maybe("identification_strategy",
                                "scene_id = ?", [sceneId]))[0] ?? null;
  let identification: Q11Result["identification"] = null;
  if (identRow !== null) {
    const primary = await one("character", asId(identRow["primary_character_id"]));
    const secondary = await one("character",
                                asId(identRow["secondary_character_id"]));
    identification = {
      row: projectRow(identRow, refs(ctx, "identification_strategy"), lookup),
      primary: primary === null
        ? null : projectRow(primary, refs(ctx, "character"), lookup),
      secondary: secondary === null
        ? null : projectRow(secondary, refs(ctx, "character"), lookup),
    };
  }

  const emotionalBeats: Q11Result["emotionalBeats"] = [];
  for (const beat of await maybe("emotional_beat", "scene_id = ?",
                                 [sceneId])) {
    const arc = await one("emotional_arc", asId(beat["emotional_arc_id"]));
    emotionalBeats.push({
      beat: projectRow(beat, refs(ctx, "emotional_beat"), lookup),
      arc: arc === null
        ? null : projectRow(arc, refs(ctx, "emotional_arc"), lookup),
    });
  }

  const cascade = await resolveDirection(ctx, Q11_LEAF, sceneId, null);

  return envelope("Q11", ctx.registry, { scene: sceneUuid }, {
    scene: scene === null
      ? null : projectRow(scene, refs(ctx, "scene"), lookup),
    information: information === null
      ? null : projectRow(information, refs(ctx, "information_strategy"),
                          lookup),
    identification,
    emotionalBeats,
    toneMarkers: (await maybe("tone_marker", "scene_id = ?", [sceneId]))
      .map((t) => projectRow(t, refs(ctx, "tone_marker"), lookup)),
    emotionalCascade: cascade.map(([entity, row]) => ({
      entity, row: projectRow(row, refs(ctx, entity), lookup),
    })),
  });
}

/** Q11's cascade leaf (§7.1). */
/**
 * The leaf of Q11's emotional cascade.
 *
 * MUST BE A REGISTRY ENTITY NAME. A leaf naming nothing — as
 * `scene_emotional_design` did, in this file and in §12.13 and nowhere
 * else — makes `emotionalCascade` `[]` for every SCF file that could
 * ever exist, and the blessed result then pins the empty array as
 * correct. The specification and the artifact agree with each other and
 * neither agrees with the schema.
 *
 * `scene_emotional_target` declares `refines: ["project_tone"]`, which
 * is the cascade §12.13 describes.
 */
export const Q11_LEAF = "scene_emotional_target";

/**
 * Scene-to-span membership, derived (§5.1). Used by Q10, where a theme
 * connected to an act reaches every scene the act covers.
 *
 * Over the film, as Q04's lineage is: a cut scene takes part in no span
 * and a cut act is not one (§6.6.1), so a span whose start scene is cut
 * covers nothing and its scenes stay with the span before it (§5.5).
 * Reading every row here made Q10 and Q04 disagree about that span.
 */
async function spanMembership(ctx: ScfContext) {
  const scenes = await rows(ctx.exec, "scene");
  const acts = await rows(ctx.exec, "act");
  const sequences = await rows(ctx.exec, "sequence");
  const headings = await rows(ctx.exec, "screenplay_lines",
                              "line_type = ?", ["heading"]);
  return deriveStructure(scenes, acts, sequences, sceneOrderHint(headings));
}

// ---------------------------------------------------------------------------
// Q15 — Provenance (§12.14)
// ---------------------------------------------------------------------------

/**
 * Does an `affected_entities` value mention this row?
 *
 * Deliberately permissive, because the column is free-form: it may hold
 * a JSON array, a JSON object, or prose. A note that mentions the right
 * entity in a shape nobody anticipated should still surface — §9.1, SCF
 * describes, and a provenance trail that silently omitted a note would
 * be worse than one that included a doubtful one.
 *
 * It lives in the core because Q15 is normative, so its matcher is too.
 * It had lived in the app, which meant an independent implementation had
 * no way to know which conventions counted.
 */
export function mentionsRow(affected: unknown, entityType: string,
                            id: number, uuid?: string | null): boolean {
  if (affected === null || affected === undefined || affected === "") {
    return false;
  }
  const handle = uuid === null || uuid === undefined || uuid === ""
    ? null : uuid;
  const matchesId = (v: unknown): boolean => {
    if (v === undefined || v === null) return true;      // bare entity
    const s = String(v).trim();
    if (handle !== null && s.toLowerCase() === handle.toLowerCase()) {
      return true;
    }
    return Number(s) === id;                              // legacy row id
  };
  try {
    const parsed: unknown = JSON.parse(String(affected));
    const items = Array.isArray(parsed) ? parsed : [parsed];
    return items.some((item) => {
      if (typeof item === "string") {
        if (item === entityType) return true;
        const cut = item.indexOf(":") >= 0 ? item.indexOf(":")
                                           : item.indexOf("#");
        if (cut < 0) return false;
        return item.slice(0, cut) === entityType &&
               matchesId(item.slice(cut + 1));
      }
      if (item !== null && typeof item === "object") {
        const o = item as Record<string, unknown>;
        const t = o["entity"] ?? o["type"] ?? o["entity_type"];
        const i = o["uuid"] ?? o["id"] ?? o["entity_id"];
        return t === entityType && matchesId(i);
      }
      return false;
    });
  } catch {
    // Prose. Matching a row id inside prose is what the written
    // convention (§12.14) exists to replace: `scene:1` is a substring
    // of `scene:12`, and a bare type name is a substring of ordinary
    // words. A uuid is unambiguous, so prose is matched on that alone.
    const text = String(affected);
    return handle !== null &&
           text.toLowerCase().includes(handle.toLowerCase());
  }
}

export interface Q15Result {
  entityType: string;
  row: ProjectedRow | null;
  /** Oldest first: the row's version chain (§6.1). */
  versionChain: ProjectedRow[];
  attached: { decisions: ProjectedRow[]; notes: ProjectedRow[] };
}

export async function q15Result(
    ctx: ScfContext, entityType: string, rowUuid: string, rowId: number,
    mentions: (affected: unknown, entityType: string, id: number,
               uuid?: string | null) => boolean,
): Promise<QueryResult<Q15Result>> {
  const lookup = await uuidLookupForAll(ctx.exec, ctx.registry);
  const row = (await rows(ctx.exec, entityType, "id = ?", [rowId]))[0]
    ?? null;

  const chain: Row[] = [];
  if (row !== null && ctx.registry.entities.get(entityType)?.versionable) {
    const seen = new Set<number>([rowId]);
    let cursor: Row | undefined = row;
    // Backwards to the root, then forwards, so the chain reads oldest
    // first. A cycle stops the walk rather than hanging it (§9.2).
    const back: Row[] = [];
    while (cursor !== undefined) {
      const pid = asId(cursor["parent_id"]);
      if (pid === null || seen.has(pid)) break;
      seen.add(pid);
      cursor = (await rows(ctx.exec, entityType, "id = ?", [pid]))[0];
      if (cursor !== undefined) back.unshift(cursor);
    }
    chain.push(...back, row);
    cursor = row;
    while (cursor !== undefined) {
      const sid = asId(cursor["superseded_by_id"]);
      if (sid === null || seen.has(sid)) break;
      seen.add(sid);
      cursor = (await rows(ctx.exec, entityType, "id = ?", [sid]))[0];
      if (cursor !== undefined) chain.push(cursor);
    }
  }

  const attach = async (table: string): Promise<Row[]> =>
    (await rows(ctx.exec, table))
      .filter((r) => mentions(r["affected_entities"], entityType, rowId, rowUuid));

  return envelope("Q15", ctx.registry,
    { entityType, row: rowUuid }, {
      entityType,
      row: row === null
        ? null : projectRow(row, refs(ctx, entityType), lookup),
      versionChain: chain.map(
        (r) => projectRow(r, refs(ctx, entityType), lookup)),
      attached: {
        decisions: (await attach("creative_decision"))
          .map((r) => projectRow(r, refs(ctx, "creative_decision"), lookup)),
        notes: (await attach("collaboration_note"))
          .map((r) => projectRow(r, refs(ctx, "collaboration_note"), lookup)),
      },
    });
}

// ---------------------------------------------------------------------------
// The dossier — shared by Q01 and Q02 (§12.15, §12.16)
// ---------------------------------------------------------------------------

export interface DossierGroup { entity: string; rows: Row[] }

export interface DossierComposition {
  subjectType: string;
  subject: Row | null;
  groups: DossierGroup[];
  motifCarriage: Array<{ appearance: Row; motif: Row | null }>;
  thematicConnections: Row[];
  relationships: DossierRelationship[];
}

/**
 * One of a character's relationships, read from the subject's end
 * (§12.15). `side` is the column the subject occupies, which is what
 * makes `a_to_b` readable: it runs A → B, and a consumer cannot say
 * which way that is without knowing which end it is standing on.
 */
export interface DossierRelationship {
  relationship: Row;
  /** The character at the other end; null where that row is absent. */
  other: Row | null;
  side: "a" | "b";
}

/**
 * Everything authored about a subject before any scene bends it.
 *
 * The group walk is DERIVED, not listed: every entity whose registry
 * `subject` is this kind, at global scope, carrying a reference back to
 * it. Adding a new entity about characters puts it in every character's
 * dossier with no code change — which is the whole argument for the
 * registry carrying `subject` and `scope` at all.
 *
 * Shared by Q01 and Q02. It lives here rather than in the app for the
 * reason Q03's and Q12's compositions did: a normative result must not
 * re-derive what a renderer already derives.
 */
export async function composeDossier(
    ctx: ScfContext, subjectType: string,
    subjectId: number): Promise<DossierComposition> {
  const subject = (await rows(ctx.exec, subjectType, "id = ?",
                              [subjectId]))[0] ?? null;
  const idField = `${subjectType}_id`;
  const groups: DossierGroup[] = [];

  for (const name of ctx.registry.order) {
    const e = ctx.registry.entities.get(name);
    if (e === undefined || e.subject !== subjectType ||
        e.scope !== "global" || name === subjectType) {
      continue;
    }
    if (!e.fields.some((f) => f.name === idField &&
                              f.fieldType === "reference")) {
      continue;
    }
    const found = await rows(ctx.exec, name, `${q(idField)} = ?`,
                             [subjectId]);
    if (found.length > 0) groups.push({ entity: name, rows: found });
  }

  // Appearances have scenes, so carriage is in story order (§12.1.6):
  // by the scene's position, then row id; one with no position last.
  const order = await sceneOrder(ctx);
  const at = (r: Row): number =>
    order.get(asId(r["scene_id"]) ?? -1) ?? Number.MAX_SAFE_INTEGER;
  const carried = (await rows(
      ctx.exec, "motif_appearance", "entity_type = ? AND entity_id = ?",
      [subjectType, subjectId]))
    .sort((a, b) => (at(a) - at(b)) ||
                    ((asId(a["id"]) ?? 0) - (asId(b["id"]) ?? 0)));
  const motifCarriage: DossierComposition["motifCarriage"] = [];
  for (const appearance of carried) {
    const motifId = asId(appearance["motif_id"]);
    motifCarriage.push({
      appearance,
      motif: motifId === null
        ? null : (await rows(ctx.exec, "motif", "id = ?", [motifId]))[0]
          ?? null,
    });
  }

  return {
    subjectType, subject, groups, motifCarriage,
    thematicConnections: await rows(
      ctx.exec, "thematic_connection", "entity_type = ? AND entity_id = ?",
      [subjectType, subjectId]),
    relationships: subjectType === "character"
      ? await dossierRelationships(ctx, subjectId) : [],
  };
}

/**
 * A character's relationships, from either column (§6.5, §12.15).
 *
 * `character_relationship` is about both of its characters equally, so
 * the group walk above — which asks for the one column that says "this
 * row is about that subject" — never finds it. It is read here instead,
 * with the other party resolved, because a relationship that does not
 * say who it is with is not much of an answer.
 *
 * A relationship to a CUT character is absent (§6.6.1): it joins someone
 * who is not in the film. One whose other end names no row at all is
 * kept, with `other` null (§9.2); `relationship.endpoint_absent` reports
 * it. A row naming the subject twice appears once, as side "a".
 */
async function dossierRelationships(
    ctx: ScfContext, subjectId: number): Promise<DossierRelationship[]> {
  const found = await rows(
    ctx.exec, "character_relationship",
    "character_a_id = ? OR character_b_id = ?", [subjectId, subjectId]);
  const out: DossierRelationship[] = [];
  for (const relationship of found) {
    const side: "a" | "b" =
      asId(relationship["character_a_id"]) === subjectId ? "a" : "b";
    const otherId = asId(
      relationship[side === "a" ? "character_b_id" : "character_a_id"]);
    let other: Row | null = null;
    if (otherId !== null) {
      other = (await rows(ctx.exec, "character", "id = ?", [otherId]))[0]
        ?? null;
      if (other === null) {
        const anyone = await rowsIncludingCut(
          ctx.exec, "character", "id = ?", [otherId]);
        if (anyone.length > 0) continue;        // cut: not in the film
      }
    }
    out.push({ relationship, other, side });
  }
  return out.sort((a, b) =>
    (asId(a.relationship["id"]) ?? 0) - (asId(b.relationship["id"]) ?? 0));
}

// ---------------------------------------------------------------------------
// Q01 — Subject dossier (§12.15)
// ---------------------------------------------------------------------------

export interface Q01Result {
  subjectType: string;
  subject: ProjectedRow | null;
  groups: Array<{ entity: string; rows: ProjectedRow[] }>;
  motifCarriage: Array<{
    appearance: ProjectedRow; motif: ProjectedRow | null;
  }>;
  thematicConnections: ProjectedRow[];
  relationships: Array<{
    relationship: ProjectedRow; other: ProjectedRow | null;
    side: "a" | "b";
  }>;
}

function projectDossier(
    ctx: ScfContext, d: DossierComposition,
    lookup: UuidLookup): Q01Result {
  return {
    subjectType: d.subjectType,
    subject: d.subject === null
      ? null : projectRow(d.subject, refs(ctx, d.subjectType), lookup),
    groups: d.groups.map((g) => ({
      entity: g.entity,
      rows: g.rows.map((r) => projectRow(r, refs(ctx, g.entity), lookup)),
    })),
    motifCarriage: d.motifCarriage.map((m) => ({
      appearance: projectRow(m.appearance, refs(ctx, "motif_appearance"),
                             lookup),
      motif: m.motif === null
        ? null : projectRow(m.motif, refs(ctx, "motif"), lookup),
    })),
    thematicConnections: d.thematicConnections.map(
      (t) => projectRow(t, refs(ctx, "thematic_connection"), lookup)),
    relationships: d.relationships.map((r) => ({
      relationship: projectRow(
        r.relationship, refs(ctx, "character_relationship"), lookup),
      other: r.other === null
        ? null : projectRow(r.other, refs(ctx, "character"), lookup),
      side: r.side,
    })),
  };
}

export async function q01Result(
    ctx: ScfContext, subjectType: string, subjectUuid: string,
    subjectId: number): Promise<QueryResult<Q01Result>> {
  const lookup = await uuidLookupForAll(ctx.exec, ctx.registry);
  return envelope("Q01", ctx.registry,
    { subjectType, subject: subjectUuid },
    projectDossier(ctx, await composeDossier(ctx, subjectType, subjectId),
                   lookup));
}

// ---------------------------------------------------------------------------
// Q02 — Subject in context (§12.16)
// ---------------------------------------------------------------------------

/**
 * The one place a canonical query genuinely builds on another.
 *
 * §12.1.3 withdrew the assumption that composites nest, because none of
 * them did. Q02's media layer is the exception: it IS Q13's answer at a
 * position, so it carries Q13's result BODY without its envelope, and
 * names the query it came from. Everything else Q02 assembles itself.
 */
export interface Q02Result {
  subjectType: string;
  subject: ProjectedRow | null;
  scene: ProjectedRow | null;
  /** The subject's standing description — Q01's result body. */
  dossier: Q01Result;
  /** Present for a character subject; empty otherwise. */
  costumes: ProjectedRow[];
  relationshipStates: ProjectedRow[];
  /**
   * The stage in force on each of the character's arcs (§4.5). The arcs
   * THEMSELVES are already in `dossier.groups` — a standing fact about
   * the character — so only what the scene changes is repeated here.
   */
  arcStates: ProjectedRow[];
  performanceStates: ProjectedRow[];
  beats: ProjectedRow[];
  /**
   * For a character subject: the variant §4.8 puts in force — the one its
   * scene_character link names — or null. Null for other kinds.
   */
  characterVariant: ProjectedRow | null;
  /** Present for a location subject. */
  locationVariant:
    { variant: ProjectedRow | null; mismatches: string[] } | null;
  /** For a prop subject: the variant §4.8 puts in force, or null. */
  propVariant: ProjectedRow | null;
  /** Present for a prop subject. */
  propState: ProjectedRow | null;
  /**
   * Q13's result body, unwrapped, with the query it came from named.
   * `intent` is already part of that body — restating it here would be
   * two places for one fact.
   */
  media: { fromQuery: string } & Q13Result;
}

export async function q02Result(
    ctx: ScfContext, subjectType: string, subjectUuid: string,
    subjectId: number, sceneUuid: string, sceneId: number,
    shotUuid: string | null, shotId: number | null,
): Promise<QueryResult<Q02Result>> {
  const position = await sceneOfPosition(ctx, sceneId, shotId) ?? sceneId;
  if (position === NOWHERE) {
    // §12.1.7: the subject is still itself; nothing is at a cut scene.
    sceneId = NOWHERE;
    shotId = null;
  }
  const lookup = await uuidLookupForAll(ctx.exec, ctx.registry);
  const order = await sceneOrder(ctx);
  const scene = (await rows(ctx.exec, "scene", "id = ?", [sceneId]))[0]
    ?? null;
  const dossier = await composeDossier(ctx, subjectType, subjectId);

  let costumes: Row[] = [];
  const relationshipStates: Row[] = [];
  const arcStates: Row[] = [];
  let performanceStates: Row[] = [];
  let beats: Row[] = [];
  let locationVariant: Q02Result["locationVariant"] = null;
  let propState: Row | null = null;
  // §4.8. variantInForce answers null for any kind it does not cover, so
  // the two members are null, never omitted, as §12.16 requires.
  const characterVariant = subjectType === "character"
    ? await variantInForce(ctx, "character", subjectId, sceneId) : null;
  const propVariant = subjectType === "prop"
    ? await variantInForce(ctx, "prop", subjectId, sceneId) : null;

  if (subjectType === "character") {
    costumes = excludeCut(await ctx.exec(
      "SELECT c.* FROM costume_scene cs JOIN costume c " +
      "ON c.id = cs.costume_id WHERE cs.scene_id = ? AND c.character_id = ? " +
      "ORDER BY cs.id", [sceneId, subjectId]));
    for (const rel of await rows(
        ctx.exec, "character_relationship",
        "character_a_id = ? OR character_b_id = ?",
        [subjectId, subjectId])) {
      const relId = asId(rel["id"]);
      if (relId === null) continue;
      const state = await relationshipStateAt(ctx, relId, sceneId, order);
      if (state !== null) relationshipStates.push(state);
    }
    for (const arc of await rows(ctx.exec, "character_arc",
                                 "character_id = ?", [subjectId])) {
      const arcId = asId(arc["id"]);
      if (arcId === null) continue;
      const state = await characterArcStateAt(ctx, arcId, sceneId, order);
      if (state !== null) arcStates.push(state);
    }
    performanceStates = await statesInForce(ctx, subjectId, sceneId, null,
                                            order);
    beats = (await rows(ctx.exec, "performance_beat",
                        "character_id = ? AND scene_id = ?",
                        [subjectId, sceneId])).sort(byBeatOrder);
  }

  if (subjectType === "location") {
    // §12.17 chooses the variant of the SCENE's location. Asked about
    // another location, nothing of this one is at the scene to dress it.
    const sceneLocation = asId((await rows(ctx.exec, "scene", "id = ?",
                                           [sceneId]))[0]?.["location_id"]);
    const [variant, mismatches] = sceneLocation === subjectId
      ? await selectLocationVariant(ctx, sceneId) : [null, []];
    locationVariant = {
      variant: variant === null
        ? null : projectRow(variant, refs(ctx, "location_variant"), lookup),
      mismatches,
    };
  }

  if (subjectType === "prop") {
    propState = await propStateAt(ctx, subjectId, sceneId, order);
  }

  // Nesting, in the one place it is honest.
  const intent = subjectType === "location"
    ? "environment" : "visual_identity";
  const media = await q13Result(ctx, subjectType, subjectUuid, subjectId,
                                intent, sceneUuid, sceneId, shotUuid,
                                shotId);

  return envelope("Q02", ctx.registry, {
    subjectType, subject: subjectUuid, scene: sceneUuid, shot: shotUuid,
  }, {
    subjectType,
    subject: dossier.subject === null
      ? null : projectRow(dossier.subject, refs(ctx, subjectType), lookup),
    scene: scene === null
      ? null : projectRow(scene, refs(ctx, "scene"), lookup),
    dossier: projectDossier(ctx, dossier, lookup),
    costumes: costumes.map((c) => projectRow(c, refs(ctx, "costume"),
                                             lookup)),
    relationshipStates: relationshipStates.map(
      (r) => projectRow(r, refs(ctx, "relationship_state"), lookup)),
    arcStates: arcStates.map(
      (r) => projectRow(r, refs(ctx, "character_arc_state"), lookup)),
    performanceStates: performanceStates.map(
      (r) => projectRow(r, refs(ctx, "performance_state"), lookup)),
    beats: beats.map((b) => projectRow(b, refs(ctx, "performance_beat"),
                                       lookup)),
    characterVariant: characterVariant === null
      ? null
      : projectRow(characterVariant, refs(ctx, "character_variant"), lookup),
    locationVariant,
    propVariant: propVariant === null
      ? null : projectRow(propVariant, refs(ctx, "prop_variant"), lookup),
    propState: propState === null
      ? null : projectRow(propState, refs(ctx, "prop_state"), lookup),
    media: { fromQuery: "Q13", ...media.result },
  });
}

// ---------------------------------------------------------------------------
// Q04 — Scene package (§12.17)
// ---------------------------------------------------------------------------

/**
 * The scene-level entities a package reports. Fixed by §12.17 rather
 * than derived, for the reason Q00's layer list is: what belongs in a
 * scene package is an editorial choice, not a fact the registry knows.
 */
export const Q04_DETAIL = [
  "scene_emotional_target", "scene_color_palette", "lighting_design",
  "scene_music_design", "dialogue_sound_design", "set_dressing",
  "tone_marker",
] as const;

export interface Q04Result {
  scene: ProjectedRow | null;
  /** Act and sequence, broadest first. */
  lineage: Array<{ entity: string; row: ProjectedRow }>;
  storyBeats: ProjectedRow[];
  /**
   * Each with its presence here (§2.4.1: a `mentioned` character is in
   * the cast and not on screen) and the variant in force (§4.8). Derived
   * records with the row as a member, as Q03's are (§12.1.2, §12.1.4).
   */
  cast: Array<{ character: ProjectedRow; presence: Presence;
                variant: ProjectedRow | null }>;
  props: Array<{ prop: ProjectedRow; presence: Presence;
                 variant: ProjectedRow | null }>;
  location: ProjectedRow | null;
  locationVariant:
    { variant: ProjectedRow | null; mismatches: string[] };
  detail: Array<{ entity: string; rows: ProjectedRow[] }>;
  blocking: ProjectedRow[];
  stagingBeats: ProjectedRow[];
  /**
   * The scene's own text (§12.17.1), in `line_order`, from the scene's
   * heading to the line before the next one. Empty when the scene has
   * no line in the screenplay.
   */
  screenplay: ProjectedRow[];
}

export async function q04Result(
    ctx: ScfContext, sceneUuid: string, sceneId: number,
): Promise<QueryResult<Q04Result>> {
  sceneId = await positionInFilm(ctx, sceneId) ?? sceneId; // §12.1.7
  const lookup = await uuidLookupForAll(ctx.exec, ctx.registry);
  const scene = (await rows(ctx.exec, "scene", "id = ?", [sceneId]))[0]
    ?? null;

  // Lineage is DERIVED from span boundaries, not read from
  // `scene_sequence`.
  //
  // Reading `scene_sequence` would answer a NORMATIVE query from a table
  // §5.4 explicitly permits to be STALE — "the boundary is the truth and
  // those rows are its shadow; they MAY be stale between commits". A
  // query reading the shadow can return a lineage the file's own
  // boundaries contradict, and §3.1 forbids treating a stored derived
  // fact as truth everywhere else.
  //
  // The shadow rows stay: an editor materialises them at commit and
  // `structure.shadow_row_unexplained` reports the ones no boundary
  // explains (§9.4). They are a compatibility surface, not a source.
  const structure = deriveStructure(
    await rows(ctx.exec, "scene"),
    await rows(ctx.exec, "act"),
    await rows(ctx.exec, "sequence"),
    sceneOrderHint(await rows(ctx.exec, "screenplay_lines",
                              "line_type = ?", ["heading"])));

  const lineage: Array<{ entity: string; row: Row }> = [];
  const actSpan = actOf(structure, sceneId);
  const sequenceSpan = sequenceOf(structure, sceneId);
  if (actSpan !== null) {
    const act = (await rows(ctx.exec, "act", "id = ?", [actSpan.id]))[0];
    if (act !== undefined) lineage.push({ entity: "act", row: act });
  }
  if (sequenceSpan !== null) {
    const seq = (await rows(ctx.exec, "sequence", "id = ?",
                            [sequenceSpan.id]))[0];
    if (seq !== undefined) lineage.push({ entity: "sequence", row: seq });
  }

  const storyBeats = (await rows(ctx.exec, "story_beat", "scene_id = ?",
                                 [sceneId])).sort(byBeatOrder);
  const cast = excludeCut(await ctx.exec(
    "SELECT c.* FROM scene_character sc JOIN character c " +
    "ON c.id = sc.character_id WHERE sc.scene_id = ? ORDER BY sc.rowid",
    [sceneId]));
  const props = excludeCut(await ctx.exec(
    "SELECT p.* FROM scene_prop sp JOIN prop p " +
    "ON p.id = sp.prop_id WHERE sp.scene_id = ? ORDER BY sp.rowid",
    [sceneId]));
  const atScene = await presenceAtScene(ctx, sceneId);

  const locationId = asId(scene?.["location_id"]);
  const location = locationId === null
    ? null
    : (await rows(ctx.exec, "location", "id = ?", [locationId]))[0] ?? null;
  const [variant, mismatches] = await selectLocationVariant(ctx, sceneId);

  const detail: Array<{ entity: string; rows: Row[] }> = [];
  for (const entity of Q04_DETAIL) {
    if (!ctx.registry.entities.has(entity)) continue;
    const found = await rows(ctx.exec, entity, "scene_id = ?", [sceneId]);
    if (found.length > 0) detail.push({ entity, rows: found });
  }

  // §3.4: located by the heading, never by the body lines' scene_id.
  // A line whose `line_type` is outside §1.3.1's closed set is a row the
  // reader does not recognise, which §10.1 says to ignore: it is kept in
  // the file and reported (`line.type_unknown`), and is not in the
  // answer. It cannot be a heading, so it bounds nothing either.
  const known = new Set<string>(LINE_TYPES);
  const screenplay = (await sceneScriptLines(ctx.exec, sceneId))
    .filter((l) => known.has(String(l["line_type"] ?? "")));

  // A staging beat has no scene of its own: it reaches one through its
  // container, a scene_blocking or an action_sequence (§12.17). Both
  // are read — an action sequence's beats are the scene's staging as
  // much as the blocking's are.
  const blocking = await rows(ctx.exec, "scene_blocking", "scene_id = ?",
                              [sceneId]);
  const actions = await rows(ctx.exec, "action_sequence", "scene_id = ?",
                             [sceneId]);
  const stagingBeats: Row[] = [];
  for (const b of blocking) {
    stagingBeats.push(...await rows(ctx.exec, "staging_beat",
                                    "scene_blocking_id = ?",
                                    [asId(b["id"])]));
  }
  for (const a of actions) {
    stagingBeats.push(...await rows(ctx.exec, "staging_beat",
                                    "action_sequence_id = ?",
                                    [asId(a["id"])]));
  }
  stagingBeats.sort((a, b) => byBeatOrder(a, b) ||
    (Number(a["id"]) || 0) - (Number(b["id"]) || 0));

  // §4.8, per entry: who appears as which version. A package listing
  // Marcus in scene 25 without saying he is the boy is wrong for anyone
  // casting or dressing it (proposal 0035).
  const castVariants: Array<[Row, Row | null]> = [];
  for (const c of cast) {
    castVariants.push([c, await variantInForce(
      ctx, "character", Number(c["id"]), sceneId)]);
  }
  const propVariants: Array<[Row, Row | null]> = [];
  for (const p of props) {
    propVariants.push([p, await variantInForce(
      ctx, "prop", Number(p["id"]), sceneId)]);
  }

  return envelope("Q04", ctx.registry, { scene: sceneUuid }, {
    scene: scene === null
      ? null : projectRow(scene, refs(ctx, "scene"), lookup),
    lineage: lineage.map((l) => ({
      entity: l.entity, row: projectRow(l.row, refs(ctx, l.entity), lookup),
    })),
    storyBeats: storyBeats.map(
      (b) => projectRow(b, refs(ctx, "story_beat"), lookup)),
    cast: castVariants.map(([c, v]) => ({
      character: projectRow(c, refs(ctx, "character"), lookup),
      presence: atScene.character.get(Number(c["id"])) ?? "seen",
      variant: v === null
        ? null : projectRow(v, refs(ctx, "character_variant"), lookup),
    })),
    props: propVariants.map(([p, v]) => ({
      prop: projectRow(p, refs(ctx, "prop"), lookup),
      presence: atScene.prop.get(Number(p["id"])) ?? "seen",
      variant: v === null
        ? null : projectRow(v, refs(ctx, "prop_variant"), lookup),
    })),
    location: location === null
      ? null : projectRow(location, refs(ctx, "location"), lookup),
    locationVariant: {
      variant: variant === null
        ? null : projectRow(variant, refs(ctx, "location_variant"), lookup),
      mismatches,
    },
    detail: detail.map((d) => ({
      entity: d.entity,
      rows: d.rows.map((r) => projectRow(r, refs(ctx, d.entity), lookup)),
    })),
    blocking: blocking.map(
      (b) => projectRow(b, refs(ctx, "scene_blocking"), lookup)),
    stagingBeats: stagingBeats.map(
      (b) => projectRow(b, refs(ctx, "staging_beat"), lookup)),
    screenplay: projectScreenplayLines(screenplay, lookup),
  });
}
