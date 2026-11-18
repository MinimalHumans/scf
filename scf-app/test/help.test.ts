// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { helpUrl, MANUAL_BASE, type HelpView } from "../src/commands/help.ts";
import type { NavMode } from "../src/state/store.ts";
import { CHARACTER_TABS } from "../src/state/characterLayout.ts";

const view = (over: Partial<HelpView> = {}): HelpView => ({
  hasProject: true, tool: null, navMode: "script",
  characterTab: "Profile", ...over,
});

const MODES: NavMode[] = [
  "intro", "project", "script", "structure", "shoot", "characters",
  "locations", "props", "subject", "queries", "schema", "assets",
  "screenplay", "storyboard", "shotlist", "gallery",
];

/** The ids site/build.mjs gives a page's headings (code blocks skipped). */
function headingIds(page: string): Set<string> {
  const source = page.replace(/\.html$/, "").replace(/^editor-/, "");
  const file = fileURLToPath(new URL(
    `../../docs/editor-${source === "quickstart" ? "quickstart"
      : `manual-${source}`}.md`, import.meta.url));
  const ids = new Set<string>();
  let fenced = false;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const m = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (m === null) continue;
    const title = m[1]!.replace(/[`*]/g, "");
    const num = /^(\d+(?:\.\d+)*)\.?\s+/.exec(title);
    ids.add(num ? `s${num[1]!.replace(/\./g, "-")}`
      : title.toLowerCase().replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, ""));
  }
  return ids;
}

describe("F1 help", () => {
  test("each tab opens its own page of the manual", () => {
    expect(helpUrl(view({ navMode: "script" })))
      .toBe(`${MANUAL_BASE}editor-script.html`);
    expect(helpUrl(view({ navMode: "props" })))
      .toBe(`${MANUAL_BASE}editor-locations-props.html#props`);
    expect(helpUrl(view({ navMode: "shotlist" })))
      .toBe(`${MANUAL_BASE}editor-presentation.html#shot-list`);
  });

  test("on Characters, the open character tab picks the section", () => {
    expect(helpUrl(view({ navMode: "characters",
                          characterTab: "Scenes & Lines" })))
      .toBe(`${MANUAL_BASE}editor-characters.html#scenes-lines`);
  });

  test("with no project, or on a fresh project, it opens the quickstart", () => {
    expect(helpUrl(view({ hasProject: false })))
      .toBe(`${MANUAL_BASE}editor-quickstart.html`);
    expect(helpUrl(view({ navMode: "intro" })))
      .toBe(`${MANUAL_BASE}editor-quickstart.html`);
  });

  test("a tool tab in front wins over the section behind it", () => {
    expect(helpUrl(view({ tool: "events", navMode: "script" })))
      .toBe(`${MANUAL_BASE}editor-tools.html#event-log`);
  });

  // The anchors follow the manual's headings; this catches a renamed
  // heading before a user lands on the top of the wrong page.
  test("every page and anchor F1 can open exists in the manual", () => {
    const urls = [
      ...MODES.map((navMode) => helpUrl(view({ navMode }))),
      ...CHARACTER_TABS.map((characterTab) =>
        helpUrl(view({ navMode: "characters", characterTab }))),
      ...(["events", "media", "settings"] as const).map((tool) =>
        helpUrl(view({ tool }))),
    ];
    for (const url of urls) {
      const [page, anchor] = url.slice(MANUAL_BASE.length).split("#");
      const ids = headingIds(page!);
      if (anchor !== undefined) expect(ids, url).toContain(anchor);
    }
  });
});
