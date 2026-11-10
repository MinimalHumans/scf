<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# SCF conformance

Companion to [scf-spec.md](scf-spec.md). This document defines what it
means to claim SCF support, so that the claim carries information.

**Status: release candidate (specification 1.0-rc.7).** Every section is specified. What is known to be
unfinished is tracked in [stability.md](stability.md); the one check the
validator cannot yet make is named in §4.

---

## 1. Why roles

"Supports SCF" is not a useful claim. A production tracker that reads
scene and character data has nothing in common with an editor that
maintains spans, cascades and identity across edits — and requiring the
tracker to implement span anchoring in order to say it reads SCF would
guarantee that nobody says it.

So conformance is claimed **per role**. Three exist, each a strict
superset of the one before.

---

## 2. The roles

### 2.1 Reader

**Claim:** *reads SCF 1.0.*

A Reader opens a `.scf` and answers questions about it. It does not
write.

A conforming Reader MUST:

- open any SQLite file carrying the SCF table set, without requiring
  `application_id` or `user_version` (spec §1.2);
- tolerate missing registry columns and unknown tables (§1.3, §1.4,
  §10.1);
- derive rather than read every value listed in §3.2;
- order scenes by story order, with the full fallback chain, and never
  by `scene_number` alone (§4.1);
- apply the position pattern the registry declares for each entity
  (§4.5);
- derive span membership from start boundaries (§5.1) and treat
  `scene_sequence` rows as potentially stale (§5.4);
- read relationships from both character columns (§6.5);
- resolve direction root-first, most specific last, and report every
  contributing layer (§7);
- return a usable answer on half-placed, dangling and contradictory
  data, and report the problem separately (§9.2);
- **exclude every row whose `lifecycle_status` is `cut`** (§6.6.1) — from
  story order, from spans, from cascades and from every result. A cut
  row is not in the film, so adding one to a file must change no answer.

A conforming Reader MUST NOT:

- match rows across files by uuid (§6.2);
- rely on `screenplay_lines.scene_id` (§3.4);
- reject a file whose schema version is higher than it knows (§11.2).

**Assets are optional for this role.** A Reader that does not resolve
assets MUST report every asset with a rooted identifier as
`unaddressed` (§8.3) rather than `missing`. An absolute identifier, or
one containing `..`, is `out-of-root` all the same: that state is
decided by the identifier, and needs no resolution to report (§8.2).

**`unmaterialised` is not required of any role.** Detecting a cloud
placeholder is a property of the environment, not of the format (§8.3),
and no conformance check asks for it — there is no fixture for it and
there cannot be one, since a placeholder is a filesystem state rather
than a file. A resolver that never produces the state is conforming; one
that reports a placeholder as `missing` is not.

### 2.2 Writer

**Claim:** *reads and writes SCF 1.0.*

Everything required of a Reader, plus:

- backfill missing uuids on open (§6.1);
- add missing registry columns rather than refusing the file (§1.4);
- preserve every table, column and row it did not originate, including
  from a schema version it does not know (§10.1, §11.3);
- never store a value §3.2 requires to be derived;
- never rewrite an authored `shot.shot_number`, except when the shot
  moves to a different scene (§3.3);
- never recompute numbering on a file whose `project.numbering_policy`
  is `fixed` (§4.3);
- report duplicate natural keys rather than rejecting them (§6.4);
- never create a prop by automatic acceptance (§9.3);
- carry a resolution report on any export containing asset references
  (§9.6);
- never embed asset bytes (§8.1).

**The defining test for this role is round-trip integrity:** open, save,
and lose nothing. See §3.

### 2.3 Editor

**Claim:** *authors SCF 1.0.*

Everything required of a Writer, plus maintenance of derived state
across edits:

- re-derive story order, span membership and cascades after any edit
  that could change them;
- apply the ownership rule when deleting a scene — rows owned by it are
  deleted, rows pointing at it keep identity with the reference cleared,
  and span start anchors are re-anchored first (§2.3);
- keep `scene_sequence` shadow rows consistent at commit, and report
  rows no boundary explains (§5.4);
- assign identity explicitly on any operation that creates or destroys
  rows, rather than inferring it from text editing (§9.3).

