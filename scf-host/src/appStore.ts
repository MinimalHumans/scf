// SPDX-License-Identifier: Apache-2.0
/**
 * appStore.ts — `app.db` (docs/file-management-plan.md §3.1): one
 * SQLite database, read and written by both the editor's window and
 * the standalone MCP, that pairs a `.scf` with the folder its assets
 * live in and keeps a permanent history of both. Keyed on each
 * project's canonical path, not its uuid: more than one row may share a
 * uuid (a versioned copy elsewhere, a Save As), and that is expected.
 *
 * Opening the underlying database is dependency-injected (`OpenAppDb`):
 * the window supplies Tauri's SQL commands (`scf-app`
 * `src/host/tauriSql.ts`), a Node process scf-core's `node.ts` driver
 * (`nodeAppStore.ts` wraps it). Both already speak the same `SqlExec`
 * seam this module runs its schema and queries over — this file owns
 * only those, not a driver.
 */

import type { Row, SqlExec, SqlValue } from "@minimalhumans/scf-core";

export interface AppDb {
  exec: SqlExec;
  close(): Promise<void>;
}

/** Opens `path`, creating an empty database if nothing is there yet. */
export type OpenAppDb = (path: string) => Promise<AppDb>;

/**
 * What `appStore.ts` needs to recover from a corrupt `app.db`: enough to
 * move the bad file aside and let a fresh one be created in its place.
 * Each environment supplies its own (`nodeAppStore.ts` on Node; the
 * window via Tauri commands).
 */
export interface AppStoreFs {
  exists(path: string): Promise<boolean>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

export interface ProjectRow {
  pathKey: string;
  scfPath: string;
  uuid: string | null;
  title: string | null;
  baseName: string | null;
  assetRoot: string | null;
  /** ISO 8601, UTC. */
  lastOpened: string;
}

export interface TouchProjectFields {
  uuid?: string | null;
  title?: string | null;
  baseName?: string | null;
  assetRoot?: string | null;
}

export interface SuggestionInput {
  uuid: string | null;
  title: string | null;
  /** Already run through `baseNameOf` (scf-core `projectName.ts`) — a
   *  raw file name would never match the stored, already-stripped
   *  column. */
  baseName: string | null;
}

export interface ProjectSuggestion extends ProjectRow {
  /** Why this row was offered: a uuid match, or a title/base-name one.
   *  Never applied automatically either way (decision 7) — strength is
   *  only how the suggestion dialog orders and labels them. */
  strength: "uuid" | "name";
}

export interface AppStore {
  close(): Promise<void>;

  /**
   * Insert or update the row for `scfPath`'s canonical path: always
   * `scfPath` and `lastOpened` (now). Any of `uuid`/`title`/`baseName`/
   * `assetRoot` given (including explicitly `null`, to clear one) are
   * written too; omitted ones are left as they were. Creates the row if
   * none exists yet.
   */
  touchProject(scfPath: string, fields?: TouchProjectFields): Promise<ProjectRow>;
  getProject(scfPath: string): Promise<ProjectRow | null>;
  setAssetRoot(scfPath: string, assetRoot: string | null): Promise<ProjectRow>;
  forgetProject(scfPath: string): Promise<void>;
  /** Most recently opened first. */
  recentProjects(limit?: number): Promise<ProjectRow[]>;
  /**
   * Other rows that might be this same project, for a path `app.db`
   * has never seen (file-management-plan.md §3.2 point 3): a uuid
   * match first (strong), most recently opened within each group,
   * then a title or base-name match (weak) — never both for the same
   * row. Only rows with an asset root attached are offered (there is
   * nothing to suggest from an unmapped project). Excludes
   * `excludeScfPath` itself.
   */
  suggestionsFor(input: SuggestionInput,
                 excludeScfPath: string): Promise<ProjectSuggestion[]>;

