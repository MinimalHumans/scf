// SPDX-License-Identifier: Apache-2.0
/**
 * store.ts — application state (Zustand).
 *
 * The host connection and the asset-folder adapter are module
 * singletons (non-reactive); the store holds reactive state: project
 * lifecycle, navigation, and the form draft — dirty-state and undo at
 * the form level. `revision` is the host's, and moves after any write
 * by any client, so lists and panels re-query.
 */

import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import registryJson from "@registry/registry.json" with { type: "json" };
import { loadRegistry, type Registry, type RegistryJson }
  from "@scf-core/registry.ts";
import { q, type Row, type SqlExec, type SqlValue } from "@scf-core/db.ts";
import { baseNameOf } from "@scf-core/projectName.ts";
import { chooseAssetFolder } from "../files/assetFolderChooser.ts";
import type { ProjectChooser } from "../files/projectChooser.ts";
import { createTauriChooser } from "../files/tauriChooser.ts";
import { getHost } from "../host/hostClient.ts";
import { windowAppStore } from "../host/windowAppStore.ts";
import type { ProjectSuggestion } from "@scf-host/appStore.ts";
import type { HostClient } from "@scf-host/client.ts";
import { buildReferenceGraph, type IncomingRef,
         type NavigableSubject } from "./registryGraph.ts";
import { suggestSaveAsName } from "./saveName.ts";
import { call } from "./api.ts";
import { rowLabel } from "@scf-core/displayName.ts";
import { type UndoEntry } from "@scf-core/ops/undoDelete.ts";
import { type ChangeUndo } from "@scf-core/ops/undoChange.ts";
import { resolveAllAssets, type ResolutionReport }
  from "@scf-core/assets.ts";
import { makeLocator } from "../files/assetLocator.ts";
import { pushProjectCacheLimitOverride, revokeAll } from "../files/objectUrlCache.ts";
import { clearResolutions } from "../files/thumbnailCache.ts";
import { setAssetLocator } from "../ui/queries/runners.ts";
import { useProjectTabs, type ProjectMemory } from "./projectTabs.ts";
import { UNREACHABLE, unwatchProject, watchProject } from "./projectWatch.ts";
import { OPEN_TABS_PREF, useSettings } from "./settings.ts";

export { suggestSaveAsName };

export const registry: Registry =
  loadRegistry(registryJson as unknown as RegistryJson);
export const referenceGraph: Map<string, IncomingRef[]> =
  buildReferenceGraph(registry);

const EDITOR_VERSION = "scf-app 0.1.0";

/** How the user names a `.scf`: the OS's own Open/Save dialogs. */
const chooser: ProjectChooser = createTauriChooser();

/**
 * scf-core's read seam, app-wide. Reads go to the host's read-only
 * connection on whichever film this window has open; writes never go
 * through here (see `call` in api.ts).
 */
export const exec: SqlExec = async (sql, params) =>
  (await getHost()).exec(sql, params);

/** Sentinel: every category collapsed. Resolved by CategoryTree, which
 * is the only place that knows the category names. */
export const COLLAPSE_ALL = new Set<string>(["\u0000all"]);

export type NavMode =
  // Where an opened project lands: a neutral page, not any one section.
  "intro" | "project" |
  "subject" | "schema" | "structure" | "queries" | "script" | "shoot" |
  "assets" | "characters" | "locations" | "props" |
  // Presentation: read-only views of the film, made to be handed on.
  "screenplay" | "storyboard" | "shotlist" | "gallery";

export { CHARACTER_TABS, type CharacterTab } from "./characterLayout.ts";
import type {
  LocationTab, PropTab, SubjectKind,
} from "./subjectKinds.ts";
import type { CharacterTab } from "./characterLayout.ts";

export interface OpenRow {
  entity: string;
  /** null = creating a new row */
  id: number | null;
}

export interface FormDraft {
  entity: string;
  id: number | null;
  values: Record<string, SqlValue>;
  original: Record<string, SqlValue>;
  undoStack: Array<Record<string, SqlValue>>;
}

interface AppState {
  phase: "start" | "loading" | "open" | "error" | "multitab";
  /** True while the live tab is switching to another tab that was
   *  already open. `phase` stays "open" throughout — the workbench
   *  shell (title strip, tabs) never unmounts for this — so Workbench
   *  reads this to show an in-place placeholder instead. */
  switchingTab: boolean;
  errorMessage: string | null;
  projectName: string | null;
  /** The open film's path on the host; null when none is open. */
  projectPath: string | null;
  /** The window's link to the host: starting (retried), ready, or
   *  given up on with a reason. */
  hostStatus: "connecting" | "ready" | "unavailable";
  hostError: string | null;
  /** The connection dropped while a film was open. */
  hostLost: boolean;
  /** The file changed on disk behind the host; writes are refused
   *  until it is reloaded. */
  externalChange: boolean;
  /** The last change another client made to this film (the MCP, say),
   *  so it is attributed rather than appearing from nowhere. */
  externalEdit: { by: string; revision: number } | null;
  dismissExternalEdit: () => void;
  /** The project's asset folder, or null when none is attached. Assets
   *  can only resolve when this is set and `assetRootStatus` is "ok". */
  assetRoot: string | null;
  /** "missing" when `assetRoot` is set but the folder cannot be found
   *  on disk right now (moved, an unmounted network drive, …). */
  assetRootStatus: "unmapped" | "ok" | "missing";
  /** The last `resolveAssets` scan for the live project, kept here so
   *  the menu badge and the Assets nav badge can both ask "is anything
   *  unresolved?" without each running their own scan. Null until the
   *  first scan lands for this project. */
  assetResolution: ResolutionReport | null;
  /** Shown when the current film's path is new to `app.db` but a uuid
   *  or title/base-name match suggests where its assets might be
   *  (file-management-plan.md §3.2 point 3). Null when there is
   *  nothing to offer, or once the dialog has been answered. Never
   *  applied on its own — the whole point of a suggestion. */
  suggestions: ProjectSuggestion[] | null;
  /** Apply a suggestion's asset root to the open film and close the
   *  dialog. */
  chooseSuggestion: (suggestion: ProjectSuggestion) => Promise<void>;
  /** Close the dialog without applying anything; the film stays
   *  unmapped. */
  dismissSuggestions: () => void;
  /** Forget one suggested entry (its ✕) without closing the dialog. */
  forgetSuggestion: (suggestion: ProjectSuggestion) => Promise<void>;
  /** Bumped when the ENVIRONMENT changes rather than the data: a folder
   *  attached. Asset resolution and Q13 depend on it and must re-run;
   *  `revision` cannot carry it, because `revision !== lastSavedRevision`
   *  is what marks the project unsaved and attaching a folder writes
   *  nothing to the film. */
  environmentRevision: number;
  revision: number;
  /** Bumped when Settings' Project history changes app.db's pairings
   *  (forget, change folder) — the start screen's recent-projects list
   *  reads it to refetch, since Settings is the only place that writes
   *  there and the two can be mounted at once. */
  recentProjectsRevision: number;
  bumpRecentProjectsRevision: () => void;

