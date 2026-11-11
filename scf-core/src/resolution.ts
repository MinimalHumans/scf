// SPDX-License-Identifier: Apache-2.0
/**
 * resolution.ts — SCF resolution semantics, executable.
 *
 * The rules are stated in docs/conventions.md and pinned by the
 * conformance suites against the Hollow Creek fixture.
 *
 * Implements the walks the canonical queries are built from:
 *   - the DESCRIPTION cascade: profile -> states-in-force -> beats, per
 *     modality, with the 2.1 persistence semantics and key-wise modulation
 *     stacking
 *   - the DIRECTION cascade: registry `refines` graph walked root-first,
 *     most specific last (Q07 / Q08 / Q11)
 *   - the MEDIA cascade: bundle -> binding -> anchor -> shot override ->
 *     assets (Q13)
 *   - location-variant selection for a scene (resolver-first)
 *
 * Conventions honoured throughout:
 *   - story position order is derived from the SCRIPT (spec §4.1), via
 *     sceneOrder() below — never from scene_number alone
 *   - most-specific-wins; everything above the winner is returned as
 *     context, ordered root-first
 *   - absence is well-defined: a missing layer is skipped, never an error
 *
 * pyTruthy() treats null, undefined, "", 0 and false as absent in the
 * predicates that need it. The conformance fixture pins those edge
 * values, so the behaviour cannot be relaxed silently.
 */

import { q, type Row, type SqlExec, type SqlValue } from "./db.ts";
import { cascadeChain, type Registry } from "./registry.ts";
import { scenePositions, sceneOrderHint } from "./structure.ts";

/** The context every semantics function operates in. */
export interface ScfContext {
  exec: SqlExec;
  registry: Registry;
}

/** Story-position index per scene id. */
export type SceneOrder = Map<number, number>;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function pyTruthy(v: SqlValue | undefined): boolean {
  return !(v === null || v === undefined || v === "" || v === 0 ||
           v === false);
}

function asNum(v: SqlValue | undefined): number | null {
  return typeof v === "number" ? v : null;
}

/**
 * Fetch rows for RESOLUTION, excluding anything cut (spec §6.6).
 *
 * A cut row is not in the film. Marking something cut rather than
 * deleting it means it stops being considered while staying
 * inspectable, so every resolver — and therefore every canonical query
 * — must not see it. Cut rows are read back through `rowsIncludingCut`.
 *
 * The filter is applied in JS rather than in SQL on purpose: most
 * entities declare `lifecycle_status` and the link entities mostly do
 * not, so a SQL
 * predicate would have to probe for the column on every table it
 * touched. A missing column reads as undefined and keeps the row, which
 * is the correct answer for an entity that has no notion of being cut.
 */
export async function rows(
    exec: SqlExec, table: string, where = "",
    params: SqlValue[] = []): Promise<Row[]> {
  return excludeCut(await rowsIncludingCut(exec, table, where, params));
}

/**
 * §6.6.1's predicate, exported so a JOIN can apply it too.
 *
 * `rows()` covers everything fetched a table at a time. It does not
 * cover a query that reaches an entity THROUGH a junction in one SQL
 * statement — Q04's cast and props, Q03's costumes and motifs, Q02's
 * costumes each join a junction that cannot be cut to an entity that
 * can.
 *
 * §6.6.1 states its test as "adding a cut row changes no answer". That
 * has a mirror: **cutting an existing row MUST change the answer.** A
 * join filtering neither side passes the test as stated and fails the
 * mirror — marking a character cut would not remove them from Q04's
 * cast.
 *
 * One predicate, two call shapes. A second definition of "cut" would
 * eventually disagree with this one.
 */
export function excludeCut(rows: Row[]): Row[] {
  return rows.filter((r) => r["lifecycle_status"] !== "cut");
}

/**
 * Fetch rows without the §6.6 filter — everything, cut included.
 *
 * For tools that show what was removed: a cut list, an audit view, a
 * history panel. NOT for answering a question about the film, which is
 * what `rows` is for.
 */
export async function rowsIncludingCut(
    exec: SqlExec, table: string, where = "",
    params: SqlValue[] = []): Promise<Row[]> {
  // In row order, stated rather than left to the query plan: §12.1.6
  // and §12.17's ties name row order, and an index scan need not give it.
  const sql = `SELECT * FROM ${q(table)}` + (where ? ` WHERE ${where}` : "") +
    " ORDER BY rowid";
  return exec(sql, params);
}

async function cols(exec: SqlExec, table: string): Promise<Set<string>> {
  const out = await exec(`PRAGMA table_info(${q(table)})`);
  return new Set(out.map((r) => String(r["name"])));
}

/**
 * `beat_order`, an unset one as 0, then row id — the one order every
 * beat array in §12 takes (§12.2, §12.16, §12.17). Q05 used to put an
 * unset order last while §12.17 said "as 0".
 */
export function byBeatOrder(a: Row, b: Row): number {
  return ((asNum(a["beat_order"]) ?? 0) - (asNum(b["beat_order"]) ?? 0)) ||
    ((asNum(a["id"]) ?? 0) - (asNum(b["id"]) ?? 0));
}

/**
 * The position a cut scene stands for: one no row is keyed to and no
 * story position contains (§12.1.7). Not null, which means "no position
 * asked" and lets baselines alone apply in Q13; a cut scene was asked,
 * and is a position with nothing at it.
 */
export const NOWHERE = -1;

