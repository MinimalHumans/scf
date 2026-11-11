// SPDX-License-Identifier: Apache-2.0
/**
 * Every member of a published result carries data somewhere.
 *
 * A member that is null, empty or `{}` in every published result of its
 * query is one a reader may ignore entirely and still reproduce every
 * artifact byte for byte — variants, vocal states and version chains all
 * sat that way, implemented and unexercised, with every check green.
 * Declaring a member and authoring a row that exercises it are one
 * change; this is the check that says when they were made as two.
 *
 * Results are grouped by query (`Q12` and `Q12-scene24-25` together),
 * so a member may be filled by any case. Projected rows' `fields` are
 * open-ended and not walked.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const DIR = join(dirname(fileURLToPath(import.meta.url)),
                 "..", "..", "fixtures", "expectations");

/**
 * Members that are empty by definition in a published artifact, and why.
 * Nothing goes here because it is inconvenient to author.
 */
const EMPTY_BY_DESIGN: Record<string, string> = {
  "Q02.media.references[].sizeBytes":
    "Environment-dependent (§8.3): no root is mapped when results are blessed.",
  "Q13.references[].sizeBytes":
    "Environment-dependent (§8.3): no root is mapped when results are blessed.",
  // NOT empty by definition: empty because the fixture has no bound,
  // superseded asset (proposal 0039's Resolution; `stability.md` marks the
  // §12.8 row "Partly"). Author one and the test below fails until these
  // two lines are dropped, which is the point of listing them here.
  "Q02.media.references[].supersedes":
    "Fixture gap: no bound asset is superseded. Pinned on a copy by " +
    "supersededGivesWay.test.ts.",
  "Q13.references[].supersedes":
    "Fixture gap: no bound asset is superseded. Pinned on a copy by " +
    "supersededGivesWay.test.ts.",
};

const isEmpty = (v: unknown): boolean =>
  v === null || v === undefined || v === "" ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === "object" && v !== null && !Array.isArray(v) &&
   Object.keys(v).length === 0);

function walk(v: unknown, path: string,
              seen: Map<string, boolean>): void {
  seen.set(path, (seen.get(path) ?? false) || !isEmpty(v));
  if (Array.isArray(v)) {
    for (const x of v) walk(x, `${path}[]`, seen);
  } else if (v !== null && typeof v === "object" && !path.endsWith(".fields")) {
    for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`, seen);
  }
}

describe("published results exercise every member", () => {
  const files = readdirSync(DIR).filter((f) => /^Q\d\d.*\.result\.json$/.test(f));

  test("all sixteen queries are published", () => {
    const queries = new Set(files.map((f) => f.slice(0, 3)));
    expect(queries.size).toBe(16);
  });

  test("no member is empty in every result of its query", () => {
    const seen = new Map<string, boolean>();
    for (const f of files) {
      const r = JSON.parse(readFileSync(join(DIR, f), "utf8")) as
        { result: unknown };
      walk(r.result, f.slice(0, 3), seen);
    }
    const alwaysEmpty = [...seen].filter(([, filled]) => !filled)
      .map(([path]) => path).filter((p) => !(p in EMPTY_BY_DESIGN));
    expect(alwaysEmpty, "author a fixture row, or a per-case result, " +
      "that fills each of these").toEqual([]);
  });

  test("nothing is excused that is no longer empty", () => {
    const seen = new Map<string, boolean>();
    for (const f of files) {
      walk((JSON.parse(readFileSync(join(DIR, f), "utf8")) as
        { result: unknown }).result, f.slice(0, 3), seen);
    }
    for (const path of Object.keys(EMPTY_BY_DESIGN)) {
      expect(seen.has(path), `${path} names no member`).toBe(true);
      expect(seen.get(path), `${path} is filled now; drop the excuse`)
        .toBe(false);
    }
  });
});
