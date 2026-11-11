// SPDX-License-Identifier: Apache-2.0
/**
 * mcpServer.ts — scf-mcp, an MCP server over `.scf` files
 * (docs/scf-mcp-design.md §5), on whatever platform it is given.
 *
 * The desktop app runs one in its window for each agent its stdio pipe
 * (`scf-editor mcp`) brings.
 *
 * Tools:
 *   open          open (or switch to) a film, with optional root
 *                 mappings — returns a quick summary
 *   recent_files  paths this or a past session has opened, most recent
 *                 first — a hint for `open` with no full path in hand
 *   find          label -> uuid (resolveNaturalKey)
 *   list          every row of an entity type, optionally filtered
 *                 (listEntities) — for a caller with nothing in hand,
 *                 in story order where the rows have one
 *   where_used    the reverse of every other tool: which rows point at
 *                 this one (whereUsed) — "which bundles hold this
 *                 asset", "what binds this bundle to anybody"
 *   shot_context, shot_media, shot_readiness
 *                 the "prompt for shot X" composite, in three calls
 *   Q00..Q13, Q15 one tool per canonical query, precisely typed
 *                 (queryTools.ts) — each id's own params, not a
 *                 generic bag, so a wrong one is a schema error before
 *                 the call is even sent, not a runtime failure
 *   readiness     Q14 directly, for pre-flight
 *
 * Writing. The read tools above never change a film. The write tools
 * (writeTools.ts) do, and only in two steps: a plan the person can
 * read, then an apply that is refused if the film is no longer what the
 * plan described. `--read-only` offers none of them. Every film is
 * opened by the SCF host (scf-host), shared with the editor, which also
 * holds the lines no tool can cross: a snapshot before the first
 * agent change, no new integrity finding, and a journal of who wrote
 * what.
 *
 * Exactly one film is open at a time, held in process state — see
 * projectCache.ts. `open` is the only tool that names a `.scf` path;
 * every other tool reads whatever `open` loaded most recently and
 * errors clearly if nothing has been opened yet. `set_root` maps
 * `@root/...` asset identifiers to real directories and is callable at
 * any time, independently of `open`. `--scf`/`--root` open a default
 * project at startup so a single-film setup needs no tool call at all
 * before querying.
 *
 * There used to be one generic `query(id, params)` tool covering all
 * sixteen. It's gone: with `params` typed as a loose string map, an
 * agent had no way to know which keys a given id needed short of
 * guessing or reading source, and got it wrong often enough to be
 * worth fixing. The sixteen dedicated tools below replace it entirely
 * — there is nothing a generic `query` could do that they cannot.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  baseNameOf, listEntities, PROJECT_ROOT, q00Result, queryMarkdown,
  resolveNaturalKey, shotContext, shotMedia, shotReadiness, whereUsed,
} from "@minimalhumans/scf-core";
import type { RootMap, ServerConfig } from "./config.ts";
import { registerJournalTool, registerWriteTools } from "./writeTools.ts";
import { buildDispatch, type QueryParams } from "./dispatch.ts";
import type { McpPlatform } from "./platform.ts";
import { createProjectCache, registry } from "./projectCache.ts";
import { FORMAT, registerQueryTools } from "./queryTools.ts";
import { registerReadTools } from "./readTools.ts";
import { err, ok, text } from "./toolResult.ts";

export interface ServerOptions {
  /**
   * Ask the person through the client before applying a write, where it
   * can (SCF_MCP_ELICIT=0 turns this off, for tests).
   */
  elicit?: boolean;
}

/**
 * A server with every tool, its recent files loaded and the `--scf` film
 * (if any) open; connect it to a transport to serve.
 */
