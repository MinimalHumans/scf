// SPDX-License-Identifier: Apache-2.0
/**
 * queryTools.ts — one MCP tool per canonical query, precisely typed.
 *
 * Originally these sixteen went through a single generic `query(id,
 * params)` tool with a loose `Record<string, string>` schema. In use,
 * an agent given that shape had no way to know which params a given id
 * needed short of guessing or reading source — the same discoverability
 * failure `list` was built to fix for enumeration, here for parameters.
 *
 * The fix leans on something that already existed and was already
 * authoritative: every query's name, one-line purpose and exact
 * parameter names are published in spec/scf-spec.md §12 (Q00 §12.12
 * through Q15 §12.14) — copied here as data, not re-derived, so this
 * catalog can't say something the spec doesn't. Each entry becomes one
 * `registerTool` call with a Zod shape naming exactly the params
 * dispatch.ts's `buildDispatch` already expects, so a wrong or missing
 * parameter is rejected by schema validation before it reaches the
 * server at all, not discovered by a failed call.
 *
 * "Copied here as data" is checked, not trusted: id/title/section/
 * summary are the same facts spec/query-reference.md already generates
 * (scf-core/scripts/emit_query_reference.mjs) and CI already keeps
 * honest against §12 (`check-query-reference`). Without a second check
 * tying THIS copy to that one, CATALOG could retitle a query or drop a
 * param and nothing would notice — see
 * test/queryCatalog.consistency.test.ts, which fails the build if the
 * two ever disagree.
 *
 * Each tool is registered under a semantic name derived from its title
 * (`toolNameFor`, e.g. "Voice direction" -> "voice_direction") rather
 * than the bare id: a tool named "Q05" tells an agent skimming
 * `tools/list` nothing, where "voice_direction" does. The id stays in
 * the description (spec cross-reference) and in every result's own
 * `query` envelope field (spec §12.1.1) — nothing about the id is lost,
 * it just isn't what selects the tool anymore.
 *
 * Q14 is deliberately not here — the friendlier, separately-named
 * `readiness` tool in mcpServer.ts already is Q14, and a "Q14" tool
 * alongside it would be the same capability under two names.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, type ZodRawShape } from "zod";
import { buildDispatch, type QueryParams } from "./dispatch.ts";
import { queryMarkdown, type QueryId } from "@minimalhumans/scf-core";
import { registry, type ProjectCache } from "./projectCache.ts";
import { SESSION_ID, forSession } from "./session.ts";
import { err, ok, text } from "./toolResult.ts";

/**
 * Every query tool also takes `format`. JSON is the normative result
 * (spec §12); markdown is the prompt-ready block the editor copies as
 * context, rendered by the same scf-core code.
 */
export const FORMAT = z.enum(["json", "markdown"]).optional().describe(
  "\"json\" (default) is the normative result; \"markdown\" is a " +
  "prompt-ready block of the same facts.");

export interface QueryToolSpec {
  id: string;
  /** spec/scf-spec.md §12 title, e.g. "Subject in context". */
  title: string;
  section: string;
  /**
   * The spec's own bolded one-line summary, VERBATIM — checked against
   * spec/query-reference.md by test/queryCatalog.consistency.test.ts.
   * Hand-added context belongs in `note`, not blended in here, or the
   * check has nothing exact left to compare.
   */
  summary: string;
  /** Extra hand-authored context beyond the spec's summary, if any —
   *  not spec-derived, so not checked against it. */
  note?: string;
  /** This query's own params — nothing else is added. */
  shape: ZodRawShape;
}

/**
 * The MCP tool name for a query: its title, lowercased and
 * underscored. Derived rather than hand-assigned so there is only one
 * place a name could go stale relative to `title` — this function —
 * instead of sixteen.
 */
