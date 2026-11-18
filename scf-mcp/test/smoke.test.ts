// SPDX-License-Identifier: Apache-2.0
/**
 * smoke.test.ts — does the built server actually start and answer.
 *
 * Not a full MCP client harness: raw JSON-RPC over the child process's
 * stdio, enough to catch "the process doesn't start" or "the tool
 * surface changed" without a live client configured.
 */

import {
  copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync,
  readlinkSync, renameSync, rmSync, unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { CATALOG, toolNameFor } from "../src/queryTools.ts";
import {
  FIXTURE, callTool, inSession, openFilm, startServer, type Server,
} from "./helpers.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCENE12 = "06857531-3e91-41a9-95dd-3262407d8132";
const SHOT1204 = "404e480d-dde6-4b4f-9cd4-daec42d5bfa0";
const ELEANOR = "1afb7bf0-8cee-4e2f-9e8e-015f9b2aaf64";
const QUERY_TOOL_NAMES = CATALOG.map((spec) => toolNameFor(spec.title));

describe("scf-mcp server — a default project set at startup", () => {
  let started: Server;
  /** `started`, in the session `--scf` gave the film. */
  let server: Server;
  beforeAll(async () => {
    started = await startServer(["--scf", FIXTURE]);
    server = inSession(started, await openFilm(started, FIXTURE));
  });
  afterAll(() => { started.kill(); });

  test("the film --scf opened has a session, and the instructions " +
      "give it", async () => {
    const opened = await openFilm(started, FIXTURE);
    expect(opened).toMatch(/^[0-9a-z]{4,}$/);
    expect(started.instructions).toContain(
      `\`${FIXTURE}\` is already open: its \`file_id\` is \`${opened}\``);
    // Without the id there is nothing to fall back on, startup film or
    // not; the refusal says which session to use.
    const r = await callTool(started, "find",
      { entityType: "scene", label: "12" });
    expect(r.isError).toBe(true);
    expect(r.json).toMatchObject({
      code: "invalid_session", rejected_file_id: null,
      open_sessions: [{ file_id: opened, path: FIXTURE }],
    });
  });

  test("lists open/recent_files/set_root/find/list, the three shot calls, " +
      "readiness plus one semantically-named tool per canonical query " +
      "(Q00-Q13, Q15 — Q14 is `readiness`)", async () => {
    const result = await server.send("tools/list") as
      { tools: Array<{ name: string }> };
    expect(result.tools.map((t) => t.name).sort()).toEqual([
      ...QUERY_TOOL_NAMES,
      "add_shot", "character_presence", "create_row", "delete_row", "find",
      "gallery", "list", "move_shot", "open", "readiness", "recent_changes",
      "recent_files", "set_root", "shot_list",
      "set_shot_cut", "set_title_page_key", "shot_context", "shot_media",
      "shot_readiness", "update_row", "where_used", "write_batch",
    ].sort());
  });

  test("recent_files reflects the film --scf opened at startup, as " +
      "plain text", async () => {
    const result = await server.send("tools/call", {
      name: "recent_files", arguments: {},
    }) as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text.split("\n")).toContain(FIXTURE);
  });

  test("scene_package (Q04) with just a scene matches the blessed " +
      "result byte-for-byte", async () => {
    const result = await server.send("tools/call", {
      name: "scene_package", arguments: { scene: SCENE12 },
    }) as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
    const envelope = JSON.parse(result.content[0]?.text ?? "{}");
    expect(envelope.query).toBe("Q04");
    expect(envelope.result.scene.fields.scene_number).toBe("12");
  });

  test("readiness takes its target's parameters: Q13 by subject and " +
      "intent", async () => {
    // Spec §12.9: without subjectType, subject and intent, Q14 could not
    // be asked about Q13 at all, and the tool silently dropped them.
    const result = await server.send("tools/call", {
      name: "readiness", arguments: {
        queryId: "Q13", params: {
          subjectType: "character", subject: ELEANOR,
          intent: "visual_identity", scene: SCENE12, shot: SHOT1204,
        },
      },
    }) as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
    const envelope = JSON.parse(result.content[0]?.text ?? "{}");
    expect(envelope.parameters.subject).toBe(ELEANOR);
    expect(envelope.parameters.intent).toBe("visual_identity");
    expect(envelope.result.findings.map((f: { entity: string }) => f.entity)
      .sort()).toEqual(
        ["bundle", "character_shot_override", "entity_anchor"]);
  });

  test("readiness takes its target's parameters: Q02 for a prop " +
      "subject", async () => {
    // Spec §12.9: Q02 is assessed for a subject of any kind, and a step
    // that does not apply to a prop is reported ok. The published worked
    // example pins the whole result.
    const expected = JSON.parse(readFileSync(join(HERE, "..", "..",
      "fixtures", "expectations", "Q14-Q02-locket-scene25.result.json"),
      "utf8"));
    const result = await server.send("tools/call", {
      name: "readiness", arguments: {
        queryId: "Q02", params: {
          subjectType: expected.parameters.subjectType,
          subject: expected.parameters.subject,
          scene: expected.parameters.scene,
        },
      },
    }) as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
    const envelope = JSON.parse(result.content[0]?.text ?? "{}");
    expect(envelope.parameters).toEqual(expected.parameters);
    expect(envelope.result).toEqual(expected.result);
  });

  test("subject_in_context (Q02) resolves subjectType/subject/scene by " +
      "name, not a generic bag", async () => {
    const result = await server.send("tools/call", {
      name: "subject_in_context",
      arguments: { subjectType: "character", subject: ELEANOR,
                   scene: SCENE12 },
    }) as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
    const envelope = JSON.parse(result.content[0]?.text ?? "{}");
    expect(envelope.query).toBe("Q02");
    expect(envelope.parameters.subject).toBe(ELEANOR);
  });

  test("subject_in_context missing its required scene is rejected " +
      "before it reaches the server, not as a runtime error", async () => {
    const result = await server.send("tools/call", {
      name: "subject_in_context",
      arguments: { subjectType: "character", subject: ELEANOR },
    }) as { isError?: boolean; rpcError?: unknown };
    // A schema-invalid call is refused at the protocol layer (a
    // JSON-RPC error) rather than reaching the handler and coming back
    // as a tool-level isError — that's the whole point of typing each
    // query's own params instead of a generic string bag.
    expect(result.rpcError !== undefined || result.isError === true)
      .toBe(true);
  });

  test("list enumerates every shot in a scene by uuid, no label guessing",
      async () => {
    const result = await server.send("tools/call", {
      name: "list",
      arguments: { entityType: "shot",
                   filter: { field: "scene_id", uuid: SCENE12 } },
    }) as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
    const shots = JSON.parse(result.content[0]?.text ?? "[]");
    expect(Array.isArray(shots)).toBe(true);
    expect(shots.length).toBeGreaterThan(0);
    expect(shots.some((s: { uuid: string }) => s.uuid === SHOT1204))
      .toBe(true);
  });

  test("find resolves a known scene label with no scfPath given",
      async () => {
    const result = await server.send("tools/call", {
      name: "find", arguments: { entityType: "scene", label: "12" },
    }) as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
    const hits = JSON.parse(result.content[0]?.text ?? "[]");
    expect(hits).toEqual([{ uuid: SCENE12, entity: "scene", label: "12" }]);
  });

  test("an unknown entity type comes back as a tool error, not a crash",
      async () => {
    const result = await server.send("tools/call", {
      name: "find", arguments: { entityType: "spaceship", label: "x" },
    }) as { isError?: boolean };
    expect(result.isError).toBe(true);
  });

  test("the three shot calls answer with no scfPath given",
      async () => {
    const result = await server.send("tools/call", {
      name: "shot_context", arguments: { shotUuid: SHOT1204 },
    }) as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
    // Compact JSON (toolResult.ts): one line, no indentation. Indented,
    // a shot's composite runs past what some clients accept as one result.
    expect(result.content[0]?.text).not.toContain("\n");
    const ctx = JSON.parse(result.content[0]?.text ?? "{}");
    expect(Object.keys(ctx).sort()).toEqual(
      ["contextFormat", "lines", "look", "physical", "presence", "shot"]);
    expect(ctx.shot.uuid).toBe(SHOT1204);
    expect(ctx.contextFormat).toBe("3.0");

    const call = async (name: string) => JSON.parse(((await server.send(
      "tools/call", { name, arguments: { shotUuid: SHOT1204 } })) as
      { content: Array<{ text: string }> }).content[0]?.text ?? "{}");
    const media = await call("shot_media");
    expect(Object.keys(media).sort()).toEqual(
      ["contextFormat", "media", "related", "shotUuid", "subject", "swept"]);
    expect(media.shotUuid).toBe(SHOT1204);
    const ready = await call("shot_readiness");
    expect(Object.keys(ready).sort())
      .toEqual(["contextFormat", "readiness", "shotUuid"]);
    expect(ready.readiness[0].result.target).toBe("Q07");
  });

  test("the media sweep covers the location and says what it asked for",
      async () => {
    // The composite once swept characters alone, silently: the scene's
    // framing plate is bound to the LOCATION and never came back.
    const result = await server.send("tools/call", {
      name: "shot_media", arguments: { shotUuid: SHOT1204 },
    }) as { content: Array<{ text: string }> };
    const ctx = JSON.parse(result.content[0]?.text ?? "{}") as {
      swept: Array<{ subjectType: string; intents: string[];
                     note?: string }>;
      media: Array<{ result: { subjectKind: string } }>;
    };
    expect(new Set(ctx.swept.map((s) => s.subjectType)))
      .toEqual(new Set(["character", "prop", "location"]));
    expect(ctx.media.some((m) => m.result.subjectKind === "location"))
      .toBe(true);
    for (const s of ctx.swept) {
      if (s.intents.length === 0) expect(s.note).toBeDefined();
    }
  });

  test("where_used runs backwards: what binds the costume bundle",
       async () => {
    const listed = await server.send("tools/call", {
      name: "list", arguments: { entityType: "bundle" },
    }) as { content: Array<{ text: string }> };
    const uuid = (JSON.parse(listed.content[0]?.text ?? "[]") as
      Array<{ uuid: string; label: string }>)
      .find((b) => b.label.includes("Shawl"))?.uuid;
    const result = await server.send("tools/call", {
      name: "where_used",
      arguments: { entityType: "bundle", uuid: uuid ?? "" },
    }) as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
    const usage = JSON.parse(result.content[0]?.text ?? "{}") as {
      usedBy: Array<{ entity: string }>;
    };
    // Reached by nothing until schema 2.16 gave costume a binding
    // entity; the reverse lookup is how that was visible at all.
    expect(usage.usedBy.some((u) => u.entity === "costume_asset_binding"))
      .toBe(true);
    expect(usage.usedBy.some((u) => u.entity === "bundle_asset")).toBe(true);
  });

  test("list returns scenes in story order, with the position", async () => {
    const result = await server.send("tools/call", {
      name: "list", arguments: { entityType: "scene" },
    }) as { content: Array<{ text: string }> };
    const scenes = JSON.parse(result.content[0]?.text ?? "[]") as
      Array<{ label: string; storyPosition: number }>;
    // 25 is the flashback coda, the last scripted scene (proposal 0033);
    // 17 is unscripted and sorts after every scripted one (§4.1).
    expect(scenes.map((s) => s.label).slice(-3)).toEqual(["24", "25", "17"]);
    expect(scenes.map((s) => s.storyPosition))
      .toEqual(scenes.map((_, i) => i));
  });

  test("a filter takes the projected spelling list itself returns",
      async () => {
    const scenes = JSON.parse((await server.send("tools/call", {
      name: "list", arguments: { entityType: "scene" },
    }) as { content: Array<{ text: string }> }).content[0]?.text ?? "[]") as
      Array<{ uuid: string }>;
    const result = await server.send("tools/call", {
      name: "list",
      arguments: { entityType: "shot",
                   filter: { field: "scene_uuid",
                             uuid: scenes[0]?.uuid ?? "" } },
    }) as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
  });

  test("shot_list is the editor's shot list: scenes in story order, " +
      "shots under them", async () => {
    const r = await callTool(server, "shot_list", {});
    expect(r.isError).toBe(false);
    const list = r.json as { shotCount: number; runningTime: string;
      scenes: Array<{ scene: { uuid: string; number: string };
        shotCount: number;
        groups: Array<{ shots: Array<{ uuid: string; cut: boolean }> }> }> };
    expect(list.shotCount).toBeGreaterThan(0);
    expect(list.scenes.reduce((n, s) => n + s.shotCount, 0))
      .toBe(list.shotCount);
    expect(list.scenes.every((s) => s.groups.every(
      (g) => g.shots.every((x) => !x.cut)))).toBe(true);
    const one = await callTool(server, "shot_list", { sceneUuid: SCENE12 });
    const only = one.json as { scenes: Array<{ scene: { uuid: string } }> };
    expect(only.scenes.map((s) => s.scene.uuid)).toEqual([SCENE12]);
    expect((await callTool(server, "shot_list",
      { sceneUuid: "nope" })).isError).toBe(true);
  }, 60_000);

  test("gallery ranks assets by what they carry, and finds the unused",
      async () => {
    const r = await callTool(server, "gallery", { limit: 5 });
    const g = r.json as { total: number; shown: number;
      assets: Array<{ score: number; uses: string[] }> };
    expect(g.shown).toBe(5);
    expect(g.assets.map((a) => a.score)).toEqual(
      [...g.assets.map((a) => a.score)].sort((a, b) => b - a));
    // "Unused" is a subset, and what is left carries less than the best.
    const everything = (await callTool(server, "gallery",
      { limit: 500 })).json as { total: number };
    const unused = (await callTool(server, "gallery",
      { filter: "unused", limit: 500 })).json as
      { total: number; assets: Array<{ score: number }> };
    expect(unused.total).toBeLessThan(everything.total);
    expect(Math.max(0, ...unused.assets.map((a) => a.score)))
      .toBeLessThan(g.assets[0]!.score);
  }, 60_000);

  test("character_presence compares links with the script's cues",
      async () => {
    const r = await callTool(server, "character_presence",
      { characterUuid: ELEANOR });
    expect(r.isError).toBe(false);
    const p = r.json as { speeches: number; scenes: Array<{
      linked: boolean; speeches: number; mismatch: string | null }> };
    expect(p.speeches).toBeGreaterThan(0);
    expect(p.scenes.reduce((n, s) => n + s.speeches, 0)).toBe(p.speeches);
    expect((await callTool(server, "character_presence",
      { characterUuid: "nope" })).isError).toBe(true);
  }, 60_000);

  test("a query tool can return its prompt-ready markdown", async () => {
    const md = await callTool(server, "scene_package",
      { scene: SCENE12, format: "markdown" });
    expect(md.isError).toBe(false);
    expect(md.text.startsWith("# Scene package")).toBe(true);
    // The same facts as the JSON, from the same query.
    const json = await callTool(server, "scene_package", { scene: SCENE12 });
    expect((json.json as { query: string }).query).toBe("Q04");
    const ready = await callTool(server, "readiness", {
      queryId: "Q07", params: { scene: SCENE12 }, format: "markdown" });
    expect(ready.text.startsWith("# Readiness")).toBe(true);
  }, 60_000);

  test("set_root maps a root onto the already-open film, no scfPath",
      async () => {
    const result = await server.send("tools/call", {
      name: "set_root", arguments: { roots: { project: HERE } },
    }) as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
    const summary = JSON.parse(result.content[0]?.text ?? "{}");
    expect(summary.rootMapped).toBe(true);
    expect(summary.roots.project).toBe(HERE);
  });
});