/**
 * `sceneId`, or NOWHERE where that scene is cut (§6.6.1, §12.1.7). A
 * query asked at a cut scene answers as at an empty position — §9.2's
 * totality, and Q03's rule since 0.39 — rather than reading the rows
 * still keyed to it, which are not cut themselves and so pass `rows()`.
 */
export async function positionInFilm(
    ctx: ScfContext, sceneId: number | null): Promise<number | null> {
  if (sceneId === null) return null;
  const scene = (await rowsIncludingCut(ctx.exec, "scene", "id = ?",
                                        [sceneId]))[0];
  return scene !== undefined && excludeCut([scene]).length === 0
    ? NOWHERE : sceneId;
}

/**
 * The scene a query is answered at, given its `scene` and `shot`
 * (§12.1.7). A shot fixes the position at its own scene: asked with no
 * scene, the shot's scene is the position; asked with a scene it is not
 * in, the question contradicts itself and is not answered. Q07 at scene
 * 3 with shot 12-04 used to mix scene 3's palette with 12-04's design.
 */
export async function sceneOfPosition(
    ctx: ScfContext, sceneId: number | null,
    shotId: number | null): Promise<number | null> {
  if (shotId === null) return positionInFilm(ctx, sceneId);
  const shot = (await rowsIncludingCut(ctx.exec, "shot", "id = ?",
                                       [shotId]))[0];
  const own = asNum(shot?.["scene_id"]);
  if (own === null) {
    throw new Error("not answered: the shot asked about is in no scene " +
                    "(§12.1.7)");
  }
  if (sceneId !== null && sceneId !== own) {
    throw new Error("not answered: the shot asked about is not in the " +
                    "scene asked about (§12.1.7)");
  }
  return positionInFilm(ctx, own);
}

/**
 * Story-position index per scene: scene id → 0-based position.
 *
 * Derived from the SCREENPLAY (spec §4.1), by delegating to
 * `scenePositions`. It must not be derived any other way: sorting by
 * `scene_number` then row id is what §4.1 forbids in as many words. The
 * conformance fixture is built so screenplay order, scene-number order
 * and row-id order differ, which is what makes the wrong derivation
 * visible.
 *
 * Every position-dependent answer runs through here: states in force,
 * latest-wins lookups, the continuity diff. Deriving it twice is how
 * the two would drift, so it is derived once, there.
 */
export async function sceneOrder(ctx: ScfContext): Promise<SceneOrder> {
  const scenes = await rows(ctx.exec, "scene");
  const headings = await ctx.exec(
    "SELECT scene_id, line_order FROM screenplay_lines " +
    "WHERE line_type = 'heading'");
  const order: SceneOrder = new Map();
  scenePositions(scenes, sceneOrderHint(headings))
    .forEach((p, i) => order.set(p.id, i));
  return order;
}

// ---------------------------------------------------------------------------
// Description cascade (Q02 / Q05 / Q06 spine)
// ---------------------------------------------------------------------------

const PROFILE_FOR_MODALITY: Record<string, string> = {
  vocal: "vocal_profile",
  physical: "physical_character_profile",
  facial: "physical_character_profile",
};

const STATE_MODALITY_FOR: Record<string, string> = {
  vocal: "vocal", physical: "physical", facial: "physical",
};

/**
 * Performance states in force at a scene, per the persistence rule:
 * scene_only states keyed exactly here, plus until_resolved states keyed
 * at-or-before here and not resolved at-or-before here. Ordered by keyed
 * position (oldest first) so stacking merges are deterministic.
 */
export async function statesInForce(
    ctx: ScfContext, characterId: number, sceneId: number,
    modality: string | null = null,
    order: SceneOrder | null = null): Promise<Row[]> {
  const ord = order ?? await sceneOrder(ctx);
  const here = ord.get(sceneId);
  if (here === undefined) return [];
  const out: Row[] = [];
  const all = await rows(ctx.exec, "performance_state",
                         "character_id = ?", [characterId]);
  for (const r of all) {
    if (modality !== null &&
        r["modality"] !== (STATE_MODALITY_FOR[modality] ?? modality)) {
      continue;
    }
    // §4.5: anything but `until_resolved` — null and unknown values
    // included — is `scene_only`, so a state the reader does not
    // understand never spreads past its own scene.
    if (r["persistence"] !== "until_resolved") {
      if (r["scene_id"] === sceneId) out.push(r);
    } else {
      const keyed = ord.get(asNum(r["scene_id"]) ?? -1);
      if (keyed === undefined || keyed > here) continue;
      const resolved = ord.get(asNum(r["resolved_at_scene_id"]) ?? -1);
      if (resolved !== undefined && resolved <= here) continue;
      out.push(r);
    }
  }
  out.sort((a, b) =>
    (ord.get(asNum(a["scene_id"]) ?? -1) ?? -1) -
    (ord.get(asNum(b["scene_id"]) ?? -1) ?? -1));
  return out;
}

/**
 * Key-wise merge of stacked states' modulations, newest wins per key.
 * Input must already be ordered oldest-first (statesInForce does this).
 */
export function mergedModulations(states: Row[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const st of states) {
    try {
      const parsed = JSON.parse(
        pyTruthy(st["modulations"]) ? String(st["modulations"]) : "{}");
      if (parsed !== null && typeof parsed === "object") {
        Object.assign(merged, parsed);
      }
    } catch {
      continue;
    }
  }
  return merged;
}