export function toolNameFor(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

const uuid = (of: string): z.ZodString =>
  z.string().describe(`Uuid of the ${of}, e.g. from find() or list().`);

const subjectFields: ZodRawShape = {
  subjectType: z.string().describe(
    "Registry entity name of the subject's kind, e.g. \"character\", " +
    "\"location\", \"prop\"."),
  subject: uuid("subject"),
};

export const CATALOG: QueryToolSpec[] = [
  { id: "Q00", title: "Brief", section: "§12.12",
    summary: "What film is this, and what are its rules.",
    shape: {} },
  { id: "Q01", title: "Subject dossier", section: "§12.15",
    summary: "Everything about a subject, before any scene bends it.",
    shape: { ...subjectFields } },
  { id: "Q02", title: "Subject in context", section: "§12.16",
    summary: "Everything needed to realise a subject in a scene, and " +
      "optionally a shot.",
    shape: { ...subjectFields, scene: uuid("scene"),
             shot: uuid("shot").optional() } },
  { id: "Q03", title: "World state", section: "§12.4",
    summary: "Everything true at one position.",
    shape: { scene: uuid("scene") } },
  { id: "Q04", title: "Scene package", section: "§12.17",
    summary: "The complete context for a scene, as a unit of work.",
    shape: { scene: uuid("scene") } },
  { id: "Q05", title: "Voice direction", section: "§12.2",
    summary: "How this character's lines should sound in this scene.",
    shape: { character: uuid("character"), scene: uuid("scene") } },
  { id: "Q06", title: "Physical direction", section: "§12.6",
    summary: "How this character moves and behaves in this scene.",
    shape: { character: uuid("character"), scene: uuid("scene") } },
  { id: "Q07", title: "Look resolution", section: "§12.3",
    summary: "What a frame in this scene, or this shot, should look " +
      "like.",
    shape: { scene: uuid("scene"), shot: uuid("shot").optional() } },
  { id: "Q08", title: "Soundscape", section: "§12.7",
    summary: "What this scene sounds like.",
    note: "No shot — sound is authored at the scene.",
    shape: { scene: uuid("scene") } },
  { id: "Q09", title: "Motif manifest", section: "§12.10",
    summary: "Which motifs should be perceivable in this scene, and " +
      "how.",
    shape: { scene: uuid("scene") } },
  { id: "Q10", title: "Thematic accounting", section: "§12.11",
    summary: "Where a theme lives across the whole story, and where " +
      "it does not.",
    shape: { theme: uuid("theme") } },
  { id: "Q11", title: "Audience state", section: "§12.13",
    summary: "What the audience knows and should feel at a position.",
    shape: { scene: uuid("scene") } },
  { id: "Q12", title: "Continuity", section: "§12.5",
    summary: "What changed between two positions.",
    note: "In story order — never by scene number.",
    shape: { from: uuid("first scene"), to: uuid("second scene") } },
  { id: "Q13", title: "Media resolution", section: "§12.8",
    summary: "Which assets are in force for a subject and an intent.",
    shape: { ...subjectFields,
             intent: z.string().describe(
               "Asset intent, e.g. \"visual_identity\", " +
               "\"voice_identity\", \"motion\"."),
             scene: uuid("scene").optional(),
             shot: uuid("shot").optional() } },
  { id: "Q15", title: "Provenance", section: "§12.14",
    summary: "Why is this value what it is, and who touched it.",
    shape: { entityType: z.string().describe(
               "Registry entity name of the row asked about."),
             row: uuid("row") } },
];


export function registerQueryTools(
    server: McpServer, cache: ProjectCache): void {
  for (const spec of CATALOG) {
    const note = spec.note === undefined ? "" : ` ${spec.note}`;
    server.registerTool(toolNameFor(spec.title), {
      description: forSession(
        `${spec.title} (${spec.id}, spec ${spec.section}). ` +
        `${spec.summary}${note}`),
      inputSchema: { file_id: SESSION_ID, ...spec.shape, format: FORMAT },
    }, async (args) => {
      try {
        const { file_id, format, ...params } = args as QueryParams & {
          file_id: string; format?: "json" | "markdown" };
        const result = await cache.withProject(file_id, async (p) => {
          const run = buildDispatch(p.locate, p.rootMapped)[spec.id];
          if (run === undefined) {
            throw new Error(`internal: no dispatch entry for "${spec.id}"`);
          }
          return run(p.ctx, params as QueryParams);
        });
        if (format === "markdown") {
          return text(queryMarkdown(spec.id as QueryId, result, registry));
        }
        return ok(result);
      } catch (e) {
        return err(e);
      }
    });
  }
}
