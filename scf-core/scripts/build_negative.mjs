// SPDX-License-Identifier: Apache-2.0
/**
 * build_negative.mjs — the negative fixtures.
 *
 * Hollow Creek contains authored ABSENCES — a thin vocal profile, a
 * missing voice bundle, gapped scene numbers — but not authored ERRORS.
 * These fixtures pin what a conforming implementation should SAY when a
 * file is wrong (conformance.md §5.3).
 *
 * Each case is a minimal database plus exactly the damage its name
 * describes. Minimal on purpose: a case that trips three findings tells
 * you nothing about which code belongs to which condition.
 *
 * The .scf files are BUILT, not checked in. Ten fresh databases is
 * several megabytes of binary in a repo whose whole point is a
 * text-first format, and they are perfectly reproducible from here. The
 * blessed reports ARE checked in — those are the artifact, and they are
 * diffable, which the databases would not be.
 *
 *   node --experimental-strip-types scripts/build_negative.mjs
 *   node --experimental-strip-types scripts/build_negative.mjs --check
 *
 * --check rebuilds and compares against the blessed reports without
 * writing, for CI.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync }
  from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initDatabase } from "../src/db.ts";
import { loadRegistry } from "../src/registry.ts";
import { openNodeDatabase } from "../src/node.ts";
import { validationReport } from "../src/report.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "..", "fixtures", "negative");
const BUILD = join(OUT, "build");

const registry = loadRegistry(JSON.parse(readFileSync(
  join(HERE, "..", "registry", "registry.json"), "utf8")));

/**
 * Deterministic, well-formed uuids. The first draft of this file used
 * readable strings like 'ch-1', and every case then reported
 * identity.uuid_malformed alongside the thing it was actually meant to
 * demonstrate — a case that trips two findings tells you nothing about
 * which code belongs to which condition. The fixtures have to be clean
 * everywhere except the one place they are dirty.
 */
const uuid = (n) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/**
 * Each case: a name, one sentence on what is wrong, and the damage.
 * The comment on each is the interesting part — it says what a reader
 * is supposed to conclude, which is the thing being pinned.
 */
