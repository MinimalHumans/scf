<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# The road to SCF 1.0 — release checklist

**Rev 14**, checked against `scf@main` at `37d47d5`
(2026-10-06) — spec **0.61**, schema **2.21**. Regenerated from the
tree, not edited forward from rev 13, which described spec 0.51 and
schema 2.13 and had drifted the way every untracked description here
eventually does.

**Decisions settled 2026-10-08** (§A): every ⚠️ in this list is now a
decision, and the work they add is §B8. `main` had moved to `3f3f7e9`
by then; no decision depends on the difference.

**Since then (2026-10-08):** 0036 landed as **spec 0.62, schema 2.22**,
tagged `schema-2.22` — so the release batch §A7 describes is **2.23**,
and every release-schema reference below says so.

**Since then (2026-10-09 – 10-15):** 0037 (shot and scene media) and
0038 (the project poster) are committed — `d651077`, `350c181`,
`54c8cf4` — as **spec 0.65** on **schema 2.23**, which was then
**tagged and pushed** as `schema-2.23` on 2026-10-12 (`50624af`); both
proposals say `implemented`. So the rest of the batch (§B8) landed as
**schema 2.24**, the release schema, decided 2026-10-16: a published
tag is not reused, as with 2.22. The week's other work was editor-only
(presentation, storyboard and shot-list tabs, screenplay export,
gallery, asset statuses) and touches nothing on this list.

**Since then (2026-10-16):** §B8, §B2 and §D3 landed as spec 0.66–0.68,
and the candidate as **spec 1.0-rc.1** on **schema 2.24**, both tagged
and pushed (`spec-1.0-rc.1`, `schema-2.24`). A documentation audit
followed before D1 — §D6.

✅ done · ◑ partial · ○ to do · ⚠️ decision needed · 🔒 one-way door

---

## Where this stands

**The machinery is green.** On a fresh clone, `tools/verify.py` passes
all 28 steps plus the published checksums: scf-core **762 passed / 6
skipped** (46 files), scf-app **373 / 1** (32), scf-mcp **27** (2),
45 artifacts, 275 public exports, 52 finding codes, 106 entities.
`scf-check` reads the fixture with 0 errors, 0 warnings, 5 info *(6 since §B2)*.
`schema-2.21` resolves at its tag and matches `SHA256SUMS`.

**What is not green is everything nothing checks.** Since rev 13 the
format absorbed proposals 0004–0035 — presence, line anchors, variants,
binding filters and combination, open vocabularies, `string_list`,
`required` — across spec 0.50–0.61 and schema 2.14–2.21. That work was
careful, and it left three kinds of debt behind:

1. **Prose that states old facts**, including in checksummed,
   normative documents (§B4).
2. **Twenty members that are empty in every normative result**, so a
   reader that ignores variants, voice states or version chains is
   byte-identical to one that implements them (§B2). The run-4 and
   run-5 pattern, again.
3. **A reference editor that re-derives queries scf-core already
   answers**, and has kept the bugs scf-core fixed (§B1).

None of it is large. All of it should be closed before the tag, because
**1.0 is where §11 starts binding** and where several of these become
expensive.

## What 1.0 commits you to 🔒

Stated first, because it decides what has to happen before the tag
rather than after it:

- **§11.0 inverts.** Files stop being disposable; removing a column,
  renaming a field or narrowing a type becomes a major change. Every
  removal still under discussion (§A) has to be settled now.
- **`registry.json`, the result envelopes and the report format become
  surfaces people build against.** Removing a member from any of them
  after 1.0 is a breaking change to a published artifact.
- **npm publish is irreversible after 72 hours.**

A **release candidate** keeps all three doors shut: tag `spec-1.0-rc.1`,
keep §11.0 in force, hold the npm publish, and run the sixth reader
against the candidate (§D1). **Decided: the release goes through an RC
whatever the timing** (§A13). The decisions below add normative text
after the last reader run — a new §12.17 order, the clip rename,
`audio_offset_*` semantics, a new finding — and that is the kind of
text runs 4 and 5 found criticals in.

---

## A. Decisions — settled 2026-10-08

Each was a conversation, not a build, and each is now decided. The
proposals carry their resolutions; the work the decisions create is
§B8.

| | # | Item | Decision |
|---|---|---|---|
| ✅ | 1 | **0002 — ownership by declaration.** §2.3 deletes by column name; `clip.scene_id` made "cut the scene" delete its footage. | **Accepted, narrow form.** A clip is *not* deleted with its scene: footage outlives the script. `clip.scene_id` is renamed so it points at the scene and is cleared on delete, and `lint_registry.py` requires every new `<entity>_id` without a declared parent to be recorded as deliberate. Populating `parentEntity` on the thirty-three and rewriting §2.3 is deferred past 1.0 (§F) — done that way it can reproduce today's behaviour, so it is non-breaking later. `stability.md` still marks §2.3 **Stable**; the rename is the last change before that is true. |
| ✅ | 2 | **0003 — absolute paths resolve.** | **Deferred** until the editor has named-root support. Behavioural and additive. |
| ✅ | 3 | **0014, 0019.** | **Declined**, reasons written into each file. |
| ✅ | 4 | **0015 — one location per scene.** | **Deferred.** `scene.location_id` stays and stays the primary; that is what keeps a later `scene_location` link additive. |
| ✅ | 5 | **`sequence.act_id`** — stored, derivable, unspecified, undefined for a sequence that crosses an act. | **Removed** in 2.24 under §11.0. Acts derive from boundaries. The app's writes and reads go (`structureCommit.ts`, `StructureView.tsx`, `EntityList.tsx`; Q04's goes with §B1), ~~and so does the finding that only checked it, `structure.sequence_act_mismatch`~~ — **corrected 2026-10-16:** the finding never read `act_id` (it reports a span crossing an act) and stays. |
| ✅ | 6 | **The registry's `queries` field** — wrong in both directions since rev 6, checked by nothing. | **Unpublished.** Dropped from `registry.json` and `registry.schema.json` in 2.24. The Python ontology keeps it, because `entity_registry.py`'s lint uses it to enforce that every entity serves a canonical query. Generating a true list from what each `qNNResult()` reads is additive and can come after 1.0. |
| ✅ | 7 | **One schema bump, not four.** | **2.23 is the release schema** *(2.24 since 2026-10-16 — see the top)*, carrying every registry change in this table — the clip rename, `act_id`, `queries` and the `audio_offset_*` help text. `project.synopsis` already shipped on its own as **2.22** (§A14), tagged before this pass settled the numbering; that tag stays as published rather than being reused, so the release batch is 2.23. Numbering stays `2.x`; no 3.0. |
| ✅ | 8 | **The schema floor.** §0.6's "2.12 and later" is false. | §0.6 says the spec describes **exactly schema 2.23** — no "and later". Later compatible 2.x revisions are governed by §11, not by the floor sentence. |
| ✅ | 9 | **`entity_anchor.audio_offset_*` has no stated meaning.** | **Specified, matching what the editor already enforces** (`mediaOps.ts`): non-negative seconds from the start of the asset's playable audio (t = 0 at the first sample); the span is start-inclusive, end-exclusive, and end MUST exceed start; a null bound is open (null start = from the beginning, null end = to the end, both null = the whole recording); meaningless on an asset without audio, where a reader MUST ignore them. In the help text and in §12.8. |
| ✅ | 10 | **Does 1.0 include the editor?** | **No.** 1.0 is the format, its artifacts and `scf-core`; the editor ships as the reference editor on its own version line. **`scf-mcp` is published to npm at 0.x** after `scf-core`, with a version range on it and no 1.0 stability promise. `editor-mvp.md` §9 should say so. **Changed 2026-10-19:** the MCP now runs only inside the desktop app (`scf-editor mcp`), so `scf-mcp` is not published; the range rewrite (`pack_with_ranges.mjs`) was removed with it. |
| ✅ | 11 | **The night kitchen (D2).** Scenes 10 and 19 (night, winter) tie the night variant (time) against the morning baseline (season), and the tie gives a night scene morning dressing. | **The rule changes, not the fixture.** §12.17 compares the axes in order — `time_of_day`, then weather, then season — instead of counting them equally; the baseline still breaks a full tie and still wins when nothing agrees, and `varies` still agrees on time. Scenes 10 and 19 then resolve the night variant; scene 12 is unchanged. Normative: `resolution.ts`, §12.17's text, re-bless Q04. |
| ✅ | 12 | **An unknown `line_type` raises no finding (D4).** | **A finding: `line.type_unknown`, severity error** — a writer broke a MUST NOT. The line is kept as unknown content; the finding names its uuid and the value. §1.3.1's "no finding is raised" sentence is replaced — its own reasoning, a wrong answer given in silence, is the case for the finding. |
| ✅ | 13 | **RC or straight to 1.0.** | **RC first, always.** Tag `spec-1.0-rc.1`, keep §11.0, hold npm, run D1 against the candidate, then cut 1.0. |
| ✅ | 14 | **0036 — `project.synopsis`** (opened after rev 14 was written). | **Accepted into 2.22, and implemented** (`0d65695`, spec 0.62): the field, a three-paragraph synopsis authored on Hollow Creek's project row, Q00's normative result carrying it, and the editor's Project tab showing it under the logline. The "uncommitted work on another machine" was this. |
| ✅ | 15 | **`docs/conventions.md`** (§C). | **Deferred** past 1.0 (§F). |