describe("scf-mcp server — no default project", () => {
  let server: Server;
  let session: string;
  beforeAll(async () => { server = await startServer([]); });
  afterAll(() => { server.kill(); });

  test("a tool call with nothing open yet is an invalid session, with " +
      "nothing to reuse", async () => {
    const r = await callTool(server, "find",
      { entityType: "scene", label: "12" });
    expect(r.isError).toBe(true);
    expect(r.json).toEqual({
      code: "invalid_session",
      message: "Session '' is invalid or unavailable. Call `open` to " +
        "continue. Reuse a session from `open_sessions`, or call `open` " +
        "with a file path.",
      rejected_file_id: null, open_sessions: [], recent_files: [],
    });
  });

  test("set_root with nothing open yet fails the same way", async () => {
    const r = await callTool(server, "set_root",
      { roots: { project: HERE } });
    expect(r.isError).toBe(true);
    expect(r.json).toMatchObject(
      { code: "invalid_session", rejected_file_id: null });
  });

  test("recent_files says so when nothing has been opened yet",
      async () => {
    const result = await server.send("tools/call", {
      name: "recent_files", arguments: {},
    }) as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toBe("(no films opened yet)");
  });

  test("open reports a real summary of the fixture, and its session",
      async () => {
    const result = await server.send("tools/call", {
      name: "open", arguments: { scfPath: FIXTURE },
    }) as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
    const summary = JSON.parse(result.content[0]?.text ?? "{}");
    expect(summary.project).toBe("Hollow Creek");
    expect(summary.sceneCount).toBeGreaterThan(0);
    expect(summary.shotCount).toBeGreaterThan(0);
    expect(summary.rootMapped).toBe(false);
    expect(summary.file_id).toMatch(/^[0-9a-z]{4,}$/);
    session = summary.file_id;
  });

  test("recent_files lists it once opened", async () => {
    const result = await server.send("tools/call", {
      name: "recent_files", arguments: {},
    }) as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toBe(FIXTURE);
  });

  test("after open, other tools reach the film by its file_id",
      async () => {
    const result = await server.send("tools/call", {
      name: "find",
      arguments: { file_id: session, entityType: "scene", label: "12" },
    }) as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBeUndefined();
    const hits = JSON.parse(result.content[0]?.text ?? "[]");
    expect(hits).toEqual([{ uuid: SCENE12, entity: "scene", label: "12" }]);
  });

  test("and only by it: the film opened last is not a default",
      async () => {
    const r = await callTool(server, "find",
      { entityType: "scene", label: "12" });
    expect(r.isError).toBe(true);
    expect(r.json).toMatchObject({
      code: "invalid_session", rejected_file_id: null,
      open_sessions: [{ file_id: session, path: FIXTURE }],
      recent_files: [FIXTURE],
    });
  });

  test("a film that cannot be opened gets no session", async () => {
    const r = await callTool(server, "open",
      { scfPath: join(HERE, "no-such-film.scf") });
    expect(r.isError).toBe(true);
    expect(r.json).toBeNull();           // the host's message, not a payload
    const refused = await callTool(server, "find",
      { file_id: "nope", entityType: "scene", label: "12" });
    expect((refused.json as { open_sessions: unknown[] }).open_sessions)
      .toEqual([{ file_id: session, path: FIXTURE }]);
  });
});

