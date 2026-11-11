<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# SCF stability tiers

Companion to [scf-spec.md](scf-spec.md). Every normative area of the
specification carries a tier. The tier is a promise about **change**,
not a statement of quality — a Stable area can still be wrong; it just
cannot change quietly.

Current as of specification 1.0-rc.7 / schema 2.25. This document is expected
to change on most rounds; the specification is not.

---

## The tiers

| Tier | Promise |
|---|---|
| **Stable** | The rule will not change incompatibly before 2.0. A change requires a deprecation cycle (spec §11.4) and a changelog entry. Third parties may build against it. |
| **Provisional** | The rule is believed right and is implemented, but has not been exercised by a second implementation or a real outside consumer. May change in a 1.x release with a changelog entry and a migration note. |
| **Unstable** | Actively being worked on. Will change. Do not build against it. |
| **Reserved** | The name or namespace is claimed; the semantics are not specified. Nothing may occupy it. |
| **Out of scope** | Not part of 1.0. May exist in files; conforming readers ignore it. |

A **1.0 release is the act of moving every Unstable row to Provisional
or better, and every "not yet implemented" note to done.** Nothing else
about it is ceremonial.

---

## By area

### Physical format

| Area | Spec | Tier | Implemented | Notes |
|---|---|---|---|---|
| SQLite container, `.scf` extension | §1.1 | Stable | Yes | Unchanged since 1.0 of the schema. |
| `application_id` / `user_version` | §1.2 | Provisional | Yes | `fileIdentity.ts`, stamped by `initDatabase`. Value chosen (`0x53434631`) and checked against SQLite's registry; `spec/scf.magic` ships the `magic(5)` stanza. Provisional until the stanza is upstreamed into `sqlite/magic.txt`, which is the only step that makes a stock `file(1)` recognise it. |
| Table set from the registry | §1.3 | Stable | Yes | |
| Additive column tolerance on open | §1.4 | Stable | Yes | `initDatabase` ALTER-adds missing registry columns. |

### Entity model