The reference editor (`scf-app`) is the only implementation claiming
this role.

---

## 3. Round-trip integrity

The Writer claim rests on one property: **a read-modify-write cycle
loses nothing.**

Settled, and tested:

- unknown tables, unknown columns and rows the writer did not originate
  MUST survive (§10.1);
- uuids MUST be stable across the cycle for every row that was not
  edited (§6.1);
- authored `shot_number` values MUST survive (§3.3);
- scene numbering MUST survive on a `fixed` file (§4.3);
- the header stamps MUST survive (§1.2).

### 3.1 What the comparison is performed on

Not the bytes. SQLite reorders pages, reuses freelist space and changes
file size without any row changing, so two byte-different files
routinely say exactly the same thing: a byte comparison would fail
constantly and mean nothing when it passed.

The comparison is a **canonical dump**, specified in `scf-spec.md` §11.6
and implemented as `canonicalDump()`. Every table sorted by name —
including unknown ones, since skipping those would miss the one failure
this role is most likely to have. Rows sorted by uuid where the table
has one, by full content where it does not. Columns sorted by name. Row
ids excluded by default, because they are not identity (§6.2).

Two files with the same canonical dump are the same SCF document,
whatever their bytes.

### 3.2 Status

`scf-app/test/roundTrip.test.ts` exercises the app's own open→edit→save
cycle: ten cycles with no edits change nothing; three cycles preserve an
`x_` table, an `x_` column with its values and an unprefixed unknown
table; an edit shows up in exactly one table and nowhere else; authored
shot numbers, `fixed` scene numbering and the header stamps all survive.

One test guards the guard — it drops a table and asserts the dump
notices, because a dump that silently skipped unknown content would
report success while the very thing §10.1 protects went missing.

What is still untested: a cycle driven through the browser's own
`sqlite3_js_db_export` and the File System Access adapter. The Node
driver exercises the same serialise-and-write guarantee, but not that
code path.

---

## 4. The validator

A validator takes an arbitrary `.scf` and reports findings without
opening the reference editor. It is what turns a conformance claim from
an assertion into something a third party can test.

Its scope, in order of value:

1. schema version, and whether the file carries `application_id` /
   `user_version` (§1.2);
2. tables and columns present that the registry does not define — a
   report, not an error (§10.1);
3. dangling references where a code names them — a relationship
   endpoint (§6.5), a span boundary (§5.5), a line anchor (§3.5); a
   reference column naming a missing row has no general code;
4. duplicate natural keys, and whether the duplicates agree (§6.4);
5. relationship findings, all seven cases (§6.5);
6. structural findings — spans with no boundary, boundaries on deleted
   scenes, two acts on one scene, shadow rows no boundary explains
   (§5.5);
7. asset resolution tally by state, given a root mapping or none (§8.3);
8. orphaned assets (§8.6);
9. identity findings — missing uuids, uuid collisions within a table
   (§6.1).

**Built since 0.15**: `scf-core/scripts/scf_check.mjs`, registered as
the `scf-check` bin, over the library code that already did the work —
`identity.ts`, `resolution.ts`, `assets.ts`, `relationships.ts`,
`junctions.ts`, `structure.ts`, `assetIndex.ts`. The finding vocabulary landed in spec 0.14:
`findings.ts` defines a closed catalog of codes with catalog-owned
severities, and `collectFindings(exec, registry)` is the engine — one
implementation of "what is wrong with this file", shared by the CLI,
the editor's panels, and the tests.

    scf-check FILE...          human-readable report
    scf-check --json FILE...   the serialised report (§9.5)
    scf-check --quiet FILE...  exit code only

Exit codes: **0** no errors, **1** at least one error finding, **2** the
file could not be read at all. The 1/2 split is deliberate — a file with
errors is one SCF read and understood; a file it could not open is a
different kind of problem, and a CI job should be able to tell them
apart. Warnings and info never fail, per §9.1.

Items 1, 2, 3, 4, 5, 6, 8 and 9 of the list above are covered. **Item 7,
the asset resolution tally, is not**: it needs a mapping from a root
name to a location, and the CLI has no way to supply one. That is not an
oversight in the tool — §0.3 makes the root mapping a property of the
consuming environment, so a validator has to be told, and the flag to
tell it has not been designed.