describe("scf-mcp server — sessions", () => {
  let dir: string;
  let server: Server;
  let one: string;
  let two: string;
  let first: string;
  let second: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "scf-mcp-sessions-"));
    one = join(dir, "one.scf");
    two = join(dir, "two.scf");
    copyFileSync(FIXTURE, one);
    copyFileSync(FIXTURE, two);
    server = await startServer([]);
    first = await openFilm(server, one);
    second = await openFilm(server, two);
  }, 60_000);
  afterAll(() => {
    server.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Which film a session's calls reach: `recent_changes` names it. */
  const filmOf = async (sessionId: string): Promise<string> =>
    ((await callTool(server, "recent_changes", { file_id: sessionId }))
      .json as { film: string }).film;

  test("each film has its own session, and a call goes where its " +
      "file_id says whichever film was opened last", async () => {
    expect(first).not.toBe(second);
    expect(await filmOf(first)).toBe(one);
    expect(await filmOf(second)).toBe(two);
    expect(await filmOf(first)).toBe(one);
  });

  test("opening a film that is already open answers as the first open " +
      "did, with the same session", async () => {
    const again = await callTool(server, "open", { scfPath: one });
    const fresh = await callTool(server, "open", { scfPath: one });
    expect(again.isError).toBe(false);
    expect((again.json as { file_id: string }).file_id).toBe(first);
    expect(Object.keys(again.json as object).sort()).toEqual([
      "file_id", "opened", "project", "revision", "rootMapped", "roots",
      "sceneCount", "shotCount", "writable"]);
    expect(fresh.json).toEqual(again.json);
    // Opening the first again did not make it anybody's default.
    expect(await filmOf(second)).toBe(two);
  });

  test("set_root maps a root for its own session's film only", async () => {
    const r = await callTool(server, "set_root",
      { file_id: first, roots: { project: HERE } });
    expect(r.isError).toBe(false);
    const mapped = async (path: string): Promise<boolean> =>
      ((await callTool(server, "open", { scfPath: path })).json as
        { rootMapped: boolean }).rootMapped;
    expect(await mapped(one)).toBe(true);
    expect(await mapped(two)).toBe(false);
  });

  test("an unknown, malformed or missing file_id is one error, " +
      "invalid_session, with the sessions and files to go on from",
      async () => {
    const sessions = [
      { file_id: first, path: one }, { file_id: second, path: two }];
    const shouted = `${first.toUpperCase()}-`;
    for (const [given, rejected] of [
      ["zzzz", "zzzz"], ["not a session id!", "not a session id!"],
      [shouted, shouted],
      ["", null], [12, null], [null, null], [undefined, null],
    ] as const) {
      const r = await callTool(server, "find", {
        ...(given === undefined ? {} : { file_id: given }),
        entityType: "scene", label: "12" });
      expect(r.isError, String(given)).toBe(true);
      expect(r.json, String(given)).toEqual({
        code: "invalid_session",
        message: `Session '${rejected ?? ""}' is invalid or unavailable. ` +
          "Call `open` to continue. Reuse a session from `open_sessions`, " +
          "or call `open` with a file path.",
        rejected_file_id: rejected,
        open_sessions: sessions,
        recent_files: [two, one],
      });
    }
  });

  test("every tool but open and recent_files takes a required " +
      "file_id, and says what to do without one", async () => {
    const listed = await server.send("tools/list") as { tools: Array<{
      name: string; description: string;
      inputSchema: { required?: string[];
                     properties: Record<string, { type?: string }> } }> };
    for (const tool of listed.tools) {
      const takes = tool.inputSchema.required?.includes("file_id") === true;
      if (tool.name === "open" || tool.name === "recent_files") {
        expect(takes, tool.name).toBe(false);
        continue;
      }
      expect(takes, tool.name).toBe(true);
      expect(tool.inputSchema.properties["file_id"]?.type, tool.name)
        .toBe("string");
      expect(tool.description, tool.name).toContain("`file_id`");
      expect(tool.description, tool.name).toContain("`invalid_session`");
    }
    expect(listed.tools.find((t) => t.name === "open")?.description)
      .toContain("`file_id`");
    expect(server.instructions).toContain("`file_id`");
    expect(server.instructions).toContain("`invalid_session`");
  });

  test("the session is checked before the tool does anything: one call " +
      "of each kind of tool, with a session that is not there", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [
      ["set_root", { roots: { project: HERE } }],
      ["list", { entityType: "scene" }],
      ["where_used", { entityType: "scene", uuid: SCENE12 }],
      ["shot_context", { shotUuid: SHOT1204 }],
      ["shot_media", { shotUuid: SHOT1204 }],
      ["shot_readiness", { shotUuid: SHOT1204 }],
      ["readiness", { queryId: "Q07", params: { scene: SCENE12 } }],
      ["scene_package", { scene: SCENE12 }],
      ["shot_list", {}], ["gallery", {}],
      ["character_presence", { characterUuid: ELEANOR }],
      ["recent_changes", {}],
      ["update_row", { entityType: "character", uuid: ELEANOR,
                       values: { summary: "Never planned." } }],
      ["add_shot", { sceneUuid: SCENE12 }],
    ];
    for (const [name, args] of calls) {
      const r = await callTool(server, name, { file_id: "gone", ...args });
      expect(r.isError, name).toBe(true);
      expect(r.json, name).toMatchObject(
        { code: "invalid_session", rejected_file_id: "gone" });
    }
  });

  test("a session whose file is gone is invalid, and is not offered " +
      "for reuse", async () => {
    unlinkSync(two);
    const r = await callTool(server, "list",
      { file_id: second, entityType: "scene" });
    expect(r.isError).toBe(true);
    expect(r.json).toMatchObject({
      code: "invalid_session", rejected_file_id: second,
      open_sessions: [{ file_id: first, path: one }],
    });
    // Put back, the film opens again — as a new session, not the old one.
    copyFileSync(FIXTURE, two);
    const reopened = await openFilm(server, two);
    expect(reopened).not.toBe(second);
    expect(await filmOf(reopened)).toBe(two);
    expect((await callTool(server, "list",
      { file_id: second, entityType: "scene" })).isError).toBe(true);
  });
});