export async function createScfMcpServer(
    platform: McpPlatform, config: ServerConfig,
    options: ServerOptions = {}): Promise<McpServer> {
  const cache = createProjectCache(platform, { readOnly: config.readOnly });

  const server = new McpServer({ name: "scf-mcp", version: "0.1.0" }, {
    instructions:
      (config.readOnly ? "Read-only access to" : "Access to") +
      " a film's Story Context Framework (`.scf`) file. " +
      "Call `open` once per film, with the path to its `.scf` file, before " +
      "anything else — every other tool reads whichever film was opened " +
      "most recently and errors if nothing has been opened yet. Don't " +
      "have the path? Check `recent_files` first. If the film uses " +
      "`@root/...` asset identifiers, map them to real directories with " +
      "`set_root`, at any time, before or after `open`.\n\n" +
      "Once a film is open:\n" +
      "- `find` resolves a natural-key label (scene/shot number, name) to " +
      "uuid(s); `list` enumerates every row of an entity type, optionally " +
      "filtered to rows pointing at a given uuid — use these when you " +
      "don't already have a uuid in hand. Scenes and anything belonging " +
      "to a scene come back in STORY order, each carrying its " +
      "`storyPosition`; a scene's number is a label and never an " +
      "order.\n" +
      "- `where_used` runs backwards: which rows point at this one. Use " +
      "it when an asset or a bundle appears in `list` and in no answer — " +
      "a bundle no binding reaches resolves for nobody, and nothing else " +
      "will tell you that.\n" +
      "- Writing a shot prompt is three calls, each small enough to take " +
      "whole: `shot_context` (the frame: framing, look, who is in it, its " +
      "lines, physical direction), `shot_media` (what to attach) and " +
      "`shot_readiness` (what is thin). The scene itself is " +
      "`scene_package`, and the project is `brief`.\n" +
      "- The `brief`, `subject_dossier`, `subject_in_context`, " +
      "`world_state`, `scene_package`, `voice_direction`, " +
      "`physical_direction`, `look_resolution`, `soundscape`, " +
      "`motif_manifest`, `thematic_accounting`, `audience_state`, " +
      "`continuity`, `media_resolution`, and `provenance` tools each " +
      "answer one canonical query (spec/scf-spec.md §12) — reach for one " +
      "of these directly when the shot calls don't cover what's asked.\n" +
      "- `shot_list` is the printed shot list (every shot in story order, " +
      "under its scene and beat), `gallery` ranks every asset by how much " +
      "it is carrying (and finds what nothing uses), and " +
      "`character_presence` compares the scenes a character is linked to " +
      "with the scenes where the script gives them a cue.\n" +
      "- Every canonical-query tool takes `format: \"markdown\"` for a " +
      "prompt-ready block of the same facts instead of the JSON.\n" +
      "- `readiness` is pre-flight: what's thin for a target query " +
      "(voice_direction, physical_direction, look_resolution, soundscape, " +
      "media_resolution, or subject_in_context) at a given position, " +
      "before you write a prompt that depends on it.\n\n" +
      (config.readOnly
        ? "This server is read-only: it offers no write tools."
        : "Changing the film is deliberately two steps. `create_row`, " +
          "`update_row`, `delete_row`, `add_shot`, `set_shot_cut`, " +
          "`move_shot` and `set_title_page_key` first return a PLAN — the " +
          "exact changes, the risks, a `planId` — and change nothing. " +
          "Show the plan to the person you are working with and wait for " +
          "their approval; then call the same tool again with `confirm` " +
          "set to the `planId`. It re-checks the film and applies only an " +
          "unchanged plan. For create, update and delete, unchanged " +
          "means the rows the plan reads and writes, so approved plans " +
          "about different rows can be applied one after another. When " +
          "a task makes several changes, use `write_batch`: one plan, " +
          "one approval, applied all or nothing, and a create's `ref` " +
          "lets later ops point at the new row as \"$ref\". " +
          "A change that would leave a reference " +
          "pointing at nothing is refused. Linking someone to a scene " +
          "where the script gives them no cue is not refused: the plan " +
          "lists it under `risks` as a question, because a character can " +
          "be present and silent. The first agent change to a film is " +
          "preceded by a " +
          "snapshot of it, and `recent_changes` shows who changed what. " +
          "SCF is the ground truth of the film: change a row only when " +
          "asked to, and say what you changed."),
  });

  // The handshake names the client; the host's journal and the editor's
  // "edited by" notice show it, so a change can be traced to who made it.
  server.server.oninitialized = () => {
    cache.setAgentName(server.server.getClientVersion()?.name);
  };

  /** The file name of a host path, so a path either separator spells. */
  const nameOf = (path: string): string => path.split(/[\\/]/).pop() ?? path;

  /**
   * Open `scfPathInput`, falling back to the asset root `app.db` has on
   * file for it when the caller gives none of its own — an explicit
   * `roots` argument always wins, for this call and from now on
   * (file-management-plan.md Step 1). Persisting is fire-and-forget: a
   * failed or slow write never blocks a tool call, and loses at most
   * the convenience of remembering it for next time. A pure local
   * write, so it is fast enough that a check immediately after calling
   * this (recent_files, say) reliably sees it land — unlike
   * `rememberIdentity` below, which needs a host round trip and must
   * not be folded in here for exactly that reason.
   */
  async function openAndRemember(scfPathInput: string, roots: RootMap) {
    const scfPath = platform.resolve(scfPathInput);
    const explicitRoot = roots[PROJECT_ROOT];
    let effectiveRoots = roots;
    if (explicitRoot === undefined) {
      const stored = await platform.appStore.getProject(scfPath);
      if (stored?.assetRoot != null) {
        effectiveRoots = { ...roots, [PROJECT_ROOT]: stored.assetRoot };
      }
    }
    const project = cache.openProject(scfPath, effectiveRoots);
    platform.appStore
      .touchProject(scfPath, explicitRoot === undefined ? {} : {
        assetRoot: explicitRoot,
      })
      .catch((e: unknown) => {
        platform.log(
          `[mcp] failed to persist ${scfPath} in app.db: ${String(e)}`);
      });
    return project;
  }

  /**
   * The film's own uuid and name, and the file's base name, kept
   * current on every open (file-management-plan.md §3.2 points 1 and
   * 4) — step 4's suggestion matching reads them. Takes an already-
   * fetched brief where the caller has one (the `open` tool does, for
   * its own response) rather than opening a second connection to get
   * one; fire-and-forget either way, same reasoning as
   * `openAndRemember`.
   */
  function rememberIdentity(
      project: ReturnType<typeof cache.openProject>,
      brief: Awaited<ReturnType<typeof q00Result>>): void {
    const row = brief.result.layers.find((l) => l.entity === "project")
      ?.row;
    const nameRaw = row?.fields["name"];
    platform.appStore.touchProject(project.scfPath, {
      uuid: row?.uuid ?? null,
      title: typeof nameRaw === "string" ? nameRaw : null,
      baseName: baseNameOf(nameOf(project.scfPath)),
    }).catch((e: unknown) => {
      platform.log(`[mcp] failed to persist ${project.scfPath}'s identity ` +
        `in app.db: ${String(e)}`);
    });
  }

  server.registerTool("open", {
    description: "Open (or switch to) a film, optionally mapping asset " +
      "roots. This is the only tool that takes a file path — every other " +
      "tool operates on whichever film was opened most recently, so call " +
      "this once per film per conversation before anything else. Calling " +
      "it again for a film already open adds any new roots without " +
      "dropping the ones already set. Returns a quick summary so you can " +
      "confirm you opened the right file.",
    inputSchema: {
      scfPath: z.string().describe("Path to the .scf file."),
      roots: z.record(z.string(), z.string()).optional().describe(
        "Root name -> absolute directory, e.g. " +
        "{ \"project\": \"/path/to/project\" }. Matches the `@root/...` " +
        "prefix asset identifiers use inside the file."),
    },
  }, async ({ scfPath, roots }) => {
    try {
      const project = await openAndRemember(scfPath, roots ?? {});
      return ok(await cache.withProject(async ({ ctx, revision, readOnly }) => {
        const brief = await q00Result(ctx);
        const scenes = await listEntities(ctx, "scene");
        const shots = await listEntities(ctx, "shot");
        const name = brief.result.layers.find((l) => l.entity === "project")
          ?.row.fields["name"] ?? null;
        rememberIdentity(project, brief);
        return {
          opened: project.scfPath,
          project: name,
          sceneCount: scenes.length,
          shotCount: shots.length,
          rootMapped: project.rootMapped,
          roots: project.roots,
          revision,
          writable: !readOnly,
        };
      }, project));
    } catch (e) {
      return err(e);
    }
  });

  server.registerTool("recent_files", {
    description: "Paths opened in this or a past session, most recently " +
      "opened first, one per line — a hint for `open` when you don't " +
      "already have the full path.",
    inputSchema: {},
  }, async () => {
    const rows = await platform.appStore.recentProjects();
    return text(rows.length === 0
      ? "(no films opened yet)" : rows.map((r) => r.scfPath).join("\n"));
  });

  server.registerTool("set_root", {
    description: "Map @root/... asset identifiers to real directories on " +
      "this machine, for the currently open film. Independent of `open` " +
      "and callable at any time — before or after it, and repeatable to " +
      "add more roots or change existing ones without reopening the file.",
    inputSchema: {
      roots: z.record(z.string(), z.string()).describe(
        "Root name -> absolute directory, e.g. { \"project\": " +
        "\"/path/to/project\" }. Matches the `@root/...` prefix asset " +
        "identifiers use inside the file. Merges into whatever roots " +
        "are already set."),
    },
  }, async ({ roots }) => {
    try {
      const project = cache.setRoots(roots);
      const explicitRoot = roots[PROJECT_ROOT];
      if (explicitRoot !== undefined) {
        platform.appStore
          .touchProject(project.scfPath, { assetRoot: explicitRoot })
          .catch((e: unknown) => {
            platform.log(`[mcp] failed to persist ${project.scfPath} in ` +
              `app.db: ${String(e)}`);
          });
      }
      return ok({ roots: project.roots, rootMapped: project.rootMapped });
    } catch (e) {
      return err(e);
    }
  });

  server.registerTool("find", {
    description: "Resolve a natural-key label (a scene number, shot " +
      "number, or name) to the uuid(s) of matching rows. Always returns " +
      "an array; more than one hit means the label is ambiguous in this " +
      "film, not that the tool failed.",
    inputSchema: {
      entityType: z.string().describe(
        "Registry entity name, e.g. \"scene\", \"shot\", \"character\"."),
      label: z.string().describe(
        "The label as written, e.g. \"10A\", \"12-04\", \"Eleanor\"."),
    },
  }, async ({ entityType, label }) => {
    try {
      return ok(await cache.withProject(({ ctx }) =>
        resolveNaturalKey(ctx, entityType, label)));
    } catch (e) {
      return err(e);
    }
  });

  server.registerTool("list", {
    description: "Every row of an entity type, optionally filtered to " +
      "rows one reference field points at (e.g. every shot in a scene). " +
      "For a question with no starting uuid or label — \"how many shots " +
      "are there\" — rather than guessing labels through find one at a " +
      "time.",
    inputSchema: {
      entityType: z.string().describe(
        "Registry entity name, e.g. \"scene\", \"shot\", \"character\"."),
      filter: z.object({
        field: z.string().describe(
          "A reference field entityType declares, e.g. \"scene_id\" on " +
          "\"shot\". The projected spelling a result hands back " +
          "(\"scene_uuid\") is accepted too."),
        uuid: z.string().describe("The uuid the field must point at."),
      }).optional().describe(
        "Narrow to rows pointing at one uuid, e.g. { field: \"scene_id\", " +
        "uuid: \"<scene uuid>\" } for every shot in one scene. Omit to " +
        "list every row of entityType."),
    },
  }, async ({ entityType, filter }) => {
    try {
      return ok(await cache.withProject(({ ctx }) =>
        listEntities(ctx, entityType, filter)));
    } catch (e) {
      return err(e);
    }
  });

  server.registerTool("where_used", {
    description: "Which rows point at this one, with the column each " +
      "points with — the reverse of every other tool here. Answers " +
      "\"which bundles is this asset in\", \"what binds this bundle to " +
      "anybody\", \"which scenes place this prop\". A row nothing " +
      "references is not necessarily wrong, but it resolves for no " +
      "query, and this is the only way to see that.",
    inputSchema: {
      entityType: z.string().describe(
        "Registry entity name of the row asked about, e.g. \"asset\", " +
        "\"bundle\", \"prop\"."),
      uuid: z.string().describe("That row's uuid, e.g. from find() or list()."),
    },
  }, async ({ entityType, uuid }) => {
    try {
      return ok({
        entityType, uuid,
        usedBy: await cache.withProject(({ ctx }) =>
          whereUsed(ctx, entityType, uuid)),
      });
    } catch (e) {
      return err(e);
    }
  });

  // A shot prompt is three calls (design doc §4.7). Each still works out who
  // is at the shot and what to ask about each; each answer is small enough
  // for a client that limits one tool result.
  const SHOT_UUID = z.string().describe(
    "A shot's uuid, e.g. from find(\"shot\", \"10A\").");

  server.registerTool("shot_context", {
    description: "The FRAME for a shot prompt — call first. The shot " +
      "itself (size, lens, angle, movement, description, story beat, " +
      "scene — the same row `list` returns), its resolved look (Q07), " +
      "`presence`: who is at the shot, seen, heard or only named, with " +
      "framing, facing and focus, each marked recorded (a shot row says " +
      "so) or inherited (from the scene); `lines`, the screenplay lines " +
      "the shot covers, or null when it records none (ranges may overlap: " +
      "coverage); and physical direction for each character seen. Then " +
      "`shot_media` for what to attach and `shot_readiness` for what is " +
      "thin. The scene's full package is `scene_package` (with " +
      "`shot.fields.scene_uuid`); the project is `brief`. " +
      "`contextFormat` is 3.0 on all three shot calls.",
    inputSchema: { shotUuid: SHOT_UUID },
  }, async ({ shotUuid }) => {
    try {
      return ok(await cache.withProject(({ ctx }) =>
        shotContext(ctx, shotUuid)));
    } catch (e) {
      return err(e);
    }
  });

  server.registerTool("shot_media", {
    description: "WHAT TO ATTACH for a shot: media in force (Q13) for " +
      "every subject at it — characters AND props AND the location. A " +
      "heard subject is asked for voice and sound only, a named one for " +
      "nothing. A result with nothing to say (no references, empty trail) " +
      "is left out and listed under its subject's `empty` in `swept`; one " +
      "whose trail explains an absence (a binding EXCLUDED, and why) is " +
      "kept. `related` carries assets about the scene or shot itself, such " +
      "as a DOP's framing plate, storyboard panels or a start and end " +
      "frame, in their stored order (`relationship` says which), each " +
      "with its resolution `state` like a Q13 reference. For a shot with many subjects, pass " +
      "`subjectUuid` (from `shot_context`'s `presence`, or the scene's " +
      "location) to take them one at a time.",
    inputSchema: {
      shotUuid: SHOT_UUID,
      subjectUuid: z.string().optional().describe(
        "Optional: only this subject, which must be at the shot."),
    },
  }, async ({ shotUuid, subjectUuid }) => {
    try {
      return ok(await cache.withProject((p) => shotMedia(
        p.ctx, shotUuid, p.locate, p.rootMapped, subjectUuid ?? null)));
    } catch (e) {
      return err(e);
    }
  });

  server.registerTool("shot_readiness", {
    description: "WHAT IS THIN for a shot: a list of Q14 pre-flight " +
      "results, each unmodified — the shot's look (Q07, first), the " +
      "scene's sound (Q08), then for each character on screen " +
      "subject-in-context (Q02, which alone checks costume) and physical " +
      "direction (Q06), and voice (Q05) for each who speaks in the shot's " +
      "lines, including a voice from outside the frame. Rubrics overlap, " +
      "and a finding two of them raise appears under both targets.",
    inputSchema: { shotUuid: SHOT_UUID },
  }, async ({ shotUuid }) => {
    try {
      return ok(await cache.withProject(({ ctx }) =>
        shotReadiness(ctx, shotUuid)));
    } catch (e) {
      return err(e);
    }
  });

  registerQueryTools(server, cache);
  registerReadTools(server, cache);
  registerJournalTool(server, cache);
  if (!config.readOnly) {
    registerWriteTools({ server, cache, elicit: options.elicit ?? true });
  }

  const READINESS_TARGETS = ["Q02", "Q05", "Q06", "Q07", "Q08", "Q13"] as const;

  server.registerTool("readiness", {
    description: "Q14 directly (spec §12.9): what is thin for a given " +
      "target query and position, for pre-flight before writing a " +
      "prompt. Each target needs different params:\n" +
      "  Q02 (Subject in context) — subjectType + subject (or character), " +
      "scene, shot?\n" +
      "  Q05 (Voice direction)    — character, scene\n" +
      "  Q06 (Physical direction) — character, scene\n" +
      "  Q07 (Look resolution)    — scene, shot?\n" +
      "  Q08 (Soundscape)         — scene\n" +
      "  Q13 (Media resolution)   — subjectType, subject, intent, scene?, shot?",
    inputSchema: {
      queryId: z.enum(READINESS_TARGETS).describe(
        "The target query to assess — only these six have a readiness " +
        "rubric (docs/scf-mcp-design.md §4.2); the other ten are " +
        "analytic and read whatever exists."),
      params: z.record(z.string(), z.union([z.string(), z.null()]))
        .optional().describe(
          "The target's own params by name — see the tool description " +
          "for which ones queryId needs."),
      format: FORMAT,
    },
  }, async ({ queryId, params, format }) => {
    try {
      const merged: QueryParams = { ...(params ?? {}), target: queryId };
      const result = await cache.withProject(async (p) => {
        const q14 = buildDispatch(p.locate, p.rootMapped)["Q14"];
        if (q14 === undefined) throw new Error("internal: Q14 dispatch missing");
        return q14(p.ctx, merged);
      });
      if (format === "markdown") return text(queryMarkdown("Q14", result, registry));
      return ok(result);
    } catch (e) {
      return err(e);
    }
  });

  if (config.scfPath !== undefined) {
    const project = await openAndRemember(config.scfPath, config.roots);
    await cache.withProject(({ ctx }) => q00Result(ctx), project)
      .then((brief) => { rememberIdentity(project, brief); })
      .catch((e: unknown) => {
        platform.log(`[mcp] could not read ${project.scfPath}'s identity ` +
          `at startup: ${String(e)}`);
      });
  }
  return server;
}