  navMode: NavMode;
  /** Path-prefix filter for the Assets tab. Lives in the store because
   *  the tree (nav rail) and the list (main panel) are now separate
   *  components sharing one selection. */
  assetPrefix: string;
  /** How schema lists order rows where a story order exists. Global and
   * sticky, because a tab switch unmounts the list and losing the choice
   * every time is the same annoyance as the collapsing schema tree. */
  listSort: "story" | "name";
  selectedQuery: string | null;
  selectedEntityType: string | null;
  selectedSubject: { entity: string; id: number; name: string } | null;
  openRow: OpenRow | null;
  /** The character open in the Characters workspace. Lives in the store
   *  so "open record" and back returns to the same character and tab —
   *  the workspace unmounts while a raw record is shown. */
  selectedCharacterId: number | null;
  characterTab: CharacterTab;
  /** The "as of scene" position the workspace shows what is in force
   *  at. Null shows baselines. Kept across characters: comparing who
   *  looks how in one scene is the point of it. */
  asOfSceneId: number | null;
  setAsOfScene: (id: number | null) => void;
  /** The location and prop open in their workspaces, and their tabs. */
  selectedLocationId: number | null;
  locationTab: LocationTab;
  selectedPropId: number | null;
  propTab: PropTab;
  /** One way in for all three kinds, so the shared shell and rail need
   *  not know which kind they are showing. */
  selectSubjectOf: (kind: SubjectKind, id: number | null) => void;
  setTabOf: (kind: SubjectKind, tab: string) => void;
  /** A screenplay line the Script view should open at when it next
   *  loads — how other sections say "show me this line". Consumed once. */
  pendingScriptLine: string | null;
  /** By the line's uuid: line identity survives edits, and the document
   *  does not number its lines the way the table does. */
  openScriptAt: (lineUuid: string) => void;
  takePendingScriptLine: () => string | null;
  /** Open a character's workspace, from anywhere. */
  openCharacter: (id: number) => void;
  /** Open any narrative element's workspace, from anywhere. */
  openSubject: (kind: SubjectKind, id: number) => void;
  selectCharacter: (id: number | null) => void;
  setCharacterTab: (tab: CharacterTab) => void;
  draft: FormDraft | null;

  /** Connect to the host (retrying while it starts). Safe to repeat. */
  connect: () => Promise<void>;
  /** After a dropped connection: connect again and reopen the film. */
  reconnect: () => Promise<void>;
  /** After `externalChange`: read the file again from disk. */
  reloadFromDisk: () => Promise<void>;
  openDemo: () => Promise<void>;
  /** Reopen every tab this window had open before it last quit —
   *  the live one live, the rest backgrounded and watched — unless
   *  the user has turned that off in Settings. */
  resumeTabs: () => Promise<void>;
  closeProject: () => Promise<void>;
  setAssetPrefix: (prefix: string) => void;
  openFromPicker: () => Promise<void>;
  /** Open a path directly — the start screen's recent-projects list,
   *  which already has one. Same path as `openFromPicker`, without
   *  the dialog. */
  openRecentProject: (path: string) => Promise<void>;
  /** Bring an already-open tab to the front: background the current
   *  project (keep its connection, remember where it was, watch it
   *  for outside changes) and open this one on the live connection. */
  switchProjectTab: (path: string) => Promise<void>;
  /** The File menu's "Open Recent": focus the path's tab if it is
   *  already open (live or backgrounded), otherwise open it as a new
   *  one. */
  openOrFocus: (path: string) => Promise<void>;
  /** Close one tab. The live tab falls back to another open tab, or to
   *  the start screen if it was the last one; a backgrounded tab just
   *  stops being watched. */
  closeProjectTab: (path: string) => Promise<void>;
  /** Attach the asset folder to the film that is open. Must run
   *  inside a click: it opens a picker. */
  attachFolder: () => Promise<void>;
  /** Resolve every asset against the current root. Never throws. */
  resolveAssets: () => Promise<ResolutionReport>;
  newProject: () => Promise<void>;
  /** Copy the film to a new path and carry on there: rename or version
   *  up. Every edit is already in the file; there is no Save. */
  saveProjectAs: () => Promise<void>;

  setNavMode: (mode: NavMode) => void;
  selectQuery: (query: string | null) => void;
  selectEntityType: (entity: string | null) => void;
  selectSubject: (
    subject: { entity: string; id: number; name: string } | null) => void;
  /** Which subject type the rail is listing. In the store because the
   * main pane must not keep showing a subject of the previous type. */
  subjectType: NavigableSubject;
  setSubjectType: (subjectType: NavigableSubject) => void;
  openEntityRow: (entity: string, id: number | null) => Promise<void>;
  closeRow: () => void;

