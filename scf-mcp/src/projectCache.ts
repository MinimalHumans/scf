// SPDX-License-Identifier: Apache-2.0
/**
 * projectCache.ts — which `.scf` a tool call means, and talking to the
 * host about it for exactly as long as the call runs.
 *
 * NO FILM OUTLIVES A CALL. `open` remembers a path and its roots; each
 * tool call makes its own connection to the host, opens the film on it,
 * answers, and disconnects (`withProject`). The host lets go of a film
 * when its last client does, so on Windows — where an open handle stops
 * any other program renaming, replacing or deleting the file — a film
 * this server has looked at is not held against the editor saving it
 * or the fixture build rewriting it. A connection per call costs a few
 * milliseconds and means a call answers from what is on disk when it
 * runs.
 *
 * A stdio MCP server is a single long-lived process a client (Claude
 * Desktop, an editor, whatever) spawns once and keeps running for its
 * whole session — there is no per-conversation process, and the MCP
 * protocol gives a stdio server no conversation identifier to key
 * state on. A client may put every conversation it has on that one
 * process, so "the film this server opened last" is not any one
 * conversation's film.
 *
 * So a film is named by SESSION. `open` takes `scfPath` and gives back
 * the film's session id (`sessionId.ts`); every other film tool takes
 * that id, and `withProject` — which every one of them goes through —
 * finds the film by it and by nothing else. An id that names no session
 * here is `invalid_session` (`session.ts`): there is no falling back on
 * a film somebody opened. A server keeps one session per film, so opening
 * a film again gives the id it already has. (In the desktop app several
 * clients' servers share one window, so sessions are the cache's and not
 * module state.)
 *
 * The recent-files list and each project's asset root outlive the
 * server: both are `app.db` (file-management-plan.md §3.1), read and
 * written directly through `platform.appStore` by the `open`,
 * `recent_files` and `set_root` tool handlers (mcpServer.ts) — this
 * cache holds no history of its own. Sessions do not outlive it: a new
 * server starts with none, and the ids it gives are new ones.
 */

import {
  loadRegistry, type FileLocator, type RegistryJson, type ScfContext,
} from "@minimalhumans/scf-core";
import { HostClientError, type HostClient }
  from "@minimalhumans/scf-host/client";
import registryJson from "@minimalhumans/scf-core/registry.json" with { type: "json" };
import type { RootMap } from "./config.ts";
import type { McpPlatform } from "./platform.ts";
import { InvalidSessionError } from "./session.ts";
import { createSessionIds } from "./sessionId.ts";

export const registry = loadRegistry(registryJson as unknown as RegistryJson);

/** A film this server knows: where it is and its roots. No handle. */
export interface Project {
  scfPath: string;
  locate: FileLocator;
  rootMapped: boolean;
  roots: RootMap;
}

/** A film open for the length of one call (`withProject`). */
export interface OpenProject extends Project {
  /** Reads, against the host's read-only connection. */
  ctx: ScfContext;
  /** This call's own connection, for writes. Closed when the call ends. */
  host: HostClient;
  /** The film's revision when this call opened it. */
  revision: number;
  readOnly: boolean;
}

export interface ProjectCache {
  /** When set, films are opened read-only: no write can come from here. */
  readonly readOnly: boolean;
  /**
   * Who this server is to the host, for attributing its writes. The MCP
   * handshake names the client (Claude Desktop, an editor…); the host's
   * journal and the editor's "edited by" notice show it.
   */
  agentName(): string;
  setAgentName(client: string | undefined): void;
  /**
   * Run `fn` against the film at `scfPath` and, once it has answered,
   * give the film a session: the one it has, if this server has opened
   * it before, else a new one. A film that cannot be opened gets none.
   * Given `roots`, they merge into whatever this path already had — so
   * calling `open` again to add a root doesn't require repeating the
   * ones already set.
   */
  openProject<T>(scfPath: string, roots: RootMap,
                 fn: (project: OpenProject) => Promise<T>):
    Promise<{ sessionId: string; result: T }>;
  /** Paths `app.db` has seen opened, most recently first. */
  recentFiles(): Promise<string[]>;
  /**
   * Merge `roots` into a session's film without reopening it. Throws
   * `InvalidSessionError` as `withProject` does.
   */
  setRoots(sessionId: string, roots: RootMap): Promise<Project>;
  /**
   * Run `fn` against the film `sessionId` names, on a connection of its
   * own that is closed however `fn` ends. Every film tool goes through
   * here, so nothing outlives a call, and the session is checked before
   * any of the tool's own work: an id that names no session here, or one
   * whose file is gone, throws `InvalidSessionError`.
   */
  withProject<T>(sessionId: string,
                 fn: (project: OpenProject) => Promise<T>): Promise<T>;
}