const CASES = [
  {
    name: "uuid-missing",
    about: "A row with no uuid. Nothing can track it across a file.",
    damage: async (exec) => {
      await exec("INSERT INTO scene (name, uuid) VALUES ('INT. VOID', NULL)");
    },
  },
  {
    name: "uuid-duplicate",
    about: "Two rows sharing a uuid. Lineage becomes ambiguous.",
    damage: async (exec) => {
      // The unique index is what normally prevents this, so it has to be
      // dropped first — which is itself a finding, and the reason this
      // case reports two things rather than one.
      await exec("DROP INDEX IF EXISTS idx_scene_uuid");
      await exec("INSERT INTO scene (name, uuid) VALUES ('A', ?)", [uuid(1)]);
      await exec("INSERT INTO scene (name, uuid) VALUES ('B', ?)", [uuid(1)]);
    },
  },
  {
    name: "uuid-malformed",
    about: "A uuid that is not uuid-shaped.",
    damage: async (exec) => {
      await exec("INSERT INTO scene (name, uuid) VALUES ('C', 'not-a-uuid')");
    },
  },
  {
    name: "relationship-endpoint-absent",
    about: "A relationship pointing at a character that is not here.",
    damage: async (exec) => {
      await exec(
        "INSERT INTO character (name, uuid) VALUES ('ELEANOR', ?)",
        [uuid(1)]);
      await exec(
        "INSERT INTO character_relationship (character_a_id, " +
        "character_b_id, directionality, uuid) VALUES (1, 404, 'mutual', ?)",
        [uuid(2)]);
    },
  },
  {
    name: "relationship-contradictory",
    about:
      "One pair described as both mutual and directed. No tool can pick " +
      "the winner — the case §6.5's directionality flag exists for.",
    damage: async (exec) => {
      await exec(
        "INSERT INTO character (name, uuid) VALUES ('ELEANOR', ?)",
        [uuid(1)]);
      await exec(
        "INSERT INTO character (name, uuid) VALUES ('MARCUS', ?)",
        [uuid(2)]);
      await exec(
        "INSERT INTO character_relationship (character_a_id, " +
        "character_b_id, directionality, uuid) VALUES (1, 2, 'mutual', ?)",
        [uuid(3)]);
      await exec(
        "INSERT INTO character_relationship (character_a_id, " +
        "character_b_id, directionality, uuid) VALUES (1, 2, 'a_to_b', ?)",
        [uuid(4)]);
    },
  },
  {
    name: "relationship-directionality-absent",
    about:
      "A relationship with no symmetry fact. Readable, but nothing can " +
      "tell a duplicate from a second direction. Note the explicit " +
      "NULL: the column defaults to 'mutual', so this state is only " +
      "reachable by clearing it — which is exactly what an import from " +
      "a tool that has no such concept would do.",
    damage: async (exec) => {
      await exec(
        "INSERT INTO character (name, uuid) VALUES ('ELEANOR', ?)",
        [uuid(1)]);
      await exec(
        "INSERT INTO character (name, uuid) VALUES ('MARCUS', ?)",
        [uuid(2)]);
      await exec(
        "INSERT INTO character_relationship (character_a_id, " +
        "character_b_id, directionality, uuid) VALUES (1, 2, NULL, ?)",
        [uuid(3)]);
    },
  },
  {
    name: "span-boundary-dangling",
    about:
      "An act anchored to a scene that is not present. Structure must " +
      "still derive (§5.5) and say so.",
    damage: async (exec) => {
      await exec(
        "INSERT INTO scene (name, scene_number, uuid) " +
        "VALUES ('INT. KITCHEN', '1', ?)", [uuid(1)]);
      await exec(
        "INSERT INTO act (name, act_number, start_scene_id, uuid) " +
        "VALUES ('Act I', 1, 999, ?)", [uuid(2)]);
    },
  },
  {
    name: "span-boundary-cut",
    about:
      "An act whose start scene is cut. A cut scene takes part in no " +
      "span (§6.6.1), so Act II covers nothing and its scene stays in " +
      "Act I (§5.5); the boundary is still there, so this is not " +
      "`structure.boundary_dangling`, and without its own code the " +
      "re-parenting would be silent.",
    damage: async (exec) => {
      await exec(
        "INSERT INTO scene (name, scene_number, uuid) " +
        "VALUES ('INT. KITCHEN', '1', ?)", [uuid(1)]);
      await exec(
        "INSERT INTO scene (name, scene_number, lifecycle_status, uuid) " +
        "VALUES ('EXT. RIDGE', '2', 'cut', ?)", [uuid(2)]);
      await exec(
        "INSERT INTO scene (name, scene_number, uuid) " +
        "VALUES ('INT. CHURCH', '3', ?)", [uuid(3)]);
      await exec(
        "INSERT INTO act (name, act_number, start_scene_id, uuid) " +
        "VALUES ('Act I', 1, 1, ?)", [uuid(4)]);
      await exec(
        "INSERT INTO act (name, act_number, start_scene_id, uuid) " +
        "VALUES ('Act II', 2, 2, ?)", [uuid(5)]);
    },
  },
  {
    name: "junction-key-null",
    about:
      "Two motif appearances on a prop, at no scene. Their natural " +
      "keys (§6.3) agree except that `scene_id` and `domain` are NULL " +
      "in both, and NULL key columns compare EQUAL (§6.4): one link, " +
      "written twice. A reader comparing with SQL's `=` sees two " +
      "distinct links and reports nothing.",
    damage: async (exec) => {
      await exec("INSERT INTO motif (name, modality, uuid) " +
                 "VALUES ('The locket', 'visual', ?)",
                 [uuid(1)]);
      await exec("INSERT INTO prop (name, uuid) VALUES ('Locket', ?)",
                 [uuid(2)]);
      for (const n of [3, 4]) {
        await exec(
          "INSERT INTO motif_appearance " +
          "(motif_id, scene_id, entity_type, entity_id, uuid) " +
          "VALUES (1, NULL, 'prop', 1, ?)", [uuid(n)]);
      }
    },
  },
  {
    name: "asset-escapes-root",
    about:
      "An identifier containing '..'. It cannot be resolved, and a " +
      "resolver that followed it would leave the project.",
    damage: async (exec) => {
      await exec(
        "INSERT INTO asset (name, identifier, uuid) VALUES (?, ?, ?)",
        ["escape", "@project/../../etc/passwd", uuid(1)]);
    },
  },
  {
    name: "asset-absolute",
    about:
      "An absolute identifier. Representable on purpose (§8.2), " +
      "non-portable, and a warning rather than an error.",
    damage: async (exec) => {
      await exec(
        "INSERT INTO asset (name, identifier, uuid) VALUES (?, ?, ?)",
        ["plate", "/Volumes/plates/sh010.exr", uuid(1)]);
    },
  },
  {
    name: "unknown-table",
    about:
      "A table SCF does not define. Preserved and ignored (§10.1) — " +
      "reported at info, because unknown usually means historical.",
    damage: async (exec) => {
      await exec("CREATE TABLE legacy_pipeline (k TEXT, v TEXT)");
      await exec(
        "INSERT INTO legacy_pipeline (k, v) VALUES ('shotgun_id', 'sg-1')");
    },
  },
  {
    name: "line-type-unknown",
    about:
      "A screenplay line typed `scene_heading`, which is not in §1.3.1's " +
      "closed set. A reader must keep it as unknown content and must not " +
      "read it as a heading, so story order would silently lose a scene; " +
      "an error, because two readers that disagree here disagree about " +
      "the story.",
    damage: async (exec) => {
      await exec(
        "INSERT INTO screenplay_lines (line_order, line_type, content, uuid) " +
        "VALUES (1, 'scene_heading', 'INT. KITCHEN - NIGHT', ?)", [uuid(1)]);
    },
  },
  {
    name: "junction-endpoint-absent",
    about:
      "A cast link with no character. A link with a missing end connects " +
      "nothing; the row is kept and reported (§9.1), as " +
      "`junction.endpoint_absent` rather than `field.required_absent`, " +
      "because what is missing is half of a relationship.",
    damage: async (exec) => {
      await exec("INSERT INTO scene (name, scene_number, uuid) " +
                 "VALUES ('INT. KITCHEN', '1', ?)", [uuid(1)]);
      await exec("INSERT INTO scene_character (scene_id, character_id, uuid) " +
                 "VALUES (1, NULL, ?)", [uuid(2)]);
    },
  },
  {
    name: "reference-dangling",
    about:
      "Three references that are filled and name no row: an ordinary " +
      "one (a cast link to character 404), a polymorphic one (a " +
      "thematic connection to character 404, found through its " +
      "`entity_type` sibling, §12.1.2), and a uuid stored as text in " +
      "an integer reference column, which is what a writer that skips " +
      "the uuid-to-row-id step leaves behind. Each is " +
      "`reference.dangling` (§9.1): one finding per column. None is " +
      "`junction.endpoint_absent`, because the column is not empty; " +
      "every query still answers (§9.2), and the link is not there.",
    damage: async (exec) => {
      await exec("INSERT INTO scene (name, scene_number, uuid) " +
                 "VALUES ('INT. KITCHEN', '1', ?)", [uuid(1)]);
      await exec("INSERT INTO scene_character (scene_id, character_id, uuid) " +
                 "VALUES (1, 404, ?)", [uuid(2)]);
      await exec("INSERT INTO theme (name, uuid) VALUES ('Guilt', ?)",
                 [uuid(3)]);
      await exec(
        "INSERT INTO thematic_connection (theme_id, entity_type, " +
        "entity_id, uuid) VALUES (1, 'character', 404, ?)", [uuid(4)]);
      await exec("INSERT INTO motif (name, modality, uuid) " +
                 "VALUES ('The locket', 'visual', ?)", [uuid(5)]);
      await exec(
        "INSERT INTO motif_appearance (motif_id, entity_type, entity_id, " +
        "uuid) VALUES (1, 'scene', ?, ?)", [uuid(1), uuid(6)]);
    },
  },
  {
    name: "asset-orphans-two",
    about:
      "Two assets nothing references. One condition on one table is one " +
      "finding (§9.5): `asset.orphan` once, with `count` 2 and both rows " +
      "in `rowIds` — not two findings, and not one row.",
    damage: async (exec) => {
      for (const [i, name] of [[1, "plate_a.exr"], [2, "plate_b.exr"]]) {
        await exec("INSERT INTO asset (name, identifier, uuid) " +
                   "VALUES (?, ?, ?)", [name, `@project/${name}`, uuid(i)]);
      }
    },
  },
  {
    name: "section-mismatch",
    about:
      "A section line bound to an act whose record has since been renamed. " +
      "The record answers queries and the line is the authoring handle " +
      "(§1.3.1), so this is info: between commits the two may differ, and " +
      "a line that has drifted is how an editor renames the wrong act.",
    damage: async (exec) => {
      await exec("INSERT INTO scene (name, scene_number, uuid) " +
                 "VALUES ('INT. KITCHEN', '1', ?)", [uuid(1)]);
      await exec("INSERT INTO act (name, act_number, start_scene_id, uuid) " +
                 "VALUES ('The Thaw', 1, 1, ?)", [uuid(2)]);
      await exec(
        "INSERT INTO screenplay_lines (line_order, line_type, content, " +
        "metadata, uuid) VALUES (1, 'section', '# The Arrival', ?, ?)",
        [JSON.stringify({ structureRef: { kind: "act", uuid: uuid(2) } }),
         uuid(3)]);
      await exec(
        "INSERT INTO screenplay_lines (line_order, line_type, content, " +
        "scene_id, uuid) VALUES (2, 'heading', 'INT. KITCHEN - NIGHT', 1, ?)",
        [uuid(4)]);
    },
  },
  {
    name: "bundle-unbound",
    about:
      "A bundle with an asset in it and no binding anywhere. Its asset " +
      "is referenced, so §8.6's orphan finding stays silent, and the " +
      "cascade starts at a subject and never arrives — nothing " +
      "resolves it at any position. Info: assembling a bundle before " +
      "deciding what it is for is an ordinary state of an unfinished " +
      "film.",
    damage: async (exec) => {
      await exec(
        "INSERT INTO asset (name, identifier, uuid) VALUES (?, ?, ?)",
        ["kitchen plate", "@project/plates/kitchen.exr", uuid(1)]);
      await exec(
        "INSERT INTO bundle (name, intent, uuid) VALUES (?, ?, ?)",
        ["Kitchen plates", "visual_identity", uuid(2)]);
      await exec(
        "INSERT INTO bundle_asset (bundle_id, asset_id, uuid) " +
        "VALUES (1, 1, ?)", [uuid(3)]);
    },
  },
  {
    name: "header-unstamped",
    about:
      "No application id. Every file written before schema 2.10 looks " +
      "like this, and a reader MUST NOT refuse it (§1.2).",
    damage: async (exec) => {
      await exec("PRAGMA application_id = 0");
      await exec("PRAGMA user_version = 0");
    },
  },
];