export interface ResolvedDescription {
  modality: string;
  profile: Row | null;
  states: Row[];
  modulations: Record<string, unknown>;
  beats: Row[];
}

/**
 * The description cascade for one character/scene/modality: baseline
 * profile -> states in force (with merged modulations) -> moment beats.
 * Q05 and Q06 are this function with different modality constants.
 */
export async function resolveDescription(
    ctx: ScfContext, characterId: number, sceneId: number,
    modality: string): Promise<ResolvedDescription> {
  const order = await sceneOrder(ctx);
  const profileTable = PROFILE_FOR_MODALITY[modality];
  if (profileTable === undefined) {
    throw new Error(`unknown modality: ${modality}`);
  }
  const profiles = await rows(ctx.exec, profileTable,
                              "character_id = ?", [characterId]);
  const states = await statesInForce(ctx, characterId, sceneId, modality,
                                     order);
  const beats = await rows(
    ctx.exec, "performance_beat",
    "character_id = ? AND scene_id = ? AND modality = ?",
    [characterId, sceneId, modality]);
  beats.sort(byBeatOrder);
  return {
    modality,
    profile: profiles[0] ?? null,
    states,
    modulations: mergedModulations(states),
    beats,
  };
}

// ---------------------------------------------------------------------------
// Latest-wins position keying (pattern 3, conventions.md) — G1 state tables
// ---------------------------------------------------------------------------

/**
 * Pattern-3 resolution: the row in force at a position is the latest row
 * keyed at-or-before it. Returns null when no row precedes the position
 * (state not yet established — well-defined absence).
 */
export async function latestState(
    ctx: ScfContext, table: string, keyField: string, keyId: number,
    sceneId: number, order: SceneOrder | null = null): Promise<Row | null> {
  const ord = order ?? await sceneOrder(ctx);
  const here = ord.get(sceneId);
  if (here === undefined) return null;
  let best: Row | null = null;
  let bestPos = -1;
  const all = await rows(ctx.exec, table, `${keyField} = ?`, [keyId]);
  for (const row of all) {
    const pos = ord.get(asNum(row["scene_id"]) ?? -1);
    if (pos === undefined || pos > here) continue;
    if (pos > bestPos ||
        (pos === bestPos &&
         (best === null ||
          (asNum(row["id"]) ?? 0) > (asNum(best["id"]) ?? 0)))) {
      best = row;
      bestPos = pos;
    }
  }
  return best;
}

export function relationshipStateAt(
    ctx: ScfContext, relationshipId: number, sceneId: number,
    order: SceneOrder | null = null): Promise<Row | null> {
  return latestState(ctx, "relationship_state", "character_relationship_id",
                     relationshipId, sceneId, order);
}

export function characterArcStateAt(
    ctx: ScfContext, arcId: number, sceneId: number,
    order: SceneOrder | null = null): Promise<Row | null> {
  return latestState(ctx, "character_arc_state", "character_arc_id",
                     arcId, sceneId, order);
}

export function propStateAt(
    ctx: ScfContext, propId: number, sceneId: number,
    order: SceneOrder | null = null): Promise<Row | null> {
  return latestState(ctx, "prop_state", "prop_id", propId, sceneId, order);
}

export function motifStateAt(
    ctx: ScfContext, motifId: number, sceneId: number,
    order: SceneOrder | null = null): Promise<Row | null> {
  return latestState(ctx, "motif_state", "motif_id", motifId, sceneId,
                     order);
}

// ---------------------------------------------------------------------------
// Direction cascade (Q07 / Q08 / Q11 spine)
// ---------------------------------------------------------------------------

/**
 * Fetch the single most-appropriate row of a cascade layer for the given
 * position: shot-scoped row if the table has shot_id and one matches, else
 * scene-scoped row, else the singleton/global first row for position-free
 * layers. Layers whose registry positionPattern is latest_wins resolve per
 * pattern 3 (latest row at-or-before the scene) rather than by exact scene
 * match. Returns null when the layer is unpopulated.
 */
async function fetchLayer(
    ctx: ScfContext, entity: string, sceneId: number | null,
    shotId: number | null): Promise<Row | null> {
  const edef = ctx.registry.entities.get(entity);
  if (edef !== undefined && edef.positionPattern === "latest_wins" &&
      sceneId !== null) {
    // Position-keyed intent: pattern 3, the same rule as latestState —
    // a tie at the winning position goes to the highest row id (§4.5).
    const order = await sceneOrder(ctx);
    const here = order.get(sceneId);
    let best: Row | null = null;
    let bestPos = -1;
    for (const row of await rows(ctx.exec, entity)) {
      const pos = order.get(asNum(row["scene_id"]) ?? -1);
      if (pos === undefined || here === undefined || pos > here) continue;
      if (pos > bestPos ||
          (pos === bestPos && best !== null &&
           (asNum(row["id"]) ?? 0) > (asNum(best["id"]) ?? 0))) {
        best = row;
        bestPos = pos;
      }
    }
    return best;
  }
  const tableCols = await cols(ctx.exec, entity);
  if (shotId !== null && tableCols.has("shot_id")) {
    const r = await rows(ctx.exec, entity, "shot_id = ?", [shotId]);
    if (r.length > 0) return r[0] ?? null;
  }
  if (sceneId !== null && tableCols.has("scene_id")) {
    const where = tableCols.has("shot_id")
      ? "scene_id = ? AND (shot_id IS NULL OR shot_id = '')"
      : "scene_id = ?";
    const r = await rows(ctx.exec, entity, where, [sceneId]);
    if (r.length > 0) return r[0] ?? null;
  }
  if (!tableCols.has("scene_id") && !tableCols.has("shot_id")) {
    const r = await rows(ctx.exec, entity);
    if (r.length > 0) return r[0] ?? null;
  }
  return null;
}