---

## B. Defects found in this pass — fix before the tag

### B1. ✅ The app's query pages re-derive what scf-core answers

`scf-core` exports a normative `qNNResult()` for **all sixteen**
queries. The app's query pages call scf-core for Q03 and Q12 and
re-derive the rest in `scf-app/src/ui/queries/runnersComposed.ts`, and
the copies have kept bugs the core fixed:

- **Q04 lineage reads `scene_sequence` and `sequence.act_id`**
  (lines 365–372). §5.4 says a conforming reader MUST derive membership
  from boundaries — the R88 fix, never carried to the app.
- **Q04 cast and props, and Q02 costumes, join without the cut filter**
  (lines 223, 384, 387). The five junction-join sites R89 fixed in core
  with `excludeCut`; a cut character still appears on the app's Q04
  page. *Found by reading; not run.*
- **No presence and no variant on the Q04 cast** (0030, 0035).
- `SCENE_DETAIL` is a second copy of `Q04_DETAIL`.
- The header comment says Q15's `affected_entities` is unpopulated in
  the fixture; it has been populated since 0.54.

**Fix the class, not the instances:** every query page renders scf-core's
`qNNResult()` and owns only its markdown. That deletes most of
`runnersComposed.ts`, and a check — no `ctx.exec` under `ui/queries/` —
keeps it deleted.

**Done 2026-10-15.** All sixteen pages call `qNNResult()`; the JSON tab
shows the normative envelope scf-mcp serves, and `runnersComposed.ts`
is deleted. Rows arrive projected, so the views read `{ uuid, fields }`
(field order from the registry) and open rows by uuid; the param picker
carries each row's uuid beside its id for the envelope.
`runners.test.ts` runs all sixteen against the fixture and fails on any
`ctx.exec` under `ui/queries/`. Q04 now shows derived lineage, the cut
filter, presence and variants (sc 25: Marcus *as Marcus, age nine*); Q03
and Q12 show variants where one is in force. Seven of the eight blessed
`.expected.md` files are byte-identical; **Q13's** was re-blessed — its
title no longer prints a row id (`character #1`), and the asset list
the References section duplicated is gone. Two page-only extras went
with the copies: Q15's "unattached" list and the anchor's
`canonical_status` tag on Q13. The `act_id` writes and reads outside the
query pages (`structureCommit.ts`, `StructureView.tsx`,
`EntityList.tsx`) stay for §B8.

### B2. ✅ Twenty members empty in every normative result

Measured by walking the sixteen `fixtures/expectations/Q??.result.json`.
For each, a reader that never produces the member at all is
byte-identical to a correct one:

| Member(s) | What it hides |
|---|---|
| `Q03.characters[].variant`, `Q03.props[].variant`, `Q04.cast[].variant`, `Q04.props[].variant`, `Q12.{characters,props}[].variantFrom/variantTo`, `Q02.characterVariant`, `Q02.locationVariant`, `Q02.propVariant` | **All of 0033 and 0035.** The only result carrying a variant, `Q13-scene25`, is not normative. `stability.md` says so; nothing fails. |
| `Q05.states`, `Q05.modulations` | The voice query's own content. The blessed position has no vocal state. |
| `Q15.versionChain` | §12.14's version chains. All three screenplay version tables are empty. |
| `Q02.propState` | Prop state in a subject's context. |
| `Q01.motifCarriage`, `Q02.dossier.motifCarriage` | Motif carriage in the dossier. |
| `Q09.candidates` | Q09's second half. |
| `Q02/Q13 …sizeBytes` | **Expected** — environment-dependent (§8.3). Not a gap. |

**Cheapest close: bless normative Q03, Q04 and Q12 at scene 25**, where
a variant is in force — data, not code, the same move 0.22 made by
blessing Q03 away from scene 12. Then author the remaining rows through
the dump/rebuild loop, together with `editor-mvp.md` §3's three:

- `performance_beat.line_ref` — **0 of 14** beats anchored
- `screenplay_prop_tags` — empty
- `screenplay_versions` and both version tables — empty (also closes
  `Q15.versionChain`)

Also empty and read by normative code: **`prop_variant`** (variant in
force for props) and **`set_dressing`**, which `Q04_DETAIL` lists.

Twenty-five of 113 fixture tables are empty in all. Most are unread
design entities and can stay that way; the ones above are the ones a
normative query reads.

**Done 2026-10-16, as spec 0.67** (fixture content only; schema stays
2.24). The cheapest close was not enough: one position cannot show
Q02's prop and location members or Q15's version chain at all. Decided
2026-10-16: **per-case normative results**, `<Q>-<case>.result.json`
beside each query's own, with published selectors, in the manifest, and
named in `conformance.md` §5.4 and §6.1. Every existing position stays
— scene 12, the 19 → 16 reorder — because each was chosen to show
something.

- **Cases:** `Q02-marcus-scene25`, `Q02-locket-scene25`,
  `Q02-kitchen-scene10` (§12.17's ranked axes, now in a published
  result), `Q03-scene25`, `Q04-scene25`, `Q05-scene19`,
  `Q12-scene24-25`, `Q12-scene25-24`, `Q15-plate-v2`; `Q13-scene3` and
  `Q13-scene25` promoted from examples. 56 manifest files.
- **Rows authored:** the locket's variant, a scene 25 `scene_prop` naming
  it and a state there; `motif_appearance` 14 carried by Eleanor;
  *Unfinished sentences* related to *Ada's locket* (Q09's candidate);
  kitchen `set_dressing` at scene 12; the night plate's v1, superseded
  by v2, and a note attached to v2; **7 of 14** beats anchored by
  `line_ref` (the other seven quote no script line, on purpose); one
  `screenplay_prop_tags` row.
- **Not authored:** `screenplay_versions` and its line table. §0.4 puts
  them outside 1.0 and readers MUST ignore them, so no normative result
  reads them; Q15's version chain is §6.1's and is now exercised by the
  asset. Left for `editor-mvp.md` §3.
- **The vocal state** came from Eleanor at scene 19 (*wrung-out*), not a
  new row at scene 12: scene 12 has none on purpose, so the injury raises
  Q14's suggestion there.
- **The check for the class:** `scf-core/test/resultCoverage.test.ts`
  fails if any member is empty in every result of its query; only the
  two `sizeBytes` are excused (§8.3), and an excuse that stops being
  true fails too. Against the old results it reports the gaps.
- `scf-check` reads the fixture with **6 infos**: the superseded v1 is
  `asset.orphan`, which is true and now exercised. The walkthrough says
  so.

### B3. ✅ Eight proposals implemented but still `draft`

