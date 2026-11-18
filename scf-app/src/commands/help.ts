// SPDX-License-Identifier: Apache-2.0
/**
 * help.ts — which page of the online manual F1 opens.
 *
 * The manual lives on the docs site, one page per part of the editor
 * (docs/editor-manual-*.md, published by site/build.mjs). Its heading
 * ids come from the heading text, so the anchors here follow the
 * headings in those files: rename a heading there and update it here.
 *
 * Pure, so the mapping is tested without a window.
 */

import type { NavMode } from "../state/store.ts";
import type { CharacterTab } from "../state/characterLayout.ts";
import type { ToolId } from "../state/tabs.ts";
// The MCP's `editor_help` answers from the same manual; one address.
import { MANUAL_BASE } from "@scf-mcp/editorManual.ts";

export { MANUAL_BASE };

const QUICKSTART = "editor-quickstart.html";

const PAGES: Record<NavMode, string> = {
  // A freshly opened project lands here, before any section is picked.
  intro: QUICKSTART,
  project: "editor-project.html",
  script: "editor-script.html",
  structure: "editor-structure.html",
  shoot: "editor-shoot.html",
  characters: "editor-characters.html",
  locations: "editor-locations-props.html#locations",
  props: "editor-locations-props.html#props",
  subject: "editor-tools.html#subjects",
  queries: "editor-tools.html#queries",
  schema: "editor-tools.html#schema",
  assets: "editor-tools.html#assets",
  screenplay: "editor-presentation.html#screenplay",
  storyboard: "editor-presentation.html#storyboard",
  shotlist: "editor-presentation.html#shot-list",
  gallery: "editor-presentation.html#gallery",
};

const CHARACTER_SECTIONS: Record<CharacterTab, string> = {
  "Profile": "profile",
  "Look": "look",
  "Wardrobe": "wardrobe",
  "Voice": "voice",
  "Physicality": "physicality",
  "Relationships": "relationships",
  "Arc": "arc",
  "Scenes & Lines": "scenes-lines",
};

const TOOL_PAGES: Record<ToolId, string> = {
  events: "editor-tools.html#event-log",
  // The manual has no section for these two yet; the tools page is closest.
  media: "editor-tools.html#assets",
  settings: "editor-tools.html",
};

export interface HelpView {
  /** A project is open in the active tab. */
  hasProject: boolean;
  /** The tool tab in front, if one is. */
  tool: ToolId | null;
  navMode: NavMode;
  characterTab: CharacterTab;
}

/** The manual page for what is on screen. */
export function helpUrl(v: HelpView): string {
  if (v.tool !== null) return MANUAL_BASE + TOOL_PAGES[v.tool];
  if (!v.hasProject) return MANUAL_BASE + QUICKSTART;
  if (v.navMode === "characters") {
    return `${MANUAL_BASE}${PAGES.characters}#` +
      CHARACTER_SECTIONS[v.characterTab];
  }
  return MANUAL_BASE + PAGES[v.navMode];
}