/**
 * Walk the direction cascade for `leaf` at a position. Returns
 * [entityName, row] layers ordered root-first; the last populated layer is
 * the most specific opinion, everything before it is context. Unpopulated
 * layers are skipped (absence is well-defined).
 */
export async function resolveDirection(
    ctx: ScfContext, leaf: string, sceneId: number | null = null,
    shotId: number | null = null): Promise<Array<[string, Row]>> {
  const layers: Array<[string, Row]> = [];
  for (const entity of cascadeChain(ctx.registry, leaf)) {
    const row = await fetchLayer(ctx, entity, sceneId, shotId);
    if (row !== null) layers.push([entity, row]);
  }
  return layers;
}

// ---------------------------------------------------------------------------
// Location variant selection (G4, resolver-first)
// ---------------------------------------------------------------------------

/**
 * The axes a variant is matched on, IN RANK ORDER (§12.17): agreeing on
 * an earlier axis outweighs agreeing on every later one. Light is what
 * the camera sees first, so a night variant built for autumn dresses a
 * winter night before a winter morning does. Counting the axes equally
 * let that morning tie and win on the baseline.
 */
const VARIANT_AXES: Array<[string, string]> = [
  ["time_of_day", "time_of_day"],
  ["weather_conditions", "weather"],
  ["season", "season"],
];

/**
 * Select the location_variant in force for a scene (§12.17): compare the
 * variants axis by axis in rank order; a full tie goes to the baseline,
 * then to the first row; if the winner agrees on no axis, the baseline.
 * Returns [variant, mismatches] — mismatches list axes where the winning
 * variant disagrees with the scene, for tools to surface rather than hide.
 */
export async function selectLocationVariant(
    ctx: ScfContext,
    sceneId: number): Promise<[Row | null, string[]]> {
  const scenes = await rows(ctx.exec, "scene", "id = ?", [sceneId]);
  const scene = scenes[0];
  if (scene === undefined || scene["location_id"] === null ||
      scene["location_id"] === undefined) {
    return [null, []];
  }
  const variants = await rows(ctx.exec, "location_variant",
                              "location_id = ?", [scene["location_id"]]);
  if (variants.length === 0) return [null, []];

  const norm = (v: SqlValue | undefined): string =>
    String(v).trim().toLowerCase();
  /**
   * `varies` on a variant's time_of_day is a WILDCARD, not a time: it
   * says the dressing holds at any hour (§12.17). Scored as an ordinary
   * value it could never agree with a scene, which made the one value
   * meaning "always applies" the one value that never won.
   */
  const agrees = (sceneAxis: string, variantAxis: string, v: Row): boolean => {
    const sv = scene[sceneAxis];
    const vv = v[variantAxis];
    if (!pyTruthy(sv) || !pyTruthy(vv)) return false;
    if (variantAxis === "time_of_day" && norm(vv) === "varies") return true;
    return norm(sv) === norm(vv);
  };
  // One flag per axis in rank order, then is_baseline: compared
  // lexicographically, so the first maximal row wins a full tie.
  const key = (v: Row): number[] => [
    ...VARIANT_AXES.map(([sceneAxis, variantAxis]) =>
      agrees(sceneAxis, variantAxis, v) ? 1 : 0),
    pyTruthy(v["is_baseline"]) ? 1 : 0,
  ];
  const beats = (a: number[], b: number[]): boolean => {
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return (a[i] ?? 0) > (b[i] ?? 0);
    }
    return false;
  };

  let best = variants[0] as Row;
  let bestKey = key(best);
  for (const v of variants.slice(1)) {
    const k = key(v);
    if (beats(k, bestKey)) {
      best = v;
      bestKey = k;
    }
  }
  if (bestKey.slice(0, VARIANT_AXES.length).every((x) => x === 0)) {
    const baselines = variants.filter((v) => pyTruthy(v["is_baseline"]));
    best = baselines[0] ?? best;
  }
  const mismatches: string[] = [];
  for (const [sceneAxis, variantAxis] of VARIANT_AXES) {
    const sv = scene[sceneAxis];
    const vv = best[variantAxis];
    if (pyTruthy(sv) && pyTruthy(vv) &&
        !agrees(sceneAxis, variantAxis, best)) {
      mismatches.push(
        `${sceneAxis}: scene=${JSON.stringify(sv)} ` +
        `variant=${JSON.stringify(vv)}`);
    }
  }
  return [best, mismatches];
}

// ---------------------------------------------------------------------------
// The variant in force (spec §4.8, proposal 0033)
// ---------------------------------------------------------------------------

/** The variant table for each subject kind that has one. */
export const VARIANT_ENTITY: Record<string, string> = {
  character: "character_variant",
  prop: "prop_variant",
  location: "location_variant",
};

/** The presence link that names a character's or prop's variant. */
const PRESENCE_LINK: Record<string, string> = {
  character: "scene_character",
  prop: "scene_prop",
};