/**
 * Record every statement a case issues, so the damage can be PUBLISHED
 * rather than only performed. A third party can build each damaged
 * database from its description; it cannot guess the report.
 */
function recordingExec(exec, log) {
  return async (sql, params = []) => {
    log.push(params.length === 0
      ? sql
      : `${sql}   -- params: ${JSON.stringify(params)}`);
    return exec(sql, params);
  };
}

async function build(name, damage) {
  const path = join(BUILD, `${name}.scf`);
  rmSync(path, { force: true });
  const db = openNodeDatabase(path);
  await initDatabase(db.exec, registry);
  const statements = [];
  await damage(recordingExec(db.exec, statements));
  const report = await validationReport(db.exec, registry, {
    source: `fixtures/negative/build/${name}.scf`,
  });
  db.close();
  return { report, statements };
}

const check = process.argv.includes("--check");
mkdirSync(BUILD, { recursive: true });

let stale = [];
const casesDoc = [];
for (const { name, about, damage } of CASES) {
  const { report, statements } = await build(name, damage);
  casesDoc.push({ name, about, statements });
  const blessed = join(OUT, `${name}.expected.json`);
  const text = `${JSON.stringify({ about, ...report }, null, 2)}\n`;
  if (check) {
    const current = existsSync(blessed)
      ? readFileSync(blessed, "utf8") : "";
    if (current !== text) stale.push(name);
  } else {
    writeFileSync(blessed, text, "utf8");
  }
}