export function createProjectCache(
    platform: McpPlatform, options: { readOnly: boolean }): ProjectCache {
  const { readOnly } = options;
  let agentName = "mcp";
  const ids = createSessionIds(platform.appStore, platform.machineId);

  /**
   * Every session this server has given, and the session of each film by
   * resolved path, so that opening one again keeps its id and the roots
   * already set. Holds no handle, so there is no reason to bound it the
   * way a cache of open files must be.
   */
  const sessions = new Map<string, Project>();
  const sessionOf = new Map<string, string>();

  /** Merge `roots` into `project` in place. No-op when `roots` is empty. */
  function applyRoots(project: Project, roots: RootMap): void {
    if (Object.keys(roots).length === 0) return;
    const absolute = Object.fromEntries(Object.entries(roots)
      .map(([name, dir]) => [name, platform.resolve(dir)]));
    project.roots = { ...project.roots, ...absolute };
    project.locate = platform.locator(project.roots);
    project.rootMapped = true;
  }

  /** The refusal of `sessionId`, with what the caller can do instead. */
  async function invalid(sessionId: string): Promise<InvalidSessionError> {
    return new InvalidSessionError(
      sessionId === "" ? null : sessionId,
      [...sessions].map(([id, p]) => ({ file_id: id, path: p.scfPath })),
      await cache.recentFiles().catch(() => []));
  }

  async function sessionProject(sessionId: string): Promise<Project> {
    const project = sessions.get(sessionId);
    if (project === undefined) throw await invalid(sessionId);
    return project;
  }

  /**
   * `fn` against `project`, on a connection that lasts as long as it
   * does. `gone` is what to throw when the file is not there.
   */
  async function run<T>(
      project: Project, fn: (project: OpenProject) => Promise<T>,
      gone?: () => Promise<Error>): Promise<T> {
    const host = await platform.connect(agentName);
    try {
      const opened = await host.open(project.scfPath, { readOnly })
        .catch(async (e: unknown) => {
          throw gone !== undefined && e instanceof HostClientError &&
            e.code === "not_found" ? await gone() : e;
        });
      return await fn({
        ...project, ctx: host.context(registry), host,
        revision: opened.revision, readOnly,
      });
    } finally {
      // Closed before the connection is: the host lets go of a dropped
      // connection's film only after it notices, and until then
      // Windows will not let anyone rename or delete the file.
      await host.closeFilm().catch(() => {});
      await host.dispose();
    }
  }

  const cache: ProjectCache = {
    readOnly,
    agentName: () => agentName,
    setAgentName(client) {
      agentName = client === undefined || client === "" ? "mcp"
        : `mcp: ${client}`;
    },

    async openProject(scfPathInput, roots, fn) {
      const scfPath = platform.resolve(scfPathInput);
      const known = sessionOf.get(scfPath);
      const project = (known === undefined ? undefined : sessions.get(known))
        ?? { scfPath, locate: platform.locator({}), rootMapped: false,
             roots: {} };
      applyRoots(project, roots);
      const result = await run(project, fn);
      // Looked up again, twice: another call may have opened this film,
      // or let its session go, while this one was reading it or waiting
      // for an id.
      let sessionId = sessionOf.get(scfPath);
      if (sessionId === undefined) {
        const minted = await ids.next();
        sessionId = sessionOf.get(scfPath);
        if (sessionId === undefined) {
          sessionId = minted;
          sessions.set(sessionId, project);
          sessionOf.set(scfPath, sessionId);
        }
      }
      const kept = sessions.get(sessionId);
      if (kept !== undefined && kept !== project) applyRoots(kept, roots);
      return { sessionId, result };
    },

    recentFiles: async () =>
      (await platform.appStore.recentProjects()).map((r) => r.scfPath),

    async setRoots(sessionId, roots) {
      const project = await sessionProject(sessionId);
      applyRoots(project, roots);
      return project;
    },

    async withProject(sessionId, fn) {
      const project = await sessionProject(sessionId);
      return run(project, fn, () => {
        // The film is gone, so its session is too: `open` is how the
        // caller finds it again, wherever it went.
        sessions.delete(sessionId);
        if (sessionOf.get(project.scfPath) === sessionId) {
          sessionOf.delete(project.scfPath);
        }
        return invalid(sessionId);
      });
    },
  };
  return cache;
}