  getPref(key: string): Promise<string | null>;
  setPref(key: string, value: string): Promise<void>;
}

export interface OpenAppStoreOptions {
  /** Windows path keys fold case; everywhere else they don't. */
  caseInsensitiveKeys: boolean;
  /**
   * Called once, only when `app.db` is freshly created: returns
   * absolute paths, most recently opened first, to seed as project rows
   * with no uuid, title or asset root — the old `mcp-config.json`'s
   * `recentFiles` (file-management-plan.md §3.1 "Migration"). Never
   * called again once the schema has been stamped.
   */
  importLegacyRecentFiles?: () => Promise<readonly string[]>;
}

const SCHEMA_VERSION = 1;

function pathKeyOf(scfPath: string, caseInsensitive: boolean): string {
  return caseInsensitive ? scfPath.toLowerCase() : scfPath;
}

function str(v: SqlValue | undefined): string | null {
  return v === null || v === undefined ? null : String(v);
}

function toProjectRow(row: Row): ProjectRow {
  return {
    pathKey: String(row["path_key"]),
    scfPath: String(row["scf_path"]),
    uuid: str(row["uuid"]),
    title: str(row["title"]),
    baseName: str(row["base_name"]),
    assetRoot: str(row["asset_root"]),
    lastOpened: String(row["last_opened"]),
  };
}

async function verify(db: AppDb): Promise<AppDb> {
  try {
    const rows = await db.exec("PRAGMA quick_check");
    const ok = rows.length === 1 && rows[0]?.["quick_check"] === "ok";
    if (!ok) {
      throw new Error(`app.db failed an integrity check: ${JSON.stringify(rows)}`);
    }
    return db;
  } catch (e) {
    await db.close().catch(() => undefined);
    throw e;
  }
}

/**
 * Whether `e` looks like SQLite reporting lock contention (a process that
 * has not let go of the file yet — e.g. one still shutting down from a
 * branch switch or restart), on either driver this runs over. Never a
 * sign of corruption: that failure clears on its own, and must never be
 * "fixed" by discarding the file it is contending over.
 */
function isLockContention(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e);
  return /\b(locked|busy)\b/i.test(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** Extra patience for a lock to clear, beyond each open's own
 *  PRAGMA busy_timeout — covers a previous process still exiting. */
const LOCK_RETRY_DELAYS_MS = [75, 200, 500];

/**
 * Open `path`, verifying it. A file that fails its integrity check, or
 * cannot be opened for a reason other than lock contention, is moved
 * aside as `<path>.bak` — history is never silently dropped without
 * leaving the old file. A path that does not exist yet is not
 * corruption: that failure is rethrown as is.
 *
 * An existing `<path>.bak` is never overwritten by a later incident: it
 * moves to a timestamped name first, so a second crash can never erase
 * the one record of the first. If that older backup still checks out,
 * it is promoted straight back to `path` — restored automatically,
 * rather than starting the user over with a blank history, and it is
 * the live file again afterward, not a separate leftover copy. A crash
 * is not a reason to lose a recent-projects list when a recent, intact
 * copy is sitting right there. Only when there is no usable backup at
 * all does this fall through to a genuinely fresh database — and even
 * then, both the freshly-corrupt file and any also-bad prior backup
 * stay on disk, under names nothing will overwrite again. Nothing here
 * ever deletes a file, only renames it.
 *
 * Lock contention (another process still holding the file) is retried
 * instead: it is transient, not corruption, and must never be treated as
 * a reason to back up and recreate the file out from under that process.
 * If it never clears, the error is rethrown rather than guessed at.
 */
export async function openVerified(
    path: string, open: OpenAppDb, fs: AppStoreFs): Promise<AppDb> {
  let lastError: unknown;
  for (const delay of [0, ...LOCK_RETRY_DELAYS_MS]) {
    if (delay > 0) await sleep(delay);
    try {
      return await verify(await open(path));
    } catch (e) {
      lastError = e;
      if (!isLockContention(e)) break;
    }
  }
  if (isLockContention(lastError)) throw lastError;
  if (!(await fs.exists(path))) throw lastError;

  const backup = `${path}.bak`;
  let priorBackup: string | null = null;
  if (await fs.exists(backup)) {
    priorBackup = `${backup}-${Date.now()}`;
    await fs.rename(backup, priorBackup);
  }
  await fs.rename(path, backup);

  if (priorBackup !== null) {
    const recovered = await verify(await open(priorBackup)).catch(() => null);
    if (recovered !== null) {
      await recovered.close();
      // Promote the verified-good prior backup back into place —
      // `path` is free (just renamed away above), so this is a move,
      // not an overwrite of anything.
      await fs.rename(priorBackup, path);
      return await verify(await open(path));
    }
  }
  return await verify(await open(path));
}

async function migrate(
    exec: SqlExec, caseInsensitiveKeys: boolean,
    importLegacyRecentFiles?: () => Promise<readonly string[]>): Promise<void> {
  const [row] = await exec("PRAGMA user_version");
  const version = Number(row?.["user_version"] ?? 0);
  if (version >= SCHEMA_VERSION) return;

  await exec(`CREATE TABLE IF NOT EXISTS project (
    path_key    TEXT PRIMARY KEY,
    scf_path    TEXT NOT NULL,
    uuid        TEXT,
    title       TEXT,
    base_name   TEXT,
    asset_root  TEXT,
    last_opened TEXT NOT NULL
  )`);
  await exec(
    "CREATE INDEX IF NOT EXISTS project_uuid ON project (uuid)");
  await exec(
    "CREATE INDEX IF NOT EXISTS project_title ON project (title COLLATE NOCASE)");
  await exec(`CREATE TABLE IF NOT EXISTS pref (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);

  if (importLegacyRecentFiles !== undefined) {
    const paths = await importLegacyRecentFiles();
    // Synthetic, strictly decreasing timestamps: recentProjects() orders
    // by last_opened, and the import has no real history to give it.
    const now = Date.now();
    for (let i = 0; i < paths.length; i++) {
      const scfPath = paths[i];
      if (scfPath === undefined) continue;
      await exec(
        "INSERT OR IGNORE INTO project (path_key, scf_path, last_opened) " +
        "VALUES (?, ?, ?)",
        [pathKeyOf(scfPath, caseInsensitiveKeys), scfPath,
         new Date(now - i).toISOString()]);
    }
  }

  // Not bound: PRAGMA does not take parameters, and this is a fixed
  // constant, never user input.
  await exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

function createStore(db: AppDb, caseInsensitiveKeys: boolean): AppStore {
  const keyOf = (scfPath: string) => pathKeyOf(scfPath, caseInsensitiveKeys);

  const getProject: AppStore["getProject"] = async (scfPath) => {
    const rows = await db.exec(
      "SELECT path_key, scf_path, uuid, title, base_name, asset_root, " +
      "last_opened FROM project WHERE path_key = ?",
      [keyOf(scfPath)]);
    return rows.length === 0 ? null : toProjectRow(rows[0]!);
  };

  const touchProject: AppStore["touchProject"] = async (scfPath, fields = {}) => {
    const pathKey = keyOf(scfPath);
    const now = new Date().toISOString();
    const given = (
      ["uuid", "title", "baseName", "assetRoot"] as const
    ).filter((key) => fields[key] !== undefined);
    const column = { uuid: "uuid", title: "title", baseName: "base_name",
                      assetRoot: "asset_root" } as const;
    const setClauses = [
      "scf_path = excluded.scf_path", "last_opened = excluded.last_opened",
      ...given.map((key) => `${column[key]} = ?`),
    ];
    await db.exec(
      "INSERT INTO project " +
      "(path_key, scf_path, last_opened, uuid, title, base_name, asset_root) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?) " +
      `ON CONFLICT(path_key) DO UPDATE SET ${setClauses.join(", ")}`,
      [pathKey, scfPath, now,
       fields.uuid ?? null, fields.title ?? null, fields.baseName ?? null,
       fields.assetRoot ?? null,
       ...given.map((key) => fields[key] ?? null)]);
    const row = await getProject(scfPath);
    if (row === null) throw new Error(`internal: lost project row for ${scfPath}`);
    return row;
  };

  return {
    close: () => db.close(),
    touchProject,
    getProject,
    setAssetRoot: (scfPath, assetRoot) => touchProject(scfPath, { assetRoot }),
    forgetProject: async (scfPath) => {
      await db.exec("DELETE FROM project WHERE path_key = ?", [keyOf(scfPath)]);
    },
    recentProjects: async (limit = 20) => {
      const rows = await db.exec(
        "SELECT path_key, scf_path, uuid, title, base_name, asset_root, " +
        "last_opened FROM project ORDER BY last_opened DESC LIMIT ?",
        [limit]);
      return rows.map(toProjectRow);
    },

    suggestionsFor: async (input, excludeScfPath) => {
      const excludeKey = keyOf(excludeScfPath);
      const columns = "path_key, scf_path, uuid, title, base_name, " +
        "asset_root, last_opened";

      const strongRows = input.uuid === null ? [] : await db.exec(
        `SELECT ${columns} FROM project ` +
        "WHERE uuid = ? AND path_key != ? AND asset_root IS NOT NULL " +
        "AND asset_root != '' ORDER BY last_opened DESC",
        [input.uuid, excludeKey]);
      const strong = strongRows.map(toProjectRow);
      const strongKeys = new Set(strong.map((r) => r.pathKey));

      const weakConditions: string[] = [];
      const weakParams: SqlValue[] = [excludeKey];
      if (input.title !== null) {
        weakConditions.push("title = ? COLLATE NOCASE");
        weakParams.push(input.title);
      }
      if (input.baseName !== null) {
        weakConditions.push("base_name = ? COLLATE NOCASE");
        weakParams.push(input.baseName);
      }
      const weakRows = weakConditions.length === 0 ? [] : await db.exec(
        `SELECT ${columns} FROM project WHERE path_key != ? AND ` +
        `asset_root IS NOT NULL AND asset_root != '' AND ` +
        `(${weakConditions.join(" OR ")}) ORDER BY last_opened DESC`,
        weakParams);
      const weak = weakRows.map(toProjectRow)
        .filter((r) => !strongKeys.has(r.pathKey));

      return [
        ...strong.map((r): ProjectSuggestion => ({ ...r, strength: "uuid" })),
        ...weak.map((r): ProjectSuggestion => ({ ...r, strength: "name" })),
      ];
    },
    getPref: async (key) => {
      const rows = await db.exec("SELECT value FROM pref WHERE key = ?", [key]);
      return rows.length === 0 ? null : String(rows[0]!["value"]);
    },
    setPref: async (key, value) => {
      await db.exec(
        "INSERT INTO pref (key, value) VALUES (?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [key, value]);
    },
  };
}

export async function openAppStore(
    path: string, open: OpenAppDb, fs: AppStoreFs,
    options: OpenAppStoreOptions): Promise<AppStore> {
  const db = await openVerified(path, open, fs);
  // WAL plus a busy timeout: the editor's window and the standalone MCP
  // can both have app.db open and writing at once (file-management-plan
  // §3.1, decision 10; risk "Two writers").
  await db.exec("PRAGMA journal_mode = WAL");
  await db.exec("PRAGMA busy_timeout = 5000");
  await migrate(
    db.exec, options.caseInsensitiveKeys, options.importLegacyRecentFiles);
  return createStore(db, options.caseInsensitiveKeys);
}
