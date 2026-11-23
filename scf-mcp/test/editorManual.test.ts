// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "vitest";
import {
  editorHelp, MANUAL, MANUAL_BASE, readSection, searchManual,
} from "../src/editorManual.ts";
import { callTool, startServer } from "./helpers.ts";

const urlOf = (query: string): string | undefined =>
  searchManual(query)[0]?.url;

describe("the editor manual", () => {
  test("every page is bundled, and its headings become sections", () => {
    const pages = new Set(MANUAL.map((s) => s.page.slug));
    expect(pages.size).toBe(9);
    expect(MANUAL.find((s) => s.id === "numbering-policy")?.url)
      .toBe(`${MANUAL_BASE}editor-project.html#numbering-policy`);
    // Numbered headings get the site's sN ids.
    expect(MANUAL.some((s) => s.url.endsWith("editor-quickstart.html#s8")))
      .toBe(true);
  });

  test("no relative link or image is left for the agent to resolve", () => {
    for (const s of MANUAL) {
      for (const [, href] of s.body.matchAll(/\]\(([^)\s]+)\)/g)) {
        expect(href, s.url).toMatch(/^https:\/\//);
      }
      expect(s.body, s.url).not.toMatch(/!\[/);
    }
  });

  test("a question finds the section that answers it", () => {
    expect(urlOf("numbering policy"))
      .toBe(`${MANUAL_BASE}editor-project.html#numbering-policy`);
    // Shot numbers are a fair answer too; the policy has to be there.
    expect(searchManual("how do I renumber scenes").map((s) => s.url))
      .toContain(`${MANUAL_BASE}editor-project.html#numbering-policy`);
    expect(urlOf("commit the script")).toContain("editor-script.html");
    expect(urlOf("print the storyboard"))
      .toContain("editor-presentation.html");
    expect(urlOf("open the help for a tab with F1"))
      .toBe(`${MANUAL_BASE}editor-project.html#help-f1`);
    expect(urlOf("where is the event log")).toContain("editor-tools.html");
    expect(searchManual("zzzz qqqq")).toEqual([]);
  });

  test("a section reads whole, with the subsections under it", () => {
    const sections = readSection("editor-project.html#the-project-tab");
    expect(sections[0]!.title).toBe("The Project tab");
    expect(sections.map((s) => s.id)).toContain("numbering-policy");
    expect(sections.map((s) => s.id)).not.toContain("file-tabs");
    // The same section by its full address, or without .html.
    expect(readSection(`${MANUAL_BASE}editor-project.html#title-page`)[0]!
      .id).toBe("title-page");
    expect(readSection("editor-project#title-page")[0]!.id)
      .toBe("title-page");
  });

  test("an unknown page or section says what there is", () => {
    expect(() => readSection("editor-nowhere.html"))
      .toThrow(/editor-shoot\.html/);
    expect(() => readSection("editor-project.html#nope"))
      .toThrow(/numbering-policy/);
  });

  test("with nothing asked, it gives the contents", () => {
    const contents = editorHelp({});
    expect(contents).toContain("editor-shoot.html");
    expect(contents).toContain("`editor-project.html#numbering-policy`");
  });
});

describe("editor_help over MCP", () => {
  test("answers with no film open", async () => {
    const server = await startServer([]);
    try {
      const result = await callTool(server, "editor_help",
        { topic: "freeze scene numbers" });
      expect(result.isError).toBe(false);
      expect(result.text)
        .toContain(`${MANUAL_BASE}editor-project.html#numbering-policy`);
    } finally {
      server.kill();
    }
  });
});
