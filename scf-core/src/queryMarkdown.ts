// SPDX-License-Identifier: Apache-2.0
/**
 * queryMarkdown.ts — a canonical query's result, as a prompt-ready block.
 *
 * Each query's NORMATIVE result (spec §12, `canonicalQueries.ts`) has a
 * markdown rendering: headed sections of what is in force, small enough
 * to paste into a prompt and readable by a person. It lives here, with
 * the queries, so the editor's "copy as context" and an MCP client asking
 * for markdown get the same text from the same code — not a rendering
 * kept in the UI that the other would have to copy.
 *
 * Nothing in this module reads a file: it takes a result a query has
 * already produced.
 */

import type { ProjectedRow, QueryResult } from "./queryResult.ts";
import type { Registry } from "./registry.ts";
import {
  Q00_LAYERS,
  type Q00Result, type Q01Result, type Q02Result, type Q03Result,
  type Q04Result, type Q05Result, type Q07Result, type Q09Result,
  type Q10Result, type Q11Result, type Q12Result, type Q13Result,
  type Q14Result, type Q15Result, type Q13TrailEntry,
} from "./canonicalQueries.ts";
import { trailLine } from "./resolution.ts";
import {
  referencesMarkdown, type AssetReference, type Provenance,
  type ResolutionSummary,
} from "./mediaReferences.ts";
import type { ResolutionState } from "./assets.ts";

// ---------------------------------------------------------------------------
// Reading a projected row (§12.1.2) for display
// ---------------------------------------------------------------------------

/** Authored, but not worth a line: identity, lifecycle, version plumbing. */
const SKIP = new Set([
  "name", "lifecycle_status", "external_id", "external_id_namespace",
  "version_label", "superseded_at",
]);

/** A row's display name, or `fallback` when it carries none. */
export function nameOf(row: ProjectedRow | null | undefined,
                       fallback = "—"): string {
  const v = row?.fields["name"];
  return v === undefined || v === null || v === "" ? fallback : String(v);
}

/** One field, or null when the row does not carry it. */
export function field(row: ProjectedRow | null | undefined,
                      key: string): string | null {
  const v = row?.fields[key];
  return v === undefined || v === null || v === "" ? null : String(v);
}

/**
 * The authored fields worth showing, in the registry's column order
 * rather than the projection's alphabetical one — a profile reads in
 * the order it was designed to be filled in. Resolved references
 * (`*_uuid`) are skipped: a uuid is identity, not content.
 */
export function authoredEntries(
    registry: Registry, entity: string | null, row: ProjectedRow,
    includeName = false): Array<[string, unknown]> {
  const keep = (k: string): boolean =>
    (includeName ? k === "name" || !SKIP.has(k) : !SKIP.has(k)) &&
    !k.endsWith("_uuid");
  const order = entity === null ? []
    : (registry.entities.get(entity)?.fields ?? []).map((f) => f.name);
  const keys = Object.keys(row.fields).filter(keep);
  const rank = (k: string): number => {
    const i = order.indexOf(k);
    return i < 0 ? order.length : i;
  };
  return keys
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map((k) => [k, row.fields[k]]);
}

/**
 * Markdown text for a field value. A `string_list` arrives as an array
 * and is written back as the JSON it was stored as, so a context block
 * reads the same whether or not the column was declared a list.
 */
