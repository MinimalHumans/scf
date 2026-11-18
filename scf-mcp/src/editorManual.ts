// SPDX-License-Identifier: Apache-2.0
/**
 * editorManual.ts — the SCF Editor's manual, for an agent asked how to
 * use the editor rather than what is in the film.
 *
 * The pages are the docs site's own Markdown (docs/editor-*.md, which
 * site/build.mjs publishes), bundled in when the window is built, so
 * an answer needs no network and can never describe a different
 * editor from the one serving it. Each answer carries the online link
 * to the same section, for the agent to pass on: the site has the
 * screenshots.
 *
 * Section ids follow site/build.mjs: a heading's text, slugged, or
 * `sN` for a numbered one. Relative links and images are made absolute
 * against the site, since the agent has no page to resolve them from.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import quickstart from "../../docs/editor-quickstart.md?raw";
import project from "../../docs/editor-manual-project.md?raw";
import script from "../../docs/editor-manual-script.md?raw";
import structure from "../../docs/editor-manual-structure.md?raw";
import shoot from "../../docs/editor-manual-shoot.md?raw";
import characters from "../../docs/editor-manual-characters.md?raw";
import locationsProps from "../../docs/editor-manual-locations-props.md?raw";
import tools from "../../docs/editor-manual-tools.md?raw";
import presentation from "../../docs/editor-manual-presentation.md?raw";
import { err, text } from "./toolResult.ts";

/** Where the docs site is published. */
export const MANUAL_BASE = "https://minimalhumans.github.io/scf/";

interface PageSource {
  /** The page's file name on the site, without `.html`. */
  slug: string;
  title: string;
  blurb: string;
  markdown: string;
}

/** In the site's order; titles and blurbs as its sidebar has them. */
const SOURCES: PageSource[] = [
  { slug: "editor-quickstart", title: "Quickstart",
    blurb: "Get going with the SCF Editor, tab by tab",
    markdown: quickstart },
  { slug: "editor-project", title: "Manual: Project",
    blurb: "The Project tab, saving, file tabs, the menu and settings",
    markdown: project },
  { slug: "editor-script", title: "Manual: Script",
    blurb: "Writing, formatting and committing in the Script tab",
    markdown: script },
  { slug: "editor-structure", title: "Manual: Structure",
    blurb: "Acts and sequences, and where each one starts",
    markdown: structure },
  { slug: "editor-shoot", title: "Manual: Shoot",
    blurb: "Beats, shots, storyboards and frames", markdown: shoot },
  { slug: "editor-characters", title: "Manual: Characters",
    blurb: "The character workspace, As of, boards and story strips",
    markdown: characters },
  { slug: "editor-locations-props", title: "Manual: Locations & props",
    blurb: "Variants, sound, prop states and script tags",
    markdown: locationsProps },
  { slug: "editor-tools", title: "Manual: Tools",
    blurb: "Subjects, Queries, Schema, Assets and the event log",
    markdown: tools },
  { slug: "editor-presentation", title: "Manual: Presentation",
    blurb: "Screenplay, storyboard, shot list and gallery, printed and " +
      "shown", markdown: presentation },
];

/**
 * One heading and the text under it, up to the next heading of level 3
 * or above. Level 1 is the page's own opening.
 */
export interface ManualSection {
  page: PageSource;
  /** The heading's id on the page; "" for the page's opening. */
  id: string;
  level: number;
  title: string;
  /** Page title, then the headings this one sits under, then its own. */
  path: string[];
  /** Under the heading, links made absolute. */
  body: string;
  url: string;
}

const decode = (s: string): string => s.replace(/&#39;/g, "'")
  .replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&amp;/g, "&");

