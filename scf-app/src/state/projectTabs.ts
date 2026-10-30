// SPDX-License-Identifier: Apache-2.0
/**
 * projectTabs.ts — more than one open `.scf` at a time.
 *
 * The window still has exactly one live project (one store, one host
 * connection: `store.ts`); this is the list of OTHER files the user has
 * open, remembered rather than loaded. Switching a tab to the front
 * closes the live project's connection (or backgrounds it) and opens
 * the target path on the same connection, so nothing here duplicates
 * `store.ts`'s state — it only remembers enough to land back where a
 * tab was left, and whether something changed in it while it was not
 * the live one (projectWatch.ts).
 */

import { create } from "zustand";
import type { CharacterTab } from "./characterLayout.ts";
import type { LocationTab, PropTab } from "./subjectKinds.ts";
import type { NavigableSubject } from "./registryGraph.ts";
import type { FormDraft, NavMode, OpenRow, ShootMemory } from "./store.ts";

/** The subset of `AppState` worth restoring when a tab comes back to
 *  the front: everything a tab switch would otherwise unmount and
 *  lose, the same fields a within-project tab switch already keeps
 *  (see the comments on `schemaCollapsed` and `shootView` in store.ts)
 *  — including an open record and any edits in it, not yet saved.
 *  Backgrounding a tab must not be how that gets discarded. */
export interface ProjectMemory {
  navMode: NavMode;
  assetPrefix: string;
  listSort: "story" | "name";
  subjectType: NavigableSubject;
  selectedQuery: string | null;
  selectedEntityType: string | null;
  selectedSubject: { entity: string; id: number; name: string } | null;
  selectedCharacterId: number | null;
  characterTab: CharacterTab;
  asOfSceneId: number | null;
  selectedLocationId: number | null;
  locationTab: LocationTab;
  selectedPropId: number | null;
  propTab: PropTab;
  schemaCollapsed: Set<string>;
  shootView: ShootMemory;
  openRow: OpenRow | null;
  draft: FormDraft | null;
  /** The asset root this tab resolved last time it was live, so
   *  switching back to it never has to forget this and re-resolve it
   *  from `app.db` — that round trip is what made "no folder" flash on
   *  every switch, however briefly (store.ts `finishOpen`). */
  assetRoot: string | null;
  assetRootStatus: "unmapped" | "ok" | "missing";
}

/** A path new to this session: land where any first open does. */
export const INTRO_MEMORY: ProjectMemory = {
  navMode: "intro", assetPrefix: "", listSort: "story",
  subjectType: "character", selectedQuery: null, selectedEntityType: null,
  selectedSubject: null, selectedCharacterId: null, characterTab: "Profile",
  asOfSceneId: null, selectedLocationId: null, locationTab: "Profile",
  selectedPropId: null, propTab: "Profile",
  schemaCollapsed: new Set(), shootView: {
    open: new Set(), showEmpty: true, hideCut: false, scrollTop: 0,
  },
  openRow: null, draft: null, assetRoot: null, assetRootStatus: "unmapped",
};

export interface ProjectTab {
  /** The host's canonical path for this film — the tab's identity. */
  path: string;
  title: string;
  memory: ProjectMemory;
  /** Set by projectWatch.ts when the file changes while this tab is
   *  not the live one. Cleared when the tab becomes live again. */
  externalDot: { by: string } | null;
  /** Why this tab could not be (re)connected — e.g. restored after a
   *  restart but its file has since moved or been deleted. The tab
   *  still shows and can still be closed; clicking it tries again.
   *  Null when the tab is fine. */
  problem: string | null;
  /** True once this path has actually been opened live and had its
   *  asset root resolved against `app.db` this session — as opposed to
   *  merely being a placeholder entry (just restored at startup and
   *  never yet visited, or added after a failed open). Only a
   *  `resolved` tab's `memory` is trustworthy enough to restore from
   *  on the fast path instead of resolving from `app.db` again
   *  (store.ts `finishOpen`); otherwise its `memory` is still just
   *  `INTRO_MEMORY`, not a real asset root. */
  resolved: boolean;
}

interface ProjectTabsState {
  /** Open tabs, in the order they were opened (or restored). */
  tabs: ProjectTab[];
  /** Add a tab for `path` if it is new, or just rename an existing one
   *  (a film's display name can change under it — Save As, a project
   *  row edit). Never touches an existing tab's memory or dot. */
  upsert: (path: string, title: string) => void;
  /** Drop a tab. Does not touch the host connection — the caller
   *  (store.ts) closes or backgrounds it first. */
  remove: (path: string) => void;
  /** Replace a tab's path and title in place (Save As): one tab, new
   *  identity, same memory. */
  rename: (oldPath: string, newPath: string, title: string) => void;
  setMemory: (path: string, memory: ProjectMemory) => void;
  memoryOf: (path: string) => ProjectMemory | undefined;
  setExternalDot: (path: string, dot: { by: string } | null) => void;
  setProblem: (path: string, problem: string | null) => void;
  setResolved: (path: string, resolved: boolean) => void;
  /** Move the tab at `fromIndex` to sit at `toIndex` (drag-reorder). */
  move: (fromIndex: number, toIndex: number) => void;
}

export const useProjectTabs = create<ProjectTabsState>((set, get) => ({
  tabs: [],

  upsert: (path, title) => set((s) => (
    s.tabs.some((t) => t.path === path)
      ? { tabs: s.tabs.map((t) => t.path === path ? { ...t, title } : t) }
      : { tabs: [...s.tabs, {
            path, title, memory: INTRO_MEMORY, externalDot: null,
            problem: null, resolved: false,
          }] }
  )),

  remove: (path) => set((s) => ({
    tabs: s.tabs.filter((t) => t.path !== path),
  })),

  rename: (oldPath, newPath, title) => set((s) => ({
    tabs: s.tabs.map((t) => t.path === oldPath
      ? { ...t, path: newPath, title } : t),
  })),

  setMemory: (path, memory) => set((s) => ({
    tabs: s.tabs.map((t) => t.path === path ? { ...t, memory } : t),
  })),

  memoryOf: (path) => get().tabs.find((t) => t.path === path)?.memory,

  setExternalDot: (path, externalDot) => set((s) => ({
    tabs: s.tabs.map((t) => t.path === path ? { ...t, externalDot } : t),
  })),

  setProblem: (path, problem) => set((s) => ({
    tabs: s.tabs.map((t) => t.path === path ? { ...t, problem } : t),
  })),

  setResolved: (path, resolved) => set((s) => ({
    tabs: s.tabs.map((t) => t.path === path ? { ...t, resolved } : t),
  })),

  move: (fromIndex, toIndex) => set((s) => {
    if (fromIndex === toIndex || fromIndex < 0 || fromIndex >= s.tabs.length ||
        toIndex < 0 || toIndex >= s.tabs.length) {
      return {};
    }
    const tabs = [...s.tabs];
    const [moved] = tabs.splice(fromIndex, 1);
    if (moved === undefined) return {};
    tabs.splice(toIndex, 0, moved);
    return { tabs };
  }),
}));