---

## 5. Test artifacts

Every artifact this section names is published at the specification
version's tag and checksummed in `SHA256SUMS`. Fetch them from
`spec-<version>` — for this document, `spec-1.0-rc.7` — never from
`main`; [ARTIFACTS.md](ARTIFACTS.md) gives each file's address, and
which files the schema tag addresses as well.

### 5.1 The fixture

`fixtures/hollow_creek.scf` is not sample data. It is a normative
artifact: several of its properties are asserted by the conformance
suites and MUST NOT change.

- **Scene numbers have gaps** (1, 3, 7, 9, …). Suites address scenes by
  number.
- **Screenplay order, scene-number order and row-id order are three
  DIFFERENT orders**, and MUST stay that way. `12A` sits mid-script with
  a higher row id than the active scenes either side of it — 12 and 19
  — though not than the cut `12B` just before it; `16` follows `19` in the script and keeps its
  number, which is legal because the project is `fixed` (§4.3). Until
  0.17 the three coincided, and a reader ordering by `scene_number`
  alone — the one thing §4.1 forbids — passed every blessed expectation.
- **Scene `12A` exists**, so §4.2.1's grammar is exercised by the
  artifact meant to demonstrate it.
- **Scene `12B` is CUT and keeps its heading**, and a cut
  `performance_beat` sits in scene 12. Both MUST change no answer
  (§6.6.1). Adding a cut row that nothing may notice is a stronger
  statement than having no cut rows at all — and it is why scene 12's
  pin below permits a cut row while permitting nothing else.
- **A cut character, Deputy Rourke, is linked into scenes 12 and 19 and
  carries the Forgiveness theme** through an active connection. He is
  in no answer: not in the published `Q04`'s cast, not in `Q03` at 19,
  and his connection is not among `Q10`'s carriers, nor counted on its
  spine (§6.6.1, §12.11). Before 1.0-rc.5 the fixture's only cut rows
  were reached by nothing a published result depended on, so a reader
  that ignored cut endpoints reproduced every result; one that does now
  fails three. Uncutting him MUST change those three.
- **A tone marker is keyed to a sequence alone** — "Held breath", on
  The Reckoning, which holds scene 12 — so the published `Q11` and
  `Q04` show that a row keyed by its sequence is at no scene (§12.13).
- **Twelve scenes carry action; scene `11` is a slugline only.** An SCF
  is legitimately an outline or a finished screenplay, and a conforming
  reader meets both in one file. Before 0.17 the fixture had no body
  lines at all, which left §3.4 — read a scene's text from its heading
  to the next — with no artifact behind it. Scene `11` is now the whole
  of the outline half, so filling it in removes a demonstrated property
  and MUST update this list. Six of those scenes carry dialogue as
  well; the six that do not are wordless on purpose, not omissions.
- **Scene 12 is pinned** — its motif manifest, its single sound cue, its
  costume set and its direction chains are asserted exactly. Nothing
  ACTIVE may be added to it. A **cut** row may be, precisely because
  §6.6.1 requires it to change nothing: the pin and the cut row test
  each other.
- **One asset's identifier is absolute, on purpose.** The locket's
  engraving macro sits on an art department drive, so with no root
  mapped its reference is `out-of-root` beside the locket's `unaddressed`
  ones (§8.3), as the published `Q02-locket-scene25` shows, and the
  fixture's report carries its one warning, `asset.identifier_absolute`.
  Rooting it removes the only published `out-of-root`.
- **Seven assets have no file behind them, on purpose.** The costume
  `.zip`, two `.wav`s, the two `.exr` plates, the locket `.glb` and the
  absolute `.tif` are the
  only non-`png`/`mp4` entries in an otherwise real folder tree, and
  they are what keeps `zip`, `exr`, `glb` and `tif` in the derived format set,
  the `sound/` folder in the path tree, and something in the file that
  a browser cannot show. Tidying them away as fictional breaks three
  suites and removes the demonstration that a real project is not all
  previewable.
- **Marcus's vocal profile is deliberately thin and his voice bundle
  deliberately absent** — the readiness suite asserts Q05 warns about
  exactly those gaps. The absence is part of what the fixture
  demonstrates, and it only reads as deliberate because Eleanor's voice
  bundle is present beside it.