  setDraftValue: (field: string, value: SqlValue) => void;
  undoDraft: () => void;
  saveDraft: () => Promise<number | null>;
  setListSort: (listSort: "story" | "name") => void;
  deleteRow: (entity: string, id: number) => Promise<void>;
  /** Collapsed schema categories. In the store, not the component:
   * switching tabs unmounts the tree, and losing the expansion every
   * time is worse than the wall of categories it was hiding. */
  schemaCollapsed: Set<string>;
  setSchemaCollapsed: (next: Set<string>) => void;
  /** Where the Shoot tab was left. Opening a shot's record replaces the
   *  view, and coming back to every scene collapsed at the top lost the
   *  place you were planning from — so the expansion, the filter and the
   *  scroll outlive the component, until the project changes. */
  shootView: ShootMemory;
  setShootView: (patch: Partial<ShootMemory>) => void;
  /** The last delete, restorable until dismissed or superseded. */
  undo: UndoEntry | null;
  /** The last workspace change, if it was more recent than any delete:
   *  one toast, one Undo, whichever kind the last action was. */
  lastChange: ChangeUndo | null;
  recordChange: (change: ChangeUndo) => void;
  undoLastChange: () => Promise<void>;
  undoDelete: () => Promise<void>;
  dismissUndo: () => void;
}

/**
 * One window at a time. Two windows on the same film would each keep
 * their own copy of the script document and each commit it whole, so
 * the later commit would silently overwrite the earlier one. One tab
 * holds a Web Lock for the life of the page; any other tab gets a clear
 * screen instead of two editors that disagree.
 */
function guardSingleTab(): void {
  if (!("locks" in navigator)) return;
  void navigator.locks.request("scf-window", { ifAvailable: true },
    (lock) => {
      if (lock === null) {
        useStore.setState({ phase: "multitab" });
        return Promise.resolve();
      }
      // Hold the lock until this page goes away.
      return new Promise<void>(() => undefined);
    });
}

// Vite HMR: a reload of this module would leave the old store's host
// subscriptions running beside the new one's. A full page reload is the
// only clean handoff.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    window.location.reload();
  });
}

/** The file name of a host path, for the title and the Save As suggestion. */
export const nameOf = (path: string): string =>
  path.split(/[\\/]/).pop() ?? path;

/**
 * Whether two path strings name the same tab, before either has gone
 * through the host's own canonicalisation (`host.open` always returns
 * the same string for the same file, which is what every *open* tab is
 * keyed by — this is only for matching a raw string against that,
 * before opening it: the File menu's Open Recent, or a restored tab at
 * startup). Good enough to recognise "already open" in the common
 * case; not a filesystem-level identity check.
 */
const samePath = (a: string, b: string): boolean =>
  a === b || a.toLowerCase() === b.toLowerCase();

/** Hosts whose events and closing this store already listens to. */
const bound = new WeakSet<HostClient>();

/**
 * Keep the store in step with the host: another client's write (the MCP,
 * say) arrives as a revision and every view re-reads, exactly as for a
 * local edit; a dropped connection is surfaced instead of leaving the
 * window silently dead.
 */
function bindHost(host: HostClient): void {
  if (bound.has(host)) return;
  bound.add(host);
  host.subscribe((event) => {
    useStore.setState((st) => ({
      revision: Math.max(st.revision, event.revision),
      // Our own name is "window"; anything else made this change.
      ...(event.event === "revision" && event.by !== "window"
        ? { externalEdit: { by: event.by, revision: event.revision } }
        : {}),
    }));
  });
  host.onClose(() => {
    if (useStore.getState().phase === "open") {
      useStore.setState({ hostLost: true });
    }
  });
}

function describeError(e: unknown): string {
  return e instanceof DOMException ? `${e.name}: ${e.message}`
    : e instanceof Error ? e.message : String(e);
}

/**
 * Put an asset root into the session: check it is there, wire the
 * locator, and tell the views to re-resolve.
 *
 * Shared by every caller that sets the root (opening a project that has
 * one on file, attaching a new one): whichever way it arrived,
 * everything downstream is identical.
 */
async function applyAssetRoot(
  set: (partial: Partial<AppState>) => void,
  get: () => AppState,
  assetRoot: string,
): Promise<void> {
  // Anything held now describes the PREVIOUS root. Bytes from a project
  // the user has left are worse than a blank thumbnail, because they
  // look like they worked. Drawn thumbnails are keyed by path, mtime
  // and size and are safe to keep — the resolutions that FOUND those
  // paths are not.
  revokeAll();
  clearResolutions();
  setAssetLocator(makeLocator(assetRoot));
  const exists = await invoke<boolean>("fs_exists", { path: assetRoot });
  set({ assetRoot, assetRootStatus: exists ? "ok" : "missing",
        environmentRevision: get().environmentRevision + 1 });
  // The media server's per-project cache limit override lives only in
  // memory (media-server's `Queue::project_caps`) and starts empty
  // every process start — this is what re-seeds it from app.db's own
  // copy, every time a root is (re-)applied, not just once.
  await pushProjectCacheLimitOverride(get().projectPath, assetRoot);
}

export interface ShootMemory {
  /** Expanded rows: `scene:<id>`, and `script:<id>` for a scene whose
   *  text is showing. */
  open: Set<string>;
  showEmpty: boolean;
  /** Hide shots whose lifecycle_status is `cut`. */
  hideCut: boolean;
  scrollTop: number;
}

/**
 * The Shoot tab's two filters are preferences, not film data, so they
 * live in the browser and outlast opening another file. Storage can
 * throw (private windows, blocked site data); the defaults then apply.
 */
const SHOOT_PREFS = {
  showEmpty: "scf:shoot-show-empty", hideCut: "scf:shoot-hide-cut",
} as const;