export function valueText(v: unknown): string {
  if (Array.isArray(v) || (typeof v === "object" && v !== null)) {
    return JSON.stringify(v);
  }
  return String(v);
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

/** Typed access to a result body; every spec knows its own. */
const body = <T>(payload: QueryResult<unknown>): T => payload.result as T;

function section(title: string, lines: string[], emptyNote?: string): string {
  if (lines.length === 0) {
    return emptyNote !== undefined ? `## ${title}\n${emptyNote}\n` : "";
  }
  return `## ${title}\n${lines.join("\n")}\n`;
}

/** Title, blank line, sections — the composed pages' layout. */
function md(title: string, blocks: string[]): string {
  return `# ${title}\n\n` + blocks.filter((b) => b !== "").join("\n");
}

function fieldLines(registry: Registry, entity: string | null,
                    row: ProjectedRow, includeName = false): string[] {
  return authoredEntries(registry, entity, row, includeName)
    .map(([k, v]) => `- ${k}: ${valueText(v)}`);
}

/** A named card: the name in bold, its fields indented under it. */
function card(registry: Registry, entity: string | null,
              row: ProjectedRow): string[] {
  return [`- **${nameOf(row, "")}**`,
          ...fieldLines(registry, entity, row).map((l) => `  ${l}`)];
}

/** `- name (k: v; k: v)` for the fields given, where present. */
function rowLine(row: ProjectedRow, keys: string[]): string {
  const parts = keys.flatMap((k) => {
    const v = field(row, k);
    return v === null ? [] : [`${k}: ${v}`];
  });
  return `- ${nameOf(row, "(unnamed)")}` +
    (parts.length > 0 ? ` (${parts.join("; ")})` : "");
}

/** ` (heard)`, ` as the boy` — only what differs from the plain case. */
function presenceNote(presence: string | null,
                      variant: string | null): string {
  return (presence !== null && presence !== "seen" ? ` (${presence})` : "") +
    (variant !== null ? ` as ${variant}` : "");
}


function dossierMarkdown(registry: Registry, d: Q01Result): string[] {
  return [
    ...d.groups.map((g) => section(g.entity,
      g.rows.flatMap((r) => card(registry, g.entity, r)))),
    section("Motif carriage", d.motifCarriage.map((m) =>
      `- ${nameOf(m.motif, "motif")}` +
      (field(m.appearance, "domain") !== null
        ? ` (${field(m.appearance, "domain")})` : ""))),
    section("Thematic connections", d.thematicConnections.map((t) =>
      `- ${field(t, "nature_of_connection") ?? "connected"}` +
      ` (subtlety: ${field(t, "subtlety_level") ?? "—"})`)),
    section("Relationships", d.relationships.map(relationshipLine)),
  ];
}

/**
 * `- Marcus Cade: family, brother (mutual)`. The direction is read from
 * the subject's own end: `a_to_b` runs A → B (§6.5), so from side "b"
 * it arrives rather than leaves.
 */
function relationshipLine(r: Q01Result["relationships"][number]): string {
  const kind = [field(r.relationship, "relationship_type"),
                field(r.relationship, "specific_relationship")]
    .filter((v): v is string => v !== null).join(", ");
  const direction = field(r.relationship, "directionality");
  const reads = direction === "a_to_b"
    ? (r.side === "a" ? "from this character to them"
                      : "from them to this character")
    : direction === "mutual" ? "mutual" : null;
  return `- ${nameOf(r.other, "(someone not in this file)")}` +
    (kind !== "" ? `: ${kind}` : "") +
    (reads !== null ? ` (${reads})` : "");
}

function cascadeMarkdown(name: string, p: Q07Result): string {
  return `# ${name}\n` + section(
    "Cascade, root first (most specific opinion last)",
    p.layers.map((l, i) =>
      `${i + 1}. **${l.entity}**: ${nameOf(l.row, "(unnamed)")}` +
      (i === p.layers.length - 1 ? " ← in force" : "")));
}

/** A trail entry as one line: the result's members, rendered. */
function q13TrailLine(t: Q13TrailEntry): string {
  return trailLine({ layer: t.layer, name: t.name,
                     bundleName: t.bundle?.name ?? null,
                     reason: t.excluded?.reason ?? null });
}

/**
 * The references section, from the result. `referencesMarkdown` takes
 * the resolver's shape, which carries row ids; a result carries none,
 * so the shape is rebuilt from what the result does carry.
 */
function q13References(p: Q13Result): string {
  const references: AssetReference[] = p.references.map((r) => ({
    ...r, id: -1, name: r.name ?? r.anchorName ?? r.uuid ?? "asset",
    provenance: r.provenance as Provenance,
    state: r.state as ResolutionState,
  }));
  const summary: ResolutionSummary = {
    referenced: references.length,
    counts: p.counts as Record<ResolutionState, number>,
    unresolved: references.filter((r) => r.state !== "resolved")
      .map((r) => ({ name: r.name, identifier: r.identifier,
                     state: r.state })),
  };
  return referencesMarkdown({ references, summary }, p.rootMapped);
}


// ---------------------------------------------------------------------------
// The renderers
// ---------------------------------------------------------------------------

export type MarkdownRenderer =
  (payload: QueryResult<unknown>, registry: Registry) => string;

/** Q05 and Q06 share a shape and differ in name and profile entity. */
function descriptionMarkdown(name: string,
                             profileEntity: string): MarkdownRenderer {
  return (payload, registry) => {
    const p = body<Q05Result>(payload);
    return `# ${name}\n` +
      section("Baseline", p.baseline === null ? ["- none — no baseline"]
        : fieldLines(registry, profileEntity, p.baseline, true)) +
      section("States in force", p.states.map((s) =>
        rowLine(s, ["persistence", "intensity"]))) +
      section("Merged modulations",
        Object.entries(p.modulations).map(([k, v]) =>
          `- ${k}: ${String(v)}`)) +
      section("Beats", p.beats.map((b) =>
        rowLine(b, ["line_text", "pace", "volume", "physical_action",
                    "visibility"])));
  };
}

export const QUERY_IDS = [
  "Q00", "Q01", "Q02", "Q03", "Q04", "Q05", "Q06", "Q07", "Q08", "Q09",
  "Q10", "Q11", "Q12", "Q13", "Q14", "Q15",
] as const;
export type QueryId = (typeof QUERY_IDS)[number];

const RENDERERS: Record<QueryId, MarkdownRenderer> = {
  Q00: (payload, registry) => {
    const p = body<Q00Result>(payload);
    const layers = new Map(p.layers.map((l) => [l.entity, l.row]));
    return md(
      `Brief — ${nameOf(layers.get("project"), "untitled project")}`,
      [
        // Every layer §12.12 reports, so an unauthored one says so
        // rather than vanishing from the brief.
        ...Q00_LAYERS.map((entity) => {
          const row = layers.get(entity);
          return row === undefined
            ? section(entity, [], "*(not yet authored)*")
            : section(entity, fieldLines(registry, entity, row,
                                         entity !== "project"));
        }),
        section("Poster", p.posters.map((a, i) =>
          `- ${nameOf(a, "asset")}${i > 0 ? " (alternative)" : ""}`)),
        section("Themes", p.themes.map((t) =>
          `- **${nameOf(t)}**` +
          (field(t, "description") !== null
            ? `: ${field(t, "description")}` : ""))),
      ]);
  },
  Q01: (payload, registry) => {
    const p = body<Q01Result>(payload);
    return md(`Dossier — ${nameOf(p.subject, "?")}`,
              dossierMarkdown(registry, p));
  },
  Q02: (payload, registry) => {
    const p = body<Q02Result>(payload);
    const rowsOf = (entity: string, list: ProjectedRow[]): string[] =>
      list.flatMap((r) => card(registry, entity, r));
    const absent = "*(none — well-defined absence)*";
    const blocks: string[] = [
      section("Dossier (global baseline)",
        p.dossier.groups.flatMap((g) =>
          g.rows.map((r) => `- [${g.entity}] ${nameOf(r, "")}`))),
    ];
    if (p.subjectType === "character") {
      blocks.push(
        section("Variant in force",
          p.characterVariant === null ? []
            : rowsOf("character_variant", [p.characterVariant]), absent),
        section("Costume in force", rowsOf("costume", p.costumes), absent),
        section("Relationship state as of here",
          p.relationshipStates.map((r) =>
            `- ${field(r, "stage_label") ?? nameOf(r, "stage")}`), absent),
        section("Arc stage as of here",
          rowsOf("character_arc_state", p.arcStates), absent),
        section("Performance states in force",
          rowsOf("performance_state", p.performanceStates), absent),
        section("Moment direction (beats)",
          rowsOf("performance_beat", p.beats), absent));
    }
    if (p.subjectType === "location" && p.locationVariant !== null) {
      const v = p.locationVariant;
      blocks.push(section("Variant in force",
        [...(v.variant === null ? []
               : rowsOf("location_variant", [v.variant])),
         ...v.mismatches.map((m) => `- mismatch: ${m}`)], absent));
    }
    if (p.subjectType === "prop") {
      blocks.push(
        section("Variant in force",
          p.propVariant === null ? []
            : rowsOf("prop_variant", [p.propVariant]), absent),
        section("Prop state as of here",
          p.propState === null ? []
            : [`- ${field(p.propState, "whereabouts") ??
                    nameOf(p.propState, "state")}`], absent));
    }
    blocks.push(section(
      `Media in force (${p.media.fromQuery}, intent=${p.media.intent})`,
      p.media.references.map((r) =>
        `- ${r.name ?? r.anchorName ?? "asset"}` +
        (r.role !== null ? ` (${r.role})` : "")),
      "*(nothing resolves)*"));
    return md(`${nameOf(p.subject, "?")} in ${nameOf(p.scene, "scene")} — ` +
              "context stack, most specific last", blocks);
  },
  Q03: (payload) => {
    const p = body<Q03Result>(payload);
    return `# World state — ${nameOf(p.scene, "scene")}\n` +
      section("Characters present", p.characters.map((c) =>
        `- ${nameOf(c.character)}` +
        presenceNote(c.presence, c.variant === null ? null
                                   : nameOf(c.variant)) +
        `: states in force: ` +
        `${c.states.map((s) => nameOf(s)).join(", ") ||
          "none (baseline)"};` +
        ` wearing: ${c.costumes.map((x) => nameOf(x)).join(", ") || "—"}`)) +
      section("Props present", p.props.map((x) =>
        `- ${nameOf(x.prop)}` +
        presenceNote(x.presence, x.variant === null ? null
                                   : nameOf(x.variant)) +
        `: ${field(x.state, "whereabouts") ?? "state not yet established"}`))
      + section("Motifs appearing", p.motifs.map((m) =>
        `- ${m.name}${m.domain !== null ? ` (${m.domain})` : ""}`));
  },
  Q04: (payload, registry) => {
    const p = body<Q04Result>(payload);
    const v = p.locationVariant;
    return md(`Scene package — ${nameOf(p.scene, "?")}`, [
      section("Structural lineage", p.lineage.map((l) =>
        `- [${l.entity}] ${nameOf(l.row)}`)),
      section("Story beats", p.storyBeats.map((b) =>
        `- ${nameOf(b, "")} (${field(b, "beat_type") ?? "beat"})` +
        (field(b, "value_shift") !== null
          ? ` — ${field(b, "value_shift")}` : ""))),
      section("Cast", p.cast.map((c) =>
        `- ${nameOf(c.character)}` + presenceNote(
          c.presence, c.variant === null ? null : nameOf(c.variant)))),
      section("Props", p.props.map((x) =>
        `- ${nameOf(x.prop)}` + presenceNote(
          x.presence, x.variant === null ? null : nameOf(x.variant)))),
      section("Location", p.location !== null
        ? [`- ${nameOf(p.location)}` +
           (v.variant !== null
             ? ` — variant in force: ${nameOf(v.variant)}` : ""),
           ...v.mismatches.map((m) => `  - mismatch: ${m}`)]
        : []),
      ...p.detail.map((d) => section(d.entity,
        d.rows.flatMap((r) => card(registry, d.entity, r)))),
      section("Staging", [
        ...p.blocking.map((b) => `- blocking: ${nameOf(b, "")}`),
        ...p.stagingBeats.map((b) =>
          `  - beat ${field(b, "beat_order") ?? ""}: ` +
          `${field(b, "name") ?? field(b, "description") ?? ""}`),
      ]),
      section("Screenplay", p.screenplay.map((l) => {
        const type = field(l, "line_type") ?? "";
        return type === "blank" ? "" : `${type}: ${field(l, "content") ?? ""}`;
      }), "*(no lines — the screenplay has not reached this scene)*"),
    ]);
  },
  Q05: descriptionMarkdown("Voice direction", "vocal_profile"),
  Q06: descriptionMarkdown("Physical direction",
    "physical_character_profile"),
  Q07: (payload) =>
    cascadeMarkdown("Look resolution", body<Q07Result>(payload)),
  Q08: (payload) =>
    cascadeMarkdown("Soundscape", body<Q07Result>(payload)),
  Q09: (payload) => {
    const p = body<Q09Result>(payload);
    return md(`Motif manifest — ${nameOf(p.scene, "?")}`, [
      p.dense
        ? `**Density warning:** ${p.manifest.length} motifs in one ` +
          `scene (heuristic threshold ${p.densityThreshold}).\n`
        : "",
      section("Checklist", p.manifest.map((m) =>
        `- [ ] **${nameOf(m.motif, "motif")}** — domain: ` +
        `${field(m.appearance, "domain") ?? "—"}; subtlety: ` +
        `${field(m.state, "subtlety_level") ??
           field(m.motif, "subtlety_level") ?? "—"}` +
        (field(m.appearance, "manifestation_notes") !== null
          ? `; ${field(m.appearance, "manifestation_notes")}` : "")),
        "*(no motifs placed here)*"),
      section("Cross-modality candidates (related motifs not placed)",
        p.candidates.map((c) => `- ${nameOf(c)}`)),
    ]);
  },
  Q10: (payload) => {
    const p = body<Q10Result>(payload);
    const gaps = p.spine.filter((s) => s.carriers === 0)
      .map((s) => `sc ${s.sceneNumber ?? "?"}`);
    return md(`Thematic accounting — ${nameOf(p.theme, "?")}`, [
      section("Carriers", p.carriers.map((c) =>
        `- ${c.targetEntity}: ${c.targetName ?? "?"} (${
          field(c.connection, "nature_of_connection") ?? "connected"}) — ` +
        `${c.sceneUuids.length} scene(s)`)),
      section("Distribution",
        p.spine.filter((s) => s.carriers > 0).map((s) =>
          `- sc ${s.sceneNumber ?? "?"}: ${s.carriers} carrier(s)`)),
      section("Absent from", gaps.length === p.spine.length
        ? ["- every scene — the theme has no position-keyed carriers"]
        : [`- ${gaps.join(", ") || "nowhere — full coverage"}`]),
    ]);
  },
  Q11: (payload, registry) => {
    const p = body<Q11Result>(payload);
    const id = p.identification;
    return md(`Audience state — ${nameOf(p.scene, "?")}`, [
      section("Known / withheld", p.information !== null
        ? fieldLines(registry, "information_strategy", p.information) : [],
        "*(no information strategy authored)*"),
      section("Identification", id !== null
        ? [`- primary: ${nameOf(id.primary)}`,
           ...(id.secondary !== null
             ? [`- secondary: ${nameOf(id.secondary)}`] : []),
           ...fieldLines(registry, "identification_strategy", id.row)]
        : [], "*(no identification strategy authored)*"),
      section("Emotional beats", p.emotionalBeats.map((e) =>
        `- ${field(e.beat, "target_emotion") ?? nameOf(e.beat, "")}` +
        (e.arc !== null ? ` (arc: ${nameOf(e.arc)})` : ""))),
      section("Tone", p.toneMarkers.flatMap((t) => [
        `- **${field(t, "tone_descriptor") ?? nameOf(t, "")}**`,
        ...fieldLines(registry, "tone_marker", t).map((l) => `  ${l}`),
      ])),
      section("Emotional direction cascade, root first",
        p.emotionalCascade.map((l, i) =>
          `${i + 1}. **${l.entity}**: ${nameOf(l.row, "")}` +
          (i === p.emotionalCascade.length - 1 ? " ← in force" : ""))),
    ]);
  },
  Q12: (payload) => {
    const p = body<Q12Result>(payload);
    const diff = (x: string | null, y: string | null): string =>
      x === y ? `${x ?? "—"} (unchanged)` : `${x ?? "—"} → ${y ?? "—"}`;
    // A variant line only where one is in force at either end, so a
    // diff with no versions in play reads as it always did.
    const variant = (a: string | null, b: string | null): string =>
      a === null && b === null ? "" : `; version: ${diff(a, b)}`;
    return `# Continuity — ${nameOf(p.from, "?")} → ${nameOf(p.to, "?")}\n` +
      section("Character states", p.characters.map((c) =>
        `- ${nameOf(c.character)}: ` +
        diff(c.statesFrom.join(", ") || "baseline",
             c.statesTo.join(", ") || "baseline") +
        variant(c.variantFrom, c.variantTo))) +
      section("Relationships", p.relationships.map((r) =>
        `- ${nameOf(r.relationship, "relationship")}: ` +
        diff(r.stageFrom, r.stageTo))) +
      section("Props", p.props.map((x) =>
        `- ${nameOf(x.prop)}: ` + diff(x.whereFrom, x.whereTo) +
        variant(x.variantFrom, x.variantTo)));
  },
  Q13: (payload) => {
    const p = body<Q13Result>(payload);
    return `# Media resolution — ${p.subjectKind}, ${p.intent}\n` +
      section("Resolution trail", p.trail.map((t) => `- ${q13TrailLine(t)}`)) +
      section("Anchors", p.references
        .filter((r) => r.provenance === "anchor")
        .map((r) => `- ${r.anchorName ?? r.name ?? "anchor"}`)) +
      q13References(p);
  },
  Q14: (payload) => {
    const p = body<Q14Result>(payload);
    return `# Readiness — ${p.target} (${p.targetName})\n` +
      section("Findings", p.findings.map((f) =>
        `- [${f.severity}] ${f.entity}: ${f.message}`));
  },
  Q15: (payload, registry) => {
    const p = body<Q15Result>(payload);
    const cards = (entity: string, list: ProjectedRow[]): string[] =>
      list.flatMap((r) => card(registry, entity, r));
    return md(`Provenance — ${p.entityType}: ${nameOf(p.row, "?")}`, [
      section("Lifecycle", p.row !== null ? [
        `- lifecycle_status: ${field(p.row, "lifecycle_status") ?? "—"}`,
        `- uuid: ${p.row.uuid ?? "—"}`,
      ] : []),
      section("Version chain", p.versionChain.map((v) =>
        `- ${field(v, "version_label") ?? v.uuid ?? "?"}` +
        (v.uuid === p.row?.uuid ? " ← this row" : "") +
        (field(v, "superseded_at") !== null
          ? ` (superseded ${field(v, "superseded_at")})` : ""))),
      section("Attached decisions",
        cards("creative_decision", p.attached.decisions)),
      section("Attached notes",
        cards("collaboration_note", p.attached.notes)),
    ]);
  },
};

/** The markdown block for a query's result. */
export function queryMarkdown(
    id: QueryId, payload: QueryResult<unknown>, registry: Registry): string {
  return RENDERERS[id](payload, registry);
}

/** Is this a canonical query id that has a rendering? */
export function isQueryId(id: string): id is QueryId {
  return (QUERY_IDS as readonly string[]).includes(id);
}