// The fixture's own report: what a validator says about the conformance
// fixture, so a third party has a whole-file report to compare against
// and not only single-fault files (conformance.md §6.1 step 1).
{
  const FIXTURE = join(HERE, "..", "..", "fixtures", "hollow_creek.scf");
  const db = openNodeDatabase(FIXTURE, { readOnly: true });
  const report = await validationReport(db.exec, registry, {
    source: "fixtures/hollow_creek.scf",
  });
  db.close();
  const path = join(HERE, "..", "..", "fixtures", "hollow_creek.report.json");
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (check) {
    if ((existsSync(path) ? readFileSync(path, "utf8") : "") !== text) {
      stale.push("hollow_creek.report.json");
    }
  } else {
    writeFileSync(path, text, "utf8");
  }
}

// The recipe file. Everything a third party needs to reconstruct the
// databases without this repository: start from a database
// created per spec/scf-schema.sql, apply these statements, compare
// against the blessed report.
const recipe = `${JSON.stringify({
  $comment:
    "GENERATED by scf-core/scripts/build_negative.mjs. The negative " +
    "fixtures of spec/conformance.md §5.3. Each case: start from an " +
    "empty conforming database (spec/scf-schema.sql, plus the header " +
    "stamps and _scf_meta.schema_version of §1.2), apply `statements` " +
    "in order, then validate. A statement ending `-- params: [...]` " +
    "binds that JSON array to its `?` placeholders. Compare against " +
    "the case's <name>.expected.json as conformance.md §6.1 says: each " +
    "finding's code, severity, table, count and rowIds; message, title " +
    "and spec are for people.",
  schemaVersion: registry.schemaVersion,
  caseCount: CASES.length,
  cases: casesDoc,
}, null, 2)}\n`;
const recipePath = join(OUT, "CASES.json");

if (check) {
  const currentRecipe = existsSync(recipePath)
    ? readFileSync(recipePath, "utf8") : "";
  if (currentRecipe !== recipe) stale.push("CASES.json");
  if (stale.length > 0) {
    console.error(`[negative] STALE: ${stale.join(", ")}`);
    console.error("  run: npm run bless-negative");
    process.exit(1);
  }
  console.log(`[negative] up to date (${String(CASES.length)} cases).`);
} else {
  writeFileSync(recipePath, recipe, "utf8");
  console.log(
    `[negative] blessed ${String(CASES.length)} cases + CASES.json.`);
}
