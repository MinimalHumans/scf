// SPDX-License-Identifier: Apache-2.0
/**
 * readTools.ts — reads the editor makes, offered to a client.
 *
 * Each of these used to exist only inside the editor's views: the shot
 * list, the gallery, who a character is in. They now live in scf-core
 * and the editor calls the same functions, so a client sees what the
 * person at the editor sees — in the same order, with the same cut
 * shots left out — rather than a second reading of the same rows.
 * These tools only shape the answer for a client: uuids instead of row
 * ids, and no Maps.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  actionText, beatBanner, buildSheets, describeUses, filterItems,
  loadGallery, presenceByScene, readScriptPresence, readShotlistRows,
  rowsIncludingCut, runningTime, sceneOrder, shortAngle, shortSize,
  sortItems,
  type GalleryFilter, type GallerySort, type Row, type SceneSheet,
} from "@minimalhumans/scf-core";
import type { ProjectCache } from "./projectCache.ts";
import { SESSION_ID, forSession } from "./session.ts";
import { err, ok } from "./toolResult.ts";

const text = (v: unknown): string | null =>
  v === null || v === undefined || v === "" ? null : String(v);

function sheetJson(sheet: SceneSheet, locations: Map<number, Row>,
                   cast: Map<number, string[]>): unknown {
  const loc = locations.get(Number(sheet.scene["location_id"]));
  return {
    scene: {
      uuid: sheet.scene["uuid"], number: text(sheet.scene["scene_number"]),
      name: text(sheet.scene["name"]),
      location: loc === undefined ? null : text(loc["name"]),
      cast: cast.get(Number(sheet.scene["id"])) ?? [],
    },
    shotCount: sheet.shotCount,
    seconds: sheet.seconds,
    allTimed: sheet.allTimed,
    groups: sheet.groups.map((g) => ({
      beat: beatBanner(g),
      shots: g.shots.map((s) => ({
        uuid: s["uuid"], number: text(s["shot_number"]),
        size: shortSize(text(s["shot_size"])),
        angle: shortAngle(text(s["camera_angle"])),
        movement: text(s["camera_movement"]), lens: text(s["lens_choice"]),
        seconds: s["duration_seconds"] ?? null,
        action: actionText(s, false),
        cut: s["lifecycle_status"] === "cut",
      })),
    })),
  };
}

export function registerReadTools(
    server: McpServer, cache: ProjectCache): void {
  server.registerTool("shot_list", {
    description: forSession(
      "The shot list: every shot in story order, grouped by " +
      "scene and under its beat, with size, angle, movement, lens, " +
      "duration and action — what the editor prints as a shot list. " +
      "Cut shots are left out unless asked for. Pass `sceneUuid` for " +
      "one scene."),
    inputSchema: {
      file_id: SESSION_ID,
      sceneUuid: z.string().optional().describe("Only this scene."),
      includeCut: z.boolean().optional().describe(
        "Also list shots that have been cut from the film."),
    },
  }, async ({ file_id, sceneUuid, includeCut }) => {
    try {
      return ok(await cache.withProject(file_id, async ({ ctx }) => {
        const rows = await readShotlistRows(ctx.exec);
        let scope = "all";
        if (sceneUuid !== undefined) {
          const scene = rows.scenes.find((s) => s["uuid"] === sceneUuid);
          if (scene === undefined) {
            throw new Error(`no scene with uuid ${sceneUuid}`);
          }
          scope = String(scene["id"]);
        }
        const sheets = buildSheets(rows.scenes, rows.beats, rows.shots, {
          scope, groupByBeat: true, includeCut: includeCut === true });
        const locations = new Map(
          rows.locations.map((l) => [Number(l["id"]), l]));
        const cast = new Map<number, string[]>();
        for (const r of rows.sceneCast) {
          const id = Number(r["scene_id"]);
          cast.set(id, [...(cast.get(id) ?? []), String(r["name"])]);
        }
        const seconds = sheets.reduce((t, s) => t + s.seconds, 0);
        return {
          shotCount: sheets.reduce((n, s) => n + s.shotCount, 0),
          runningTime: runningTime(seconds),
          allTimed: sheets.every((s) => s.allTimed),
          scenes: sheets.map((s) => sheetJson(s, locations, cast)),
        };
      }));
    } catch (e) {
      return err(e);
    }
  });

  server.registerTool("gallery", {
    description: forSession(
      "Every asset in the film ranked by how much it is " +
      "carrying — direct uses plus, for each subject it reaches, one and " +
      "the number of scenes that subject is in. Answers \"which " +
      "references matter most\" and \"what is not used by anything\". " +
      "Lists files, never their bytes."),
    inputSchema: {
      file_id: SESSION_ID,
      sort: z.enum(["importance", "alphabetical", "newest"]).optional()
        .describe("Default importance."),
      filter: z.enum(["all", "character", "location", "prop", "shot",
                      "unused"]).optional().describe("Default all."),
      includeHistory: z.boolean().optional().describe(
        "Also superseded and cut assets."),
      limit: z.number().int().min(1).max(500).optional().describe(
        "How many (default 50)."),
    },
  }, async ({ file_id, sort, filter, includeHistory, limit }) => {
    try {
      return ok(await cache.withProject(file_id, async ({ ctx }) => {
        const all = await loadGallery(ctx.exec, includeHistory === true);
        const kept = sortItems(
          filterItems(all, (filter ?? "all") as GalleryFilter, false),
          (sort ?? "importance") as GallerySort);
        return {
          total: kept.length,
          shown: Math.min(kept.length, limit ?? 50),
          assets: kept.slice(0, limit ?? 50).map((it) => ({
            uuid: it.asset["uuid"], name: text(it.asset["name"]),
            identifier: text(it.asset["identifier"]), kind: it.kind,
            score: it.score, uses: describeUses(it.uses),
          })),
        };
      }));
    } catch (e) {
      return err(e);
    }
  });

  server.registerTool("character_presence", {
    description: forSession(
      "Where a character is, two ways: the scenes they are " +
      "linked to, and the scenes where the script gives them a cue. " +
      "Where the two disagree it says how — `silent` (linked and the " +
      "scene is written, but they never speak: often right, a question " +
      "rather than an error) or `unlinked` (speaks in a scene they are " +
      "not linked to). Scenes in story order."),
    inputSchema: {
      file_id: SESSION_ID,
      characterUuid: z.string().describe("The character's uuid."),
    },
  }, async ({ file_id, characterUuid }) => {
    try {
      return ok(await cache.withProject(file_id, async ({ ctx }) => {
        const who = (await rowsIncludingCut(
          ctx.exec, "character", "uuid = ?", [characterUuid]))[0];
        if (who === undefined) {
          throw new Error(`no character with uuid ${characterUuid}`);
        }
        const id = Number(who["id"]);
        const order = [...(await sceneOrder(ctx)).entries()]
          .sort((a, b) => a[1] - b[1]).map(([sceneId]) => sceneId);
        const links = await ctx.exec(
          "SELECT * FROM scene_character WHERE character_id = ?", [id]);
        const script = await readScriptPresence(ctx.exec, id);
        const scenes = new Map((await rowsIncludingCut(ctx.exec, "scene"))
          .map((s) => [Number(s["id"]), s]));
        return {
          character: { uuid: characterUuid, name: text(who["name"]) },
          speeches: script.speeches.length,
          scenes: presenceByScene(order, links, script).map((p) => {
            const s = scenes.get(p.sceneId);
            return {
              scene: { uuid: s?.["uuid"] ?? null,
                       number: text(s?.["scene_number"]),
                       name: text(s?.["name"]) },
              linked: p.link !== null,
              role: p.link === null ? null : text(p.link["role_in_scene"]),
              speeches: p.speeches,
              mismatch: p.mismatch,
            };
          }),
        };
      }));
    } catch (e) {
      return err(e);
    }
  });
}