- **Shot 12-04 keeps a production numbering scheme** the derived code
  disagrees with, demonstrating §3.3.
- **A second, narrowly carried theme** exists so Q10's gap reporting has
  something to report.

Rebuild scripts: `fixtures/build/`.

### 5.2 The suites

| Suite | Covers |
|---|---|
| `conformance.canonical.test.ts` | The canonical query semantics — persistence, latest-wins, the cascade. |
| `conformance.readiness.test.ts` | Findings on deliberately incomplete data. |

These test the reference implementation against the fixture. They do not
test an arbitrary file, which is what §4 is for.

### 5.3 Negative fixtures

Nineteen cases in `fixtures/negative/`, each a minimal database plus
exactly the damage its name describes, with a blessed report beside it.

Minimal on purpose: a case that trips three findings tells you nothing
about which code belongs to which condition. The first draft used
readable strings like `ch-1` for uuids and every case reported
`identity.uuid_malformed` alongside the thing it was meant to
demonstrate.

The `.scf` files are **built, not checked in** —
`npm run bless-negative` regenerates them, `npm run check-negative`
verifies the blessed reports in CI. A fresh database per case is several
megabytes of binary in a repo whose point is a text-first format, and
they are exactly reproducible. The reports are the artifact, and unlike
the databases they diff.

Reproducible **by anyone**: `CASES.json` publishes each case's
statements in order, so a third party builds each database from its
description rather than guessing its report. That file is
generated by the same script that builds them, so it cannot describe
something the script does not do.

Covered: missing, malformed and duplicate uuids; a relationship endpoint
that is absent, a contradictory pair, and one with no directionality; a
span boundary on a scene that is not present; an asset identifier that
escapes its root and one that is absolute; a bundle no binding reaches;
two orphaned assets, which are one finding with `count` 2 (§9.5's
grain); an unknown table; an unstamped header; a screenplay line whose
`line_type` is outside the published set (`line.type_unknown`); a link
with a missing end (`junction.endpoint_absent`); a link whose key
columns are null, which compare equal (`junction.duplicate_key`); a span
whose start scene is cut (`structure.boundary_cut`); and a section line
bound to an act renamed since (`structure.section_mismatch`).

### 5.4 The canonical query expectations

`fixtures/expectations/`, blessed and checked on every test run. Spec
§12 defines all sixteen queries as result structures.

**`<Q>.result.json` is the normative artifact for every one of the
sixteen**, and carries nothing file-local: rows by uuid, no row ids, no
timestamps, references resolved.

**`<Q>-<case>.result.json` is normative too.** One position cannot show
every member of some results: Q02's prop and location members fill only
for a prop or a location subject, Q15's version chain only for a
versionable row, a variant only where one is in force. A case result
asks the same query somewhere that can, and its selectors are published
with the rest. Without them a reader ignoring variants, vocal states or
version chains reproduced every result byte for byte.
`scf-core/test/resultCoverage.test.ts` fails if any member is empty in
every result of its query, save the two `sizeBytes` that are empty by
definition (§8.3).

`<Q>.expected.md` accompanies eight of them — the rendered context
markdown, which is what a consumer of those queries actually receives.
Names, not ids. It is a convenience, and a contract for none of them.

A third artifact, `shapes.json`, was **retired in 0.30**. It sketched
the app runners' raw payload structure, predated §12, and recorded a
flat row with an unresolved `<row-ref>` where a result carries
`{ uuid, fields }`. Once all sixteen queries had normative results it
asserted a weaker version of the same property in a shape this
specification does not describe — two artifacts for one property,
free to disagree.

**Payloads themselves are not blessed.** They carry row ids, and row ids
are file-local (§6.2), so a second implementation reading the same
fixture would legitimately produce different ones. Expectations that
failed for that reason would teach a reader to stop believing them.

Parameters resolve from **selectors**, published as
[`selectors.json`](../fixtures/expectations/selectors.json) — scene number 12, the character
named Eleanor — recorded alongside the expectations, so another
implementation can resolve them for itself.