/**
 * The variant of a subject in force at a scene (spec §4.8), or null.
 *
 * ONE definition, used by the binding filter, the anchor layer and Q02 —
 * a second reading of "in force" would be free to disagree with this one.
 *
 * - **location**: the variant §12.17 selects for the scene, and only if
 *   it is a variant of THIS location. A scene set somewhere else puts no
 *   variant of this one in force.
 * - **character, prop**: the variant the subject's presence link at the
 *   scene names. No link, a null `variant_id`, a cut variant, or a
 *   variant of another subject (`presence.variant_foreign`) → null.
 * - Any other kind, or no position → null.
 */
export async function variantInForce(
    ctx: ScfContext, subject: string, subjectId: number,
    sceneId: number | null): Promise<Row | null> {
  if (sceneId === null) return null;
  if (subject === "location") {
    const [v] = await selectLocationVariant(ctx, sceneId);
    return v !== null && asNum(v["location_id"]) === subjectId ? v : null;
  }
  const link = PRESENCE_LINK[subject];
  const table = VARIANT_ENTITY[subject];
  if (link === undefined || table === undefined) return null;
  const links = await rows(ctx.exec, link,
                           `scene_id = ? AND ${subject}_id = ?`,
                           [sceneId, subjectId]);
  links.sort((a, b) => (asNum(a["id"]) ?? 0) - (asNum(b["id"]) ?? 0));
  const wanted = asNum(links[0]?.["variant_id"]);
  if (wanted === null) return null;
  const variant = (await rows(ctx.exec, table, "id = ?", [wanted]))[0];
  if (variant === undefined) return null;
  return asNum(variant[`${subject}_id`]) === subjectId ? variant : null;
}

// ---------------------------------------------------------------------------
// Media cascade (Q13)
// ---------------------------------------------------------------------------

/**
 * Which anchor kind an intent is answered by (§12.8). Exported because
 * a second copy of this map is a second answer: `shotContext` reads it
 * to know what a subject's anchors could satisfy.
 */
export const ANCHOR_TYPE_FOR_INTENT: Record<string, string> = {
  visual_identity: "visual", surface: "visual", environment: "visual",
  voice_identity: "audio", acoustic: "audio", motion: "motion",
  performance: "motion",
};

const sameText = (a: SqlValue | undefined, b: SqlValue | undefined): boolean =>
  String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

/**
 * Whether a binding is in force at a position, and when it is not, WHY
 * (spec §12.8).
 *
 * Every filter the binding declares must be satisfied — they compose as
 * AND — and a filter the file leaves null is no condition at all. This
 * used to test the scene range alone while four other declared columns
 * were read by nothing, so a binding scoped to a variant, a time of day
 * or a physical state applied everywhere and its `trail` line said it
 * fired. A cascade that cannot explain an absence is worse than one
 * that resolves less.
 *
 * With no position asked about, only baselines apply and no positional
 * filter is evaluated: there is nothing to evaluate it against, and a
 * baseline that declares one is answering a question nobody asked.
 */
async function bindingApplies(
    ctx: ScfContext, subject: string, subjectId: number, binding: Row,
    sceneId: number | null, order: SceneOrder,
): Promise<BindingVerdict> {
  if (sceneId === null) {
    return pyTruthy(binding["is_baseline"])
      ? { applies: true }
      : { applies: false, by: "not_baseline", value: null,
          reason: "not a baseline" };
  }
  const here = order.get(sceneId);
  const start = order.get(asNum(binding["scene_range_start_id"]) ?? -1);
  const end = order.get(asNum(binding["scene_range_end_id"]) ?? -1);
  if (start !== undefined && (here === undefined || here < start)) {
    return { applies: false, by: "before_scene_range", value: null,
             reason: "before its scene range" };
  }
  if (end !== undefined && (here === undefined || here > end)) {
    return { applies: false, by: "after_scene_range", value: null,
             reason: "after its scene range" };
  }

  // time_of_day_filter (location): equal to the scene's, on §12.17's
  // axis and 0012's closed vocabulary.
  if (pyTruthy(binding["time_of_day_filter"])) {
    const scene = (await rows(ctx.exec, "scene", "id = ?", [sceneId]))[0];
    const value = String(binding["time_of_day_filter"]);
    if (scene === undefined || !pyTruthy(scene["time_of_day"])) {
      return { applies: false, by: "time_of_day_filter", value,
               reason: `time_of_day_filter ` +
                 `"${String(binding["time_of_day_filter"])}", scene says nothing` };
    }
    if (!sameText(scene["time_of_day"], binding["time_of_day_filter"])) {
      return { applies: false, by: "time_of_day_filter", value,
               reason: `time_of_day_filter ` +
                 `"${String(binding["time_of_day_filter"])}" vs scene ` +
                 `"${String(scene["time_of_day"])}"` };
    }
  }

  // variant_id (character, prop, location): the variant §4.8 puts in
  // force here. Until 0033 only the location column existed, because
  // nothing said which character or prop variant was in force.
  if (pyTruthy(binding["variant_id"])) {
    const inForce = await variantInForce(ctx, subject, subjectId, sceneId);
    const wanted = asNum(binding["variant_id"]);
    if (inForce === null || asNum(inForce["id"]) !== wanted) {
      const table = VARIANT_ENTITY[subject];
      const filtered = table === undefined ? undefined
        : (await rows(ctx.exec, table, "id = ?", [wanted]))[0];
      return { applies: false, by: "variant_id",
               value: filtered === undefined
                 ? null : String(filtered["uuid"] ?? ""),
               reason: inForce === null
                 ? "variant filter, no variant in force here"
                 : `variant filter vs "${String(inForce["name"])}" in force` };
    }
  }

  // The state filters (character): a state of that modality in force at
  // this position (§4.5), whose description matches.
  for (const [column, modality] of [
    ["physical_state_filter", "physical"],
    ["vocal_state_filter", "vocal"],
  ] as const) {
    if (!pyTruthy(binding[column])) continue;
    if (subject !== "character") continue;
    const states = await statesInForce(ctx, subjectId, sceneId, modality,
                                       order);
    // Matched against the state's NAME — its natural-key label (§12.5),
    // which is what an author writing a filter has in hand. The
    // description is a sentence and nobody will retype one.
    const hit = states.some((st) => sameText(st["name"], binding[column]));
    if (!hit) {
      return { applies: false, by: column, value: String(binding[column]),
               reason: `${column} "${String(binding[column])}", no such ` +
                 `${modality} state in force` };
    }
  }

  return { applies: true };
}