**0010, 0011, 0017, 0018, 0020, 0021, 0023** landed in schema 2.14 —
the registry carries every field they add and lacks the one 0021
removes — and **0006** was superseded by 0023. All eight still say
`draft`, so the directory understates what was built by a third.

**`check_proposal_status.py` missed them** because its pattern needs the
word "proposal" before the number, and the schema changelog cites them
parenthetically — `scene.characters_present` **(0021)**. Widen the
pattern to a parenthesised four-digit number, fix the eight, and the
check covers what it was written for.

**Done 2026-10-08.** The check matches `(0ddd…)` citations too — a
leading 0, so a year in parentheses cannot match — and on its first run
flagged exactly the seven above. All eight now say `implemented`, with a
Resolution confirmed against the registry rather than the changelog;
0006 as implemented through 0023. 27 proposals are recorded as landed,
all agreeing.

### B4. ✅ Checksummed documents that say false things

The R86 class: a hand-written count or version beside a fact that
moved.

**`spec/scf-spec.md`**
- §0.6: "Currently `0.54`" and "Currently `2.19`" under a header saying
  0.61 and 2.21. "Describes schema 2.12 and later" — see §A.
- §4.5's table: "95 of 103 entities" — **98 of 106**.
- §7: "Twelve of the 103" — twelve is right, **106**.
- §2 (line 339): "Version 2.19 defines 106 entities" — 2.21.
- §11.0 names 2.9 and 2.12 as the changes taken under it. 2.14, 2.15
  and 2.21 removed fields too.

**`spec/conformance.md`**
- Its status line promises sections "marked *not yet specifiable*"; no
  section is marked.
- §4, "The validator", opens with "*Not yet built.*" `scf-check` has
  existed since 0.15.

**`spec/stability.md`**
- Header: "0.59 / schema 2.19".
- **"Polymorphic `_id` columns dropped"** still says `projectRow()`
  drops any `_id` with no `referenceEntity` — **the 0.29 rule 0.40
  removed**, contradicting the row 56 lines above it.
- Artifact addressing: "41 files … 42 as of 0.33" — **45**. API:
  "224 names" — **275**. Finding catalog: "36 codes" — **52**.
- Patterns 1–3 cite **§4.3** (numbering policy); they are **§4.5**.
- "Expectation coverage" still waits on queries being specified.
- **`varies` is marked Implemented: No.** `resolution.ts:430`
  implements it — the gap is that no fixture variant uses it. By this
  document's own definition of 1.0 ("every 'not yet implemented' note
  to done"), a wrong *No* blocks the release on paper. Same review for
  the `status` row: "nothing reads it" describes a writing stage, which
  nothing needs to read; the gap is again exercise, not implementation.
- "Rubric steps resolve to entities" sits under *Identity*.
- The summary still describes 0.38.

**The check worth adding**, since this keeps recurring: no bare count
of entities, codes, exports or artifacts in checksummed prose unless
the stamping step writes it. The generators already know every number
above.

**Done 2026-10-08 (spec 0.63, editorial), except that check.** Every
item above is fixed, plus seven the list missed: §0.7 still said 99
entities and **thirteen** link entities while §6.3 and §6.6 said
**fourteen** (the registry has sixteen); §2.4 "sixteen" open fields
(seventeen); and `stability.md`'s forward-compatibility row called §10.1
untested while its own history says it is tested. Where a count was not
load-bearing it was removed in favour of the generated file that holds
it, which is the class fix in prose form. `varies` and `status` now say
*Yes — not exercised*. §11.0 lists 2.14, 2.15 and 2.21, and
`check_spec_references.py` records their removed columns as history.

**✅ The check, too (2026-10-08): `schema/check_prose_counts.py`**, in
`verify.py` and CI. It does not ban numbers; it compares them. For each
quantity a generated file knows — entities, link entities, per-tier
counts, open fields, finding codes, exported names, manifest files, line
types, canonical queries — a number beside that noun in the reading
documents must be the true one. It skips sentences anchored in time
("in 0.53", "as of 2.14"), subsets ("eleven of the sixteen", or a count
under half the total), code blocks and changelogs. Run against the
documents as they stood before this pass, it finds twelve of the stale
counts above unaided. On its first run against the corrected tree it
found six more nobody had listed — `faq.md`'s "ninety-nine" twice, and
the tier counts in `what-is-scf.md` and `authoring-guide.md` (tier 0 is
26, tier 2 is 34, tier 6 is 18) — and all six are fixed.

### B5. ✅ `verify.py` fails on Windows

**Fixed 2026-10-08.** `py tools/verify.py --fast` now runs end to end on
a Windows checkout — all 23 steps and the published checksums green,
the site step skipped and said so. Before, it could not start.

- ✅ **Step 28 ran `python3`**, absent or the Store stub on Windows.
  It uses `PY = sys.executable`, like every other step.
- ✅ **The Python generators wrote CRLF on Windows.** Text mode
  translates `\n`, and four writers — `generate_registry_json.py`,
  `artifact_manifest.py`, `dump_fixture.py`, `screenplay_body.py` —
  did not pass `newline="\n"`. `0d65695` therefore published a
  `registry.json` digest over CRLF bytes that exist nowhere; git
  normalised the file on commit, so nothing looked wrong locally.
  Fixed at the root in `7f2fbb7`, and the digest corrected.
  `.gitattributes` already said why this matters; the writers were the
  exceptions to it.
- ✅ **`check_pin.py` crashed on Windows** decoding `git` output with the
  locale codec. It decodes as UTF-8, and it now hashes the tagged blob's
  **raw bytes** — it used to decode and re-encode them, so a digest that
  is defined over bytes went through a text round trip first.
- ✅ **`verify.py` would not start without `site/` installed.** The site
  step is skipped with a warning instead, and the summary says
  "everything run passes … 1 step skipped", never "everything passes".
  Its step output and its own console output are decoded and written as
  UTF-8, so neither a test runner's `✓` nor its own `…` breaks on
  Windows.
- ✅ **A CRLF working tree failed the golden-corpus test.** With
  `core.autocrlf=true` a Windows checkout can hold CRLF copies of LF
  files despite `eol=lf`. The corpus test (both tiers) and
  `bless_corpus.mjs --check` compare the blessed types after normalising
  line ends, so the check is about classification, not the checkout.

### B6. ◑ Packaging blocks the publish

- **`scf-core`'s `files` lists `LICENSE` and `NOTICE`, and neither
  exists in `scf-core/`.** `npm pack --dry-run` ships 224 files and no
  licence. Apache-2.0 §4 requires both to travel with the
  distribution. Copy them in at `prepack`, and make `pack-test` assert
  they are in the tarball — it checks everything else.
- No `repository` field (npm provenance and the package page need it);
  no `publishConfig.access: "public"`, which a scoped package needs.
- **The `@minimalhumans` npm scope does not exist** — the registry
  answers "Scope not found". Creating the org is free and reversible;
  publishing is not. Create it now, before the name is taken.
- `scf-mcp` depends on `"file:../scf-core"`; it needs a version range
  before it can be published. `scf-app` has no `license` field.

**Done 2026-10-08:** `tools/legal_files.mjs` copies the root `LICENSE`
and `NOTICE` in at `prepack` and out at `postpack` (the copies are
gitignored), for both packages; `pack-test` asserts both arrive
byte-equal, and without the hook the tarball has neither. `repository`
and `publishConfig.access: "public"` on both; scf-mcp gained a `files`
list (it had none, so it would have shipped its tests) and a README;
`scf-app` has `license`.

