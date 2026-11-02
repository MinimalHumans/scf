// SPDX-License-Identifier: Apache-2.0
/**
 * tabs.ts — the title strip's tab state (docs/ui-rework-tabs.md §2).
 *
 * One project tab (for now) and the tool tabs, which belong to the app
 * rather than to a project: each is a singleton, so opening one that is
 * already open focuses it.
 */

import { create } from "zustand";

export type ToolId = "events" | "settings" | "media";

export const TOOL_TITLES: Record<ToolId, string> = {
  events: "Event log",
  settings: "Settings",
  media: "Media",
};

interface TabsState {
  /** Open tool tabs, in the order they were opened. */
  tools: ToolId[];
  /** The tab in front: the project (or the start screen), or a tool. */
  active: "project" | ToolId;
  openTool: (id: ToolId) => void;
  closeTool: (id: ToolId) => void;
  showProject: () => void;
}

export const useTabs = create<TabsState>((set) => ({
  tools: [],
  active: "project",
  openTool: (id) => set((s) => ({
    tools: s.tools.includes(id) ? s.tools : [...s.tools, id],
    active: id,
  })),
  closeTool: (id) => set((s) => ({
    tools: s.tools.filter((t) => t !== id),
    active: s.active === id ? "project" : s.active,
  })),
  showProject: () => set({ active: "project" }),
}));