/**
 * Why a layer of the media cascade did not contribute (§12.8). A closed
 * vocabulary: `by` and `value` are compared, `reason` is prose.
 */
export type TrailExclusionCode =
  | "not_baseline" | "before_scene_range" | "after_scene_range"
  | "time_of_day_filter" | "variant_id" | "physical_state_filter"
  | "vocal_state_filter" | "replaced" | "variant_not_in_force"
  | "displaced" | "canonical_status";

export interface TrailExclusion {
  by: TrailExclusionCode;
  /**
   * What excluded it: a filter's value, an anchor's status, or the uuid
   * of the binding that replaced it, the variant a filter names, or the
   * variant in force. Null where the code says everything.
   */
  value: string | null;
  /** Prose for a person. MUST NOT be parsed or compared. */
  reason: string;
}

/**
 * A trail entry as one line for a person — `binding Eleanor while wounded
 * -> bundle …: EXCLUDED, …`. A rendering, not part of any result: the
 * entry's members are the answer (§12.8).
 */
export function trailLine(e: {
  layer: string; name: string | null; bundleName: string | null;
  reason: string | null;
}): string {
  return `${e.layer} ${e.name ?? "(unnamed)"}` +
    (e.bundleName !== null ? ` -> bundle ${e.bundleName}` : "") +
    (e.reason !== null ? `: EXCLUDED, ${e.reason}` : "");
}

/** `trailLine` for an entry as the cascade returns it. */
export function trailEntryLine(e: TrailEntry): string {
  const label = (r: Row | null): string | null =>
    r === null ? null
      : String(pyTruthy(r["name"]) ? r["name"] : r["id"]);
  return trailLine({ layer: e.layer, name: label(e.row),
                     bundleName: label(e.bundle),
                     reason: e.excluded?.reason ?? null });
}

type BindingVerdict =
  | { applies: true }
  | ({ applies: false } & TrailExclusion);

/** One layer the cascade considered, broadest first (§12.8). */
export interface TrailEntry {
  layer: "binding" | "anchor" | "shot override";
  /** The binding, anchor or shot override row. */
  row: Row;
  /** The bundle it brings, for a binding or a shot override. */
  bundle: Row | null;
  excluded: TrailExclusion | null;
}

async function bundleAssets(
    ctx: ScfContext, bundleId: number): Promise<Row[]> {
  const links = await rows(ctx.exec, "bundle_asset", "bundle_id = ?",
                           [bundleId]);
  links.sort((a, b) => {
    const ao = asNum(a["order"]);
    const bo = asNum(b["order"]);
    if ((ao === null) !== (bo === null)) return ao === null ? 1 : -1;
    if ((ao ?? 0) !== (bo ?? 0)) return (ao ?? 0) - (bo ?? 0);
    return (asNum(a["id"]) ?? 0) - (asNum(b["id"]) ?? 0);
  });
  const out: Row[] = [];
  for (const link of links) {
    const assets = await rows(ctx.exec, "asset", "id = ?",
                              [link["asset_id"] ?? null]);
    const asset = assets[0];
    if (asset !== undefined) {
      out.push({ ...asset, role_in_bundle: link["role_in_bundle"] ?? null });
    }
  }
  return out;
}

export interface ResolvedMedia {
  subject: string;
  subject_id: number;
  intent: string;
  override_assets: Row[];
  anchors: Row[];
  /**
   * The asset each anchor points at, aligned with `anchors` by index.
   *
   * An anchor NAMES a place in an asset; it is not an asset itself and
   * has no identifier. Consumers asking which assets are in force want
   * these. Resolve `anchors[i].asset_id` here and nowhere else —
   * resolved outside, a row id gets looked up in the wrong table and the
   * anchor is reported as an unrelated asset.
   */
  anchor_assets: Array<Row | null>;
  base_assets: Row[];
  assets_most_specific_first: Row[];
  /**
   * For an asset row above that stands in for a superseded one (§12.8,
   * proposal 0039): the superseded row it replaced, keyed by the row
   * object itself. Per occurrence, not per asset: two layers can reach
   * one successor from different originals.
   */
  stands_in_for: Map<Row, Row>;
  trail: TrailEntry[];
  /**
   * Every binding of the requested intent and whether it applied, by row
   * id, for an editor that marks which of a character's exceptions are in
   * force at a scene. Not part of any published result.
   */
  binding_verdicts: Array<{ id: number; applies: boolean;
                            reason: string | null }>;
}