That sentence was true of the intent and false of the repository until
0.40: the selectors lived in two test files, one of which covered only
the eight queries with rendered markdown, and nothing shipped. The
fourth reader run recovered five from prose in this document and then
read four more out of the `parameters` block of the artifact it was
about to be graded against. Q13's was the sharpest — its `intent` was
not in that block either, and the reader took it from the RESULT, so it
had to read the answer in order to learn the question. Both are fixed:
the selectors are published and Q13's envelope carries what it was
asked.

Q03 and Q12 are blessed **away from scene 12** — at 19, and diffing
19 → 16 — because the rest of the expectations cluster there, and a
live ordering bug once sat under a fully passing suite for exactly
that reason.

---

## 6. Claiming conformance

Self-certification. There is no certifying body, no registry of
implementations, and no fee — the artifacts are public and the checks
are runnable, which is the whole mechanism.

### 6.1 The procedure

**Reader.** Against `fixtures/hollow_creek.scf`:

1. Run your validator over the fixture — for the reference, `scf-check`.
   It MUST report no `error` finding (`scf-check` exits 0), its findings'
   codes and severities MUST come from
   [`finding-catalog.json`](finding-catalog.json), and its report MUST
   match [`hollow_creek.report.json`](../fixtures/hollow_creek.report.json)
   as step 3 compares a report.
2. Reproduce the canonical query expectations in
   `fixtures/expectations/` for the queries you implement. For each
   query, compare against its `.result.json` and every
   `<Q>-<case>.result.json`, as JSON values (§12.1.6). **Two members are
   prose and are compared as present strings, not by content**: a
   reference's `detail` and a trail entry's `excluded.reason` (§12.8);
   both are null in the same places. No other member is prose: Q04's
   `detail` is a list of projected rows and is compared as one. Q14 is compared as §12.9 says. The
   rendered markdown is **not** a contract for any query.
3. Build the negative fixtures from
   [`CASES.json`](../fixtures/negative/CASES.json) — an empty conforming
   database per `scf-schema.sql`, **plus the header stamps of spec §1.2
   and the `_scf_meta` row `schema_version`**, then each case's
   statements in order —
   and validate each. Compare each finding of its blessed report by
   `code`, `severity`, `table`, `count` and `rowIds` (spec §9.5); its
   `message`, `title` and `spec` are for people and are not compared.
   Extra findings are permitted and MUST be disclosed; missing ones are a
   failure. A statement ending `-- params: [...]` binds that JSON array to
   its `?` placeholders.

**Writer.** Everything above, plus:

4. Open the fixture, write it back unchanged, and show that the
   canonical dump (§3.1) is identical.
5. Do the same with a file carrying an `x_` table, an `x_` column and an
   unprefixed unknown table. All three MUST survive.

**Editor.** Everything above, plus a statement of which derived state
you maintain across edits (§2.3). There is no mechanical test for this
role; it is a description, and it should read as one.

### 6.2 The claim

A claim states: the **role**, the **specification version** — whose
`spec-<version>` tag holds the artifacts the reports were produced
against (§5) — the **schema version range** accepted, and any
**disclosed divergences**.
Publish it where your users will find it, and link the reports.

A claim without the reports is a claim about your intentions.

### 6.3 What a claim is not

It is not a guarantee, an endorsement, or a licence to use the name for
anything else (the trademark statement in `NOTICE` governs that).
It is a statement that on a stated date, against stated artifacts,
your implementation behaved as described — and a reader can check.

---

## 7. Current status

| Implementation | Role claimed | Basis |
|---|---|---|
| `scf-core` | Reader | The canonical and readiness suites pass against the fixture; `scf-check` exits 0 on it; all nineteen negative fixtures report as blessed. |
| `scf-app` | Editor | The app suite passes, including the open→edit→save round trip and third-party content preservation across repeated cycles. |
| — | Writer | No independent implementation exists. |

There is no second **maintained** implementation. An independent one
has been written from the text for every reader run, by people without
the reference code (eleven so far, `docs/release-checklist.md` §D1), and
none is kept current. Until one is, every rule in the
specification is guaranteed only to be implementable in the way it was
already implemented, which is the weakest form of that guarantee — and
the reason §6 exists in a form a stranger could actually follow.