**○ Still open, and none can be done from the repository:**
- **Create the `@minimalhumans` npm org** — a step on npmjs.com.
- ✅ **scf-mcp's dependency** — decided 2026-10-08: the repository keeps
  `file:../scf-core`, and `tools/pack_with_ranges.mjs` replaces it with
  `^<scf-core's version>` for the length of a pack or publish, restoring
  `package.json` byte-for-byte after, failure or not. Publish with
  **`npm run publish:release`** in `scf-mcp/`; a bare `npm publish` is
  refused by a `prepublishOnly` guard while a `file:` dependency
  remains. A wrapper rather than a prepack hook because `npm publish`
  re-reads `package.json` after packing, so a hook restoring it at
  postpack would publish correct bytes under wrong metadata. `verify.py`
  and CI run its `plan` mode, so a rewrite that cannot be made fails
  now. Workspaces replace it after 1.0 (§F).
- **Both packages are `"private": true`**, which npm refuses to publish.
  Presumably the guard until publish day; flip it as part of §E.

### B7. ✅ Small hygiene

- **`scf-core/scripts/scf_check.mjs` is committed `100644`** but is the
  package's bin; installing chmods it, so `verify.py` leaves a dirty
  tree on Linux and macOS. `git update-index --chmod=+x`.
- **`schema-2.13` and `schema-2.21` are lightweight tags**; 2.14–2.20
  are annotated, as `ARTIFACTS.md` and §10 say they should be.
  Recreating 2.21 annotated *at the same commit* changes no bytes, so
  `check_pin` keeps passing.
- `verify.py` omits two checks CI runs — the corpus bless check and
  "the demo fixture is the conformance fixture". Both pass today.

**Done 2026-10-08:** `scf_check.mjs` is `100755` in the index; both
checks are `verify.py` steps. `schema-2.13` and `schema-2.21` were
recreated annotated at their own commits (`b1bdc18`, `fd371dd`), so every
schema tag from 2.12 to 2.22 is annotated, and `check_pin` still
passes.

### B8. ✅ Work the §A decisions add

Everything here except the finding lands in the **one 2.24
regeneration** — registry, `scf-schema.sql`, `entity-reference.md`,
every artifact, the fixture rebuild — so do it in one change, and each
item that declares something authors a fixture row that exercises it.

- **Schema 2.24** (§A1, A5, A6, A7, A9; §A14 already in 2.22; 0037/0038 tagged as 2.23):
  - rename `clip.scene_id` to a pointer; the delete-a-scene test now
    expects the clip kept with the reference cleared, and
    `canonicalDump` after a scene delete changes accordingly;
  - the `<entity>_id`-must-be-deliberate lint in `lint_registry.py`;
  - drop `sequence.act_id`, its app reads and writes, and
    `structure.sequence_act_mismatch` (finding catalog 52 → 51 before
    the addition below) — and re-take `docs/walkthrough.md`'s
    `scf-check` output, which quotes that finding;
  - drop `queries` from `registry.json` and `registry.schema.json`; keep
    it in `entity_registry.py`;
  - `audio_offset_*` help text as decided;
  - ✅ `project.synopsis` (0036) — done in `0d65695`, with a synopsis
    authored in the fixture.
  - ✅ shot and scene media (0037) — committed in `d651077` (editor
    view `350c181`): `relationship_type` gains `storyboard`,
    `start_frame`, `end_frame`, `previs`; `asset_relationship.order`;
    spec 0.64 §8.6; shot 12-04's panels in the fixture. It moved
    `SCHEMA_VERSION` to 2.23 ahead of the rest of this batch; 2.23 was
    then tagged, so the rest is 2.24.
  - ✅ the project poster (0038) — committed in `54c8cf4`:
    `relationship_type` gains `poster`; spec 0.65 §8.6 and §12.12; Q00
    gains `posters`; the fixture project relates `poster01.png`.
- **Spec text:** §0.6's floor (exactly 2.24, §A8); §12.8's
  `audio_offset_*` sentence (§A9); §12.17's ordered comparison (§A11);
  §1.3.1's finding sentence (§A12); §2.3's clip note (§A1); the
  CHANGELOG naming each break taken under §11.0.
- **§12.17 order (§A11):** `resolution.ts` compares `time_of_day`, then
  weather, then season; re-bless Q04 and anything else that resolves a
  location variant; the night kitchen (scenes 10, 19) is the fixture
  row that exercises it.
- **`line.type_unknown` (§A12):** error severity, in the catalog and
  `scf-check`, with a test row carrying an unlisted `line_type`.
- **Proposal statuses:** 0002 moves from `accepted` to `implemented`
  when this lands. 0036 is already `implemented`.
- `editor-mvp.md` §9 answered: the editor is not in 1.0 (§A10).

**Done 2026-10-16, as spec 0.66 on schema 2.24** (tagged with the
candidate the same day). One
regeneration: registry, `scf-schema.sql`, `entity-reference.md`, the
finding catalog, the fixture rebuild, Q04 re-blessed, the negative
reports and `SHA256SUMS`.

- **`clip.scene_id` → `clip.slated_scene_id`** (§A1; the name settled
  2026-10-16), no longer required. A clip's line range reads its scene
  through `rangeSceneField()` in `lines.ts`; `sceneOps.test.ts` asserts
  a scene delete clears the pointer and keeps the clip.
- **The lint** is `lint_ownership_by_name()` in `lint_registry.py`,
  scoped to `scene_id`, the one name §2.3 matches on. It records the
  thirty-three owners in `DELIBERATE_SCENE_OWNERS` and fails on a new
  one, or a stale entry.