/**
 * §12.8: a superseded asset gives way to its successor.
 *
 * Follows `superseded_by_id` to the last asset on the forward version
 * chain: the first row that is not `superseded`, or the last row the
 * chain reaches where it simply stops. Returns the asset itself when it
 * is not superseded, has no successor, points at a row that is not
 * there, or sits on a cycle — the resolver is total (§9.2), and the
 * `identity.*` codes report each of those. Returns null where the
 * successor is CUT: §6.6.1 excludes it like any cut row, and the
 * reference is dropped, not walked back.
 *
 * This is substitution, not exclusion. Q15 still walks the whole chain.
 */
async function successorInForce(
    ctx: ScfContext, asset: Row): Promise<Row | null> {
  if (asset["lifecycle_status"] !== "superseded") return asset;
  const visited = new Set<number>([asNum(asset["id"]) ?? -1]);
  let at = asset;
  while (at["lifecycle_status"] === "superseded") {
    const next = asNum(at["superseded_by_id"]);
    if (next === null) break;                    // the chain stops here
    if (visited.has(next)) return asset;         // a cycle has no last row
    const row = (await rowsIncludingCut(
      ctx.exec, "asset", "id = ?", [next]))[0];
    if (row === undefined) break;                // dangling: stay put
    visited.add(next);
    at = row;
  }
  if (at["lifecycle_status"] === "cut") return null;
  return at;
}

/**
 * Apply `successorInForce` to one layer's assets, in place of each
 * superseded one. The successor keeps what the LAYER said about the
 * original — its `role_in_bundle` — because the layer placed a file in
 * a role, and the newer file inherits the place.
 */
async function givingWay<T extends Row | null>(
    ctx: ScfContext, layer: T[], standsInFor: Map<Row, Row>,
    drop: "remove" | "null"): Promise<T[]> {
  const out: T[] = [];
  for (const asset of layer) {
    if (asset === null) { out.push(asset); continue; }
    const successor = await successorInForce(ctx, asset);
    if (successor === asset) { out.push(asset); continue; }
    if (successor === null) {
      if (drop === "null") out.push(null as T);
      continue;
    }
    const standIn: Row = "role_in_bundle" in asset
      ? { ...successor, role_in_bundle: asset["role_in_bundle"] ?? null }
      : { ...successor };
    standsInFor.set(standIn, asset);
    out.push(standIn as T);
  }
  return out;
}

/**
 * The media cascade, as a function. subject is 'character', 'prop', or
 * 'location'. Returns override / anchor / base layers with assets
 * most-specific-first, plus the resolution trail.
 */