function readShootPref(key: keyof typeof SHOOT_PREFS,
                       fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(SHOOT_PREFS[key]);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

function writeShootPrefs(patch: Partial<ShootMemory>): void {
  try {
    for (const key of ["showEmpty", "hideCut"] as const) {
      const v = patch[key];
      if (v !== undefined) localStorage.setItem(SHOOT_PREFS[key], v ? "1" : "0");
    }
  } catch {
    // Not remembered this time; the view still changes.
  }
}

const freshShootView = (): ShootMemory =>
  ({ open: new Set(), showEmpty: readShootPref("showEmpty", true),
     hideCut: readShootPref("hideCut", false), scrollTop: 0 });

/** The fields a tab switch would otherwise unmount and lose, captured
 *  so switching back restores them (projectTabs.ts) — including an open
 *  record and any unsaved edits in it: a switch backgrounds a tab, it
 *  does not discard what you were doing in it. */
function snapshotMemory(get: () => AppState): ProjectMemory {
  const s = get();
  return {
    navMode: s.navMode, assetPrefix: s.assetPrefix, listSort: s.listSort,
    subjectType: s.subjectType, selectedQuery: s.selectedQuery,
    selectedEntityType: s.selectedEntityType,
    selectedSubject: s.selectedSubject,
    selectedCharacterId: s.selectedCharacterId, characterTab: s.characterTab,
    asOfSceneId: s.asOfSceneId, selectedLocationId: s.selectedLocationId,
    locationTab: s.locationTab, selectedPropId: s.selectedPropId,
    propTab: s.propTab, schemaCollapsed: s.schemaCollapsed,
    shootView: s.shootView, openRow: s.openRow, draft: s.draft,
    assetRoot: s.assetRoot, assetRootStatus: s.assetRootStatus,
  };
}

/**
 * Before the live connection leaves for another path: if the project it
 * is leaving is still an open tab (not one being closed outright),
 * remember where it was and start watching it for outside changes
 * while it is not the live one.
 */
async function backgroundCurrentProject(get: () => AppState): Promise<void> {
  const { phase, projectPath } = get();
  if (phase !== "open" || projectPath === null) return;
  if (!useProjectTabs.getState().tabs.some((t) => t.path === projectPath)) {
    return; // being closed, not backgrounded — nothing to remember
  }
  useProjectTabs.getState().setMemory(projectPath, snapshotMemory(get));
  void watchProject(projectPath);
}

/** Back to the start screen with nothing open: `closeProjectTab`'s path
 *  when the tab it closes was the last one. */
async function closeToStart(
  set: (partial: Partial<AppState>) => void,
): Promise<void> {
  revokeAll();
  clearResolutions();
  setAssetLocator(null);
  set({ phase: "start", projectPath: null, projectName: null,
        errorMessage: null, hostLost: false, externalChange: false,
        navMode: "intro", selectedCharacterId: null, characterTab: "Profile",
        shootView: freshShootView(),
        asOfSceneId: null, selectedLocationId: null, locationTab: "Profile",
        selectedPropId: null, propTab: "Profile",
        assetPrefix: "", openRow: null, draft: null,
        selectedSubject: null, assetRoot: null,
        assetRootStatus: "unmapped", assetResolution: null,
        suggestions: null });
  try {
    await (await getHost()).closeFilm();
  } catch {
    // The host is gone or never had it; either way it is closed.
  }
}

/**
 * The tail every open shares: land on the script, with nothing of the
 * previous project left behind, and resolve the asset root
 * (file-management-plan.md §3.2): a path `app.db` already has an
 * asset root for attaches silently; one with no asset root yet —
 * whether brand new or just never attached — offers a suggestion when
 * the film's own uuid, title or file name matches another row's.
 * Either way, the film's identity is kept current in `app.db` for
 * next time.
 */
async function finishOpen(
  set: (partial: Partial<AppState>) => void,
  get: () => AppState,
  path: string, revision: number,
): Promise<void> {
  // Only a tab that has actually been live before, with its asset root
  // really resolved, is safe to restore on the fast path below — a
  // mere placeholder (upserted at startup, or after a failed open, but
  // never yet opened) has nothing but INTRO_MEMORY to offer, and
  // trusting that would skip resolving its asset root at all.
  const existingTab = useProjectTabs.getState().tabs.find(
    (t) => t.path === path);
  const memory = existingTab?.resolved === true
    ? existingTab.memory : undefined;

  // Clear the root EXPLICITLY for a path new to this session. Opening
  // a film while another is live otherwise leaves `assetRoot`
  // untouched, and the new project inherits the old one's folder —
  // addressing every asset against another film's disk. Nothing
  // reports it, because a stale root resolves perfectly well.
  //
  // A path already open this session instead carries its OWN root
  // forward from `memory`, applied right here rather than reset to
  // null and re-resolved from `app.db` a moment later (the bookkeeping
  // below) — THAT round trip is what made "no folder" flash on every
  // switch between two already-open tabs, however briefly.
  revokeAll();
  clearResolutions();
  setAssetLocator(memory?.assetRoot == null
    ? null : makeLocator(memory.assetRoot));
  set({ schemaCollapsed: COLLAPSE_ALL, navMode: "intro",
        shootView: freshShootView(),
        selectedCharacterId: null, asOfSceneId: null,
        selectedLocationId: null, selectedPropId: null,
        openRow: null, draft: null, undo: null, lastChange: null,
        phase: "open", projectName: nameOf(path), projectPath: path,
        revision, hostLost: false,
        externalChange: false, errorMessage: null,
        externalEdit: null, suggestions: null,
        assetRoot: memory?.assetRoot ?? null,
        assetRootStatus: memory?.assetRootStatus ?? "unmapped",
        assetResolution: null,
        environmentRevision: get().environmentRevision + 1 });

  // This path is becoming the live tab: it needs no background watch
  // (the main connection now reports its revision directly).
  void unwatchProject(path);
  useProjectTabs.getState().upsert(path, nameOf(path));
  useProjectTabs.getState().setProblem(path, null);
  if (memory !== undefined) {
    // Restore where it was left — the asset root above included, so
    // this is the rest: section, selection, any open draft.
    set(memory);
    return;
  }

  // Bookkeeping must never cost the user their session: a film that
  // opened is open regardless of whether app.db can be read right now.
  try {
    const [rows, store] = await Promise.all([
      exec("SELECT uuid, name FROM project LIMIT 1"), windowAppStore(),
    ]);
    const uuidRaw = rows[0]?.["uuid"];
    const nameRaw = rows[0]?.["name"];
    const uuid = typeof uuidRaw === "string" ? uuidRaw : null;
    const title = typeof nameRaw === "string" ? nameRaw : null;
    const baseName = baseNameOf(nameOf(path));

    const existing = await store.getProject(path);
    let resolvedRoot = existing?.assetRoot ?? null;
    if (resolvedRoot !== null) {
      await applyAssetRoot(set, get, resolvedRoot);
    } else {
      // Unmapped, whether this path is brand new or was opened before
      // and dismissed: either way there is no asset root yet.
      const suggestions = await store.suggestionsFor(
        { uuid, title, baseName }, path);
      // When the UUID is a match and the current root is null, auto-assign
      // the other root folder (most recently opened if several exist).
      const uuidMatch = suggestions.find(
        (s) => s.strength === "uuid" && s.assetRoot !== null);
      if (uuidMatch?.assetRoot != null) {
        resolvedRoot = uuidMatch.assetRoot;
        await applyAssetRoot(set, get, resolvedRoot);
      } else if (suggestions.length > 0) {
        set({ suggestions });
      }
    }
    await store.touchProject(path, {
      uuid, title, baseName,
      ...(resolvedRoot !== null ? { assetRoot: resolvedRoot } : {}),
    });
    // Only now: a switch back to this tab can trust its memory instead
    // of running all of the above again.
    useProjectTabs.getState().setResolved(path, true);
  } catch (e) {
    console.warn("[finishOpen] could not resolve the asset root:", e);
  }
}

/** Open an already-known path: the chooser's result, or a row from
 *  the start screen's recent-projects list or the File menu's Open
 *  Recent. */
async function openPath(
  set: (partial: Partial<AppState>) => void,
  get: () => AppState,
  path: string,
): Promise<void> {
  // A tab already live, switching to another one that is also already
  // open (or was), keeps `phase` at "open" throughout — the workbench
  // shell never unmounts for this, `switchingTab` stands in for
  // `phase: "loading"` instead (Workbench.tsx) — there is no reason to
  // flash the start screen between two tabs that both already have a
  // place to land. A first open, with nothing live yet, still has
  // nowhere else to show "opening" but there.
  const alreadyOpen = get().phase === "open";
  // Noted before backgrounding changes it: if this open fails, falling
  // back to what was live is better than losing the whole workbench
  // over one tab whose file turned out to be gone.
  const fallback = alreadyOpen ? get().projectPath : null;
  await backgroundCurrentProject(get);
  set(alreadyOpen ? { switchingTab: true, errorMessage: null }
                  : { phase: "loading", errorMessage: null });
  try {
    const host = await getHost();
    bindHost(host);
    const opened = await host.open(path, {
      migrate: true, editorVersion: EDITOR_VERSION });
    await finishOpen(set, get, opened.path, opened.revision);
    set({ switchingTab: false });
  } catch (e) {
    useProjectTabs.getState().upsert(path, nameOf(path));
    useProjectTabs.getState().setProblem(path, UNREACHABLE);
    if (fallback !== null && fallback !== path) {
      await openPath(set, get, fallback);
    } else {
      set({ phase: "error", errorMessage: describeError(e),
            switchingTab: false });
    }
  }
}

export const useStore = create<AppState>((set, get) => ({
  phase: "start",
  switchingTab: false,
  schemaCollapsed: new Set<string>(),
  shootView: freshShootView(),
  subjectType: "character",
  undo: null,
  lastChange: null,
  errorMessage: null,
  projectName: null,
  projectPath: null,
  hostStatus: "connecting",
  hostError: null,
  hostLost: false,
  externalChange: false,
  externalEdit: null,
  dismissExternalEdit: () => useStore.setState({ externalEdit: null }),
  assetRoot: null,
  assetRootStatus: "unmapped",
  assetResolution: null,
  suggestions: null,
  environmentRevision: 0,
  recentProjectsRevision: 0,
  bumpRecentProjectsRevision: () => set((s) => ({
    recentProjectsRevision: s.recentProjectsRevision + 1 })),
  revision: 0,

  // The script is what a project is FOR: opening anywhere else means a
  // click before you can write. Every open path sets this too, so
  // closing one project and opening another lands on the script again.
  navMode: "intro", selectedCharacterId: null, characterTab: "Profile",
  asOfSceneId: null, selectedLocationId: null, locationTab: "Profile",
  selectedPropId: null, propTab: "Profile",
  assetPrefix: "",
  listSort: "story",
  selectedQuery: null,
  selectedEntityType: null,
  selectedSubject: null,
  openRow: null,
  draft: null,

  connect: async () => {
    set({ hostStatus: "connecting", hostError: null });
    try {
      bindHost(await getHost({
        retry: {
          // The host starts with the dev server but not before it; say
          // so rather than showing nothing for the first seconds.
          onWait: (attempt) => {
            if (attempt >= 3) {
              set({ hostError: "Still waiting for the SCF host to start…" });
            }
          },
        },
      }));
      set({ hostStatus: "ready", hostError: null });
    } catch (e) {
      set({ hostStatus: "unavailable", hostError: describeError(e) });
    }
  },

  reconnect: async () => {
    const path = get().projectPath;
    try {
      const host = await getHost();
      bindHost(host);
      if (path !== null) {
        const opened = await host.open(path, { migrate: false });
        set({ hostLost: false, externalChange: false,
              hostStatus: "ready", hostError: null,
              revision: Math.max(get().revision, opened.revision),
              environmentRevision: get().environmentRevision + 1 });
      }
    } catch (e) {
      set({ errorMessage: `Could not reconnect: ${describeError(e)}` });
    }
  },

  reloadFromDisk: async () => {
    try {
      const host = await getHost();
      const revision = await host.reload();
      set({ externalChange: false,
            revision: Math.max(get().revision, revision),
            environmentRevision: get().environmentRevision + 1 });
    } catch (e) {
      set({ errorMessage: `Could not reload: ${describeError(e)}` });
    }
  },

  openDemo: async () => {
    // Asked first: the demo has to live somewhere, and every edit is
    // written straight to its file.
    const path = await chooser.chooseNew("Hollow Creek (demo).scf");
    if (path === null) return;
    await backgroundCurrentProject(get);
    set({ phase: "loading", errorMessage: null });
    try {
      const res = await fetch("/hollow_creek.scf");
      if (!res.ok) throw new Error(`demo fetch failed: ${String(res.status)}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const host = await getHost();
      bindHost(host);
      const made = await host.create(path, { bytes });
      // Migrated through the open path below, which stamps the editor.
      const opened = await host.open(made.path, {
        migrate: true, editorVersion: EDITOR_VERSION });
      const check = await host.exec(
        "SELECT (SELECT COUNT(*) FROM character) + " +
        "(SELECT COUNT(*) FROM scene) AS n");
      if ((check[0]?.["n"] as number ?? 0) === 0) {
        throw new Error("the demo was copied but contains no data");
      }
      await finishOpen(set, get, opened.path, opened.revision);
    } catch (e) {
      set({ phase: "error", errorMessage: describeError(e) });
    }
  },

  resumeTabs: async () => {
    if (!useSettings.getState().rememberTabs) return;
    const stored = await (await windowAppStore())
      .getPref(OPEN_TABS_PREF).catch(() => null);
    if (stored === null || stored === "") return;
    let data: { tabs?: { path: string; title: string }[];
                activePath?: string | null };
    try {
      data = JSON.parse(stored) as typeof data;
    } catch {
      return; // not worth failing the launch over a corrupt pref
    }
    const remembered = data.tabs ?? [];
    if (remembered.length === 0) return;

    // Try the path that was active last, then the rest in their saved
    // order, until one actually opens live; every path still gets its
    // tab back regardless, backgrounded and watched (which marks its
    // own `problem` if IT cannot be reopened either).
    const ordered = [...remembered];
    const activeAt = ordered.findIndex((t) => t.path === data.activePath);
    if (activeAt > 0) ordered.unshift(...ordered.splice(activeAt, 1));

    set({ phase: "loading", errorMessage: null });
    let liveOpened = false;
    for (const t of ordered) {
      if (liveOpened) {
        useProjectTabs.getState().upsert(t.path, t.title);
        void watchProject(t.path);
        continue;
      }
      try {
        const host = await getHost();
        bindHost(host);
        const opened = await host.open(t.path, {
          migrate: true, editorVersion: EDITOR_VERSION });
        await finishOpen(set, get, opened.path, opened.revision);
        liveOpened = true;
      } catch {
        useProjectTabs.getState().upsert(t.path, t.title);
        useProjectTabs.getState().setProblem(t.path, UNREACHABLE);
      }
    }
    if (!liveOpened) {
      const first = ordered[0];
      set({ phase: "start",
            errorMessage: ordered.length === 1 && first !== undefined
              ? `Could not reopen ${nameOf(first.path)}: it may have ` +
                "moved or been deleted."
              : "None of the files open last time could be reopened — " +
                "they may have moved or been deleted." });
    }
  },

  openFromPicker: async () => {
    const path = await chooser.chooseExisting();
    if (path === null) return;                           // user cancelled
    await openPath(set, get, path);
  },

  openRecentProject: (path) => openPath(set, get, path),

  /**
   * The folder, asked for after the file — the other half of file-first
   * opening, and the only route to assets for a session that started
   * from a plain `.scf`. Any folder the user picks is accepted; what it
   * actually resolves is `resolveAssets`'s business, shown after
   * attaching rather than gated here.
   */
  attachFolder: async () => {
    const { projectPath } = get();
    // "Choose a different folder…" reaches this from the suggestion
    // dialog too; either way, calling this answers the question the
    // dialog was asking.
    set({ suggestions: null });
    try {
      const path = await chooseAssetFolder();
      if (path === null) return;                          // user cancelled
      if (projectPath !== null) {
        await (await windowAppStore()).setAssetRoot(projectPath, path);
      }
      await applyAssetRoot(set, get, path);
    } catch (e) {
      // A failed attach must not cost the user their session: this is
      // an addition to an open project, not an open. Reported inline
      // rather than through `phase: "error"`, which unmounts the
      // workbench.
      set({ errorMessage: `Could not attach the asset folder: ${
        describeError(e)}` });
    }
  },

  chooseSuggestion: async (suggestion) => {
    const { projectPath } = get();
    if (projectPath === null || suggestion.assetRoot === null) return;
    set({ suggestions: null });
    try {
      await (await windowAppStore())
        .setAssetRoot(projectPath, suggestion.assetRoot);
      await applyAssetRoot(set, get, suggestion.assetRoot);
    } catch (e) {
      set({ errorMessage: `Could not attach the asset folder: ${
        describeError(e)}` });
    }
  },

  dismissSuggestions: () => set({ suggestions: null }),

  forgetSuggestion: async (suggestion) => {
    try {
      await (await windowAppStore()).forgetProject(suggestion.scfPath);
    } catch (e) {
      set({ errorMessage: `Could not forget that entry: ${
        describeError(e)}` });
      return;
    }
    set((s) => ({
      suggestions: s.suggestions === null ? null
        : s.suggestions.filter((row) => row.pathKey !== suggestion.pathKey),
    }));
  },

  setAssetPrefix: (assetPrefix) => set({ assetPrefix }),

  resolveAssets: async () => {
    const { assetRoot } = get();
    // Keep the query layer's locator in step with the session: Q13
    // reports what resolves, and a stale root would make it lie.
    setAssetLocator(assetRoot === null ? null : makeLocator(assetRoot));
    const report = await resolveAllAssets(exec, makeLocator(assetRoot));
    // Cached for the menu and Assets-nav badges, which read this rather
    // than each running their own scan.
    set({ assetResolution: report });
    return report;
  },

  newProject: async () => {
    // Asked first, while the current screen is still up: the film is a
    // file from its first moment, and every edit is written to it.
    const path = await chooser.chooseNew("Untitled.scf");
    if (path === null) return;
    await backgroundCurrentProject(get);
    // "loading" first, and awaited into the next task, so mounted views
    // unmount before the host switches films. A view whose query lands
    // between the two films would read the wrong one.
    set({ phase: "loading", errorMessage: null, openRow: null,
          draft: null, selectedSubject: null });
    await new Promise((r) => setTimeout(r, 0));
    try {
      const host = await getHost();
      bindHost(host);
      const made = await host.create(path, { editorVersion: EDITOR_VERSION });
      await finishOpen(set, get, made.path, made.revision);
    } catch (e) {
      set({ phase: "error", errorMessage: describeError(e) });
    }
  },

  /** Close the live tab. */
  closeProject: async () => {
    const { projectPath } = get();
    if (projectPath !== null) await get().closeProjectTab(projectPath);
  },

  switchProjectTab: (path) =>
    path === get().projectPath ? Promise.resolve() : openPath(set, get, path),

  openOrFocus: async (path) => {
    const already = useProjectTabs.getState().tabs.find(
      (t) => samePath(t.path, path));
    await (already === undefined
      ? openPath(set, get, path) : get().switchProjectTab(already.path));
  },

  closeProjectTab: async (path) => {
    const { projectPath } = get();
    if (path !== projectPath) {
      // A backgrounded tab: nothing live to close, just stop watching it.
      await unwatchProject(path);
      useProjectTabs.getState().remove(path);
      return;
    }
    // The live tab. Drop it from the list FIRST, so backgrounding (which
    // checks the list) does not try to keep it around for a path that is
    // on its way out.
    useProjectTabs.getState().remove(path);
    const next = useProjectTabs.getState().tabs[0];
    if (next !== undefined) {
      // Opening the next tab on the same connection leaves this film —
      // the host closes it once nothing else has it open (core.ts).
      await openPath(set, get, next.path);
    } else {
      await closeToStart(set);
    }
  },

  /**
   * Save As — the project follows the new file, so this is how you
   * version up (hollow_creek_v2.scf) or rename without leaving the
   * editor. The old file is left exactly as it was; there is nothing to
   * save first, because every edit is already in it.
   *
   * The new path's row in `app.db` carries the same uuid, title and
   * asset root as the old one (file-management-plan.md §3.2) — read
   * fresh from the film rather than copied from the old row, since
   * nothing here guarantees that row still exists.
   */
  saveProjectAs: async () => {
    const { projectPath, projectName, assetRoot } = get();
    const path = await chooser.chooseNew(
      suggestSaveAsName(projectName, true));
    if (path === null) return;
    try {
      const host = await getHost();
      const copied = await host.saveAs(path);
      if (projectPath !== null) {
        useProjectTabs.getState().rename(
          projectPath, copied.path, nameOf(copied.path));
      }
      set({ projectPath: copied.path, projectName: nameOf(copied.path),
            revision: Math.max(get().revision, copied.revision) });
      try {
        const rows = await exec("SELECT uuid, name FROM project LIMIT 1");
        const uuidRaw = rows[0]?.["uuid"];
        const nameRaw = rows[0]?.["name"];
        await (await windowAppStore()).touchProject(copied.path, {
          uuid: typeof uuidRaw === "string" ? uuidRaw : null,
          title: typeof nameRaw === "string" ? nameRaw : null,
          baseName: baseNameOf(nameOf(copied.path)),
          assetRoot,
        });
      } catch (e) {
        console.warn("[saveProjectAs] could not persist app.db identity:", e);
      }
    } catch (e) {
      set({ errorMessage: `Save As failed: ${describeError(e)}` });
    }
  },

  // A tab is a destination: arriving at one closes whatever record was
  // covering it, rather than showing the tab's rail beside someone
  // else's form.
  setListSort: (listSort) => set({ listSort }),
  setNavMode: (navMode) => set({ navMode, openRow: null, draft: null }),
  selectCharacter: (selectedCharacterId) =>
    set({ selectedCharacterId, openRow: null, draft: null }),
  setCharacterTab: (characterTab) => set({ characterTab }),
  setAsOfScene: (asOfSceneId) => set({ asOfSceneId }),
  selectSubjectOf: (kind, id) => set({
    ...(kind === "character" ? { selectedCharacterId: id }
      : kind === "location" ? { selectedLocationId: id }
      : { selectedPropId: id }),
    openRow: null, draft: null,
  }),
  setTabOf: (kind, tab) => set(
    kind === "character" ? { characterTab: tab as CharacterTab }
      : kind === "location" ? { locationTab: tab as LocationTab }
      : { propTab: tab as PropTab }),
  pendingScriptLine: null,
  openScriptAt: (pendingScriptLine) =>
    set({ pendingScriptLine, navMode: "script", openRow: null, draft: null }),
  takePendingScriptLine: () => {
    const line = get().pendingScriptLine;
    if (line !== null) set({ pendingScriptLine: null });
    return line;
  },
  openSubject: (kind, id) => set({
    ...(kind === "character" ? { selectedCharacterId: id, navMode: "characters" }
      : kind === "location" ? { selectedLocationId: id, navMode: "locations" }
      : { selectedPropId: id, navMode: "props" }),
    openRow: null, draft: null,
  }),
  openCharacter: (selectedCharacterId) =>
    set({ selectedCharacterId, navMode: "characters", openRow: null,
          draft: null }),
  setSchemaCollapsed: (schemaCollapsed) => set({ schemaCollapsed }),
  setShootView: (patch) => {
    writeShootPrefs(patch);
    set((s) => ({ shootView: { ...s.shootView, ...patch } }));
  },
  selectQuery: (selectedQuery) =>
    set({ selectedQuery, openRow: null, draft: null }),
  selectEntityType: (selectedEntityType) =>
    set({ selectedEntityType, openRow: null, draft: null }),
  setSubjectType: (subjectType) =>
    set({ subjectType, selectedSubject: null, openRow: null, draft: null }),
  selectSubject: (selectedSubject) =>
    set({ selectedSubject, openRow: null, draft: null }),

  openEntityRow: async (entity, id) => {
    const edef = registry.entities.get(entity);
    if (edef === undefined) return;
    let values: Record<string, SqlValue> = {};
    if (id !== null) {
      const rows = await exec(
        `SELECT * FROM ${q(entity)} WHERE id = ?`, [id]);
      values = { ...(rows[0] ?? {}) };
    } else {
      for (const f of edef.fields) {
        values[f.name] = (f.default as SqlValue | undefined) ?? null;
      }
    }
    set({
      openRow: { entity, id },
      draft: { entity, id, values, original: { ...values },
               undoStack: [] },
    });
  },

  closeRow: () => set({ openRow: null, draft: null }),

  setDraftValue: (field, value) => {
    const draft = get().draft;
    if (draft === null) return;
    set({
      draft: {
        ...draft,
        undoStack: [...draft.undoStack.slice(-49), { ...draft.values }],
        values: { ...draft.values, [field]: value },
      },
    });
  },

  undoDraft: () => {
    const draft = get().draft;
    if (draft === null || draft.undoStack.length === 0) return;
    const previous = draft.undoStack[draft.undoStack.length - 1];
    if (previous === undefined) return;
    set({
      draft: {
        ...draft,
        values: previous,
        undoStack: draft.undoStack.slice(0, -1),
      },
    });
  },

  saveDraft: async () => {
   try {
    const draft = get().draft;
    if (draft === null) return null;
    const edef = registry.entities.get(draft.entity);
    if (edef === undefined) return null;
    if (draft.id === null) {
      const newId = await call("record.create", draft.entity, draft.values);
      await get().openEntityRow(draft.entity, newId);
      return newId;
    }

    await call("record.update", draft.entity, draft.id, draft.values);
    await get().openEntityRow(draft.entity, draft.id);
    return draft.id;
   } catch (e) {
    set({ errorMessage: `Save failed: ${
      e instanceof Error ? e.message : String(e)}` });
    return null;
   }
  },

  deleteRow: async (entity, id) => {
    let undo: UndoEntry | null = null;
    try {
      undo = await call("record.delete", entity, id);
    } catch (e) {
      set({ errorMessage: `Delete failed: ${
        e instanceof Error ? e.message : String(e)}` });
      return;
    }
    const { openRow } = get();
    set({
      undo,
      lastChange: null,
      ...(openRow?.entity === entity && openRow.id === id
        ? { openRow: null, draft: null } : {}),
    });
  },

  undoDelete: async () => {
    const undo = get().undo;
    if (undo === null) return;
    try {
      await call("undo.delete", undo);
      set({ undo: null });
    } catch (e) {
      set({ errorMessage: `Undo failed: ${
        e instanceof Error ? e.message : String(e)}` });
    }
  },

  dismissUndo: () => set({ undo: null, lastChange: null }),

  recordChange: (change) => {
    const empty = change.created.length === 0 && change.before.length === 0;
    set(empty ? {} : { lastChange: change, undo: null });
  },

  undoLastChange: async () => {
    const change = get().lastChange;
    if (change === null) return;
    try {
      await call("undo.change", change);
      set({ lastChange: null });
    } catch (e) {
      set({ errorMessage: `Undo failed: ${
        e instanceof Error ? e.message : String(e)}` });
    }
  },
}));

/**
 * Display name for a row. Scene rows lead with their number — headings
 * repeat across an imported script, numbers do not. Link rows have no
 * name of their own; those callers use `linkLabel` with resolved
 * references instead (see displayName.ts).
 */
export function rowName(entity: string, row: Row): string {
  return rowLabel(registry.entities.get(entity), entity, row);
}

/**
 * Open a row in the entity form by its uuid. Query results reference
 * rows by uuid, never by row id (§12.1.2), so a link in a query view
 * starts from one.
 */
export async function openEntityByUuid(
    entity: string, uuid: string | null): Promise<void> {
  if (uuid === null || !registry.entities.has(entity)) return;
  const found = await exec(
    `SELECT id FROM ${q(entity)} WHERE uuid = ?`, [uuid]);
  const id = found[0]?.["id"];
  if (id !== undefined && id !== null) {
    await useStore.getState().openEntityRow(entity, Number(id));
  }
}

export function isDirty(draft: FormDraft | null): boolean {
  if (draft === null) return false;
  return Object.keys(draft.values).some(
    (k) => (draft.values[k] ?? null) !== (draft.original[k] ?? null));
}

/** What `resumeTabs` reads back (kept in sync with it by inspection,
 *  not a shared type, since the two run in different modules' scope
 *  and the shape is tiny). */
function serializeTabs(): string {
  return JSON.stringify({
    tabs: useProjectTabs.getState().tabs.map(
      (t) => ({ path: t.path, title: t.title })),
    activePath: useStore.getState().projectPath,
  });
}

let persistedTabs: string | null = null;
let persisting = Promise.resolve();

/** Save the open-tabs list to `app.db` whenever it (or the live path)
 *  actually changes — skipped entirely when the user has turned
 *  "remember open tabs" off, and de-duplicated against the last write
 *  so a background tab's dot flipping does not trigger one. */
function persistTabs(): void {
  if (!useSettings.getState().rememberTabs) return;
  const snapshot = serializeTabs();
  if (snapshot === persistedTabs) return;
  persistedTabs = snapshot;
  persisting = persisting.then(async () => {
    try {
      await (await windowAppStore()).setPref(OPEN_TABS_PREF, snapshot);
    } catch (e) {
      console.warn("[persistTabs] could not save the open tabs:", e);
    }
  });
}

useProjectTabs.subscribe(persistTabs);
useStore.subscribe((s, prev) => {
  if (s.projectPath !== prev.projectPath) persistTabs();
});

/** Tests only: wait for every `persistTabs` write queued so far to land
 *  in `app.db` before simulating a restart. */
export async function flushTabPersistence(): Promise<void> {
  await persisting;
}

guardSingleTab();