| Area | Spec | Tier | Implemented | Notes |
|---|---|---|---|---|
| Registry as normative source | §2.1 | Stable | Yes | Generated from `entity_registry.py`; linted. |
| Registry structure published | §2.1 | Provisional | Yes | `spec/registry.schema.json`, validated against `registry.json` by `registrySchema.test.ts`. Provisional until a third party has consumed it. |
| Physical DDL published | §1.3 | Provisional | Yes | `spec/scf-schema.sql`, dumped from `initDatabase()`, with a `--check` mode. Excludes `sqlite_%` since 0.25 — it previously carried `CREATE TABLE sqlite_sequence`, which SQLite rejects, so the published DDL could not be loaded. |
| Reference projection derived from the registry | §12.1.2 | Provisional | Yes | `referencesOf()`. Replaced hand-written per-query maps that disagreed with each other. |
| Anchors contribute their asset | §12.8 | Provisional | Yes | `resolveMedia` dereferences; `mediaReferences` needs no cross-table lookup, so the row-id conflation cannot recur. |
| The variant in force | §4.8 | Provisional | Yes | Stated in 0.60 (proposal 0033); reported on every cast and prop entry of Q03, Q04 and Q12 since 0.61 (proposal 0035). A character's or prop's variant is the one its scene presence link names; a location's is §12.17's. One function, `variantInForce`, serves the binding filter, the anchor layer and Q02. Exercised by the fixture's scene 25 flashback, where Marcus and the locket are each in a variant, in normative case results since 0.67: `Q02-marcus-scene25`, `Q02-locket-scene25`, `Q03-scene25`, `Q04-scene25`, `Q12-scene24-25` and `Q12-scene25-24`, `Q13-scene25`; `variants.test.ts` carries each rule two-sided. Provisional: two variants in one scene of one fixture, and a scene showing two versions of one character is not expressible at scene level. |
| Anchor audio span | §12.8 | Provisional | Partly | Stated in 0.66: seconds from the first sample, start-inclusive and end-exclusive, a null bound open. Matches what the reference editor enforces on write (`mediaOps.ts`). Partly: no fixture anchor carries a span, no finding reports a reversed one, and no query result reads it — the span locates part of a recording and changes nothing in force. |
| Variant anchors | §12.8 | Provisional | Yes | Since 0.60 `entity_anchor.subject_variant_id` is read: a variant's anchor contributes only where it is in force, and displaces the subject's own of its type. Before 0.60 the column was read by nothing. Since 0.61 an anchor carries no state filter at all: the three free-text state columns nothing read were removed (proposal 0034). |
| How bindings combine | §12.8.2 | Provisional | Yes | Stated in 0.58 (proposal 0031). `precedence` orders the bindings in force, higher being the more specific opinion; `combine = replace` excludes lower bindings for the same subject and intent, never anchors or shot overrides. Before 0.58 neither was defined, the fixture used `precedence` both ways round, and every night scene in the kitchen resolved its day plates. Pinned by `bindingCombination.test.ts`, two-sided. |
| Artifact addressing and checksums | §2.1 | Provisional | Yes | `spec/ARTIFACTS.md` and `SHA256SUMS` cover every file `schema/artifact_manifest.py` lists — the specification documents, the generated artifacts and the blessed results and negative reports — and the manifest states the count. The four specification documents and the blessed negative reports joined the generated artifacts in 0.31. Each file is addressed by one of two tags: `schema-X.Y` for the registry and what is generated from it alone, `spec-X.Y` for everything else, so a specification release never moves a schema tag. Every schema version from 2.12 is tagged; `check_pin.py --strict` confirms both current tags serve, file by file, the digests `SHA256SUMS` claims, and fails on a file neither addresses. |
| Licensing boundary: prose CC BY 4.0, generated data Apache-2.0 | — | Provisional | Yes | Stated in `spec/LICENSE` since 0.32 and enforced per file by `tools/add_spdx_headers.py --check`, which CI runs. Provisional only because no third party has yet relied on it. |
| `@minimalhumans/scf-core` public API | — | Provisional | Yes | `src/index.ts` is an explicit export list organised by `conformance.md`'s roles since 0.34, when four editor-tooling modules were cut. `spec/api-surface.json` records every name and CI checks two things: that the set has not moved, and that **every type named in a public signature is itself public**. Provisional rather than Stable because no external consumer has used it; the package is still unpublished. |
| Reproducible fixture build | — | Provisional | Yes | `fixtures/build/build_fixture.py` since 0.35: published DDL + `hollow_creek.data.json` + the screenplay, from nothing, byte-identical across runs. CI checks the rebuild against the checked-in file. Provisional because only one fixture has ever been built this way. |
| The generated references | — | Provisional | Yes | `entity-reference.md` and `query-reference.md` since 0.37, both generated and CI-checked. Explicitly not normative. Provisional because nobody outside the project has read them yet. |
| Cut exclusion through a junction | §6.6.1 | Provisional | Yes | Fixed in 0.39. `rows()` covers a table at a time; five queries reached an entity THROUGH a junction in one join and filtered neither side. `cutChangesTheAnswer.test.ts` pins the mirror of §6.6.1's test — cutting a row MUST change the answer — which nothing had checked. |
| `unmaterialised` detection | §8.3 | Provisional | **n/a** | Stated in 0.39 as a property of the ENVIRONMENT, like §0.3's root mapping. No conformance check asks for it and there can be no fixture, since a placeholder is a filesystem state rather than a file. An implementation that never produces the state is conforming; one that reports a placeholder as `missing` is not. |
| Polymorphic references declared | §12.1.2 | Provisional | Yes | `polymorphicType` since 0.40, and `polymorphicTargets` since schema 2.25 for the one column whose target is not the table its sibling names: `entity_anchor.subject_variant_id` points into the subject kind's variant table. The rule was "any column ending `_id`", which deleted `external_id` from ten entities and two ordinary references besides, and no artifact could catch it. A rule that pattern-matches a name eventually matches something the name did not mean. |
| The full `lifecycle_status` vocabulary | §6.6 | Provisional | Yes | Six values, stated in 0.40; the section had named two. Only `cut` is excluded from resolution and §6.6 now says why. |
| `required` means incomplete | §9.1 | Provisional | Yes | Stated in 0.54 (proposal 0005). The flag had no meaning anywhere: no `NOT NULL`, no finding, one asterisk in a form. Exercised by the fixture's unplaced shot, which raises `field.required_absent`. `junction.endpoint_absent` is exercised since 0.68 by the negative case `junction-endpoint-absent`, a cast link with no character. |
| Bound section lines | §1.3.1 | Provisional | Yes | Stated in 0.54 (proposal 0016) after living in scf-app's source since the editor existed. The fixture's eight section lines bind by uuid. The fixture's lines agree with their spans, which is the state a committed file should be in, so `structure.section_mismatch` is exercised by the negative case `section-mismatch` (0.68): a line bound to an act renamed since. |
| `affected_entities` write convention | §12.14 | Provisional | Yes | Stated in 0.54 (proposal 0007). Exercised since the fixture attached a decision and a note to scene 12 by uuid — Q15's `attached` member had been empty in every published result until then. |
| `string_list` | §2.5 | Provisional | Yes | Stated in 0.54 (proposal 0024). 29 fields; Q00's `visual_identity` and `project_color_palette` layers carry arrays in the published result. |
| Character arcs | §12.16 | Provisional | Yes | Schema 2.15 (proposal 0008). `arcStates` on Q02, the arcs themselves through the dossier. Eleanor's three stages are in the fixture. |
| `status` is a writing stage | §6.6 | Provisional | Yes | Stated in 0.53 (proposal 0004), and 2.14 removed `cut` from the vocabulary that carried it. A writing stage is something nothing needs to read, so `scf-core` not reading it is the rule working, not a gap. **Exercised since 0.68:** scenes 3, 12 and 19 are `draft`, `locked` and `revised`, and 12B is `locked` and `cut` — a page locked in the shooting script and cut from the film. Every result still excludes 12B by `lifecycle_status` (Q10's spine), and the published scene rows carry the stages. |
| The carrier record's row member | §12.1.4 | Provisional | Yes | Named for the entity unless the section says otherwise, stated in 0.40. Five of sixteen sections could not be shaped correctly from the document before it. |
| Published query selectors | §5.4 | Provisional | Yes | `fixtures/expectations/selectors.json` since 0.40, generated and cross-checked against every published `parameters` block. `conformance.md` promised them from the start and nothing shipped. |
| Spec prose resolves against the registry | — | Provisional | Yes | `schema/check_spec_references.py` since 0.40, in CI. 0.29 wrote two entity names that do not exist; 0.38 made the RUBRIC's names checkable and left the prose unchecked. |
| Story order across unscripted scenes | §4.1 | Provisional | Yes | Stated in 0.41 and **exercised since 0.42**: fixture scene 17 carries a number and no heading, and the published Q10 spine puts it after scene 24. A reader ordering by `scene_number` alone gets a different answer and the artifact says so. |
| Position tie-break within a scene | §4.5 | Provisional | Yes | Row id, stated in 0.41. Pattern 2 merges oldest-first; pattern 3 takes the highest id at the winning position. |
| `persistence` closed at two values | §4.5 | Provisional | Yes | Stated in 0.41, with an unknown value treated as `scene_only` — the narrower reading, so it cannot silently extend a state across the story. |
| Rubric steps scoped to the query's position | §12.9.1 | Provisional | Yes | Stated in 0.41. A step asks about the position the query was asked about, not the file. |
| Q14 takes its target's parameters | §12.9 | Provisional | Yes | Since 1.0-rc.4: `subjectType`, `subject` and `intent` join `character`, `scene` and `shot`, so Q02 can be assessed for a prop or a location and Q13 at all. A step that cannot be narrowed to the subject's kind is reported `ok`, saying it does not apply. `Q14-Q02-locket-scene25` and `Q14-Q13-eleanor-shot1204` are worked examples. Every walker reports every step of its rubric. |
| Q14 narrows as its target reads | §12.9.1 | Provisional | Yes | Since 1.0-rc.5, one rule: a step's rows are the ones the target reads — one declared reference away for the subject, by §7.3's fall-through for a shot, by pattern for a position — and a rubric step's `satisfiedBy` names what can satisfy it. Reader run 9 found four places the text and the reference disagreed (a relationship state "not applying" to its character, a costume owned but not worn counting as worn, a shot's lighting missing where Q07 found it, no costume subject in Q13's rubric). `Q14-Q02-eleanor-scene7`, `Q14-Q07-shot12A` and `Q14-Q13-shawl-scene12` pin them. The rc.5 pass also found the reference's Q07 walker outside its permitted range on two absences the fixture never has (`color_script_entry`, `shot_design`), and Q08's skipping `location_sound_profile` at a scene with no location. 1.0-rc.6, from reader run 10: a reference to `scene` or `shot` is a position, never a route to a subject; a media step is one satisfied by `bundle` alone, and Q13's first step says so (`satisfiedBy`); the rubric marks look steps `appliesTo: "seen"`, which do not apply to a character subject who is not seen; Q02's media intent is per kind of subject (`intentBySubjectType`), `environment` for a location. `Q14-Q02-kitchen-scene10`, `Q14-Q13-windchime-scene12` and `Q14-Q02-ada-scene3` pin them. The reference's Q05 walker raised a `suggestion` for absent vocal beats on a `recommended` step; it now raises a `warning`. 1.0-rc.7, from reader run 11: a step over rows a query resolves is satisfied by what that query resolves (`resolvedBy`), so Q13's `entity_anchor` step counts only the anchors Q13 lets contribute at the position, and `Q14-Q13-marcus-scene12` pins it; a shot fixes the position for every step, the media step's Q13 answer included, and the reference's Q05 and Q06 walkers now ask their media step at the shot. **Q14 stays Provisional at 1.0**: its rubric has met one fixture, and a refinement after 1.0 that changes what a step permits changes a MUST, so it lands as a minor version (§11.5) with a changelog entry, never as a patch. |
| Positions and refused questions | §12.1.7 | Provisional | Yes | Since 1.0-rc.5. A shot fixes the position at its scene (`Q13-shot1204`); a shot outside the scene asked is not answered; a cut scene is an empty position for every query, as Q03's has been; a refused question has no result. |
| **Rubric steps resolve to entities** | §12.9.1 | Provisional | Yes | **Closed in 0.38.** A step now carries `entities` (registry names, checked against the registry at generation time), an optional `filter` and `intent`, and a `label` derived from them for display only. `readinessRubric.test.ts` additionally pins that every entity Q14 reports is one the rubric declares — `readiness.ts` assesses by hand rather than walking the rubric, so the two were free to drift and nothing checked them. |
| Q04 carries the scene's text | §12.17.1 | Provisional | Yes | Added in 0.49. `screenplay_lines` is a `uuidExtraTable`, so the section declares its own reference columns and its own bounds; the empty case is exercised by fixture scene 17, which has no heading line. Provisional until a second implementation has produced the member from the text alone. |
| Location variant selection | §12.17 | Provisional | Yes | Stated in 0.41 and **exercised since 0.42**: scene 12's kitchen dressing was built for autumn and reused in winter, so it still wins on two axes and the published Q04 result carries a non-empty `mismatches`. The axes rank in order since 0.66 — time of day, then weather, then season — and scenes 10 and 19, winter nights, exercise it: the autumn night variant wins over the winter-morning baseline (`conformance.canonical.test.ts`). The fallback when the winner agrees on no axis is exercised since 0.68 by `Q02-ridge-scene21`: neither ridge variant agrees with a winter storm night, and the baseline is chosen, its three mismatches reported. |
| `time_of_day` is a light axis | §12.17 | Provisional | Partly | Stated in 0.53 (proposal 0012). `day` added, `continuous` removed — it could never match a variant. Partly: the fixture authors refined times against DAY headings, which is the case the rule exists for, but no fixture scene carries `day` itself. |
| `varies` is a wildcard on the time axis | §12.17 | Provisional | Yes | Stated in 0.53, and implemented in `resolution.ts`. `varies` scored as an ordinary value could never agree, making the one value meaning "holds at any hour" the one that never won. **Exercised since 0.68** by `Q02-church-scene16`: the church's candles variant says only `varies`, and wins over the bare baseline at a morning service because the wildcard agrees. |
| Dossier group reference column | §12.15 | Provisional | Yes | `<subject>_id`, stated in 0.41. |
| Relationships in the dossier | §12.15, §12.16 | Provisional | Yes | Proposal 0041. Q01 gains `relationships`: each `character_relationship` naming the subject on either side, as `{relationship, other, side}`. Until then neither Q01 nor Q02 said who a relationship was with, since `character_relationship` has no `character_id` column for the group walk to find. Exercised by the published `Q01`, `Q02` and `Q02-marcus-scene25` (both sides, both directionalities). The cut, absent and self-pair rules are pinned by `dossierRelationships.test.ts` on a copy of the fixture and by no published result. |
| Q11's emotional cascade | §12.13 | Provisional | Yes | Fixed in 0.44. The leaf was `scene_emotional_design`, which is not a registry entity, so the member was `[]` for every file that could exist — and the blessed artifact recorded the empty array. Now `scene_emotional_target`, which declares `refines: ["project_tone"]`. |
| Sequences crossing an act boundary | §5.3 | Provisional | Yes | Fixed in 0.44. `structure.sequence_act_mismatch` tested the start scene, which is the comparison §5.3 calls incorrect, and so never fired on a fixture that contains a crossing. It now tests the span. |
| Bare entity names in prose are checked | — | Provisional | Yes | `check_spec_references.py` since 0.44 validates backticked snake_case identifiers, not only `entity.column`. The 0.40 version could not have caught `scene_emotional_design`. |
| `clip`'s screenplay line references | §3.5, §4.7 | Provisional | Yes | Declared in schema 2.13 as row-id references to `screenplay_lines` (proposal 0001), and replaced in 2.19 by the line anchors `line_start_ref` and `line_end_ref` (proposal 0032), which name a line by uuid. Exercised by the fixture's two clips. |
| Polymorphic references count as asset usage | §2.3, §8.6 | Provisional | Yes | Stated in 0.47 and exercised by a fixture asset reachable only through `asset_relationship.entity_id`. |
| Shot and scene media: types and order | §8.6 | Provisional | Yes | Proposal 0037, spec 0.64, schema 2.23. `relationship_type` gains `storyboard`, `start_frame`, `end_frame`, `previs`; `asset_relationship.order` orders an entity's related assets. Exercised by shot 12-04's panels, whose `order` runs against their row ids. |
| The project poster | §8.6, §12.12 | Provisional | Yes | Proposal 0038, spec 0.65, schema 2.23. `relationship_type` gains `poster`, related to the project row; Q00 returns `posters`. Exercised by the fixture project's one-sheet. |
| Absolute identifiers are permitted | §8.2 | Provisional | Yes | Stated explicitly in 0.48: a warning, never a refusal, and `..` is the error instead. Whether an implementation may resolve one to bytes is 0003 and open. |
| The proposal path | — | Provisional | Yes | `proposals/` since 0.32. Thirty-eight filed: thirty-three implemented, three declined, two deferred past 1.0 (0003, 0015). `check_proposal_status.py` fails if a changelog records a proposal that still reads `draft`. |
| Framework columns | §2.2 | Stable | Yes | |
| Ownership rule (`scene_id` belongs vs points at) | §2.3 | Stable | Yes | `scf-core/src/ops/sceneOps.ts`. Derived, so new entities are covered without an edit. |
| Hidden `nameField` rule | §2.3 | Stable | Yes | |
| Registry-derived asset usage | §2.3 | Provisional | Yes | Correct as written; only one implementation has ever applied it. |
| Tier bands 0–6 | §0.7 | Provisional | Yes | Descriptive only. Carries no semantics, which is why it is not Stable — if a tier ever gains meaning, this changes. |

### Derived versus stored

| Area | Spec | Tier | Implemented | Notes |
|---|---|---|---|---|
| The derive-don't-store rule | §3.1–3.2 | Stable | Yes | The oldest rule in the format and the most load-bearing. |
| `shot_number` exception | §3.3 | Stable | Yes | Includes the renumber-on-scene-move clause. |
| `screenplay_lines.scene_id` MUST NOT be relied on | §3.4 | Provisional | Yes | Stated as a prohibition because the column is a known fragility. If the threading ever becomes reliable, this text changes rather than the column. |

### Position and ordering

| Area | Spec | Tier | Implemented | Notes |
|---|---|---|---|---|
| Story order from screenplay position | §4.1 | Stable | Yes | `scenePositions` / `sceneOrderHint` / `storyOrder()`, with SQL twins. |
| Fallback chain (`scene_number`, then row id) | §4.1 | Stable | Yes | |
| `scene_number` is a label | §4.2 | Stable | Yes | |
| Scene-number grammar and ordering | §4.2.1–4.2.3 | Provisional | Yes | `sceneNumbers.ts`. Implemented in both engines and pinned, including a test asserting the two agree. Provisional rather than Stable only because no second implementation has exercised it. |
| `scene_number` declared type | §4.2.3 | Provisional | Yes | Widened to text in schema 2.9. The FIXTURE's column was rebuilt to match in 0.17 — until then the registry, the published DDL and the fixture disagreed, and §4.2's grammar was unexercised by the artifact meant to demonstrate it. |
| The fixture exercises §4.1's ordering rule | §4.1 | Provisional | Yes | Fixed in 0.17: `12A` sits mid-script with a higher row id than the active scenes either side of it, and `16` follows `19` keeping its number. The three orders now differ, and three invariant tests pin that. |
| Numbering policy covers all four numbers | §4.3 | Provisional | Yes | 0.17 states that act, sequence, scene and shot numbers are all authored and all governed by `project.numbering_policy`. The editor recomputes all four under `derived` and preserves all four under `fixed`, including when the Structure view renumbers spans directly; `scf-core/test/structureCommit.test.ts` asserts both. |
| `project.numbering_policy` | §4.3 | Provisional | Yes | Renamed from `scene_numbering` in 2.11; the old column removed in 2.12 under §11.0. `numbering.ts` owns resolution, and a test asserts a stale `scene_numbering` cannot override it. |
| Pre-1.0 change licence | §11.0 | Provisional | n/a | States that §11's rules take effect at 1.0 and that earlier files are disposable, with the fixture excepted. Provisional because it is the kind of clause that is easy to write and easy to overrun — it needs the 1.0 release to prove it was honoured. |
| Result envelope and row projection | §12.1 | Provisional | Yes | `queryResult.ts`. Rows by uuid, volatile columns dropped, references resolved to uuids. Provisional until a second implementation has produced a matching result. |
| The `{uuid, fields}` projected row | §12.1.2 | Provisional | Yes | Stated in 0.29. It had been demonstrated by the blessed artifacts and never defined, which was the third reader run's central finding. Provisional until a second implementation has produced one from the text alone. |
| Polymorphic `_id` columns dropped | §12.1.2 | Provisional | Yes | `projectRow()` drops a column the registry declares `polymorphicType`, and the query lifts the resolved reference instead. Stated in 0.29 as "any `_id` with no `referenceEntity`"; 0.40 replaced that pattern-match with the declaration ("Polymorphic references declared", above). Q10 and Q15 both depend on it. |
| Derived records carry nulls | §12.1.4 | Provisional | Yes | Stated in 0.29. The opposite of §12.1.2's omit-empties rule, and the two were indistinguishable in the artifacts. |
| Open vocabularies | §2.4 | Provisional | Yes | Stated in 0.53 (proposal 0022). Sixteen fields lost `other` and gained `open: true`; `vocabulary.unlisted_value` reports the tail. Exercised by the fixture's `creative_decision` row carrying `decision_type = "sound"`, which had never been a member and which nothing had ever checked. |
| Presence of a vocabulary value | §2.4.1 | Provisional | Yes | Stated in 0.57 (proposal 0030). `optionPresence` in the registry gives each value of `scene_character.role_in_scene`, `scene_prop.significance` and the shot `framing` fields a presence: `seen`, `heard` or `named`. `lint_registry.py` requires it to be total over the options. Before 0.57 the vocabularies carried presence and nothing defined it, so the published Q03 and Q12 listed a `mentioned` character with nothing to say she is not on screen. |
| A presence link is authored | §2.4.1 | Provisional | Yes | Proposal 0041. A `scene_character` or `scene_prop` row is valid with no cue in the scene, and a writer MUST NOT refuse it for that. The reference host's write gate refused exactly this until now (`ops/integrityGate.ts`); it reports the disagreement as a question in the plan and applies the write. Pinned by `opTable.test.ts`, `scf-host/test/agent.test.ts` and `scf-mcp/test/writeTools.test.ts`. No finding exists for it, by design. |
| Theme carriers on spans | §12.11 | Provisional | Yes | Stated in 0.53 (proposal 0013). An act or sequence carries a theme at every scene of its derived membership, so a scene moved across a boundary moves its count with it. The fixture connects Forgiveness to Act 2. |
| §12's closed vocabularies | §12.1.5 | Provisional | Yes | §8.3's states, §12.9's severities, and §12.8's `provenance`, trail `layer` and `excluded.by`. §12.1.5 also names the one formatted string (§12.17's `mismatches`, whose escapes are stated exactly since 1.0-rc.4) and the prose members. All three `provenance` values appear in the published Q13 and Q02 results. |
| Label lists | §12.1.5 | Provisional | Yes | Stated in 0.29, with the source column named per query. Q12 only. |
| Q09 relatedness is one hop | §12.10 | Provisional | Yes | Stated in 0.29. Non-transitive, deliberately. |
| Report `clean`, `rowIds`, `count` | §9.5 | Provisional | Yes | Stated in 0.29. `clean` was listed in §9.5 and never defined; the semantics lived only in `findings.ts`. Since 1.0-rc.2 one code on one table is one finding with every row at fault in `rowIds`, pinned by the negative case `asset-orphans-two` and the identity cases, and the fixture's own report is published (`fixtures/hollow_creek.report.json`). |
| The media trail as records | §12.8 | Provisional | Yes | Since 1.0-rc.2 each `trail` entry is a derived record with a closed `excluded.by`, and only `excluded.reason` is prose. Exercised by Q13, `Q13-scene3` (a filter), `Q13-scene25` (a replacement and an unverified anchor) and the Q02 cases. `displaced` and `variant_not_in_force` are unexercised by a published result: the fixture's displaced anchor is also unverified, and §12.8 reports `canonical_status` first. |
| A superseded asset gives way | §12.8 | Provisional | Partly | Proposal 0039. A reference whose asset is `superseded` names the last asset on its forward version chain instead, with `supersedes` naming the one the layer brought; every reference carries `lifecycleStatus`. Pinned by `supersededGivesWay.test.ts` on a copy of the fixture. **No published result exercises the substitution**: the fixture's one chain leaves the v1 kitchen night plate `active` and unbound, so every published `supersedes` is null and an implementation that ignores the rule reproduces every published result. The fixture needs a bound, superseded asset before this can be Stable. |
| The screenplay tables are published | §1.3.1 | Provisional | Yes | `screenplay-tables.json`, dumped from `initDatabase()` on `scf-schema.sql`'s reasoning. Columns, nullability, defaults and a purpose per table. |
| `line_type` is a closed vocabulary | §1.3.1 | Provisional | Yes | Fifteen values. `LINE_TYPES` in `fountain/types.ts` is a runtime array, the artifact is generated from it, and `screenplayTables.test.ts` checks the artifact back. The column — free TEXT — cannot enforce the closure, so a validator reports a value outside the set as `line.type_unknown` (`error`, since 0.66), exercised by the negative case `line-type-unknown`. Provisional because no second implementation has written the column. |
| All sixteen queries | §12.2–12.17 | Provisional | Yes | Specified and blessed as `fixtures/expectations/*.result.json`. Q03 and Q12 are blessed away from scene 12 — at 19, and diffing 19 → 16 — so the suite can now tell a §4.1-conforming resolver from one ordering by `scene_number`. Reintroducing the old ordering fails four tests; before 0.22 it failed none. |
| Expectation coverage | — | Provisional | Yes | Every query is specified and has a normative result, and since 0.67 a normative case result wherever one position cannot show a member: scenes 3, 7, 10, 12, 16, 19, 21, 24 and 25, a prop and a location subject, a versioned asset, a cascade tie, and Q14 for a Q02, a Q07 and a Q13 target. No member of any result is empty in every result of its query except the two environment-dependent `sizeBytes` (§8.3); `resultCoverage.test.ts` fails if that changes. Provisional: one fixture. |
| Results exclude `cut` rows | §12.1.2 | Provisional | Yes | Follows §6.6.1. Settled before the other fourteen queries were blessed, so they get blessed once. |
| Shot-code canonical form | §4.4.1 | Stable | Yes | `shots.ts`. Bijective base-26, zero-based. |
| Shot codes parsed relative to the scene | §4.4.2 | Provisional | Yes | `parseShotCode()`, used by both `nextShotNumber()` and `restampShotNumber()`. Pinned by the A-page regression cases in `shots.test.ts`. |
| Shot-code allocation | §4.4.3 | Provisional | Yes | Continue-past-highest, with the stated no-retired-codes limitation. |
| Restamping under `numbering_policy` | §4.4.4 | Provisional | Yes | Corrected in 0.29: §4.4.4 had cited `project.scene_numbering`, removed in schema 2.12. |
| Presence at a shot | §4.6 | Provisional | Yes | Stated in 0.57 (proposal 0030). `shot_character` and `shot_prop` rows, three closed fields, and `shot.presence_complete`; an unrecorded shot inherits its scene. `presence.ts` is the one implementation, and Q03, Q04, Q12, Q14 and `shotContext` all call it. The fixture exercises recorded, complete and inherited shots. Provisional: no second implementation, and the field vocabularies have met one film. |
| A shot is at its scene's location | §4.6 | Provisional | Yes | Stated in 0.57. A deliberate line: a flashback or each side of an intercut is its own scene. It asks something of importers, who split an intercut written as one scene. |
| The lines a shot covers | §4.7 | Provisional | Yes | Stated in 0.59 (proposal 0032). Two line anchors on `shot` and on `clip`; whole lines; ranges may overlap, which is how coverage is shot. Unrecorded shots do not inherit their scene's lines. `lines.ts` is the one implementation. |
| Line anchors | §3.5 | Provisional | Partly | Stated in 0.59. A text uuid, declared by `lineAnchor` in the registry, with orphans reported. Partly: re-anchoring through a split or merge is a SHOULD, implemented by this repository's editor and unexercised by any other writer. Before 0.59 none of this was in the specification, and `clip`'s row-id line references had come to point at a blank line, a section marker and a heading in the fixture. |
| Pattern 1 — explicit rows | §4.5 | Stable | Yes | |
| Pattern 2 — persistence | §4.5 | Stable | Yes | Pinned. |
| Pattern 3 — latest wins | §4.5 | Stable | Yes | Pinned. |
| Oldest-first merge of persistent states | §4.5 | Provisional | Yes | Field-by-field override is right for the cases in the fixture; no outside consumer has tested it. |

### Structure

| Area | Spec | Tier | Implemented | Notes |
|---|---|---|---|---|
| Spans defined by start alone | §5.1 | Stable | Yes | |
| Contiguity constraint | §5.2 | Stable | Yes | Accepted cost, stated in the design record. A cross-cut requirement would require replacing the model, not patching it. |
| Acts and sequences independent | §5.3 | Stable | Yes | |
| Run-grouping requirement for renderers | §5.3 | Provisional | Yes | `actOutline()`. A presentation requirement in a data spec — sits oddly, may move to a rendering note. |
| `scene_sequence` shadow rows | §5.4 | Provisional | Yes | **Decided in 0.38: they stay.** The question was whether a stored derived fact should survive 1.0. It resolved differently than expected once Q04 was found reading them — the defect was not that the rows exist but that a normative query treated a permitted-to-be-stale shadow as truth. Q04 now derives from boundaries, no canonical query reads the table, and §5.4 requires a conforming reader to derive. What remains is a compatibility surface for consumers outside this specification, with `structure.shadow_row_unexplained` reporting rows no boundary explains. |
| Half-placed structure valid | §5.5 | Stable | Yes | |

### Identity

| Area | Spec | Tier | Implemented | Notes |
|---|---|---|---|---|
| Row `uuid` on all entities | §6.1 | Stable | Yes | Schema 2.3. |
| Uuids do not cross files | §6.2 | Stable | Yes | |
| Junction natural keys | §6.3 | Provisional | Yes | Published as `spec/junction-keys.json` in 0.26 — it was cited as a FUNCTION until then, so no third party could compute one. Still only exercised by de-duplication; merge is the real test and does not exist. Since 0.60 a reference marked `qualifier` is excluded from the key. |
| Unexplained shadow rows reported | §5.4 | Provisional | Yes | `structure.shadow_row_unexplained`, added in 0.26. §5.4 required a finding the closed catalog had no code for, and the detection lived only in the editor's commit path — so the one tool a third party runs never mentioned them. |
| Duplicates as findings | §6.4 | Stable | Yes | |
| Relationship `directionality` | §6.5 | Provisional | Yes | Schema 2.4. |
| Read from both character columns | §6.5 | Stable | Yes | |
| `lifecycle_status` preserved | §6.6 | Provisional | Yes | The column exists and is authored on every non-link entity. |
| Cut rows excluded from every derivation | §6.6.1 | Provisional | Yes | `rows()` filters; `rowsIncludingCut()` is the history path. The fixture carries a cut scene with a heading and a cut beat in scene 12, so the rule is exercised rather than asserted. |
| Reading back what was cut | §6.6.2 | Provisional | Yes | **Closed in 0.38.** `scf-check --cut` lists every cut row by uuid and name, through `rowsIncludingCut`, on a code path separate from the report — §6.6.2 asks for that separation, and a cut row is an authorial act rather than a finding. |
| `sceneOrder` derives from the screenplay | §4.1 | Provisional | Yes | Fixed in 0.21 — it had sorted by `scene_number` then row id, which §4.1 forbids. Now delegates to `scenePositions`, with a test asserting the two agree. |

### Cascade

| Area | Spec | Tier | Implemented | Notes |
|---|---|---|---|---|
| Cascade identified by its leaf | §7.1 | Provisional | Yes | Rewritten in 0.17. The previous text described a scope ordering that does not exist. |
| Chain is the `refines` closure | §7.2 | Provisional | Yes | `cascadeChain()`. Independently reverse-engineered from the data by a second implementation, which reproduced Q07's seven layers and Q08's two exactly — good evidence the rule is right, and that it was undocumented. |
| One row per entity, most specific first | §7.3 | Provisional | Yes | `fetchLayer()`. Since 1.0-rc.4 a `latest_wins` layer's tie at its position goes to the highest row id, as §4.5's pattern 3 does everywhere, and `Q07-scene3` pins it; until then §7.3 said the lowest and §4.5 the highest, and the reference followed §7.3 here and §4.5 for the state tables. |
| Every contributing entity returned | §7.4 | Stable | Yes | |

### Assets

| Area | Spec | Tier | Implemented | Notes |
|---|---|---|---|---|
| Asset is a reference, never a container | §8.1 | Stable | Yes | Pinned by an assertion that no export contains `base64`, `blob:` or `data:`. |
| Identifier grammar | §8.2 | Provisional | Yes | Schema 2.8. Newest normative area in the document. |
| `@project` root | §8.2 | Stable | Yes | |
| Root mapping not stored in the file | §8.2 | Stable | Yes | Follows from portability. |
| Absolute paths representable, flagged | §8.2 | Provisional | Yes | |
| Resolution states | §8.3 | Provisional | Yes | Settled in 0.19. Five states, the code's spelling, and the spec/code disagreement about an unmapped root resolved in the spec's favour: it is `unaddressed`, not `out-of-root`. `out-of-root` now depends only on the identifier, never on the session. Since 1.0-rc.4 §0.3 and §12.8.1 say so too, and the fixture's absolute `.tif` is `out-of-root` in the published `Q02-locket-scene25` beside rooted references that are `unaddressed`. |
| Purpose lives on the link | §8.4 | Stable | Yes | `asset_type` was removed in 2.8, deliberately not replaced. |
| Format is a hint | §8.5 | Stable | Yes | |
| Unknown extension is not an error | §8.5 | Stable | Yes | `previewCapability()` lands unknowns in tier 3, never tier 1. |
| Orphan detection registry-derived | §8.6 | Provisional | Yes | Measured to 2,000 assets. |
| Content metadata never stored | §8.7 | Stable | Yes | Including the "cannot be queried" consequence. |
| Layers | §8.8 | Reserved | No | Name claimed. Layers live in a subfolder, never at the root. Nothing else specified. |

### Findings

| Area | Spec | Tier | Implemented | Notes |
|---|---|---|---|---|
| Describes, does not enforce | §9.1 | Stable | Yes | |
| Resolvers total | §9.2 | Stable | Yes | |
| Extraction is a proposal | §9.3 | Stable | Yes | |
| Props never auto-accepted | §9.3 | Stable | Yes | |
| Export carries a resolution report | §9.6 | Provisional | Yes | |
| Finding catalog published | §9.4 | Provisional | Yes | `spec/finding-catalog.json`, generated and checked. Closes the reason no independent implementation could satisfy §9.4. |
| Negative fixtures reproducible by third parties | — | Provisional | Yes | `fixtures/negative/CASES.json`, generated by the same script that builds them. |
| **Queries as part of the format** | §12 | Provisional | Yes | Decided 2026-08-17: the sixteen canonical queries are normative, and the normative answer is the STRUCTURE, not the rendered prose. **All sixteen are specified** (§12.2–12.17), each with a published normative `.result.json`, and §12.1's shape conventions were stated in 0.29. This row read "Nothing is specified yet — the largest remaining piece of specification work" until 0.36, four revisions after that stopped being true. |
| Enumerated finding types | §9.4 | Provisional | Yes | `findings.ts` — a closed catalog, published as `spec/finding-catalog.json`, with severity owned by the catalog, deterministic ordering, and `collectFindings()` as the single engine a CLI, the panels and the tests all share. Provisional until a report has been read by someone who did not write it. |
| The known-table set | §1.3 | Provisional | Yes | §1.3 defines the file's tables as the registry plus `UUID_EXTRA_TABLES`, which conflated two questions. Schema 2.10 splits them: `ownedTables` for SCF's tables that carry no identity, `uuidExtraTables` for those that do, and `Registry.knownTables` as the union. Title-page rows are properties of the screenplay, so they carry no uuids. Found by `collectFindings` on its first run over the fixture. |
| What each finding carries | §9.4.1 | Provisional | Yes | Since 1.0-rc.4 `table`, `rowIds` and `count` are stated for every catalog code, read from `findings.ts` and its producers. Twenty-four of the 55 are raised in a published report — a negative case's or the fixture's — and pinned by it; the rest are stated and unexercised. |
| Enumerated finding behaviour on broken files | §9.4 | Provisional | Yes | Nineteen negative cases in `fixtures/negative/`, each pinning one code, with blessed reports and a `--check` mode. 1.0-rc.5 added `span-boundary-cut` (a new code, `structure.boundary_cut`, §5.5) and `junction-key-null` (null key columns compare equal, §6.4). `reference-dangling` came with its code (below). |
| A reference to nothing is a finding | §9.1, §9.4.1 | Provisional | Yes | Proposal 0040. `reference.dangling` (`warning`): a reference column, ordinary or polymorphic, required or not, holding a value that names no row. Until then only relationship endpoints, span starts and line anchors were covered, and a uuid stored as text in an integer reference column was reported by nothing. Catalog version 1.1, 55 codes. Pinned by `references.test.ts` and the negative case `reference-dangling` (an ordinary reference, a polymorphic one, and text in an integer column). A polymorphic column whose sibling names no registry entity is still reported by nothing. The reference host's write gate refuses a write that adds one. |
| The serialised report | §9.5 | Provisional | Yes | `report.ts`, own format version, determinism pinned. Provisional until a second implementation has parsed one. |
| `scf-check` | §9.4–9.5 | Provisional | Yes | CLI over `collectFindings`. Covers eight of `conformance.md` §4's nine checks; the asset resolution tally needs a root-mapping flag that has not been designed. |

### Extensibility

| Area | Spec | Tier | Implemented | Notes |
|---|---|---|---|---|
| Ignore unknown content | §10.1 | Provisional | Yes | Pinned by `extensibility.test.ts`. |
| Preserve unknown content on write | §10.1 | Provisional | **Yes — verified** | An `x_` table, an `x_` column with its values, and an unprefixed unknown table survive `initDatabase` across five cycles, and survive the app's own open→edit→save cycle across three. Provisional rather than Stable because the browser's `sqlite3_js_db_export` path is still exercised only by hand. |
| Document equality / canonical dump | §11.6 | Provisional | Yes | `canonical.ts`. Answers `conformance.md` §3's open question about what a round trip is compared on. Provisional until a second implementation has produced a dump. |
| Canonical query expectations as data | — | Provisional | Yes | `fixtures/expectations/` — a normative `.result.json` for all sixteen queries and a normative `<Q>-<case>.result.json` wherever one position cannot show a member, plus rendered markdown for eight. Both free of row ids and timestamps. `shapes.json` was retired in 0.30. |
| Conformance claim process | — | Provisional | n/a | `conformance.md` §6: self-certification, per role, with the reports published. Untested in the only way that matters — nobody has made a claim. |
| Reserved names | §10.2 | Provisional | Yes | `@plates` and `@nas` reserved; entity and column names checked by `lint_registry.py` and `registrySchema.test.ts`. |
| `x_` extension prefix | §10.3 | Provisional | Yes | Enforced at the moment a name is chosen (the linter) and again at the generated artifact (the schema test). Preservation covered by the row above. |

### Versioning

| Area | Spec | Tier | Implemented | Notes |
|---|---|---|---|---|
| Additive-only schema changes | §11.1 | Stable | Yes | Every change has been one except those §11.0 lists, taken before 1.0 under its clause. |
| Forward compatibility | §11.2 | Provisional | Partly | Follows from §10.1, which is tested and holds (`extensibility.test.ts`, since 0.13). Partly because no file from a later schema has yet been read by an earlier reader outside the test suite. |
| Backward compatibility | §11.3 | Provisional | Partly | Same. |
| Deprecation window | §11.4 | Provisional | n/a | No removal has gone through it yet: every one so far was taken under §11.0, which §11.4's note records. |

### Out of scope

| Area | Tier | Notes |
|---|---|---|
| Version / snapshot system | Out of scope | May never enter. Revert is retired; publish and diff remain read-only. External file versioning is the right tool. |
| Cross-file merge | Out of scope | Depends on natural keys, which are specified. The algorithm is not. Belongs with multi-user work. |
| Packaging / archive form | Out of scope | Not planned. |
| Editor UX, import heuristics | Out of scope | Never in scope. |
| Metadata query | Out of scope | Deliberately impossible, per §8.7. |

---

## Summary — what stands between here and 1.0

**No Unstable rows remain**, and none has since 0.38, when rubric steps
came to resolve against the registry (§12.9.1), `scf-check --cut` began
reading back what was cut (§6.6.2), and `scene_sequence` shadow rows
were decided — they stay, and no canonical query reads them (§5.4).

**No row is "not yet implemented" either.** Two rows — `varies` and
`status` — once said *No* when what they lacked was a fixture row that
exercises them. Both are exercised since 0.68, along with every other
rule that was implemented and never run against data;
`docs/release-checklist.md` §D3 lists that class and the row each gained.

By the definition at the top of this document, **that is what a 1.0
is.** It is not a claim that the format is finished, and this section
should not be read as one. Two Provisional rows carry known gaps:

- **The asset resolution tally in `scf-check`** (§8.3) — the one check
  of `conformance.md` §4's nine the validator cannot do, because §0.3
  makes the root mapping a property of the consuming environment and no
  flag exists to supply one.
- **The `scf-core` public API** — stated and enforced since 0.34, and
  not yet used by anyone outside this repository; the package is
  unpublished.

And what remains outside this document is real: documentation for people
who are not implementing the format, a second MAINTAINED implementation,
and a package that is published rather than merely publishable. None of
those is a stability question, which is why none of them appears above —
`docs/release-checklist.md` is where they are tracked.

*Closed in 0.38:* all three remaining Unstable rows. See §12.9.1, §6.6.2
and §5.4, and the note below on what a 1.0 means.

*Closed in 0.34:* the published API surface. `src/index.ts` states it
explicitly, the closure is enforced, and the four editor-tooling modules
are out. What remains is judgement rather than structure — a handful of
rendering and browsing helpers inside kept modules could still go, and
that is a proposal rather than a defect.

*Closed in 0.33:* artifact addressing. `schema-2.12` exists, and every
URL the manifest publishes resolves and verifies against its digest.

*Closed in 0.24:* the envelope holds for a whole-story answer, not only
a positional one.

*Closed in 0.23:* every query that takes a position is specified. Q13's
embedded row id is gone, and §12.1.1 now distinguishes a row reference
from a literal parameter.

*Closed in 0.22:* the expectations no longer cluster on one scene. The
suite can now distinguish a conforming resolver from one using the
ordering §4.1 forbids — which it could not do when that bug was live.

*Closed in 0.21:* §6.6 is decided — cut rows are excluded from every
derivation, and the fixture carries cut rows that prove it by changing
nothing. `sceneOrder` was also found ordering by `scene_number`, which
§4.1 forbids, and now derives from the screenplay.

*Closed in 0.20:* §12 exists. The queries have an envelope, a portable
row projection, and two normative definitions.

*Closed in 0.19:* `scene_numbering` is gone, and with it the one place
the format deliberately stored a fact twice; and §8.3's resolution
states now agree between spec and implementation.

*Closed in 0.17:* the finding catalog is published (§9.4); the negative
fixtures are reproducible without this repository; §7 was rewritten,
having been found wrong rather than incomplete; and the fixture's three
orders were made to differ, so §4.1 is checkable at last.

*Closed in 0.15:* the known-table set (§1.3), and `scf-check`, which
was the item most of §5 was waiting on.

*Closed in 0.14:* enumerated finding types (§9.4).

*Closed in 0.13:* unknown-content preservation (§10.1) — tested, and it
holds — and the `x_` prefix (§10.3), now enforced at both the linter and
the generated artifact.

*Closed in 0.12:* `application_id` / `user_version` (§1.2).

*Closed in 0.11:* the `scene_number` declared type (widened in schema
2.9) and shot-code parsing (`parseShotCode()`), which were one decision
with two commits.