export async function resolveMedia(
    ctx: ScfContext, subject: string, subjectId: number, intent: string,
    sceneId: number | null = null,
    shotId: number | null = null): Promise<ResolvedMedia> {
  const order = await sceneOrder(ctx);
  const idField = `${subject}_id`;
  const trail: TrailEntry[] = [];

  // Base bundles via bindings, filtered to intent, in §12.8.2's order:
  // precedence highest first, equal precedence by row id, lower first.
  const bindings = await rows(ctx.exec, `${subject}_asset_binding`,
                              `${idField} = ?`, [subjectId]);
  bindings.sort((a, b) =>
    ((asNum(b["precedence"]) ?? 0) - (asNum(a["precedence"]) ?? 0)) ||
    ((asNum(a["id"]) ?? 0) - (asNum(b["id"]) ?? 0)));
  const baseAssets: Row[] = [];
  // Built highest precedence first, and reversed into `trail`, which runs
  // broadest first (§12.8).
  const bindingLines: TrailEntry[] = [];
  // The first `replace` binding in force: everything below its precedence
  // is excluded. Equal precedence is ordered, never replaced.
  let replacer: { name: string; uuid: string; precedence: number } | null =
    null;
  const verdicts: ResolvedMedia["binding_verdicts"] = [];
  for (const b of bindings) {
    const bundles = await rows(ctx.exec, "bundle", "id = ?",
                               [b["bundle_id"] ?? null]);
    const bundle = bundles[0];
    if (bundle === undefined || bundle["intent"] !== intent) continue;
    const name = String(pyTruthy(b["name"]) ? b["name"] : b["id"]);
    const entry = (excluded: TrailExclusion | null): TrailEntry =>
      ({ layer: "binding", row: b, bundle, excluded });
    const verdict = await bindingApplies(ctx, subject, subjectId, b,
                                         sceneId, order);
    if (!verdict.applies) {
      // An absence with a reason. A binding excluded silently is how a
      // filter nothing read went unnoticed for two schema versions.
      const { by, value, reason } = verdict;
      bindingLines.push(entry({ by, value, reason }));
      verdicts.push({ id: asNum(b["id"]) ?? -1, applies: false, reason });
      continue;
    }
    const precedence = asNum(b["precedence"]) ?? 0;
    if (replacer !== null && precedence < replacer.precedence) {
      const reason = `replaced by ${replacer.name}`;
      bindingLines.push(entry({ by: "replaced", value: replacer.uuid,
                                reason }));
      verdicts.push({ id: asNum(b["id"]) ?? -1, applies: false, reason });
      continue;
    }
    bindingLines.push(entry(null));
    verdicts.push({ id: asNum(b["id"]) ?? -1, applies: true, reason: null });
    baseAssets.push(
      ...await bundleAssets(ctx, asNum(b["bundle_id"]) ?? -1));
    if (replacer === null && sameText(b["combine"], "replace")) {
      replacer = { name, uuid: String(b["uuid"] ?? ""), precedence };
    }
  }
  trail.push(...bindingLines.reverse());

  // Anchors for the subject, of the intent's anchor type (§12.8's
  // table). One of another type answers a different question and is not
  // considered; one of this type that is not verified is considered,
  // excluded, and says so.
  const anchorType = ANCHOR_TYPE_FOR_INTENT[intent];
  // An anchor whose asset is cut names a place in something that is not
  // in the film (§6.6.1), and is not considered — no trail entry, as for
  // a binding whose bundle is cut (§12.8). An ABSENT asset is different:
  // the anchor is still in the film, dangling, and is kept.
  const cutAssets = new Set((await rowsIncludingCut(
    ctx.exec, "asset", "lifecycle_status = 'cut'")).map((r) => r["id"]));
  const ofType = (await rows(
    ctx.exec, "entity_anchor", "subject_type = ? AND subject_id = ?",
    [subject, subjectId]))
    .filter((a) => anchorType === undefined ||
                   a["anchor_type"] === anchorType)
    .filter((a) => !cutAssets.has(a["asset_id"] ?? null));
  const verified = (a: Row): boolean =>
    a["canonical_status"] === null || a["canonical_status"] === undefined ||
    a["canonical_status"] === "" || a["canonical_status"] === "verified";
  for (const a of ofType) {
    if (verified(a)) continue;
    const status = String(a["canonical_status"]);
    trail.push({ layer: "anchor", row: a, bundle: null, excluded: {
      by: "canonical_status", value: status,
      reason: `canonical_status "${status}", not verified` } });
  }
  let anchors = ofType.filter(verified);

  // Variant anchors (§12.8, proposal 0033). An anchor naming a variant
  // contributes only where that variant is in force; where it does and
  // the variant has an anchor of this type, the subject's own anchors of
  // the type step aside — an anchor is identity, and two faces at one
  // position contradict rather than combine. Every anchor left out says
  // why: until 0033 `subject_variant_id` was read by nothing, and a
  // variant's face came back as the subject's in every scene.
  const variant = await variantInForce(ctx, subject, subjectId, sceneId);
  const variantId = variant === null ? null : asNum(variant["id"]);
  const ofVariant = anchors.filter((a) =>
    variantId !== null && asNum(a["subject_variant_id"]) === variantId);
  const own = anchors.filter((a) => !pyTruthy(a["subject_variant_id"]));
  const kept = ofVariant.length > 0 ? ofVariant : own;
  const inForce = variant === null ? null : String(variant["uuid"] ?? "");
  for (const a of anchors) {
    if (kept.includes(a)) continue;
    trail.push({ layer: "anchor", row: a, bundle: null,
      excluded: pyTruthy(a["subject_variant_id"])
        ? { by: "variant_not_in_force", value: inForce,
            reason: variant === null
              ? "its variant is not in force here"
              : `its variant is not "${String(variant["name"])}"` }
        : { by: "displaced", value: inForce,
            reason: `displaced by variant "${String(variant?.["name"])}"` } });
  }
  anchors = kept;
  const anchorAssets: Array<Row | null> = [];
  for (const a of anchors) {
    trail.push({ layer: "anchor", row: a, bundle: null, excluded: null });
    const assetId = Number(a["asset_id"]);
    anchorAssets.push(Number.isFinite(assetId)
      ? (await rows(ctx.exec, "asset", "id = ?", [assetId]))[0] ?? null
      : null);
  }

  // Shot overrides, most specific of all. A kind with no override
  // entity (a costume) has none to consider.
  const overrideAssets: Row[] = [];
  if (shotId !== null &&
      ctx.registry.entities.has(`${subject}_shot_override`)) {
    const overrides = await rows(
      ctx.exec, `${subject}_shot_override`,
      `shot_id = ? AND ${idField} = ?`, [shotId, subjectId]);
    for (const o of overrides) {
      if (pyTruthy(o["bundle_override_id"])) {
        const bundle = (await rows(ctx.exec, "bundle", "id = ?",
                                   [o["bundle_override_id"] ?? null]))[0]
          ?? null;
        // Of the intent asked about, like a binding's bundle: an override
        // of the face is not an answer about the voice.
        if (bundle === null || bundle["intent"] !== intent) continue;
        trail.push({ layer: "shot override", row: o, bundle,
                     excluded: null });
        overrideAssets.push(
          ...await bundleAssets(ctx, asNum(o["bundle_override_id"]) ?? -1));
      }
    }
  }

  // A superseded asset gives way to its successor (§12.8), after the
  // layers are walked and before anything is deduplicated: the
  // at-most-once rule then sees the successor, so one another layer
  // already carries appears once, under the stronger layer.
  const standsInFor = new Map<Row, Row>();
  const overrides = await givingWay(ctx, overrideAssets, standsInFor,
                                    "remove");
  // Aligned with `anchors` by index, so a dropped one leaves its slot.
  const anchored = await givingWay(ctx, anchorAssets, standsInFor, "null");
  const base = await givingWay(ctx, baseAssets, standsInFor, "remove");

  const overrideIds = new Set(overrides.map((x) => x["id"]));
  return {
    subject,
    subject_id: subjectId,
    intent,
    override_assets: overrides,
    anchors,
    anchor_assets: anchored,
    base_assets: base,
    assets_most_specific_first: [
      ...overrides,
      ...base.filter((a) => !overrideIds.has(a["id"])),
    ],
    stands_in_for: standsInFor,
    trail,
    binding_verdicts: verdicts,
  };
}