/** The id site/build.mjs gives a heading. */
export function headingId(heading: string): string {
  const title = decode(heading).replace(/[`*]/g, "");
  const num = /^(\d+(?:\.\d+)*)\.?\s+/.exec(title);
  return num ? `s${num[1]!.replace(/\./g, "-")}`
    : title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** Links and images that resolve on the site, written out in full. */
function absolute(markdown: string, slug: string): string {
  return markdown
    .replace(/!\[([^\]]*)\]\((images\/[^)\s]+)\)/g,
      (_, alt: string, src: string) =>
        `[Screenshot: ${alt}](${MANUAL_BASE}${src})`)
    .replace(/\]\((?![a-z]+:)([^)\s]+)\)/g, (_, href: string) =>
      `](${MANUAL_BASE}${href.startsWith("#") ? `${slug}.html` : ""}${href})`);
}

function parse(page: PageSource): ManualSection[] {
  const markdown = page.markdown.replace(/\r\n/g, "\n")
    .replace(/^<!--\s*SPDX-License-Identifier:[^>]*-->\s*\n/, "");
  const sections: ManualSection[] = [];
  const trail: string[] = [];
  let current: { id: string; level: number; title: string; path: string[];
                 lines: string[] } | null = null;
  const close = (): void => {
    if (current === null) return;
    const { lines, ...rest } = current;
    sections.push({
      ...rest, page,
      body: absolute(lines.join("\n").trim(), page.slug),
      url: `${MANUAL_BASE}${page.slug}.html` +
        (rest.id === "" ? "" : `#${rest.id}`),
    });
  };
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const m = fenced ? null : /^(#{1,3})\s+(.+?)\s*$/.exec(line);
    if (m === null) {
      current?.lines.push(line);
      continue;
    }
    close();
    const level = m[1]!.length;
    const title = decode(m[2]!).replace(/[`*]/g, "");
    trail.length = Math.max(level - 1, 0);
    trail[level - 1] = title;
    current = {
      id: level === 1 ? "" : headingId(m[2]!), level, title,
      path: [page.title, ...trail.slice(1)], lines: [],
    };
  }
  close();
  return sections;
}

export const MANUAL: ManualSection[] = SOURCES.flatMap(parse);

// ── Search ──────────────────────────────────────────────────────────

const STOP = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "can", "do", "does",
  "editor", "for", "from", "get", "how", "i", "in", "into", "is", "it",
  "me", "my", "of", "on", "or", "scf", "should", "the", "there", "this",
  "to", "use", "what", "when", "where", "which", "why", "with", "you",
]);

/**
 * Plural and -ing/-ed endings off, so "numbering", "numbered" and
 * "numbers" are one word: crude, but the manual is small and its
 * headings say what they mean.
 */
function stem(t: string): string {
  if (t.endsWith("ies") && t.length > 4) return `${t.slice(0, -3)}y`;
  for (const suffix of ["ing", "ed"]) {
    if (t.endsWith(suffix) && t.length - suffix.length >= 4) {
      const root = t.slice(0, -suffix.length);
      // "committ" -> "commit"
      return /([^aeiousl])$/.test(root) ? root.slice(0, -1) : root;
    }
  }
  return t.endsWith("s") && !t.endsWith("ss") && t.length > 3
    ? t.slice(0, -1) : t;
}

/**
 * What a query word may match: itself, and for "renumber" or
 * "reorder" the word without its "re", at a little less weight.
 */
function alternatives(t: string): Array<[string, number]> {
  return t.startsWith("re") && t.length >= 7
    ? [[t, 1], [t.slice(2), 0.75]] : [[t, 1]];
}

function tokens(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0 && !STOP.has(t)).map(stem);
}

interface Indexed {
  section: ManualSection;
  heading: Set<string>;
  context: Set<string>;
  body: Map<string, number>;
}

const INDEX: Indexed[] = MANUAL.map((section) => {
  const body = new Map<string, number>();
  for (const t of tokens(section.body)) body.set(t, (body.get(t) ?? 0) + 1);
  return {
    section,
    heading: new Set(tokens(section.title)),
    context: new Set(tokens(section.path.slice(0, -1).join(" "))),
    body,
  };
});

/**
 * How telling a word is: rare across the manual's sections counts for
 * more than common. "scene" is in half of them; "renumber" in a few.
 */
const SECTIONS_WITH = new Map<string, number>();
for (const ix of INDEX) {
  for (const t of new Set([...ix.heading, ...ix.context, ...ix.body.keys()])) {
    SECTIONS_WITH.set(t, (SECTIONS_WITH.get(t) ?? 0) + 1);
  }
}
const rarity = (t: string): number =>
  Math.log(1 + INDEX.length / (SECTIONS_WITH.get(t) ?? 1));

/**
 * The sections that best answer `query`, best first: a word in a
 * section's heading counts most, then in the headings it sits under,
 * then each use in its text (up to four), each weighed by how rare the
 * word is. A section with every word scores half as much again. Only sections within half the best score
 * come back, so a clear answer is not padded with weak ones.
 */
export function searchManual(query: string, limit = 3): ManualSection[] {
  const terms = [...new Set(tokens(query))];
  if (terms.length === 0) return [];
  const scored = INDEX.map((ix) => {
    let score = 0;
    let matched = 0;
    for (const term of terms) {
      const s = Math.max(...alternatives(term).map(([t, weight]) =>
        weight * rarity(t) * ((ix.heading.has(t) ? 6 : 0) + (ix.context.has(t) ? 3 : 0) +
         Math.min(ix.body.get(t) ?? 0, 4))));
      if (s > 0) matched += 1;
      score += s;
    }
    if (matched === terms.length && terms.length > 1) score *= 1.5;
    return { section: ix.section, score };
  }).filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
  const best = scored[0]?.score ?? 0;
  return scored.filter((s) => s.score >= best / 2).slice(0, limit)
    .map((s) => s.section);
}

// ── Reading ─────────────────────────────────────────────────────────

/** "editor-shoot.html#media", "editor-shoot#media", or its full URL. */
export function readSection(ref: string): ManualSection[] {
  const [pagePart, id = ""] = ref.trim().replace(MANUAL_BASE, "")
    .split("#") as [string, string?];
  const slug = pagePart.replace(/\.html$/, "");
  const page = MANUAL.filter((s) => s.page.slug === slug);
  if (page.length === 0) {
    throw new Error(`no manual page "${pagePart}". The pages are: ` +
      SOURCES.map((p) => `${p.slug}.html`).join(", "));
  }
  if (id === "") return page;
  const start = page.findIndex((s) => s.id === id);
  if (start === -1) {
    throw new Error(`no section #${id} on ${slug}.html. Its sections ` +
      `are: ${page.filter((s) => s.id !== "").map((s) => s.id).join(", ")}`);
  }
  // The section and everything under it.
  const level = page[start]!.level;
  const end = page.findIndex((s, i) => i > start && s.level <= level);
  return page.slice(start, end === -1 ? undefined : end);
}