- **`sequence.act_id` removed** with the app's write
  (`structureCommit.ts`) and reads (`StructureView.tsx`; `EntityList.tsx`
  now derives a sequence's act from the boundaries). **Correction to
  §A5:** `structure.sequence_act_mismatch` never read the column — since
  0.44 it reports a span that crosses an act — so it **stays**, decided
  2026-10-16. The catalog is 52 + `line.type_unknown` = **53**, and the
  walkthrough's `scf-check` output changed only in its schema number.
- **`queries`** dropped from `registry.json`, `registry.schema.json` and
  the TypeScript `EntityDef`; kept in `entity_registry.py` for the lint.
- **`audio_offset_*`** help text and the §12.8 paragraph, as decided.
- **§12.17** compares the axes in rank order. Scenes 10 and 19 resolve
  the night variant, pinned in `conformance.canonical.test.ts` (and it
  fails under the old rule). Q04's result at scene 12 is unchanged by
  the rule; it loses the sequence's `act_uuid`.
- **`line.type_unknown`**, error, in `lines.ts`, the catalog and
  `scf-check`, with the negative case `line-type-unknown` raising it
  alone.
- **Spec 0.66:** §0.6 (exactly 2.24), §1.3.1, §2.3, §11.0's list of
  breaks, §12.8, §12.17, a CHANGELOG entry naming the three breaks, and
  `stability.md`'s variant row. 0002 is `implemented`.

---

## C. Non-normative docs that drifted

| | File | What |
|---|---|---|
| ✅ | `docs/glossary.md` | "Currently 2.12" and "currently 0.42"; "103 entities" |
| ✅ | `docs/walkthrough.md` | `scf-check` output shows schema 2.12 and two findings; today it is 2.22 and five. "107 tables" — the walkthrough's own command prints **114**, counting SQLite's bookkeeping table. **Changes again in 2.23**, when `structure.sequence_act_mismatch` goes (§B8) |
| ✅ | `README.md` | Manifest "44 files" — 45. **No mention of `scf-mcp`** |
| ✅ | `scf-core/README.md` | "All 99 entities" — 106. This is the page npm will show |
| ✅ | `docs/scf-mcp-design.md` (was `spec/`) | Sat in `spec/` beside the normative documents and is not in the manifest; says "Nothing here is built" and "Status: proposal"; stamped 0.51/2.13; its link to `editor-mvp.md` is broken from `spec/`. **Move to `docs/`**, mark as built. `scf-mcp/` has no README |
| ✅ | `docs/editor-mvp.md` | §5 and §8 describe rev 13; §7b's "open decision" (`region_box` help text) is done — the registry carries it |
| ✅ | `docs/conventions.md` | ~38 inbound references meaning "the rules". Carried since rev 11. **Deferred past 1.0** (§A15, §F) |

---

## D. Verification before the tag

| | Item | Notes |
|---|---|---|
| ◑ | **D1. A sixth reader run** | **The biggest risk on this list.** No run since 0.49. Twenty spec revisions (0.50–0.68 and 1.0-rc.1) and about thirty proposals of normative text since — §2.4.1 presence, §3.5 line anchors, §4.6–4.8, §12.8.1–12.8.2 — read by nobody outside the project. Runs 4 and 5 each found a critical that no published artifact could see. Run it **after** B2 and B4, so it reads a true document against artifacts that exercise it, and start it from `what-is-scf.md`: section 7 has never been read cold. It runs unattended — launch it as soon as B2/B4 land. **Run 6 done 2026-10-16 against `spec-1.0-rc.1`: 4 critical, 13 major, 15 minor; rc.1 cannot be cut as 1.0.** 21 of 28 comparable results reproduced from the text alone, 15 of 15 negatives with three guesses. All addressed in **1.0-rc.2** (see below). **Run 7 done 2026-10-16 against `spec-1.0-rc.2`: 1 critical, 7 major, 13 minor.** 24 of 29 results from the text alone, 16 of 16 negatives, the fixture's report exact. Addressed in **1.0-rc.3**. **Run 8 done 2026-10-20 against `spec-1.0-rc.3`: 0 critical, 6 major, 14 minor.** 30 of 30 results, 16 of 16 negatives and the fixture's report from the text alone, all on the first run; the majors are two contradictions between MUSTs (§7.3/§4.5 ties, §0.3/§8.2 root mapping), an unstated finding grain for 37 codes, Q04's staging path, a wrong registry declaration and Q14's missing parameters. Addressed in **1.0-rc.4** on **schema 2.25**. **Run 9 done 2026-10-20 against `spec-1.0-rc.4`: 0 critical, 6 major, 19 minor.** Every published result (31 exact, 3 Q14 per §12.9), 16 of 16 negatives and the fixture's report from the text alone, no guess load-bearing on any artifact; all six majors are in cases nothing published asked about — Q14's narrowing (four), a span whose start scene is cut, a shot asked without or outside its scene. Addressed in **1.0-rc.5**, schema unchanged at 2.25. **Run 10 done 2026-10-20 against `spec-1.0-rc.5`: 0 critical, 4 major, 11 minor.** All 57 published artifacts reproduced from the text (32 exact results, 6 Q14 by §12.9's terms, 18 negatives, the fixture's report); all four majors are in Q14's rubric (§12.9.1), and fixing them changes which Q14 severities are permitted, so §11.5 makes it a minor change, not a 1.0.x patch. **Decided by the user 2026-10-20:** a small **1.0-rc.6** limited to Q14, then a short run 11 checking only Q14 and anything rc.6 touched, then cut 1.0. **Run 11 done 2026-10-20 against `spec-1.0-rc.6`: 0 critical, 2 major, 9 minor.** All 78 checksummed artifacts verified; every non-Q14 result (32), all 18 negatives and the fixture's report reproduced exactly, and all 9 published Q14 results conform by §12.9's terms. Both majors are in Q14's rubric: Q13's `entity_anchor` step narrowed differently from Q13 (493 of 5,385 swept positions disagree, Marcus at scene 12 among them), and whether the media step's Q13 is asked at the shot. Criticals across runs 6–11: 4, 1, 0, 0, 0, 0. **Decided by the user 2026-10-20:** a tiny **1.0-rc.7** for those two majors, then cut **1.0 from rc.7 without another reader run**, Q14 staying Provisional. |
| ✅ | D2. Fixture: the night kitchen | Scenes 10 and 19 resolve the **day** baseline because the night variant is autumn and they are winter (`narrative-workspaces.md` §11). **Decided (§A11): the rule was wrong** — §12.17 now ranks time of day first. **Done in §B8:** both resolve the night variant, and a test pins it. |
| ✅ | D3. Rules stated and exercised by nothing | `junction.endpoint_absent`, `structure.section_mismatch`, §12.17's zero-score baseline, `varies`, a `status` that disagrees with `lifecycle_status`, act and sequence renumbering under `derived` (§4.3). **Done 2026-10-16 (spec 0.68), a row each:** negative cases `junction-endpoint-absent` and `section-mismatch`, each raising its finding alone; church and ridge location variants published as `Q02-church-scene16` (`varies` wins on the wildcard alone) and `Q02-ridge-scene21` (nothing agrees, the baseline with three mismatches); scenes 3, 12, 19 at `draft`, `locked`, `revised`, and 12B `locked` and `cut`. Renumbering under `derived` and `fixed` was already tested in `structureCommit.test.ts`; `stability.md` said otherwise and now does not. |
| ✅ | D4. An unknown `line_type` raises no finding | §1.3.1 closes the vocabulary at fifteen; the column is free text and nothing reports a sixteenth. **Decided (§A12): `line.type_unknown`, severity error.** Done in §B8, with a negative case. |
| ? | D5. The docs site is live | Could not confirm from here. Settings → Pages → Source = GitHub Actions. |
| ✅ | D6. A documentation audit before D1 | Stale prose is what past reader runs flagged most, so every hand-written document was read against the tree after the candidate was tagged: the four specification documents, `docs/`, all thirty-eight proposals, the READMEs, `site/`, governance and security, and the source headers that state facts about the format. **Done 2026-10-16.** Fixed: counts (negative cases 11 → 15, link entities, entity totals, independent implementations 3–4 → 5), claims made false by 0.66–0.68 (`line.type_unknown`, the ranked axes, `varies`/`status` exercised, `queries` unpublished, the cascade described as a scope ladder), proposals 0001, 0002, 0027, 0033, 0037 and 0038 brought up to what landed, and a Resolution for each of the thirteen implemented proposals that had none. Two defects beyond prose: **four negative reports were published but not in the manifest** (`bundle-unbound`, `junction-endpoint-absent`, `line-type-unknown`, `section-mismatch`) — added, 58 → 62 artifacts, with a guard in `artifact_manifest.py` so an unlisted report fails; and `readiness-rubrics.json`'s comment contradicted §12.9.1 on optional steps. The specification documents changed editorially only; see the CHANGELOG's re-cut entry. **Decided 2026-10-16:** both tags are re-pointed at the audit commit before D1 launches — nobody had fetched the candidate, so the editorial fixes ship as rc.1 rather than rc.2. |

---

## E. Release day

Two days, per §A13: the candidate, then the release once D1 is back
and quiet. In each, the manifest goes last because `SHA256SUMS` covers
the prose.

**RC day — every door stays shut:**

1. ✅ Spec **`1.0-rc.1`**: CHANGELOG entry; §0.6 rewritten (exactly
   schema 2.24); stability and conformance headers. §11.0 stays in
   force. *Done 2026-10-16, with §11.5's sentence on what a candidate
   is, and the README badge, README, site and `what-is-scf.md` status
   lines.*
2. ✅ Schema **2.24** (§A7): every artifact regenerated, the fixture
   rebuilt. *Every `--check` current, the fixture rebuild identical.*
3. ✅ `python schema/artifact_manifest.py`, then `tools/verify.py`, green.
   *Green except the pin step until step 4's tag; green with it.*
4. ✅ Annotated tags, pushed: `schema-2.24` and `spec-1.0-rc.1`. Then
   `check_pin.py --strict` against the remote. No npm publish. *Done
   2026-10-16; the pin step passes.*
5. ✅ Launch D1 against the candidate. *Run 6, 2026-10-16: an rc.2 is
   needed.*

**1.0-rc.2 — from run 6, prepared 2026-10-16.** No schema change.
Decisions 2026-10-16: Q13's `trail` becomes derived records with a
closed `excluded.by` (C1); Q04's cast and props nest as Q03's (M1);
booleans stay the stored 0/1, now stated (M2).

- **Criticals.** C1 as above, with `reason` and `detail` compared as
  present strings only. C2: Q07's cascade projected by a hand-written
  map and lost `string_list`; each layer now projects by its own
  entity. C3: the resolver dropped unverified anchors silently; they
  now appear in `trail` excluded by `canonical_status`, and §12.8 says
  only a verified anchor contributes. C4: motif carriage in story order.
- **Majors** are mostly sentences the reference already behaved by:
  the intent → anchor-type table (M3), Q02's media intent (M4), what a
  shot override contributes — and it now matches the intent, as a
  binding does (M5) — bundle order (M6), the heading's `scene_id`
  (M7), `scene_not_in_script` (M9), the zero `user_version` (M10), Q14's
  narrowing (M11), every derived-record member name (M13). M8 and M12
  changed artifacts: identity findings carry their rows, the published
  report merges one code on one table into one finding, findings are
  computed over every row, and the fixture's own report is published.
- **Minors**: row order for position-less arrays (and `rows()` now
  orders by rowid rather than trusting the plan), ties, opaque vs absent
  scene numbers, two spans on one scene, null optional parameters,
  `CASES.json`'s params suffix, section-line comparison, `..`,
  `ShotContext-readiness` moved out of the published directory, stale
  counts, `what-is-scf.md` §7, empty `string_list`, shot-only states,
  and `asset-orphans-two` for §9.5's grain.
- **m14, for run 7:** export only `spec/`, `docs/what-is-scf.md`,
  `README.md`, `fixtures/hollow_creek.scf`, `fixtures/hollow_creek.report.json`,
  `fixtures/expectations/` and `fixtures/negative/` — not
  `fixtures/build/`, which is reference-adjacent code.

**rc.2 day:**

1. ✅ Spec `1.0-rc.2`: CHANGELOG, headers, every artifact re-blessed.
2. ✅ Addressing split (conventions §8 step 7): `ARTIFACTS.md` now
   addresses the registry and what is generated from it alone by
   `schema-2.24`, and everything else by `spec-1.0-rc.2`; `check_pin.py`
   checks each file against its own tag. **`schema-2.24` does not move**
   — its seven files are byte-identical where it already points.
3. ✅ Commit, then the annotated tag `spec-1.0-rc.2` on that commit,
   pushed. No schema tag. *`c408a59`.*
4. ✅ `check_pin.py --strict`, then launch run 7 against `spec-1.0-rc.2`.
   *Run 7, 2026-10-16: 1 critical, 7 major, 13 minor; an rc.3 is needed.*

**1.0-rc.3 — from run 7, prepared 2026-10-16.** No schema change, no
result changes shape. Run 7 reproduced 24 of 29 results, 16 of 16
negatives and the fixture's report from the text alone; every finding
was a missing sentence. Report: `.claude/reader-run-7/reader-run-7-report.md`
(outside git).

- **C1**: §12.17's `mismatches` format, stated exactly.
- **Majors**: Q12's character order (M1); Q06's baseline (M2); findings
  derive spans over cut scenes (M3) and unscripted scenes sit in the
  last spans (M4); §9.4.1 states every code's condition (M5); one
  `by` per excluded layer, in order (M6); §7.3's shot fall-through, with
  the case result `Q07-shot12A` (M7).
- **Minors**: m1–m10, m12, m13 in the text. Two latent validator bugs
  found on the way and fixed (`boundary_unnumbered`'s table,
  `scenes_before_first_act`'s rows). **m11 is not done**: the fixture has
  no cut row that a link reaches, so §6.6.1's cut-endpoint rule has no
  published artifact. Closing it means adding a cut character to the
  fixture and re-blessing, which is a change to the conformance fixture
  and is left for a decision.
- **Decision to revisit**: an intent outside §12.8's anchor table
  (`behavior`) is answered by every anchor type. The text now says what
  the reference does; whether `behavior` should map to `motion` is open.

**rc.3 day:**

1. ✅ Spec `1.0-rc.3`: CHANGELOG, headers, every artifact re-blessed.
2. ✅ Commit, then the annotated tag `spec-1.0-rc.3` on that commit,
   pushed. No schema tag; `schema-2.24` does not move. *`ff41afb`.*
3. ✅ `check_pin.py --strict`, then launch run 8 against `spec-1.0-rc.3`,
   exporting `scf-core/registry/registry.json` with m14's list.
   *Run 8, 2026-10-20: 0 critical, 6 major, 14 minor; an rc.4 is
   needed.*

**1.0-rc.4 — from run 8, prepared 2026-10-20.** **Schema 2.25**, approved
for M5. Run 8 reproduced 30 of 30 results, 16 of 16 negatives and the
fixture's report from the text alone; every finding was a contradiction,
a missing sentence or an unexercised case. Report:
`.claude/worktrees/pensive-archimedes-8b9566/reader-run-8-report.md`
(outside git).

- **M1** — a `latest_wins` tie takes the highest row id (§4.5), stated
  once in §7.3 step 1 and §12.1.6. The reference's cascade took the
  lowest and its state tables the highest; `fetchLayer` now matches
  `latestState`. New case `Q07-scene3`.
- **M2** — without a root mapping, rooted identifiers are `unaddressed`
  and absolute or `..` ones `out-of-root` (§0.3, §8.3, §12.8.1,
  conformance §2.1). Fixture: asset 55, an absolute `.tif` in the
  locket's bundle, so `Q02-locket-scene25` shows both states; the
  fixture's report gains one warning.
- **M3** — §9.4.1 states `table`, `rowIds` and `count` for all 53
  codes, from `findings.ts` and its producers.
- **M4** — `stagingBeats` takes beats through `scene_blocking` and
  `action_sequence`; the reference read only blocking and now reads
  both. New case `Q04-scene21`.
- **M5** — `polymorphicTargets` (schema 2.25) on
  `entity_anchor.subject_variant_id`; §12.1.2 and §12.8. `whereUsed`,
  the orphan count and the fixture reference test honour it.
- **M6** — Q14 takes `subjectType`, `subject` and `intent`
  (`q14Result`, `readiness.ts`, scf-mcp `dispatch.ts`/`server.ts`, the
  editor's Q14 page, selectors, §12.9). Every walker now reports every
  rubric step, pinned by a coverage test. New worked examples
  `Q14-Q02-locket-scene25`, `Q14-Q13-eleanor-shot1204`;
  `Q14.result.json` gains three null parameters and nothing else.
- **Minors** — all fourteen in the text: m1 (`_scf_meta`), m2
  (conformance §6.1 step 3), m3 (`counts`), m4 (Q04 `detail`), m5
  (format string), m6 and m7 (Q02 members, `media`), m8 and m9 (row
  order; every array's order stated), m10 (Q14 `findings` order and
  `entity`), m11 (`canonical_status`), m12 (`mismatches` escapes), m13
  (Q04 `detail` is not prose), m14 (stale notes).
- **Unexercised list** — stated: null `persistence`, a cut
  `resolved_at_scene_id`, null `precedence`, which binding `replaced`
  names, unverified variant anchors do not displace, Q14's `shot`.
  **Left:** a carrier whose polymorphic target is cut (Q10), rows keyed
  by `sequence_id` in Q11, and null junction key columns (§6.3) — each
  needs a decision, not a sentence.
- **Latent bugs found on the way and fixed:** an unknown `persistence`
  was read as `until_resolved` (§4.5 says `scene_only`); Q02 reported
  the scene's location variant for any location subject; `formatOf`
  ignored `\` in an absolute Windows path; Q04's cast and props joins
  had no `ORDER BY`. None changes a published result.

**rc.4 day — tag only after the commit is pushed:**

1. ✅ Spec `1.0-rc.4`, schema 2.25: CHANGELOG, schema changelog,
   headers, every artifact re-blessed, manifest last.
2. ✅ Commit and push. Then, on that pushed commit, both annotated tags
   — `schema-2.25` because `SCHEMA_VERSION` moved, `spec-1.0-rc.4` for
   everything else — and nothing else moves. *Both at `1c1aaca`.*

   ```sh
   git push origin main
   git tag -a schema-2.25 -m 'schema 2.25'
   git tag -a spec-1.0-rc.4 -m 'spec 1.0-rc.4'
   git push origin schema-2.25 spec-1.0-rc.4
   py schema/check_pin.py --strict
   ```

   `schema-2.24` stays at `62a14cc` and `spec-1.0-rc.3` at `ff41afb`.
3. ✅ `check_pin.py --strict` green, then launch run 9 against
   `spec-1.0-rc.4`, exporting the registry from `schema-2.25` with
   m14's list. *Run 9, 2026-10-20: 0 critical, 6 major, 19 minor; an
   rc.5 is needed.*

**1.0-rc.5 — from run 9, prepared 2026-10-20.** **Schema 2.25,
unchanged**: no fix touched `registry.json`, so `schema-2.25` addresses
the seven schema files as it does today and takes no new tag. Run 9
reproduced every published artifact from the text; its majors were all
beyond the published positions. Report:
`.claude/worktrees/wonderful-hopper-00c7ac/reader-run-9-report.md`
(outside git).

- **M1–M4, Q14** — one rule in §12.9.1: a step's rows are the ones its
  target reads (subject one declared reference away; position by
  pattern, by §7.3's shot fall-through, or by column). Rubric steps gain
  `satisfiedBy` (Q02's costume step: `costume_scene` only); Q13's step 1
  names `costume_asset_binding`; `entity_anchor` and shot overrides do
  not apply to a costume. `readiness.ts` follows it. New worked examples
  `Q14-Q02-eleanor-scene7`, `Q14-Q07-shot12A`, `Q14-Q13-shawl-scene12`.
- **M5** — a span whose start scene is cut covers no scene (§5.5); new
  code `structure.boundary_cut` (54 codes), negative case
  `span-boundary-cut`. Q10's span membership now excludes cut rows, as
  Q04's did.
- **M6** — §12.1.7: a shot fixes the position at its scene; a shot
  outside the scene asked is not answered (Q07, Q02, Q13, Q14). New case
  `Q13-shot1204`.
- **rc.4's three open edge cases, decided from the reference**: a Q10
  carrier whose target is cut is dropped (the reference kept it with a
  null name; §6.6.1's endpoint rule says drop, so the reference
  changed), exercised by the published `Q10`; Q11 counts only rows keyed
  by `scene_id`, exercised by the published `Q11` through a
  sequence-keyed tone marker; null junction key columns compare equal,
  negative case `junction-key-null`.
- **m4** — fixture: cut Deputy Rourke linked into scenes 12 and 19 and
  carrying Forgiveness. A reader ignoring cut endpoints now fails `Q04`,
  `Q03` and `Q10`.
- **Minors** — all nineteen addressed in the text, and where the
  reference disagreed it now follows the text: m12 (a cut scene is an
  empty position everywhere; Q04 returned its lines), m3 (one beat
  order; Q05 sorted unset last), m11 (unknown line types ignored, per
  §10.1), m14 (anchor on a cut asset not considered), m7/m8 (rubric
  `params` and Q06's step), m16 (catalog ordering), m18 (no result for
  a refused question). **m5 is left**: making `polymorphicTargets`
  observable needs a cut variant whose id equals a live character's, a
  contrived fixture row for a declaration whose reading the in-force
  test already makes harmless.
- **Latent bugs found on the way and fixed:** Q07's walker raised
  severities outside its steps' ranges on absences the fixture never
  has; Q08 skipped a step at a scene with no location; Q13 threw for a
  costume at a shot (no `costume_shot_override` table); Q03's and Q02's
  costume joins and Q03's motif join had no `ORDER BY`. None changes a
  published result.

**rc.5 day — tag only AFTER the commit is pushed.** Twice a tag has
been created on the previous commit because it was made before the
commit existed. Commit, push, read the new commit's hash, and name it
in the tag command:

1. ✅ Spec `1.0-rc.5`, schema 2.25: CHANGELOG, headers, every artifact
   re-blessed, manifest last.
2. ✅ Commit and push `main`. Then, with `<commit>` the hash
   `git rev-parse HEAD` prints for that pushed commit:

   ```sh
   git tag -a spec-1.0-rc.5 -m "spec 1.0-rc.5" <commit>
   git push origin spec-1.0-rc.5
   py schema/check_pin.py --strict
   ```

   No schema tag: `schema-2.25` stays at `1c1aaca`, as do
   `spec-1.0-rc.4` there and `spec-1.0-rc.3` at `ff41afb`.
   *`spec-1.0-rc.5` at `2da5dc4`.*
3. ✅ `check_pin.py --strict` green, then a lighter run 10 against
   `spec-1.0-rc.5` that checks only what rc.5 changed. *Run 10,
   2026-10-20: 0 critical, 4 major, 11 minor, all majors in Q14; an
   rc.6 limited to Q14 is needed.*

**1.0-rc.6 — from run 10, prepared 2026-10-20, scoped to Q14.**
**Schema 2.25, unchanged**: the rubric is a spec-side artifact and
`registry.json` did not move, so `schema-2.25` takes no new tag. Run 10
reproduced every published artifact from the text; its four majors
were two MUSTs in §12.9.1 disagreeing off the published positions.
Report: `.claude/worktrees/bold-chatelet-e3ce53/reader-run-10-report.md`
(outside git).

- **M1** — a reference to `scene` or `shot` is a position, never a
  route to a subject (§12.9.1). The reference already behaved so.
- **M2** — a media step is one satisfied by `bundle` alone; Q13's step 1
  gains `satisfiedBy: ["bundle"]`, so a binding excluded at the position
  is a `blocker`. New case `Q14-Q13-windchime-scene12`.
- **M3** — rubric member `appliesTo: "seen"` on Q02's appearance,
  physical and costume steps and Q07's appearance step; §12.9 says a
  character subject not seen at the position reports them as not
  applying. `readiness.ts` checks presence. New case `Q14-Q02-ada-scene3`.
- **M4** — Q02's media step carries `intentBySubjectType` (`environment`
  for a location), as §12.16 says; the generator checks intents against
  the registry. New case `Q14-Q02-kitchen-scene10` (a blocker: the
  fixture has no `environment` bundle).
- **Minors done** — m1 ("does not apply" restated), m2 (`entity_anchor`
  step filtered to verified, unset counting as verified), m3 ("narrowed
  as its target narrows"), m5 (Q14 parameters and `shot` for any
  target), m9 (Q14 at a cut scene), m10 (Appendix A's eighteen cases,
  conformance §5.3's list, Q08's `params`).
- **Left, outside Q14 and not wording** — m4 (shot-keyed rows at an
  empty position; a shot in no scene, §12.1.7), m6
  (`sequence_act_mismatch` over cut scenes), m7 (a link's hidden `name`
  in §6.4's comparison), m8 (a relationship to a cut character), m11 (a
  dangling binding's trail entry). Listed in the CHANGELOG.
- **Latent bug found on the way and fixed:** Q05's walker raised a
  `suggestion` for absent vocal beats on a `recommended` step, outside
  its permitted range. No published result changes.

**rc.6 day — tag only AFTER the commit is pushed:**

1. ✅ Spec `1.0-rc.6`, schema 2.25: CHANGELOG, headers, every artifact
   re-blessed, manifest last.
2. ✅ Commit and push `main`. Then, with `<commit>` the hash
   `git rev-parse --short HEAD` prints for that pushed commit:

   ```sh
   git tag -a spec-1.0-rc.6 -m "spec 1.0-rc.6" <commit>
   git push origin spec-1.0-rc.6
   py schema/check_pin.py --strict
   ```

   No schema tag: `schema-2.25` stays at `1c1aaca`, `spec-1.0-rc.5` at
   `2da5dc4`. *`spec-1.0-rc.6` at `aa02028`.*
3. ✅ `check_pin.py --strict` green, then a short run 11 against
   `spec-1.0-rc.6` that checks only Q14 (§12.9, §12.9.1, the rubric,
   every `Q14*` result) and anything else rc.6 touched. *Run 11,
   2026-10-20: 0 critical, 2 major, 9 minor, both majors in Q14; a tiny
   rc.7, then 1.0 from it without another run.*

**1.0-rc.7 — from run 11, prepared 2026-10-20, scoped to Q14, the last
candidate.** **Schema 2.25, unchanged**: `registry.json` did not move.
Every rule rc.7 touches that the fixture can show is pinned by a
published worked example. Report:
`.claude/worktrees/affectionate-haslett-9c78de/reader-run-11-report.md`
(outside git).

- **M1** — §12.9.1: a step over rows a query resolves is satisfied by
  what that query resolves. Rubric member `resolvedBy: "Q13"` on Q13's
  `entity_anchor` and shot-override steps, checked by the generator: the
  anchor step counts only the anchors Q13 lets contribute (verified, the
  intent's anchor type, §4.8's variant rules). `readiness.ts` already
  read them from `resolveMedia`. New case `Q14-Q13-marcus-scene12` (a
  warning: his one verified anchor is his variant's, not in force).
- **M2** — §12.9: the shot fixes the position for every step, the media
  step's Q13 answer included. `readiness.ts`'s Q05 and Q06 walkers now
  pass the shot. **No worked example**: the fixture's one shot override
  is a `visual_identity` bundle, so no published position separates the
  readings, and adding a voice override would change the fixture and
  other published results.
- **Minors done (wording)** — m2 ("one declared reference away"), m3 (a
  shot narrows a column only for a target that takes one, which keeps
  M2's sentence and the reference consistent), m8 (`counts` keys), the
  stale "nine so far" in conformance §7, `stability.md`'s coverage row,
  the "among them" list in §12.9.1.
- **Left for after 1.0, behaviour not wording** — m1 (a non-baseline
  filterless binding, or a scene-ranged one, at a cut scene; with rc.6's
  m4), m4 (§4.6 shot rows for a character not linked or `named`), m5
  (Q14 without a required parameter or with a foreign subject kind), m6
  (marking cross-step findings), m7 (`entity` for a step that does not
  apply), m9 (a cut subject). rc.6's m4, m6, m7, m8, m11 stand. Listed
  in the CHANGELOG.

**rc.7 day — tag only AFTER the commit is pushed:**

1. ✅ Spec `1.0-rc.7`, schema 2.25: CHANGELOG, headers, every artifact
   re-blessed, manifest last.
2. ○ Commit and push `main`. Then, with `<commit>` the hash
   `git rev-parse --short HEAD` prints for that pushed commit:

   ```sh
   git tag -a spec-1.0-rc.7 -m "spec 1.0-rc.7" <commit>
   git push origin spec-1.0-rc.7
   py schema/check_pin.py --strict
   ```

   No schema tag: `schema-2.25` stays at `1c1aaca`, `spec-1.0-rc.6` at
   `aa02028`.
3. ○ `check_pin.py --strict` green. **No run 12** (the user's decision,
   2026-10-20): 1.0 is cut from rc.7's text.

**Unreleased — editorial, prepared 2026-10-19 as an rc.3 on the
desktop branch.** Moving the editor's operations into scf-core changed
`stability.md`'s file references and scf-core's exports
(`api-surface.json`). No requirement, schema, result or report changed.
It ships with the next release; it takes no tag of its own.

**1.0 day — from rc.7, with no further reader run:**

1. ○ Spec **1.0**, the text of rc.7 with no requirement changed: a
   CHANGELOG entry saying so; §11.0 changed from "becomes binding at
   1.0" to binding; §11.5's release-candidate paragraph in the past
   tense; headers (`scf-spec.md`, `stability.md`, `conformance.md`),
   README badge and status, `site/index.md` and `what-is-scf.md` status
   lines, and conformance §5's `spec-<version>` example. Q14's rows in
   `stability.md` stay Provisional.
2. ○ Schema **2.25** stands (rc.4, unchanged in rc.5–rc.7): no
   regeneration and no new schema tag.
3. ○ `py schema/artifact_manifest.py`, then `py tools/verify.py`, green
   but for the pin step until the tag below is pushed.
4. ○ 🔒 Annotated tag `spec-1.0`, pushed — and, only if step 2 made a
   new schema version, its `schema-X.Y` on the same commit. No existing
   tag moves. Then `check_pin.py --strict`.
5. ○ 🔒 `npm publish --access public` for `scf-core`, after `pack-test`
   confirms the licence is in the tarball. (`scf-mcp` is no longer
   published: it ships inside the desktop app, §A10.)
6. ○ A GitHub Release: notes from the CHANGELOG, the manifest's files
   and `SHA256SUMS` attached.
7. ○ Pages rebuilt from the tag.

---

## F. After 1.0 — decided, not forgotten

Listed so an unstated deferral cannot be mistaken for an oversight.

- **Second maintained implementation.** Five independent readers, all
  Python, all discarded. Every Provisional row already encodes its
  absence; 1.0 does not need it.
- **Magic stanza upstream** — a PR to `github.com/file/file`. Possible
  any day; blocks nothing.
- **Asset resolution tally** in `scf-check` — conformance §4's ninth
  check, waiting on a root-mapping flag.
- **Proposal 0003** (waits on named roots in the editor), and anything
  additive that arrives later.
- **Proposal 0002's declaration move** — `parentEntity`/`parentField` on
  the thirty-three and §2.3 reading declarations only. Non-breaking if
  it reproduces 2.24's behaviour, which it must.
- **Proposal 0015** — intercut, as an additive `scene_location` link;
  `scene.location_id` stays the primary.
- **A generated `queries` member** in `registry.json`, from what each
  `qNNResult()` reads. Additive.
- **An npm workspace** for `scf-core`, `scf-mcp` and `scf-app`, so a
  sibling dependency is a real range resolved locally. It retires
  `tools/pack_with_ranges.mjs` (§B6). Deferred because it replaces three
  lockfiles with one and changes dependency hoisting — plumbing to move
  when nothing else is.
- **`docs/conventions.md`** and its ~38 inbound references.
- **The editor at its own version** (§A10), and `scf-mcp` toward 1.0.
- **Hosted editor build**, signed tags, roadmap and decision log.
- **Editor:** spine editing and Q15's "why?" affordance (`editor-mvp.md`
  §4); `narrative-workspaces.md` §11 — readiness badge, shot-level
  variants, `shotContext` naming the variant, the undo toast, the scene
  rail jumping by `line_order`, offline fonts, and **sixteen
  `last_insert_rowid()` calls** to replace with `RETURNING id` before
  anything writes in the background.
- **Announcement, landing page, positioning, citable reference.**

---

## A two-day plan

**Decide — done 2026-10-08.** Section A is settled, and the
`project.synopsis` work it was waiting on has landed (§A14).

**Day 1, morning — the mechanical half.** B3, B4, B6 except the
publish, B7 and C (B5 is done). It is one change across many files.

**Day 1, afternoon — the app.** B1: query pages onto scf-core. Removing
`act_id` (§B8) falls out of it: Q04's read goes with the runner, and the
structure views derive acts from boundaries.

**Day 2, morning — 2.24 and the fixture.** §B8's schema and spec
changes, then B2: bless Q03/Q04/Q12 at scene 25, author the anchored
beats, prop tags, a published version, a prop variant, a vocal state
and the synopsis at blessed positions; rebuild; re-bless, including Q04
under the new §12.17 order. One regeneration.

**Day 2, afternoon — the candidate.** RC day as written in §E: tag
`spec-1.0-rc.1` and `schema-2.24`, hold the npm publish and §11.0, and
**launch D1 against the candidate**. Cut 1.0 when it returns quiet. The
RC loses nothing; publishing a format the sixth reader then finds a
critical in would.

---

## Where six revisions of this list leave the lesson

Rev 13 closed on the rule that **declaring a thing and authoring a row
that exercises it are one change, not two.** Thirty proposals later,
§B2 is that rule broken twenty times, every one of them quietly, and
§B4 is the older lesson — anything derivable written by hand eventually
disagrees with itself — broken a dozen more. Both checks this list
proposes, the always-empty-member scan and the no-bare-counts rule, are
checks for the class.