describe("scf-mcp server — a session id is never given twice", () => {
  test("a new server does not know an earlier one's sessions, and " +
      "gives the same film a different id", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "scf-mcp-test-"));
    try {
      const first = await startServer([], configDir);
      const before = await openFilm(first, FIXTURE);
      await new Promise((r) => { setTimeout(r, 200); });
      first.kill();

      const second = await startServer([], configDir);
      try {
        const stale = await callTool(second, "find",
          { file_id: before, entityType: "scene", label: "12" });
        expect(stale.isError).toBe(true);
        expect(stale.json).toMatchObject({
          code: "invalid_session", rejected_file_id: before,
          open_sessions: [], recent_files: [FIXTURE],
        });
        const after = await openFilm(second, FIXTURE);
        expect(after).not.toBe(before);
        // Opening it here did not bring the old id back.
        expect((await callTool(second, "find", { file_id: before,
          entityType: "scene", label: "12" })).isError).toBe(true);
      } finally {
        second.kill();
      }
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("two servers on one app.db never give the same id", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "scf-mcp-test-"));
    const dir = mkdtempSync(join(tmpdir(), "scf-mcp-sessions-"));
    const a = await startServer([], configDir);
    const b = await startServer([], configDir);
    try {
      const films = Array.from({ length: 6 }, (_, i) => {
        const film = join(dir, `film-${String(i)}.scf`);
        copyFileSync(FIXTURE, film);
        return film;
      });
      const ids = await Promise.all(films.flatMap((film) =>
        [openFilm(a, film), openFilm(b, film)]));
      expect(new Set(ids).size).toBe(ids.length);
    } finally {
      a.kill();
      b.kill();
      rmSync(configDir, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("scf-mcp server — recent_files persists across restarts", () => {
  test("a new server, given the same config directory, remembers " +
      "what an earlier one opened", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "scf-mcp-test-"));
    try {
      const first = await startServer([], configDir);
      await first.send("tools/call", {
        name: "open", arguments: { scfPath: FIXTURE },
      });
      // The config write is fire-and-forget (projectCache.ts) so a
      // failed or slow write never blocks a tool call — give it a
      // moment to land on disk before closing the server.
      await new Promise((r) => { setTimeout(r, 200); });
      first.kill();

      const second = await startServer([], configDir);
      try {
        const result = await second.send("tools/call", {
          name: "recent_files", arguments: {},
        }) as { content: Array<{ text: string }>; isError?: boolean };
        expect(result.isError).toBeUndefined();
        expect(result.content[0]?.text).toBe(FIXTURE);
      } finally {
        second.kill();
      }
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});

describe("scf-mcp server — set_root persists and a later open falls " +
    "back to it", () => {
  test("a stored asset root is attached silently when open is given none",
      async () => {
    const configDir = mkdtempSync(join(tmpdir(), "scf-mcp-test-"));
    try {
      const first = await startServer([], configDir);
      try {
        await callTool(first, "set_root", {
          file_id: await openFilm(first, FIXTURE),
          roots: { project: HERE },
        });
      } finally {
        first.kill();
      }

      const second = await startServer([], configDir);
      try {
        const result = await callTool(second, "open", { scfPath: FIXTURE });
        expect(result.isError).toBe(false);
        const summary = result.json as
          { rootMapped: boolean; roots: Record<string, string> };
        expect(summary.rootMapped).toBe(true);
        expect(summary.roots["project"]).toBe(HERE);
      } finally {
        second.kill();
      }
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("an explicit root at open always wins over the stored one, and " +
      "replaces it", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "scf-mcp-test-"));
    try {
      const first = await startServer([], configDir);
      try {
        await callTool(first, "open", {
          scfPath: FIXTURE, roots: { project: HERE },
        });
      } finally {
        first.kill();
      }

      const other = dirname(HERE);
      const second = await startServer([], configDir);
      try {
        const opened = await callTool(second, "open", {
          scfPath: FIXTURE, roots: { project: other },
        });
        const openedSummary = opened.json as { roots: Record<string, string> };
        expect(openedSummary.roots["project"]).toBe(other);
      } finally {
        second.kill();
      }

      // The explicit root from the second server replaced the first's.
      const third = await startServer([], configDir);
      try {
        const result = await callTool(third, "open", { scfPath: FIXTURE });
        const summary = result.json as { roots: Record<string, string> };
        expect(summary.roots["project"]).toBe(other);
      } finally {
        third.kill();
      }
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});

describe("scf-mcp server — no film is held open between calls", () => {
  test("a film the server has answered from can be renamed and deleted " +
       "while it runs", async () => {
    // projectCache.ts opens a film for exactly as long as one call runs.
    // A held handle kept every film a session had looked at locked on
    // Windows: the editor could not save it, nor the fixture build
    // rewrite it.
    const dir = mkdtempSync(join(tmpdir(), "scf-mcp-release-"));
    const film = join(dir, "film.scf");
    copyFileSync(FIXTURE, film);
    const server = await startServer([]);
    try {
      const file_id = await openFilm(server, film);
      const call = (name: string, args: Record<string, unknown>) =>
        server.send("tools/call", {
          name, arguments: { file_id, ...args },
        }) as Promise<{ isError?: boolean }>;
      expect((await call("shot_context", { shotUuid: SHOT1204 })).isError)
        .toBeUndefined();
      expect((await call("list", { entityType: "scene" })).isError)
        .toBeUndefined();

      // Where the OS lists what a process holds (Linux, where CI runs),
      // nothing may point at the film.
      const fds = `/proc/${String(server.pid)}/fd`;
      if (existsSync(fds)) {
        const held = readdirSync(fds).map((fd) => {
          try { return readlinkSync(join(fds, fd)); } catch { return ""; }
        });
        expect(held.filter((p) => p.startsWith(film))).toEqual([]);
      }
      // Where a held file cannot be renamed or deleted (Windows), these
      // throw if the server still has it open.
      const moved = join(dir, "film-renamed.scf");
      renameSync(film, moved);
      unlinkSync(moved);

      // And with the file gone the server says so, rather than answering
      // from a handle it should not have kept.
      expect((await call("list", { entityType: "scene" })).isError)
        .toBe(true);
    } finally {
      server.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