function render(section: ManualSection, depth: "full" | "own"): string {
  const heading = depth === "full"
    ? `## ${section.path.join(" › ")}\n${section.url}`
    : `${"#".repeat(Math.max(section.level, 2))} ${section.title}`;
  return section.body === "" ? heading : `${heading}\n\n${section.body}`;
}

/** Every page, its blurb and its link, and every section's id. */
export function manualContents(): string {
  const lines = [
    "# SCF Editor manual",
    `Online at ${MANUAL_BASE}. Read a section with \`editor_help\` and ` +
      "`section` set to an id below.",
  ];
  for (const source of SOURCES) {
    lines.push("", `## ${source.title} — ${source.slug}.html`,
      source.blurb);
    for (const s of MANUAL) {
      if (s.page !== source || s.level === 1) continue;
      lines.push(`${s.level === 3 ? "  " : ""}- ${s.title} ` +
        `(\`${source.slug}.html#${s.id}\`)`);
    }
  }
  return lines.join("\n");
}

const FOOTER = "Give the person the link when it helps: the online page " +
  "has the screenshots. `editor_help` with no arguments lists every " +
  "section.";

export function editorHelp(args: { topic?: string; section?: string })
    : string {
  if (args.section !== undefined && args.section.trim() !== "") {
    const [first, ...rest] = readSection(args.section);
    return [render(first!, "full"),
      ...rest.map((s) => render(s, "own")), FOOTER].join("\n\n");
  }
  if (args.topic === undefined || args.topic.trim() === "") {
    return manualContents();
  }
  const hits = searchManual(args.topic);
  if (hits.length === 0) {
    return `The SCF Editor manual has nothing on "${args.topic}". ` +
      "Its contents follow; read a section with `section`.\n\n" +
      manualContents();
  }
  return [`From the SCF Editor manual, for "${args.topic}":`,
    ...hits.map((s) => render(s, "full")), FOOTER].join("\n\n");
}

export function registerEditorHelp(server: McpServer): void {
  server.registerTool("editor_help", {
    description: "How to use the SCF Editor, the desktop app this " +
      "server runs in, answered from its manual with a link to the " +
      "online page. For the app, not the film: where a button is, what " +
      "a tab is for, how Commit, numbering, storyboards or exports work. " +
      "Give `topic` (a question or keywords) for the best-matching " +
      "sections, `section` (an id like `editor-shoot.html#media`) to " +
      "read one whole, or nothing for the contents. No film needs to " +
      "be open.",
    inputSchema: {
      topic: z.string().optional().describe(
        "What the person wants to do or know, e.g. \"renumber scenes\"."),
      section: z.string().optional().describe(
        "A section to read whole: page, or page#id, from the contents."),
    },
  }, ({ topic, section }) => {
    try {
      const args: { topic?: string; section?: string } = {};
      if (topic !== undefined) args.topic = topic;
      if (section !== undefined) args.section = section;
      return text(editorHelp(args));
    } catch (e) {
      return err(e);
    }
  });
}
