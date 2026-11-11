<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# SCF specification changelog

Changes to [`scf-spec.md`](scf-spec.md). Governed by its §11.5:

- **patch** — editorial only. No requirement changes meaning.
- **minor** — any MUST or MUST NOT added, removed, or changed in meaning.
- **major** — a change that would make a conforming implementation
  non-conforming.

This tracks the **specification**, not the schema. Schema versions live
in [`../docs/schema-changelog.md`](../docs/schema-changelog.md), and the
two move independently by design (spec §0.6).

Every entry names the schema version the specification described at the
time, so that a reader of an old spec knows what it was describing.

---

## 1.0-rc.8 - 2026-11-11

*Describes schema 2.25.*

**Editorial.** `stability.md` names the files where the editor's
operations now live in scf-core, and `api-surface.json` is regenerated
for what scf-core now exports.

**Three proposals from production use**, all found on real films after
rc.7 and all taken under §11.0, which still holds. Each adds or changes
a requirement, so under §11.5 this is a **minor** change and the next
candidate carries it. **No registry change; schema stays 2.25.** Every
published query result is re-blessed, because `resultFormat` moves to
`1.1`; the fixture is unchanged.

### §12.8 — a superseded asset gives way to its successor (proposal 0039)

- **A reference whose asset is `superseded` names its successor
  instead**: the last asset on the forward version chain, reached by
  following `superseded_by_id`. The successor keeps the layer's
  `provenance`, `role` and `anchorName`. Q13 had gone on returning a
  replaced character sheet as `resolved`, beside the sheet that
  replaced it, and a film with 95 superseded assets out of 213 had no
  way to tell from the result. The at-most-once rule applies after the
  substitution. A superseded asset with no successor, a dangling
  pointer and a cycle each leave the reference as it is (§9.2). A cut
  successor drops the reference. This is substitution, not exclusion:
  §6.6.1 is untouched, Q15 still walks the chain, and §6.6 gains one
  sentence pointing here.
- **Every reference gains two members**: `lifecycleStatus`, the asset's
  status with unset read as `active`, and `supersedes`, the uuid of the
  asset it stands in for or null. `deprecated`, `archived` and `draft`
  stay in force and are now visible.
- **`resultFormat` is `1.1`** (§12.1.1), for these members and for
  Q01's below. Q14's media and Q02's `media` change with Q13.
- **The published results do not exercise the substitution.** The
  fixture's one chain leaves v1 `active` and unbound, so every
  published `supersedes` is null. `supersededGivesWay.test.ts` pins the
  rule on a copy of the fixture; `stability.md` records the gap.

### §9.1, §9.4.1 — `reference.dangling` (proposal 0040)

- **New code `reference.dangling`**, `warning`: a reference column
  holds a non-empty value that names no row of its target, cut or not.
  It covers ordinary and polymorphic references, required and optional.
  A value that is not an integer names no row, which is what a writer
  that skips the uuid-to-row-id step leaves behind. Where
  `relationship.endpoint_absent` or `structure.boundary_dangling`
  covers the column, that code is raised instead; the version columns
  are left to the `identity.*` codes. One finding per column.
- **§12.1.2** no longer says a polymorphic reference to an absent row
  is "not a finding". The query's answer is unchanged, a null
  `targetUuid`; the report now carries the code.
- **Catalog version 1.1, 55 codes.** New negative case
  `reference-dangling`, nineteen in all. The fixture's own report is
  unchanged: it has no dangling reference.
- Not covered, and still reported by nothing: a polymorphic column
  whose sibling names no registry entity.

### §2.4.1 — a presence link is authored (proposal 0041)

- **A `scene_character` or `scene_prop` row is valid whether or not the
  subject has a cue in the scene, and a writer MUST NOT refuse it on
  that ground.** A link and the script may disagree; that is a question
  an authoring tool MAY ask, never a finding. The reference host
  refused 94 such links on one film: its write gate had promoted an
  editor review aid to a hard block, against §2.4.1's own definition of
  `named` presence and against §9.1.

### §12.15, §12.16, §6.5 — relationships in the dossier (proposal 0041)

- **Q01 gains `relationships`**: for a character, each
  `character_relationship` naming them in either column, as
  `{relationship, other, side}`. `character_relationship` has no
  `character_id` column, so the group walk never found it, and neither
  Q01 nor Q02 said who a relationship was with or which way it read. A
  relationship to a cut character is absent; one whose other end is not
  in the file is kept with `other` null; one naming the subject twice
  appears once, as side `"a"`. Any other subject kind carries `[]`.
- **Q02 carries it through `dossier`**, and §12.16 now says that
  `relationshipStates` holds the stages and not the relationships.
  §6.5 cites Q01 as the worked example of reading both columns.
- Seven published results gain the member: `Q01` and `Q02` (three
  entries each, Eleanor on side `"a"`), `Q02-marcus-scene25` (two, one
  on each side) and the four non-character Q02 cases (`[]`).

## 1.0-rc.7 — 2026-10-20

*Describes schema 2.25.*

**The seventh and last release candidate, limited to Q14**, from the
eleventh independent reader run (`docs/release-checklist.md` §D1). It
reproduced every published artifact outside Q14 exactly, conformed on
all nine published Q14 results, and had no critical finding. Its two
majors were both in §12.9.1: each let two readings of the text give
different severities on a `recommended` or `required` step. Fixing them
changes which Q14 severities are permitted, so under §11.5 this is a
**minor** change. **No registry change; schema stays 2.25.** Taken under
§11.0, which still holds. 1.0 is to be cut from this candidate without a
further reader run; Q14 stays Provisional (`stability.md`).

### §12.9.1 — a step over rows a query resolves (M1)

- **A step over rows a query resolves is satisfied by what that query
  resolves**, at the position, not by the rows §12.9.1's routes reach. A
  rubric step gains `resolvedBy`, naming the query; Q13's
  `entity_anchor` and shot-override steps carry `"Q13"`. The anchor step
  therefore counts exactly the anchors Q13 lets contribute: verified, of
  the intent's anchor type (§12.8), and a variant's only where §4.8 puts
  that variant in force, the subject's own displaced where it does. The
  override step counts only overrides whose bundle has the intent. The
  routes alone found Marcus's one verified anchor, which names his young
  variant, and called him pinned at every position; Q13 returns no
  anchor for him outside scene 25. New worked example
  `Q14-Q13-marcus-scene12`: the step is a `warning`. The generator
  checks that `resolvedBy` names a query with a rubric.

### §12.9 — the shot fixes the position for every step (M2)

- A Q14 asked at a shot asks its media step's Q13 at that shot, whether
  or not the target takes one: a `voice_identity` bundle applied by a
  `character_shot_override` there meets Q05's media step. The media step
  said "at the query's scene and shot", which read as Q14's or as the
  target's. No worked example: the fixture's one shot override replaces
  a `visual_identity` bundle, so no published position tells the readings
  apart, and adding one would change the fixture and other published
  results in the last candidate.
- Consistently, a shot narrows a column only for a target that takes
  one: "a column naming a parameter the target takes", not "the query
  received" (m3). Q08's `sound_cue` is narrowed by its `scene_id`.

### Reference

`readiness.ts` already read Q13's anchors and overrides from
`resolveMedia`, the code Q13 answers with, so the anchor step needed no
change. Its Q05 and Q06 walkers asked their media step's Q13 without the
shot; they now pass it. No published result changes.

### Editorial

- §12.9.1: "one declared reference away" is a reference to an entity
  with a reference to the subject's kind, whatever the column is named,
  as `character_relationship`'s `character_a_id` is (m2). The list of
  steps naming an entity their target does not read gives examples, not
  every one.
- §12.9: `counts` has every severity as a key, zeros included (m8).
- `conformance.md` §7: eleven reader-run implementations, not nine;
  `stability.md`'s expectation-coverage row names scenes 7, 12, 16 and
  19 and the Q07 target. README, site and `what-is-scf.md` status lines.

### Left for after 1.0

Run 11's other minors need a decision about behaviour, not a sentence,
and are unchanged: a non-baseline binding with no filter and no range at
a cut scene, and a scene-ranged one there (m1, §12.1.7, §12.8.1 — with
rc.6's m4); whether a shot row naming a character its scene does not
link, or makes `named`, counts as seen (m4, §4.6); Q14 asked without a
required parameter or with a subject kind its target does not take (m5,
§12.1.7); marking a cross-step finding and bounding its severity (m6);
`entity` for a step that does not apply, on which the published results
differ (m7); a cut subject asked about (m9, §12.1.2). rc.6's deferred
m4, m6, m7, m8 and m11 are unchanged.

---

## 1.0-rc.6 — 2026-10-20

*Describes schema 2.25.*

**The sixth release candidate, limited to Q14**, from the tenth
independent reader run (`docs/release-checklist.md` §D1). It reproduced
all 57 published artifacts from the text alone, with no critical
finding. Its four majors were all in §12.9.1's rubric, each two MUSTs
giving different severities in a case nothing published asked about.
Fixing them changes which Q14 severities are permitted, so under §11.5
this is a **minor** change, not an editorial one. **No registry change;
schema stays 2.25.** Taken under §11.0, which still holds. Nothing
outside Q14 changed except wording.

### §12.9.1 — the rubric says what the text says (M1–M4)

- **A reference to `scene` or `shot` is a position, never a route to a
  subject (M1).** Read literally, "one declared reference away" reached
  `location` through `scene.location_id` from every scene-keyed entity,
  so Q05's `dialogue_rhythm` did not apply to any character and Q02's
  costume step applied to a location — the opposite of the section's own
  examples. The reference already behaved this way.
- **A media step is one satisfied by `bundle` alone (M2).** Q13's first
  step gains `satisfiedBy: ["bundle"]`: the binding tables are context,
  and a binding of the subject's that is excluded at the position does
  not meet the step. The multi-entity rule called that `ok` and the
  media rule a `blocker`; it is a `blocker`. New worked example
  `Q14-Q13-windchime-scene12`.
- **Look steps are marked (M3).** A rubric step gains `appliesTo:
  "seen"`, on Q02's appearance, physical and costume steps and Q07's
  `character_appearance_profile`. §12.9 says how it meets a subject: a
  character subject not seen at the position — heard, named, or not
  there — reports those steps as not applying. The reference assessed
  them for anyone. New worked example `Q14-Q02-ada-scene3`.
- **Q02's media intent is per kind of subject (M4).** The step's
  `intent: "visual_identity"` becomes `intentBySubjectType`, mapping a
  location to `environment` and a character or prop to
  `visual_identity`, as §12.16 asks the Q13 answer Q02 nests. The
  generator checks every intent against the registry's bundle intents.
  New worked example `Q14-Q02-kitchen-scene10`: the fixture's kitchen
  has no `environment` bundle, so the step is a `blocker`.

### Rules now stated

- §12.9.1: "does not apply" means the step cannot be narrowed to the
  subject asked about by either route; an entity that reaches the
  subject applies whatever else it names, as `costume_scene` names a
  costume (m1).
- §12.9.1: Q13's `entity_anchor` step counts verified anchors only, an
  unset status counting as verified, as Q13 reads them; the step gains
  `filter: canonical_status = verified`, and the `filter` member says an
  unset value reads as the target reads it (m2).
- §12.9.1: a step's rows are narrowed *as its target narrows*, not "the
  rows its target reads" — some steps name entities their target does
  not read (m3).
- §12.9: every parameter is recorded in the envelope as asked; one the
  target does not take is ignored, except `shot`, which fixes the
  position for every target (m5). At a cut scene, Q14 assesses what its
  target answers at that empty position, and no character is seen there
  (m9).

### Reference

`readiness.ts` follows the rules above: Q02's look steps check presence
(§2.4.1, §4.6) and its media intent is read from the rubric; Q07 sees no
one at an empty position. Its Q05 walker raised a `suggestion` for
absent vocal beats on a `recommended` step, outside the permitted range;
it now raises a `warning`. The media step's message no longer says "no
bundle/binding" where a binding exists and is excluded. No published
result changes.

### Editorial

- Appendix A: eighteen negative cases, not sixteen; conformance §5.3's
  list names `junction-key-null` and `span-boundary-cut` (m10).
- The rubric's Q08 `params` is `scene`, §12.9's name (m10).
- `stability.md`'s Q14 row; README, site and `what-is-scf.md` status
  lines, and ten reader-run implementations.

### Left for after 1.0

Run 10's minors outside Q14 that are not wording are unchanged: shot-keyed
rows at an empty position and a shot in no scene (m4, §12.1.7);
`sequence_act_mismatch` derived over cut scenes (m6, §9.4.1); a link's
hidden `name` in the duplicate comparison (m7, §6.4); a relationship to a
cut character (m8, §6.6.1); a dangling binding's trail entry (m11, §12.8).
Each needs a decision about behaviour, not a sentence.

---

## 1.0-rc.5 — 2026-10-20

*Describes schema 2.25.*

**The fifth release candidate**, from the ninth independent reader run
(`docs/release-checklist.md` §D1). It reproduced every published result,
every negative report and the fixture's report from the text alone, with
no critical finding. Its six majors were all in cases nothing published
asked about: Q14's narrowing in four places, a span whose start scene is
cut, and a shot asked without its scene or outside it. **No registry
change; schema stays 2.25.** Taken under §11.0, which still holds.

### §12.9.1 — Q14 narrows as its target reads (M1–M4)

One rule replaces "narrowed by whichever parameters the entities declare
as a column" and "satisfied by any of them unless its `purpose` says
otherwise": **a step's rows are the rows its target reads.** To the
subject through a column naming it, or one declared reference away —
so `relationship_state` applies to the character it belongs to (M1).
To the position by pattern, by §7.3's fall-through where the target
takes a shot, or by column — so a shot with no lighting of its own is
ready on the scene's, as Q07 answers there (M3). A rubric step gains
`satisfiedBy`: Q02's costume step is satisfied by a `costume_scene` here
and by nothing else, which is what §12.9's own example always said (M2).
Q13's rubric names `costume_asset_binding`; `entity_anchor` and the shot
overrides do not apply to a costume (M4). "Does not apply" is now
defined: every entity that could satisfy the step is keyed to a subject
of another kind, or to a shot or location the position lacks. A media
step names `bundle`; one with no `intent` takes the target's. New worked
examples: `Q14-Q02-eleanor-scene7`, `Q14-Q07-shot12A`,
`Q14-Q13-shawl-scene12`.

The rubric's `params` use §12.9's names, and Q02's lists `shot` (m7).
Q06's beat step is `physical` only, as Q06 returns (m8). Q07's rubric
lists `color_script` and `look_development`, which the reference always
reported. The reference's Q07 walker raised a `suggestion` for an absent
`color_script_entry` (a `recommended` step, so `warning`) and a
`warning` for an absent `shot_design` (`optional`); Q08's skipped
`location_sound_profile` at a scene with no location; Q13 failed on a
costume asked at a shot. All fixed; the fixture never exercised them.

### §5.5 — a span whose start scene is cut covers no scene (M5)

As an absent boundary would: its scenes belong to the span before it. It
is not re-anchored, because a cut scene has no position to be next to.
**New finding `structure.boundary_cut`** (warning), since the validator
derives over cut scenes too and otherwise saw the span anchored. Negative
case `span-boundary-cut`. Q10's span membership now excludes cut scenes
and cut spans, as Q04's lineage always did; the two disagreed.

### §12.1.7 — positions, and questions that are not answered (M6, m12, m18)

**A shot fixes the position at its own scene**: asked alone (Q13, and
Q14 for Q13) it is at its scene, which the envelope still records as
null; asked with a scene it is not in, the question is not answered.
`Q13-shot1204` shows the first. **A cut scene is an empty position for
every query**, as Q03's always was: the reference's Q04 returned the cut
scene's own screenplay lines, and Q05, Q07 and Q11 read rows still keyed
to it. **A question that is not answered has no result** — no envelope
with a null `result`.

### Rules now stated

- §6.4: null key columns compare equal (negative case `junction-key-null`).
- §12.11: a connection whose target is cut is not a carrier, and is
  absent from `carriers`; carriers are in connection row order (m13).
- §12.13: a row keyed by `sequence_id` alone is at no scene for Q11.
- §12.8: a binding to a cut bundle and an anchor on a cut asset are not
  considered and have no trail entry (m14). The reference kept the
  anchor as contributing with nothing to contribute; it now drops it.
- §12.16: each character member's shape and order (m1, m2).
- §12.2, §12.16: an unset `beat_order` sorts as 0 in every beat array
  (m3). The reference's Q05 sorted it last and Q02 did not sort.
- §12.4: Q03's `costumes` and `motifs` order (m1); §12.14: Q15's
  `attached` in row order.
- §12.17.1: an unknown `line_type` is not in `screenplay`, per §10.1;
  `line_order` ties by row id (m11). The reference included such lines.
- §4.5: a state resolved at or before its own scene is in force nowhere
  (m9). §4.2.3: `scene_number` is read trimmed; empty is absent (m19).
- §8.3: an unparseable identifier, root-name case, a bare root and a URL
  (m10).
- §12.1.6: the lowest-row-id sentence no longer reads as if `Q07-scene3`
  did not exist (m17), and no longer claims every array's order is
  stated (m1).
- §2.1: implementation counts no longer go stale (m15).
- §9.4's null-table and no-row-id ordering is in the catalog (m16).

### Conformance and stability

- `conformance.md` §5.1: the cut deputy and the sequence-keyed tone
  marker; §5.3 and §7: eighteen negative cases; §7 counts runs, not
  implementations.
- `stability.md`: rows for Q14's narrowing and §12.1.7; 54 codes, 23
  raised in a published report.

### Artifacts

- Fixture (m4): Deputy Rourke, cut, linked into scenes 12 and 19 and
  carrying Forgiveness through an active connection; "Held breath", a
  tone marker keyed to The Reckoning alone. `Q04`, `Q03`, `Q10` and
  `Q11` are unchanged and now depend on the rules above.
- New: `Q13-shot1204`, `Q14-Q02-eleanor-scene7`, `Q14-Q07-shot12A`,
  `Q14-Q13-shawl-scene12`, the negative cases `span-boundary-cut` and
  `junction-key-null`, and their selectors.
- `readiness-rubrics.json`: `satisfiedBy`, renamed `params`, the
  changed steps above. `finding-catalog.json`: 54 codes, and the
  ordering's null rules. Q14 messages say "in force" where they said
  "resolve" (m6).

---

## 1.0-rc.4 — 2026-10-20

*Describes schema 2.25.*

**The fourth release candidate**, from the eighth independent reader run
(`docs/release-checklist.md` §D1). It reproduced every published result,
every negative report and the fixture's report from the text alone, and
found two contradictions between normative rules and several unstated
ones. **Schema 2.25** adds one registry member. Taken under §11.0, which
still holds.

### §4.5 and §7.3 — a `latest_wins` tie takes the highest row id

§7.3 said a step matching several rows takes the lowest row id, and §4.5
said pattern 3 takes the highest. The fixture holds the tie — two
`color_script_entry` rows at scene 1 and two at scene 21 — so two readers
each following one sentence gave different Q07 answers at four scenes.
**Step 1 is pattern 3 and takes the highest**, as the state tables
always did; steps 2–4 keep the lowest. §12.1.6 states the exception. The
reference followed §7.3 in the cascade and §4.5 everywhere else, and now
follows §4.5 in both. No published result changes; the new case result
`Q07-scene3` pins it.

### §0.3, §8.3, §12.8.1 — no root mapping makes rooted identifiers `unaddressed`

Three sentences said every asset is `unaddressed` without a mapping,
contradicting §8.2's absolute and `..` identifiers, which are
`out-of-root` whatever the session. The identifier is now decided first,
everywhere, as the reference always did; conformance §2.1 agrees. The
fixture gains one bundled asset with an absolute identifier, so the
published `Q02-locket-scene25` shows `out-of-root` beside `unaddressed`,
and the fixture's report carries one warning,
`asset.identifier_absolute`.

### §9.4.1 — every code's `table`, `rowIds` and `count`

The table covered 16 of the catalog's 53 codes. It now covers every one,
read from the reference validator: the presence, line, relationship,
asset, binding, structure, required-value and vocabulary codes, with the
grain each is raised at before §9.5 merges it. A merged finding keeps
the first message. §9.5: `counts` counts findings, not their `count`s.

### §12.17 — staging beats reach their scene through either container

`staging_beat` has no `scene_id`; it names a `scene_blocking` or an
`action_sequence`. `stagingBeats` now takes both, ordered by
`beat_order` then row id. The reference read only blocking, so Q04 at a
scene whose staging is an action sequence lost its beats. New case
result `Q04-scene21`. `detail` includes shot-level rows, and is not
prose.

### §12.1.2, §12.8 — `subject_variant_id` points into the variant table (schema 2.25)

The registry declared `entity_anchor.subject_variant_id` polymorphic on
`subject_type`, which names `character`, `prop` or `location`, while the
row it names is in `character_variant`, `prop_variant` or
`location_variant`. A resolver following the declaration read the
fixture's variant anchor as Eleanor. Schema 2.25 adds
`polymorphicTargets` to the field — the target per sibling value — and
§12.1.2 says the sibling names the table only where no map is declared.
`registry.schema.json` describes the member. The reference's where-used
walk and orphan count honour it.

### §12.9 — Q14 takes its target's parameters

Q14 could not be asked about a prop or a location for Q02, or about Q13
at all. It now declares `subjectType`, `subject` and `intent` beside
`character`, `scene` and `shot`, all seven in its envelope; a subject
narrows by its kind, a polymorphic subject column by its sibling, and a
step that cannot apply to the subject's kind is reported `ok`, saying
so. `findings` are ordered by severity, and `entity` is stated for a
step naming several. The Q02 rubric's `params` name a subject. The
reference's walkers now report every step of their rubrics — Q02, Q06,
Q07, Q08 and Q13 each skipped some — and Q13's anchor step reports
`warning` when absent, as `recommended` requires. `Q14.result.json`
gains three null parameters; new worked examples
`Q14-Q02-locket-scene25` and `Q14-Q13-eleanor-shot1204`. The MCP
`readiness` tool and the editor's Q14 page take the new parameters.

### Rules now stated

- §1.2: `_scf_meta` is a key/value table, and `_scf_meta.schema_version`
  means its `schema_version` row.
- §4.5: a null `persistence` is `scene_only`; a `resolved_at_scene_id`
  naming a scene with no story position resolves nothing. The reference
  read an unknown `persistence` as `until_resolved`; it now reads it as
  `scene_only`.
- §8.5: the format string — the last extension, lowercased, no dot,
  null where there is none.
- §12.1.6: row order is a last resort, and every array in §12 now has
  its order stated: Q03 and Q04 `props` and `cast` in link order, Q12
  `props` in `prop` order, Q04 `blocking` and `detail` rows, Q11
  `toneMarkers`, Q00 `themes`, Q01 `groups` and `thematicConnections`.
- §12.8: a null or empty `canonical_status` is verified; a row written
  without one carries the default `candidate`. Only a verified variant
  anchor displaces. §12.8.2: a null `precedence` is 0, and the binding
  named by `replaced` is the first `replace` binding above.
- §12.16: which inapplicable Q02 members are `[]` and which null, and
  `media` is Q13's body with `fromQuery` beside its members. The
  reference reported the scene's location variant for a location
  subject that is not the scene's location; it is now
  `{variant: null, mismatches: []}`.
- §12.17: `mismatches` escapes exactly as JSON requires and no more;
  non-ASCII is written as itself.

### Conformance and stability

- `conformance.md` §6.1 step 3 names the header stamps and the
  `_scf_meta` row the negative base database carries; step 2 says Q04's
  `detail` is not prose. §5.1 lists the absolute asset, and corrects
  `12A`'s row id against the cut `12B`.
- `stability.md`: `provenance` is exercised; `12A`'s row id restated;
  rows for Q14's parameters and §9.4.1.
- Eight independent implementations (`conformance.md` §7, README, site,
  `what-is-scf.md`).

### Artifacts

- New: `Q07-scene3`, `Q04-scene21`, `Q14-Q02-locket-scene25`,
  `Q14-Q13-eleanor-shot1204`, and their selectors.
- Every result, report and generated file carries schema 2.25. Beyond
  that, only `Q02-locket-scene25` (the absolute reference), `Q14` (three
  null parameters) and `hollow_creek.report.json` (the warning) change.
- `api-surface.json`: `polymorphicTarget`, `polymorphicKindsFor` and
  `Q14Subject` are exported.

---

## 1.0-rc.3 — 2026-10-16

*Describes schema 2.24.*

**The third release candidate**, from the seventh independent reader run
(`docs/release-checklist.md` §D1). It reproduced 24 of 29 results, every
negative report and the fixture's report from the text alone. What it
found is sentences the text was missing, not missing rules. No schema
change, and no published result changes shape; one case result is added.

### §12.17 — `mismatches` has a stated format (the critical)

Each entry is exactly `<axis>: scene=<value> variant=<value>`, the
scene's column name and the two stored values as JSON strings. It was
compared byte for byte and never stated. §12.1.5 now names formatted
strings and prose as kinds of string, and lists the trail's `layer` and
`excluded.by` among the closed vocabularies. A `varies` time of day
agrees only with a scene that has a time.

### Rules now stated

- §7.3: a shot with no row of its own falls through to the scene's row;
  `latest_wins` does not fall through; several matching rows give the
  lowest row id. New case result `Q07-shot12A` exercises the
  fall-through.
- §12.5: Q12's characters are both positions' `scene_character` rows
  pooled in row-id order.
- §12.6, §12.2: Q06's `baseline` is `physical_character_profile`.
- §12.4: Q03's `states` are `performance_state` rows of every modality.
- §12.8: one `by` per excluded layer, in a stated precedence; the order
  of anchors in `trail`; an intent outside the anchor table considers
  every anchor; `canonical_status` names the registry's `candidate` and
  `rejected` (the registry default is `candidate`).
- §5.2: a scene the screenplay does not contain belongs to the spans that
  run to the end. §5.4, §9.5: findings derive story order and membership
  over every scene, cut ones included.
- §9.4.1 (new): the condition, `table`, `rowIds` and `count` of every
  code no other section states, including the seven single-row identity
  codes a validation report need not compute. §9.4: findings are ordered
  by code point, a null table first.
- §12.1.1: `schemaVersion` is the implementation's schema, not the
  file's. §12.1.6: "the" row is the lowest row id.
- §2.4: an open vocabulary may be resolved over, on its known values.

### Artifacts

- `fixtures/expectations/Q07-shot12A.result.json`, new.
- `finding-catalog.json`: `structure.boundary_unnumbered` is titled for
  what it reports (a span starting at an unnumbered scene), and
  `identity.successor_without_timestamp` names `superseded_at`.
- The validator: `structure.boundary_unnumbered` reports a sequence's
  boundary on `sequence`, not `act`; `structure.scenes_before_first_act`
  names the scenes it is about. Neither is exercised by a published
  report. `fixtures/hollow_creek.report.json`: scene 17's message no
  longer says it belongs to no act.
- Counts: sixteen negative cases (`conformance.md` §5.3, §7; Appendix A;
  `stability.md`; README) and seven independent implementations;
  `conformance.md` §7 says "maintained", and §6.1 and §4 no longer read
  as instructions for the reference tool only.

---

## 1.0-rc.2 — 2026-10-16

*Describes schema 2.24.*

**The second release candidate**, from the sixth independent reader run
(`docs/release-checklist.md` §D1): four results that contradicted the
text or could not be produced from it, and thirteen rules an implementer
needed and the text did not state. No schema change. **Breaking for
Q13, Q02 and Q04 results**, taken under §11.0, which still holds.

### §12.8 — the trail is structured (breaking)

`trail` was English sentences that conformance compared byte for byte,
so no reader could reproduce Q13 or Q02 from the text. Each entry is now
a derived record — `layer`, `uuid`, `name`, `bundle`, and `excluded`
with a closed `by` vocabulary and a `value` — and only
`excluded.reason` is prose. Conformance compares `reason` and a
reference's `detail` as present strings only.

### §12.8 — which anchors are considered, and which contribute

The intent → `anchor_type` table is now in the text. **Only a verified
anchor contributes** (`canonical_status` `verified` or unset); any other
is considered, excluded and in `trail`. The reference had dropped
unverified anchors silently, which is why a displaced candidate anchor
was missing from `Q13-scene25`'s trail against §12.8's MUST. A shot
override contributes its bundle only for the intent asked about, as a
binding does; a bundle's assets come in `bundle_asset` order; and an
override's other columns change nothing Q13 returns.

### §12.17 — Q04's cast and props are derived records (breaking)

`{character, presence, variant}` and `{prop, presence, variant}`, as
Q03's are. Q04 had put `presence` and `variant` beside a projected row's
`uuid` and `fields`, which §12.1.2 forbids.

### Results that contradicted the text

- **Q07** projected `string_list` columns as JSON text; it now projects
  each cascade layer by its own entity's column roles, as §2.5 and
  every other result do.
- **Motif carriage** (§12.15) is in story order, which §12.1.6 required
  and the reference did not do.

### Rules now stated

- §1.2: a `user_version` of 0 is an absent stamp, not a disagreement.
- §1.3.1: how a section line's label is compared with its span.
- §3.4: a heading names its scene by its own `scene_id`, authoritatively.
- §4.1: `structure.scene_not_in_script` only where the file has a
  screenplay. §4.2.3: conforming numbers, then opaque, then absent.
- §4.5: a pattern-2 state with no `scene_id` is in force nowhere.
- §5.5: two spans on one scene — the later by row id takes the scenes.
- §8.2: a path with `..` is `out-of-root`.
- §9.5: **one code on one table is one finding**, every row at fault in
  `rowIds`; findings are computed over every row, cut ones included.
  The identity findings now carry their rows, and the published report
  merges per condition.
- §12.1.1: an optional parameter not supplied is null.
- §12.1.2: a `boolean` column is carried as the stored 0 or 1; an empty
  `string_list` is omitted.
- §12.1.4: every section that names a derived record's row member other
  than for its entity is listed; §12.5, §12.13 and §12.17 name theirs.
- §12.1.6: an array with no story position is in row order.
- §12.9.1: a media step is narrowed through the subject's own Q13 answer,
  a positioned step by its pattern.
- §12.16: Q02's media intent, per subject kind.
- §12.17: ties go to the lowest row id.

### Artifacts

- `fixtures/hollow_creek.report.json`: the fixture's own report, which a
  validator MUST match (`conformance.md` §6.1).
- Negative case `asset-orphans-two` pins §9.5's grain.
- `conformance.md` §6.1 says exactly what is compared in a report and a
  result, and how `CASES.json`'s `-- params:` suffix binds.
- `ShotContext-readiness.result.json` is not a canonical result and has
  left `fixtures/expectations/`.
- Stale counts in §2.1, §2.4.1, §12.1.2 and `conformance.md` §5.1, and
  two sentences in `what-is-scf.md` §7.
- **Addressing by two tags.** `ARTIFACTS.md` addressed every artifact by
  the schema tag, so a candidate that changed only prose and results had
  to move a published tag. The registry and what is generated from it
  alone stay at `schema-2.24`, which no longer moves; the specification
  documents, results, reports, fixture and the spec-derived artifacts
  are fetched from `spec-1.0-rc.2` (§2.1, `conformance.md` §5).
  `check_pin.py` verifies every file against its own tag.

---

## 1.0-rc.1, re-cut — editorial corrections — 2026-10-16

*Describes schema 2.24.*

**Patch-level: no requirement changes meaning** (§11.5). A
documentation audit before the sixth reader run (`docs/release-checklist.md`
§D6) corrected statements the tree had made false. The candidate had
been tagged and not yet read by anyone, so `spec-1.0-rc.1` and
`schema-2.24` were re-pointed at the corrected tree rather than spending
a candidate number on editorial fixes. The candidate the reader run
reads is this one.

**`scf-spec.md`**
- §1.4: "every schema change to date has been an additive optional
  field" is true outside the changes §11.0 lists, and now says so.
- §6.6: a `superseded` row's version chain is §12.14's, not §6.4's.
- §12.1.6: the sections that rely on row order are §12.2's `beats`, the
  `characters` of §12.4 and §12.5, and §12.10's `manifest` — "those are
  the only two" was false, and "§12.5's `beats`" named the wrong
  section.
- §12.11: a link entity is defined in §0.7, not §2.2.
- §12.16: the `media` row had fallen out of its table, below the
  paragraph on `arcStates`.
- Appendix A: fifteen negative cases, not eleven; the resolution report
  is §9.6; §4.3's "deprecation window" is gone with `scene_numbering`;
  rows for the per-case results (`resultCoverage.test.ts`) and §12.17's
  ranked axes.

**`conformance.md`** — fifteen negative cases (§5.3, §7); §5.1's
dialogue count is six of the twelve scenes with action, not nine; §5.4
states the expectations once instead of three times; §6.3 points at the
trademark statement in `NOTICE`, which exists.

**`stability.md`** — the `line_type` row names `line.type_unknown`; the
summary no longer calls `varies` and `status` unexercised; the proposal
path, `clip`'s line references (anchors since 2.19), the export report
(§9.6), the negative-case count and the additive-change rows are
current; a row for the anchor audio span (§12.8, stated in 0.66).

**This changelog** — the candidate's entry pointed "above" at the
entries below it. 0.54's entry does not mention that §12.16 gained
`arcStates` (proposal 0008); it did, in 0.54.

---

## 1.0-rc.1 — 2026-10-16

*Describes schema 2.24.*

**The first release candidate for 1.0.** No requirement changes from
0.68; this entry names the candidate and adds §11.5's sentence on what
a candidate is. It is tagged `spec-1.0-rc.1`, beside `schema-2.24`, and
is what the sixth independent reader run reads
(`docs/release-checklist.md` §D1).

**§11.0 stays in force.** Files are still disposable and the candidate
may still break them; that ends at 1.0, not here. Nothing is published
to npm.

What the candidate carries since the last reader run read the format
(0.49), by the entries below: line anchors and ranges (§3.5, §4.7),
presence (§2.4.1), variants (§4.8) and binding filters (§12.8.1–12.8.2),
open vocabularies and `string_list`, `required` as incompleteness; and
the 1.0 decisions of 0.66 — exactly schema 2.24 (§0.6),
`line.type_unknown` (§1.3.1), a clip outliving its scene (§2.3),
`sequence.act_id` removed, the audio-offset semantics (§12.8) and the
ranked variant axes (§12.17). Since 0.67–0.68 every member of every
published result carries data, through per-case normative results, and
every rule `stability.md` named as unexercised has a row.

### §11.5 — release candidates

A candidate is `<version>-rc.N`. Its requirements are the release's
unless a later candidate changes them, and a defect found in one is
fixed in the next.

---

## 0.68 — 2026-10-16

*Describes schema 2.24.*

**Minor.** Rules stated and exercised by nothing now have a row each
(`docs/release-checklist.md` §D3). No requirement changes; the artifacts
a conforming reader is graded on grow.

- **§12.17's wildcard and fallback** in two new normative case results:
  `Q02-church-scene16`, where a variant whose `time_of_day` is `varies`
  wins on the wildcard alone, and `Q02-ridge-scene21`, where no variant
  agrees on any axis and the baseline is chosen with three mismatches.
- **`junction.endpoint_absent`** and **`structure.section_mismatch`**:
  negative cases `junction-endpoint-absent` and `section-mismatch`, each
  raising its finding alone.
- **§6.6's writing stage:** the fixture's scenes carry `draft`, `locked`
  and `revised`, and scene 12B is `locked` and `cut` — a `status` that
  disagrees with `lifecycle_status`, excluded by the latter everywhere.
- **§4.3's span renumbering** under `derived` and `fixed` was already
  tested in the editor; `stability.md` now says so.

---

## 0.67 — 2026-10-16

*Describes schema 2.24.*

**Minor.** Every member of a published result now carries data
(`docs/release-checklist.md` §B2).

### §12 and `conformance.md` §5.4 — per-case normative results

Twenty members were empty in every published result, so a reader that
ignored variants, vocal states, prop state, motif carriage, motif
candidates or version chains reproduced all sixteen byte for byte. Some
could be filled by authoring rows; others no single position can show —
Q02's prop and location members need a prop or a location subject, and
Q15's version chain needs a versionable row. `<Q>-<case>.result.json`
files are now normative beside each query's own, with published
selectors; a conforming reader compares against all of them:
`Q02-marcus-scene25`, `Q02-locket-scene25`, `Q02-kitchen-scene10`,
`Q03-scene25`, `Q04-scene25`, `Q05-scene19`, `Q12-scene24-25`,
`Q12-scene25-24`, `Q15-plate-v2`, and the two Q13 cases that were
published as examples, `Q13-scene3` and `Q13-scene25`.

`scf-core/test/resultCoverage.test.ts` fails if any member is empty in
every result of its query, except the two environment-dependent
`sizeBytes` (§8.3).

### The fixture

Rows authored for it, no schema change: the locket in a variant and a
state at scene 25; a motif carried by Eleanor and a related motif not
placed at scene 12; kitchen set dressing at scene 12; the night plate's
superseded v1 and a note attached to v2; seven performance beats
anchored to their lines; and a screenplay prop tag. `scf-check` now
reports six infos — the superseded v1 is an asset nothing references
(`asset.orphan`).

---

## 0.66 — 2026-10-16

*Describes schema 2.24.*

**Minor.** The 1.0 decisions (`docs/release-checklist.md` §A). Three
changes would break a conforming implementation after 1.0 and are taken
under §11.0 now: `clip.scene_id` is renamed, `sequence.act_id` removed,
and `registry.json`'s per-entity `queries` unpublished. They land as
schema 2.24: `schema-2.23` was tagged on 2026-10-12 with proposals 0037
and 0038, and stays as published.

### §0.6 — exactly schema 2.24

"Describes schema 2.12 and later" was false, and is gone. The
specification describes schema 2.24; a file at any other version is
governed by §11.

### §1.3.1 — an unknown `line_type` is a finding

A line whose `line_type` is outside the published set MUST be reported
as `line.type_unknown`, at `error`, naming the line's uuid and the
value. It was deliberately silent, and the reason given for the
requirement — a reader that guesses wrong answers wrongly and in
silence — is the case for the finding. Only `screenplay_lines` is
checked. The negative fixtures gain `line-type-unknown`.

### §2.3 — a clip is not deleted with its scene

Footage outlives the script (proposal 0002). `clip.scene_id` becomes
`clip.slated_scene_id`, which points at the scene rather than belonging
to it, so deleting the scene clears it and keeps the clip. An editor
that deleted clips with their scene now clears the reference instead,
and `canonicalDump` after a scene delete changes accordingly.

### §5 — `sequence.act_id` removed

A sequence's act is derived from the span boundaries; the stored
column was derivable, unspecified, and undefined for a sequence that
crosses an act. `structure.sequence_act_mismatch` is unchanged: it
reports a crossing span and never read the column.

### §12.8 — what an anchor's audio offsets mean

`audio_offset_start_sec` and `audio_offset_end_sec` are seconds from the
first sample of the asset's playable audio, start-inclusive and
end-exclusive, the end MUST exceed the start, a null bound is open, and
a reader MUST ignore them on an asset without audio.

### §12.17 — the variant axes are ranked

The location variant in force is chosen by comparing the axes in order
— `time_of_day`, then weather, then season — rather than by counting
agreements. Scenes 10 and 19, winter nights, now resolve the autumn
night variant instead of the winter-morning baseline. The baseline
still breaks a full tie and still wins when the winner agrees on
nothing, and `varies` still agrees on time. Q04's published result, at
scene 12, is unchanged by the rule; it loses the sequence's `act_uuid`.

### §11.0 — the breaks taken

The list of changes taken under §11.0 names schema 2.24's three.

---

## 0.65 — 2026-10-09

*Describes schema 2.23.*

**Minor.** Proposal 0038: the project poster.

### §8.6 and §12.12 — the film's poster

`asset_relationship.relationship_type` gains `poster`. An asset related
to the project row as `poster` is the film's key art; several may be,
and §8.6's order makes the first the poster. Q00 gains `posters`, those
assets projected in that order, empty when there are none.

The fixture's project relates `poster01.png` as its poster.

---

## 0.64 — 2026-10-09

*Describes schema 2.23.*

**Minor.** Proposal 0037: media about a shot or a scene.

### §8.6 — shot and scene media are typed and ordered

§8.6 already put an asset about a shot or a scene on
`asset_relationship`, but nothing could say a file was the storyboard,
and a storyboard of six panels had no order but row id, which is when
each was attached. `relationship_type` gains `storyboard`,
`start_frame`, `end_frame` and `previs`, and `asset_relationship` gains
`order`. An implementation listing an entity's related assets **MUST**
present them by `order`, unordered rows last, then row id. One sequence
per entity, not per type.

The fixture's shot 12-04 carries two storyboard panels whose `order`
runs against their row ids, and a start frame.

---

## 0.63 — 2026-10-08

*Describes schema 2.22.*

**Editorial.** No requirement changes meaning. The checksummed documents
stated facts that had moved — `docs/release-checklist.md` §B4.

### Counts and versions written by hand

§0.6 restated the spec and schema versions as `0.54` and `2.19` under a
header saying otherwise; it now points at the header. §0.7 called the
registry 99 entities and the link entities thirteen; §6.3 and §6.6 said
fourteen; the registry has sixteen. §2.1 said "version 2.19 defines 106
entities", §4.5 "95 of 103", §7.2 "twelve of the 103". Where a count was
not load-bearing it is gone, in favour of the generated artifact that
holds it (`entity-reference.md`, `junction-keys.json`) — a number
written beside a fact that moves is the class this entry exists to
close, not only its instances.

### §11.0 — what was taken under it

The clause named two changes, 2.9 and 2.12. 2.14, 2.15 and 2.21 removed
or replaced columns under it too, and are now listed.

### `stability.md` and `conformance.md`

`stability.md`: header and summary (it still described 0.38); the
polymorphic-`_id` row stated the 0.29 rule 0.40 replaced; patterns 1–3
cited §4.3 for §4.5; `varies` and `status` said *not implemented* when
what they lack is a fixture row, and now say *Yes — not exercised*;
"Expectation coverage" waited on queries that are all specified; the
forward-compatibility row called §10.1 untested, contradicting the
document's own record that it is tested; the rubric row moved out of
*Identity*; counts of artifacts, exports and finding codes give way to
the files that hold them.

`conformance.md`: §4 opened "*Not yet built*" about a validator built in
0.15, and the status line promised sections marked *not yet
specifiable* that no section is.

---

## 0.62 — 2026-10-07

*Describes schema 2.22.*

**Editorial.** No normative change. Proposal 0036 adds
`project.synopsis` — the story told short, between the one-sentence
logline and the screenplay. §12.12 Q00 projects the project row whole,
so the brief carries the synopsis with no change to its text; the
published Q00 result gains the member because the fixture authors one.

---

## 0.61 — 2026-10-05

*Describes schema 2.21.*

**Minor.** Proposals 0034 and 0035, the two items 0033 left open.

### §12.8 — an anchor has no state filter (0034)

`entity_anchor.physical_state`, `vocal_state` and `environmental_state`
were free text that §12.8 never read: an anchor recorded as the wounded
face was returned as the face in every scene. Reading them was possible
for a character, whose states have names to match, and not for a prop or
location, which have no named state at all. They are removed. Media
scoped by state is a binding with a state filter; a different design is
a variant; `condition_description` still says what the asset shows, as
description.

### §4.8, §12.4, §12.5, §12.17 — the cast names its variant (0035)

Q03 and Q04 carry `variant` on each character and prop entry, projected
or null; Q12 carries `variantFrom` and `variantTo`, by name, as it
reports states and stages. A scene package listing Marcus in scene 25
without saying he is the boy was wrong for anyone casting or dressing
it. The published Q03, Q04 and Q12 move by null members only.

---

## 0.60 — 2026-10-02

*Describes schema 2.20.*

**Minor.** Proposal 0033. Character and prop variants could be authored
and nothing said where either applied; and one declared column that
should have answered it was read by nothing.

### §4.8 — the variant in force (new)

A location's variant in force was already defined, by §12.17's scoring.
A character's or prop's had no rule, which is why 0027 removed the
`variant_id` filter from their bindings. It is now the variant named by
`variant_id` on the subject's `scene_character` or `scene_prop` link at
the scene. No link, a null, a cut variant, or another subject's variant
puts none in force; the last is reported as `presence.variant_foreign`.

### §6.3 — qualifiers

The natural key was every reference a link declares. `variant_id` on a
presence link is a reference that QUALIFIES the link rather than naming
one of its endpoints, so a `qualifier` flag in the registry keeps it out
of the key: two rows for one character in one scene that differ only in
variant are one link written twice.

### §12.8 — anchors honour `subject_variant_id`

The column was declared and §12.8 never read it, so an
anchor recorded for a variant came back as the subject's own at every
position. An anchor naming a variant now contributes only where that
variant is in force, and there displaces the subject's own anchors of
its type. Excluded anchors appear in `trail` with the reason.

### §12.8.1 — the variant filter returns to character and prop bindings

Its satisfied-where column now reads §4.8 for all three kinds.

### §12.16 — Q02 gains `characterVariant` and `propVariant`

Beside `locationVariant`; null, never omitted, where they do not apply.
The published Q02 moves by those two null members.

---

## 0.59 — 2026-10-01

*Describes schema 2.19.*

**Minor.** Proposal 0032. Nothing said which lines a shot covers, and the
one link to a line that existed pointed at the wrong ones.

### §3.5 — line anchors (new)

Prop tags and performance beats have long named a screenplay line by its
uuid, and the editor re-anchors them through a split or merge and sweeps
the orphans. None of it was in the specification, so a second
implementation had no way to know it should. A line anchor is now a
format concept: a text uuid, declared by `lineAnchor` in the registry,
with re-anchoring a SHOULD and an orphan reported as
`line.anchor_orphaned`.

### §4.7 — the lines a shot covers (new)

A shot's lines were reachable only through footage, take to clip to
lines, and a generation-first project has no take until the shot exists.
`shot` now carries a range of two line anchors. Whole lines; ranges may
overlap, because a scene is covered from several angles and resolved in
editing; and a shot with no range is unrecorded, not inheriting its
scene's lines. Three findings report a range that cannot be read.

`clip.screenplay_line_start_id` and `_end_id` are removed in favour of
the same two anchors. They named a line by row id, which a rewrite of
the screenplay re-numbers, and in the fixture both clips had come to
point at a blank line, a section marker and a heading.

### §12.1.2 — the screenplay-table example goes

Its example of a reference into a screenplay table was the clip's line
references. The rule stays; a line is now named by an anchor instead.

---

## 0.58 — 2026-09-30

*Describes schema 2.18.*

**Minor.** Proposal 0031. What happens when several bindings are in
force for one subject and intent was never stated, and the one number
that could have ordered them meant nothing.

### §12.8.2 — precedence, and add or replace (new)

§12.8 defined the layers and §12.8.1 when one binding applies. Nothing
said how two bundles in force together combine. The implementation took
all of them, ordered by `precedence`, and `precedence` had no help text
anywhere. The fixture used it both ways: higher meant more specific for
the kitchen and less specific for Eleanor, whose baseline sat at 10
above her wounded state at 1. At scene 12, a night storm, the kitchen
resolved its night references and its day plates together.

`precedence` is now the author's ranking, higher being the more specific
opinion, and a baseline SHOULD sit at 0. It orders and never excludes on
its own. A new `combine` field says whether a binding adds to the others
in force or replaces those below it. `add` is the default and is what
every binding did before. Replacing never reaches anchors or shot
overrides, and never an equal precedence. Two findings report a baseline
that replaces and a `replace` binding caught in a tie.

### §12.8 — the trail runs broadest first, as it said

The trail listed bindings highest precedence first, which for the
kitchen was most specific first, against §12.8's own table. It now lists
them lowest first. Eleanor's published trail looked right only because
her precedence was inverted; with the fixture corrected and the order
fixed, it reads exactly as before.

---

## 0.57 — 2026-09-30

*Describes schema 2.17.*

**Minor.** Proposal 0030. Whether a subject is on screen was either
undefined (at a scene) or not recordable at all (at a shot). Both are
now stated.

### §2.4.1 — presence: seen, heard or named

`scene_character.role_in_scene` has always included `mentioned` and
`voiceover`, and `scene_prop.significance` `mentioned`. Nothing said
what they meant, and §12.4 said a character "appears because a
`scene_character` link says so", so every consumer took a mentioned
character to be on screen. The published Q03 and Q12 list Ada Cade,
who is only ever mentioned, among the characters present with nothing
to say otherwise. The shot composite swept her for visual media and
asked for her physical direction, and Q14 warned that she had no
appearance profile, which an author could only silence by designing the
look of someone who is never seen.

Each value now declares a presence in the registry (`optionPresence`),
total over the options and linted. The spec defines the three presences
and does not restate the mapping: `entity-reference.md` publishes it,
generated. A link with no value, or an unlisted one, is `seen`.

### §4.6 — presence at a shot (new)

There was no way to say who is in a shot. A prompt for shot 3B needed
Marcus in the doorway and Eleanor's back in the soft foreground, and it
had to be inferred from the scene's blocking prose.

`shot_character` and `shot_prop` record it, with three independent
closed fields, `framing`, `facing` and `focus`, because the cases a
single vocabulary would list are not exclusive. `shot.presence_complete`
says the rows are the whole frame. Unset, the scene's subjects are
inherited, so a file with no shot rows answers exactly as before. Four
findings report what the rule keeps rather than refuses.

§4.6 also states that **a shot is at its scene's location**: a change of
place is a new scene, flashbacks and intercuts included.

### §12.4, §12.5, §12.17 — results carry presence

Q03's characters and props, and Q04's `cast` and `props`, carry
`presence`. Q12's carry `presenceFrom` and `presenceTo`, null at a
position that does not link them. The published results are re-blessed.

### §12.9 — a step about how characters look covers the seen ones

Q14's appearance-profile check applies to characters seen at the
position: at a shot by §4.6, at a scene by §2.4.1.

### Also

The header said the specification described schema 2.15. It described
2.16, and now describes 2.17. §0.6's "Currently `2.15`" and §2.1's entity
count were stale in the same way.

---

## 0.56 — 2026-09-30

*Describes schema 2.16.*

**Minor.** Proposals 0012 (its last item), 0025 (its documentation
half), 0027 and 0029. Six columns that looked like scoping and applied
everywhere are now either read or gone, and the one media subject that
could not be bound can be.

### §12.8.1 — a binding applies where every filter it declares is satisfied

The three binding entities declared six columns that narrow when a
binding applies. `bindingApplies` tested the scene range and nothing
else, so a binding scoped to a variant, a time of day or a physical
state applied EVERYWHERE — and silently: its `trail` line said it
fired, with no note that four of its five conditions were never
evaluated.

Nothing in the repository could catch it. The fixture authored none of
the six, so every published artifact was byte-identical whether an
implementation honoured them or ignored them — the same invisible class
as `external_id` before 0.40 and the empty `asset_relationship` table
before 2.13. A second implementation reading the registry would have
honoured them, diverged on any file that used them, and been right.

Per column: `time_of_day_filter` matches the scene's `time_of_day` over
0012's closed vocabulary; `variant_id` matches the variant §12.17 puts
in force; the two state filters match a `performance_state` in force at
the position (§4.5) **by name**, because a filter is something an author
types and nobody retypes a sentence. `act_id` is removed everywhere —
act membership is derived from boundaries, so an act-scoped binding is a
scene range that goes stale when a boundary moves. The character and
prop `variant_id` columns are removed: nothing says which character or
prop variant is in force at a position, so those two could never be
evaluated at all.

**Filters compose as AND, and an excluded binding MUST appear in
`trail` with the filter that excluded it.** A cascade that cannot
explain an absence is the failure the first `scf-mcp` session actually
hit: asked for the wind chime at scene 3 it got the chime's scene-24
state, because the way to say "only after 24" that the resolver read was
the scene range, and the columns that looked like they meant that did
not.

The fixture now exercises each: one binding scoped by time of day, one
by variant, one by Eleanor's `wounded` state. Its trail reads, at scene
3, `Kitchen at night -> bundle Kitchen - Night Ref: EXCLUDED,
time_of_day_filter "night" vs scene "morning"`.

### §8.6 — costume media, and plates that are about a scene

`costume_asset_binding` is new (0029). Costume was the one media subject
with references and no way to bind them, which is what the fixture's
only `asset.bundle_unbound` finding was: a bundle of costume images
bound to nothing, not by oversight but because no row type could bind
it. The finding moved to a twelfth negative fixture so that it stays
exercised.

It arrived through §8.6's registry-derived reach rule rather than an
edit to it, and `bundleReach`, `unboundBundleIds`, the editor's bind
form and its media checks all covered it the day it was declared. One
test asserting the list of binding subjects had to change; no caller
did.

**An asset may be about a SCENE or a SHOT rather than about a subject.**
A DOP's framing plate for one scene belongs to no character, prop or
location in it, and the cascade starts at a subject, so a binding is the
wrong shape — there is deliberately no fourth binding table, because
precedence, baselines and filters mean nothing for "this picture is of
that scene". Such an asset is related through `asset_relationship`, and
`shotContext` now carries those rows as `related`. The plate the first
session missed reaches shot 3B that way.

### The editor knew about one filter too

`mediaChecks` flagged "in force at every scene" for any non-baseline
binding with no scene range — which, after this round, described three
correctly scoped bindings. It now reads the filter columns from the
registry (`variant_id` and anything ending `_filter`), so the check
covers a filter added later without being edited. The same mistake as
the cascade's, one layer up.

---

## 0.55 — 2026-09-28

*Describes schema 2.15.*

**Minor.** One normative rule changed meaning and one published result
moved with it (proposal 0028); one finding was added; and the tooling
around media gained the reverse lookup it never had. Most of this round
came from the first `scf-mcp` session, which wrote a shot prompt against
the fixture and came back with what the format could not tell it.

### §12.11 named four kinds of carrier and meant "wherever it is placed"

Q10 reached scenes through a hand-written list: a scene, a motif, a
character, an act or a sequence, and nothing else. A prop carrying a
theme therefore returned `sceneUuids: []` while `scene_prop` placed it
in three scenes, and the published Q10 result recorded that emptiness as
correct. Costumes and locations were in the same position.

The list was the defect. §12.11 now states the rule the registry already
implies: a carrier is reached through a **link** entity declaring
`scene_id` and the subject's column, or through `scene`'s own reference
to it. What the four kinds had in common was never their kind, it was
that something placed them.

The distinction the new wording insists on is placement versus
description. `performance_beat` names a character and a scene and does
not place the character there — the character is placed by
`scene_character` — so a blanket "any table naming both" rule would have
changed what a character carrier means. The registry's `subject: link`
is what separates the two, and it is declared rather than inferred.

**Q10's published result changes.** Ada's locket, connected to
Forgiveness as a prop, now reaches the three scenes `scene_prop` places
it in, and the spine's counts rise at those three. No other carrier in
the fixture moves — which is the check that the rule generalises the old
behaviour instead of replacing it.

### §8.6 — `asset.bundle_unbound`, the orphan one level up

An asset in a bundle that no binding reaches is referenced by something,
so `asset.orphan` stays silent, and the cascade starts at a subject and
never arrives — the assets resolve for nobody at any position. The
fixture carried five such bundles for months, including the kitchen's
own anchor images, and the only way to find them was to diff a full
asset list against a resolution per subject per intent by hand.

`asset.bundle_unbound` is `info`: a bundle assembled before anyone has
decided what it is for is an ordinary state of an unfinished film. The
catalog is 41 codes. The fixture raises it once, deliberately — Ada's
shawl is a costume, and `costume` has no binding entity, so the bundle
holding its reference has nowhere to be bound. That finding is the
format gap, visible in the one place a reader will meet it.

### `whereUsed` — every query ran forwards

The sixteen queries all ask "given a subject and a position, what is in
force". Nothing asked the reverse, and the absence has now cost two
readers real time. `whereUsed(ctx, entityType, uuid)` returns the rows
that point at one row, each projected, derived from the registry
including polymorphic pairs. It is in the API surface (246 exports) and
behind `scf-mcp`'s `where_used`.

### `list` — story order, and the spelling it hands back

`listEntities` returned rows in row order, which §12.1.6 says means
nothing, for an entity whose order is the one thing a reader most wants.
An agent read the row order of a thirteen-scene film as the story and
reported a published spine as misordered. Scenes, and rows belonging to
a scene, now come back in story order (§4.1) carrying `storyPosition`.

The same call rejected `scene_uuid` as a filter field while every result
it returns spells that column `scene_uuid` (§12.1.2). Round-tripping a
value from an answer into the next question failed on a rule the caller
had followed. The projected spelling is now accepted on the way in.

### `scf-mcp` was merged with nothing running its tests

Neither `tools/verify.py` nor `.github/workflows/ci.yml` mentioned the
package, so its suite ran only when someone ran it by hand. And by
hand it ran empty: the smoke tests spawn `dist/server.js`, and without
a build every spawn fails, every call waits out its timeout, and vitest
reports seventeen tests as skipped rather than failed. A suite that
covers nothing and says nothing.

Both are fixed — a `mcp` job in CI and three steps in `verify.py`, with
the build ahead of the tests because it is a dependency of them rather
than a separate proof — and `test/smoke.test.ts` now throws if `dist`
is missing, naming the command. The build-then-skip shape is the same
class as `npx scf-check` being broken because it was tested outside
`node_modules`: verified where it was written rather than where it
runs.

### `shotContext` swept characters and nothing else

The composite derived its intents from `QUERY_PATHS`, which keys on
`<subjectType>_id`; only `character` has such a path, so the scene's
location and props were collected into the subject set and asked for
nothing. Writing a prompt for shot 3B, that hid the DOP's framing plate
for the scene — the single most useful asset for the job — while the
response looked complete.

Intents are now the union of what a query path declares for the kind and
**what the file actually binds to that subject**, with anchors as a last
resort for a subject that has neither. A new `swept` member lists every
subject and the intents asked for, so a subject nothing binds media to
is visible rather than missing. A composite that quietly returns a
partial answer is worse than one that refuses.

---


## 0.54 — 2026-09-21

*Describes schema 2.15.*

**Minor.** Four normative changes, from proposals 0005, 0007, 0016 and
0024. Like 0.53's, all four came out of mapping a second writer against
the format, and three of them are cases where a rule existed in one
implementation's source and nowhere else.

### §9.1 — what `required` means

The registry marks 132 fields on 84 entities `required`, and nothing
said what that meant. The DDL declares no `NOT NULL`, no finding
existed, and the only consumer anywhere was a form drawing an asterisk.
So one implementation could refuse a row that another wrote and both
could claim to conform — and `shot.scene_id` is `required`, which made
an unplaced shot idea either conforming or corrupting depending on who
read it.

`required` now means the row is **incomplete** without the value: never
refused on write, always reported. Two codes carry it, because §9.4
takes severity from the catalog and one code cannot hold both cases:
`field.required_absent` (`info`) for an unfinished row, and
`junction.endpoint_absent` (`warning`) for a link entity missing an
endpoint, which connects nothing. Where a more specific finding already
covers the column — `relationship.endpoint_absent` — that one is raised
instead, not as well.

The fixture now carries an unplaced shot, so the finding fires on
something. No row in it had a missing required value before, which is
why neither reading could be told from the artifacts.

### §1.3.1 — a section line may name the span it declares

scf-app has bound section lines to acts and sequences since the editor
existed, through `metadata.structureRef`, and the specification had
never heard of it. A second writer could not produce the binding, so
every file it wrote would have grown a duplicate act at the first
commit.

The binding is now specified, **by uuid rather than row id**: ids are
file-local and renumberable (§6.2, §12.1.2), and the fixture's own
build renumbers. The record answers queries and the line is the
authoring handle; an editor may update one from the other at commit,
and a disagreement between them is `structure.section_mismatch`
(`info`), not an error. What a section MEANS — whether `### Midpoint`
is an act, a sequence or neither — stays an editor convention, stated
as such.

### §12.14 — how to write `affected_entities`

Q15's attachment column told a reader four ways to read it and a writer
nothing, and all four identified a row by its id. A writer SHOULD now
record `"<entity>:<uuid>"` and MUST NOT write a row id. Reading stays
permissive, legacy spellings included.

**Prose is matched on uuids alone.** The old matcher looked for a row
id or a bare type name as substrings, so `scene:1` matched `scene:12`
and any note containing "appropriate" attached itself to every prop.

The fixture attaches a decision and a note to scene 12 in the new form.
Q15's published `attached` member had been `{"decisions": [], "notes":
[]}` since it was blessed: an implementation that ignored attachment
entirely matched the artifact byte for byte.

### §2.5 — a list is not a blob

Twenty-nine fields hold a list of short strings, and the registry called
them `json` — the same type as a keyed map and as the attachment column
above. So the editor rendered a raw JSON textarea, which no designer
will type into, and §12.1.2 projected the *text*, leaving a consumer to
parse JSON out of a JSON document.

`string_list` is now its own field type: a JSON array of strings,
projected as an array. A malformed value is carried as the text it holds
rather than dropped (§9.2).

---

## 0.53 — 2026-09-20

*Describes schema 2.14.*

**Minor.** Four normative changes, from proposals 0004, 0012, 0013 and
0022. All four came out of mapping a second writer — Scriptyard's `.scf`
export — against the format, which is the first time anything outside
this repository has tried to produce a file.

### §6.6 — `status` is a writing stage and cuts nothing

`scene`, `act` and `sequence` carry both `status` and
`lifecycle_status`, and `status` listed `cut` among its values. §6.6.1
excludes on `lifecycle_status` alone, so an author who set the field
labelled Status to `cut` got a scene that kept its position, its act and
its place in every query, with nothing reporting the disagreement.

No artifact could show it: all 22 of the fixture's scene, act and
sequence rows carry `status = outline`, and nothing in `scf-core` reads
the column at all. §6.6 now says a writing stage makes no claim about
the film and MUST NOT affect resolution, and 2.14 removes `cut` from the
vocabulary rather than honouring it — two columns for one fact can
disagree, and then one of them has to win.

### §12.11 — an act or a sequence can carry a theme

`thematic_connection.entity_type` gained `act` and `sequence`. A carrier
pointing at a span reaches **every scene of its derived membership**
(§5.1), so a scene moved across a boundary moves its count with it and
nothing is stored twice. "Act 2 is where the story argues about
forgiveness" is a claim an author makes and no scene-level connection
implies.

### §12.17 — `time_of_day` is a light axis, and `varies` is a wildcard

The column mixed two axes and lacked the commonest word in a heading.
Six of its values were lighting states; `continuous` was a continuity
relation to the preceding scene, which no location variant can ever
agree with; and `day` was absent, so a Fountain import — whose parser
recognises DAY — wrote null for most day scenes.

2.14 adds `day` (unrefined daylight, what a heading-only import writes)
and removes `continuous`, which stays in the heading text where a
screenplay puts it. §12.17 also states that a variant whose
`time_of_day` is `varies` agrees with any scene on that axis: scored as
an ordinary value, the one value meaning "this dressing holds at any
hour" was the one value that could never win.

### §2.4 — open and closed vocabularies

Sixteen `select` and `multiselect` fields ended in `other`, which
records that the vocabulary failed and discards the value that would
have said how. A production shooting 12K stored `other` and lost the
number.

Those sixteen are now **open**: the options are the known values, a
writer may store any other string, and a reader MUST keep it as the
value rather than mapping it onto a listed one. `other` is gone from all
sixteen. A new finding, `vocabulary.unlisted_value` (info), reports the
tail so a maintainer can promote a common value into the list.

The section also states why the other vocabularies stay closed, which is
the more important half: §12.17's axis scoring, §6.6.1's cut rule and
§9.4's severities all resolve over finite sets. An open vocabulary is
for values a human reads, not values a resolver branches on.

The fixture proved the finding immediately. One `creative_decision` row
has carried `decision_type = "sound"` — never a member of that
vocabulary, where every other row says `audio` — since it was authored,
and nothing had ever looked.

---

## 0.52 — 2026-09-16

*Describes schema 2.13.*

**Editorial.** No normative change. One sentence about the fixture was
no longer true of it.

### §8.6's polymorphic case pointed at two assets that no longer existed

§8.6 says the fixture carries an asset reachable only through
`asset_relationship.entity_id`, so that an implementation which ignores
polymorphic references reports an orphan the file plainly references.

When the fixture's assets were re-authored in the app, the two assets
that row named were deleted and the row was not. It pointed from
nothing to nothing. `scf-check` stayed clean, every published result
stayed byte-identical, and the case §8.6 relies on silently stopped
existing — the same invisible class as the empty `asset_relationship`
table this sentence was written to close.

The row now relates the lettered poster to its textless master, which
nothing else references. The sentence names what the fixture carries.
A new test resolves every polymorphic reference in the fixture, so a
dangling one fails rather than passing unnoticed.

---

## 0.51 — 2026-08-26

*Describes schema 2.13.*

**Editorial.** No normative change, and no fix — the repair is a `git
push`. What lands here is the check that would have caught it.

### The URL ARTIFACTS.md publishes for its own registry returns 404

`ARTIFACTS.md` gives consumers one canonical way to fetch a normative
artifact, pinned to `schema-<VERSION>`, and says — correctly — that
`main` is a moving target and MUST NOT be used to pin a version.

**Schema 2.13 shipped in 0.47 and was never tagged.** So for every
revision since, the manifest's own quoted example returned 404:

    .../schema-2.13/scf-core/registry/registry.json   → 404
    .../schema-2.12/scf-core/registry/registry.json   → 200

Through all of it `sha256sum -c` passed, `artifact_manifest.py --check`
passed, and every step of `tools/verify.py` passed. All of them verify
bytes in the checkout. **Nothing verified the one instruction the
document gives to a reader who does not have the checkout.**

That is the third instance of one pattern in three revisions — §12.13's
leaf, `query-reference.md`'s empty tables, and now this. Each time an
artifact agreed with its own generator while the thing an outsider
needed was broken. Worth stating as a rule: **local agreement is not
reachability.**

### The check

`schema/check_pin.py` asks the remote whether the advertised tag exists,
and — when the tag is fetched locally — whether the artifact at that tag
matches `SHA256SUMS`. A tag that resolves to the wrong commit is worse
than a missing one: the URL works, the bytes differ, and the consumer
concludes the artifact is corrupt.

It runs in `tools/verify.py` (strict) and in CI on `main` only. Not on
branches: a tag cannot point at a commit that has not been pushed, so on
a branch it would be red for a reason the author cannot fix, and a check
that is unfixably red is a check people route around.

**Until `schema-2.13` is pushed, `tools/verify.py` fails on this step.**
That is the check working. The first draft of it ran non-strict and
printed `ok` while the URL 404'd, because `verify.py` shows a step's
output only when it fails — the defect reproduced inside its own check.

---

## 0.50 — 2026-08-26

*Describes schema 2.13.*

**Editorial.** No normative change. `query-reference.md` is regenerated
and now has content where it had blanks.

### Every "What it needs" table was empty

`query-reference.md` publishes, for each of the six walkable queries, the
entities `readinessReport` walks to produce Q14. Every row of every one
of those tables rendered as an empty cell:

    | `` | required | something to resolve |

`QueryStep.entity` became `entities: string[]` in **0.38**, when several
steps turned out to be naming things the registry could not resolve —
`costume + costume_scene` is two entities, `bundle + *_asset_binding` is
a pattern, `media: voice_identity` is an asset intent and not an entity
at all. `emit_normative_data.mjs` was updated and now refuses to publish
a name the registry does not know. `emit_query_reference.mjs` was not,
and kept reading the field that no longer existed.

The generator now prints `QueryStep.label`, which is the field documented
for the purpose and the only one that renders a multi-entity step, a
filtered step and a media step correctly.

### Why nothing caught it

`check-query-reference` runs the generator and compares its output
against the committed file. Generator and artifact agreed, so the check
passed — for twelve revisions. **It verified consistency, and the defect
was in correctness.**

This is §12.13's shape again: an artifact recording an empty answer as
the right answer, with a check confirming the emptiness was reproducible.

A check that compares a generator against its own output cannot find
this class, so the assertion went **inside the generator**: a step that
renders an empty cell now throws and names the field to print. Confirmed
against the regression itself — reintroducing `step.entity` fails at
Q05 rather than publishing blanks.

---

## 0.49 — 2026-08-26

*Describes schema 2.13.*

**Minor.** Q04 gains a `screenplay` member (§12.17.1). No schema change:
the data has been in every conforming file since the screenplay tables
existed, and no query carried it.

### Q04 answered with everything about the scene except the scene

§12.17 assembles the complete context for a scene — lineage, beats,
cast, props, location and its variant, the scene-level design layer,
staging — and did not carry the scene's text. The reference editor said
so in its own output, in the rendered view and in the prompt-ready block
a writer pastes into an assisted writing session:

> *Screenplay text joins this package when Part 3 lands.*

Part 3 — the screenplay editor of the second-implementation plan — had
shipped. The sentence had become false in the product and in every block
copied out of it, and the reason nobody caught it is that the work
package it named existed only in a design document that was never in the
repository.

### What the new member had to settle

`screenplay_lines` is a `uuidExtraTable`, so §12.1's projection rules
reach it only for identity — the registry declares none of its columns
and none of its references. §12.17.1 therefore states its own shape
rather than inheriting one, which is the lesson of §12.1.4: five of
sixteen sections could not be shaped correctly from the document, and a
sixth would have joined them.

Three decisions are worth naming:

- **`scene_id` is omitted rather than resolved.** §3.4 says
  implementations MUST NOT rely on it. A normative answer that carried
  it would invite exactly that.
- **The terminating bound is the next heading by `line_order`, whichever
  scene owns it** — including a cut one. Those lines are absent because
  the bound stops before them, not because §6.6.1 filtered them; a
  screenplay line has no `lifecycle_status` to filter on.
- **An empty array is an answer.** Scene 17 of the fixture is a scene
  the screenplay has not reached, and it is the case that keeps the
  member from being guessed as "never empty".

`Q04.result.json` is re-blessed; it now carries scene 12's twenty lines.

---

## 0.48 — 2026-08-26

*Describes schema 2.13.*

**Editorial.** No requirement changes. §8.2 says out loud a permission it
already granted, and the documentation stops contradicting it.

### The documentation forbade something the format allows

`docs/authoring-guide.md` said:

> **Never paste an absolute path.** It will work on your machine and
> nowhere else, and the format reports it as a defect rather than
> silently accepting it.

**None of that is the format's position.** §8.2 says absolute paths are
representable, `asset.identifier_absolute` is a **warning**, and the
negative fixture's own description reads *"Representable on purpose
(§8.2), non-portable, and a warning rather than an error."*

What happened is narrower and worth naming: the reference editor writes
rooted addresses by default, which is a good default, and the
documentation wrote that preference down as a rule. A tool's convention
became a prohibition in the one document a newcomer reads first.

§8.2 now states the permission rather than leaving it to be inferred
from a severity: an absolute identifier is legal, a conforming
implementation MUST NOT refuse a file for carrying one, and **`..` is
the case that is an error** — because where it lands depends on where
its root sits.

### Nothing said that a project can have more than one root

`@project` is the common case. It is not the only one: §10.2 reserves
`@plates` and `@nas`, the resolver passes a root name through, and a
project whose material is spread across volumes can address all of it
portably.

**None of the five reader-facing documents mentioned this**, which is
why the multi-drive case looked like it required absolute paths. The
authoring guide and the glossary now cover it, with the point that a
second studio maps the same roots at their own locations and every
address still resolves.

The reference editor supports `@project` only, so the portable answer to
that use case is currently unavailable in it. That is separate work.

### And a contradiction the documentation was hiding

§8.3 defines `out-of-root` as **"resolvable but non-portable"**, and
`resolveIdentifier` returns that state for an absolute path **without
ever calling the locator** — no size, no mtime, no confirmation the file
exists, even on the machine where the path is correct. Its own detail
string says the path "resolves on this machine", which is precisely what
the code declines to find out.

`proposals/0003` argues for attempting the lookup and keeping the state.
§8.2 records in the meantime that an implementation **MAY** resolve an
absolute path and MUST keep `out-of-root` if it does, so the sentence a
reader hits first is no longer wrong about what is permitted.

This is the second time a preference of the reference implementation's
was written into a document as though it were a rule of the format's.
The first was §12.9.1's severity table, corrected in 0.40.

---

## 0.47 — 2026-08-25

*Describes schema **2.13**.*

**Minor.** Two MUSTs added, one schema change, one reader-visible change
to a projected row. Both resolve findings from the fifth reader run, one
of them through the proposal path.

### 0001 — `clip`'s screenplay line references are declared

`clip.screenplay_line_start_id` and `clip.screenplay_line_end_id` hold
`screenplay_lines` row ids and carried no `referenceEntity`, so §12.1.2
could not resolve them and both survived projection as bare row ids — in
the section that spends a paragraph forbidding exactly that.

Both are now declared as references to `screenplay_lines`, and §12.1.2
projects them as `screenplay_line_start_uuid` and `_end_uuid` through
the derivation it already had. **No new rule and no special case:** the
independent reader that found this resolves them correctly with no code
change, which is the evidence that the defect was in the registry rather
than in the prose.

§12.1.2 now records that a reference MAY target a `uuidExtraTable`.
This is the first one that does.

**The fixture gains two clips**, without which the defect stays
invisible: `clip` was empty, and §12.1.2 omits empty fields, so a
correct implementation and a row-id-leaking one produced byte-identical
output on all sixteen results.

### A polymorphic reference to an asset counts as a use

§2.3 defined asset usage as "every field whose `referenceEntity` is
`asset`". **A polymorphic column carries no `referenceEntity` by
definition** — its target is chosen per row — so
`asset_relationship.entity_id` was invisible to the rule, and an asset
related to another asset was reported by §8.6 as an orphan with a row in
the same file pointing straight at it.

§2.3 and §8.6 now require the `polymorphicType` sibling to be resolved
per row and the reference counted where it resolves to `asset`. Still
derived from the registry; nothing is listed.

**The fixture gains an asset relationship**, and a concept painting
reachable only through it. `asset_relationship` was empty, so a reader
that counted polymorphic references and one that did not produced
identical `asset.orphan` findings on the fixture and on all eleven
negative cases.

### The shape both share

0.40 replaced §12.1.2's name-matching rule with one that reads
declarations. These are the two places that change left exposed, seen
from opposite sides: **one column the registry had not declared**, and
**one rule that reads declarations meeting a column whose target is
declared per row**. Neither could be found from the published artifacts,
because in both cases the table that would have shown it was empty.

That is the third and fourth defect in this repository invisible to
every published artifact, and the response each time has been the same —
put a row in the fixture that tells a correct implementation apart from
a broken one.

---

## 0.46 — 2026-08-25

*Describes schema 2.12.*

**Editorial.** No specification changes. Two proposals opened, and one
small defect found while checking them.

### The proposal path gets its first two entries

`proposals/0001` and `0002`, both from the fifth reader run's findings.
They are proposals rather than fixes because **neither is a defect**:
each is a decision about what the format should do, with a defensible
answer on both sides. That is the distinction `proposals/README.md`
draws, and until now nothing had tested it.

**0001 — `clip`'s screenplay line columns.** Two integer columns index
`screenplay_lines.id` and carry no `referenceEntity`, so they survive
projection as bare row ids in the section that forbids exactly that.
0.40 created this: the old rule dropped them by accident while
destroying `external_id`, and fixing the larger defect uncovered a
smaller one it had been concealing. No published artifact can catch it —
the fixture's `clip` table is empty.

**0002 — ownership by declaration.** §2.3 decides who gets deleted with
what by matching a column named `scene_id`. Thirty-seven entities
declare one. It is the construction §12.1.2 spent four revisions
removing, in a rule whose failure mode is data loss rather than a
missing field — and the registry already has `parentEntity`, which
**only four of the thirty-seven use**. The mechanism and the rule
disagree about what the mechanism is.

Neither is acted on here.

### A sentinel that was querying a table named after a NUL byte

Checking 0001's implementation risk turned this up. 0.40 marks a
polymorphic column in a reference map with a `POLYMORPHIC` sentinel, and
`uuidLookupForAll` builds its index from every value in that map — so
the sentinel went in as a table name, and every query since has issued
`SELECT id, uuid FROM "<NUL>polymorphic"` and swallowed the error.

Harmless, wasteful, and it quietly widened a `catch` written for a
different case: a missing table is a finding, not a lookup failure, and
the catch had been covering both.

---

## 0.45 — 2026-08-25

*Describes schema 2.12.*

**Editorial.** Two documents restored, and a checker that failed the
wrong way.

### `what-is-scf.md` and `authoring-guide.md` were not in the repository

A revert-and-reapply sequence dropped both. `walkthrough.md`,
`glossary.md` and `faq.md` from the same change survived, so the loss
was invisible in `docs/` — the directory still looked populated.

What made it visible was `check_spec_references.py`, which lists all
five for checking. That is the tool working: a document listed as
checked and absent is a real inconsistency, and it stopped the build.

Both are restored, along with their entries in `site/build.mjs` and the
`docs/` row of the README, which the same revert had also removed.

### The checker crashed instead of reporting

It raised `FileNotFoundError` and printed a Python traceback, which
tells whoever reads the CI log that **the checker is broken** rather
than that a file is missing. The reader has to work out which from a
stack trace.

It now names the absent documents and says what the two possibilities
are: the list is stale, or a commit that should have added a file did
not. Both are worth stopping for, so it still fails — it just fails
legibly.

This is the second time a check in this repository has been right about
there being a problem and wrong about how it said so. 0.44's CRLF
diagnostic fired on a SQLite database and confidently advised
renormalising line endings. A check that reports badly costs more than
one that does not exist, because it is believed.

---

## 0.44 — 2026-08-25

*Describes schema 2.12.*

**Minor.** Two defects, both of which a published artifact certified as
correct. This is the response to the **fifth independent reader run**,
which reproduced fifteen of sixteen queries and eleven of eleven
negative fixtures and made a full Reader claim with divergences
disclosed — the first run to perform all three of `conformance.md`
§6.1's steps and disclose rather than decline.

### §12.13 named an entity that does not exist

`emotionalCascade` gave its cascade leaf as `scene_emotional_design`.
**There is no such entity.** The string occurred exactly twice in the
project — that line and a constant in the reference implementation — and
matched nothing in the registry, the DDL, the generated references or
the fixture.

So the member was `[]` for every SCF file that could ever exist. And
`Q11.result.json` blessed the empty array, which made the test pinning
§12.13 assert that the dead answer was correct.

**This is a harder case than 0.40's `external_id`.** That was a rule
broader than it meant, invisible because the fixture happened not to
exercise it. This one *was* exercised: the fixture authors a
`scene_emotional_target` row and the `project_tone` row it refines —
exactly the data the cascade was written for — and the artifact recorded
the empty answer anyway. The specification and the artifact agreed with
each other, and neither agreed with the schema.

The leaf is now `scene_emotional_target`, and Q11 returns the two layers
it always should have.

### §5.3 — a code that could not fire on a fixture that triggers it

`structure.sequence_act_mismatch` is declared in the catalog as
"Sequence crosses an act boundary", `info`, §5.3. The check tested
whether a sequence's stored `act_id` matched the act derived for its
**first scene** — a different condition, and specifically the comparison
§5.3 calls incorrect: *"Grouping by 'sequences whose start falls in this
act' is incorrect."*

The fixture contains a crossing. "The Reckoning" is filed under act 2,
starts in act 2 — so the old check was satisfied — and runs on into act
3. The reader found it by deriving span membership per §5.1 rather than
by trusting the start.

The check now tests the span, and reports at `info` because §5.3 says a
crossing is **legal and MUST NOT be rejected**. It is a note to whoever
presents acts and sequences as nested, who has to split the sequence
into per-act runs.

This repository's own test suite had been asserting the wrong property
for four revisions, which is why nothing caught it.

### The checker that should have caught the first one

`check_spec_references.py`, added in 0.40 after two invented entity
names reached a reader, validates every `entity.column` written in the
prose against the registry. **`scene_emotional_design` carries no
column**, so it was invisible to exactly the tool built for this.

It now validates bare backticked snake_case identifiers as well.
Everything on the legal side is derived — entity names, column names,
option values, position patterns, framework columns, the screenplay
tables' columns, the `line_type` vocabulary, finding codes, and the
`X_uuid` form of every reference column. Four names are allow-listed:
three SQLite identifiers and `scene_heading`, which §1.3.1 names
deliberately as the value that is wrong.

Re-introducing `scene_emotional_design` now fails the check.

### Smaller

Four citations gave §4.3 for position patterns, which are §4.5; §4.3 is
numbering policy. One of them was in the Reader role's requirement list
in `conformance.md`.

`query-reference.md` listed `shot` among Q08's parameters, which §12.7
forbids in as many words. The generator read the envelope's
`parameters` block, where `shot` is present and null. A null there means
the answer was computed without it, and the generated index now says so
separately rather than listing it as something you supply.

---

## 0.43 — 2026-08-24

*Describes schema 2.12.*

**Editorial.** No specification changes. A CI failure, its cause, and
the reason the cause was not caught.

### `pack-test` asserted the fixture was clean

0.42 gave the fixture a scene with no screenplay heading, so that §4.1's
ordering fallback is exercised by something. That raises
`structure.scene_not_in_script` at `info`, deliberately.

Four test files were updated for that change. **`pack_test.mjs` was
not**, because it is a script rather than a test and does not run under
vitest, and it asserted the literal string `no findings`.

The assertion was also testing the wrong thing. That step exists to
prove the INSTALLED BIN RUNS — that it resolves its imports from the
package, opens a real `.scf` and reports on it — and coupling it to what
the fixture happens to contain made it break for a reason unrelated to
packaging. It now checks that the report names the file, its schema
version, and zero errors and warnings.

### Why the local check said it was fine

The pre-push verification was a hand-assembled chain, and one link read:

    npm run pack-test 2>&1 | tail -1 && npm run typecheck

**A pipe reports the exit code of the last command in it.** `tail`
succeeded, the chain continued, and a failing step scrolled past as one
blank line. Every step after it ran and passed, so the run looked green.

`tools/verify.py` replaces the chain: every check CI runs, in order, no
pipes, one exit code, and the full output of any step that fails.
Twenty-four steps, about eighty seconds. `CONTRIBUTING.md` and
`conventions.md` §8 now point at it.

It is not a second description of CI — it runs the same commands, and
where the two drift the workflow is right, because that is what gates a
merge. Keeping them in step is manual, and saying so here is better than
pretending otherwise.

### A diagnostic that gave the wrong advice

Writing `verify.py` surfaced a second defect. `artifact_manifest.py
--check` detects CRLF line endings when it reports a stale manifest,
because a Windows checkout cannot match digests taken over raw bytes
(0.30). It tested every artifact, including `hollow_creek.scf` — a
SQLite database, which contains `\r\n` byte pairs by coincidence.

So **any** staleness, from any cause, printed a confident instruction to
renormalise line endings and `DO NOT REGENERATE`. Exactly the wrong
advice, delivered with the authority of a specific diagnosis. It now
tests text artifacts only, using the same NUL-in-the-first-8KB check git
uses.

---

## 0.42 — 2026-08-23

*Describes schema 2.12.*

**Editorial.** No requirement changes. The fixture gains two rows so
that two rules stop being unexercised.

### Two rules nothing tested

0.41 stated §4.1's ordering for scenes the screenplay does not contain,
and §12.17's `mismatches`. Both were correct, implemented, and **checked
by nothing** — the fixture's thirteen scenes all carried headings, so
the fallback never fired, and its chosen location variant agreed on
every axis, so `mismatches` was always empty.

The fourth reader run guessed §12.17's shape and guessed **wrong**,
emitting `{field, scene, variant}` triples where the format is an array
of strings. It could not have known: no artifact showed it, and a rule
no artifact demonstrates is a rule the next reader will guess at too.

**Scene 17** — "INT. HOLLOW CREEK CHURCH - VESTRY - DAY" — carries a
scene number and no screenplay heading. It sorts after scene 24, and the
published Q10 spine says so. A reader ordering by `scene_number` alone
puts it between 16 and 19 and now diverges from a published artifact
instead of from nothing.

**Scene 12's kitchen dressing was built for an autumn night**, and the
film uses it in winter. It still wins on time of day and weather, so it
is still the variant in force, and the published Q04 result now carries
the season it is wrong about. That is precisely what `mismatches` is
for: the best available variant, and an honest note about where it does
not fit.

### The fixture reports a finding now, deliberately

Scene 17 raises `structure.scene_not_in_script` at `info`. The fixture
is no longer finding-free, and that is the point rather than a cost.

§9.2 requires a reader to answer usefully on half-placed data **and to
say what is missing**. A fixture with nothing missing can demonstrate
the first half and not the second, and the eleven negative fixtures
cover files that are *wrong*, not files that are *unfinished* — a
different and much more common condition. `report.test.ts` now asserts
both halves: nothing is wrong with the fixture, and something in it is
plainly unfinished.

### A message nobody had read

`structure.scene_not_in_script` said the scene "has no number and
belongs to no act". **A scene absent from the script can carry a number
perfectly well** — scene 17 does. What it has no story POSITION, which
is a different thing and is exactly what §4.1's fallback exists for.

The wording had never been wrong in practice because nothing in the
fixture had ever produced it.

---

## 0.41 — 2026-08-23

*Describes schema 2.12.*

**Minor.** One member renamed; the rest is rules that were true, relied
on, and never written down.

This closes the fourth reader run's remaining findings. **None of these
was a wrong statement** — they are places the document was silent and
the reader had to choose. It chose correctly almost every time, which is
the point: a specification that can be guessed right is still one that
has to be guessed.

### §4.1 — how scripted and unscripted scenes interleave

They do not. **Every scene the screenplay contains precedes every scene
it does not**, because the two have no shared axis: a scripted scene has
a line position and an unscripted one has a number. §4.1 gave the
fallback chain and never said how the populations relate, so a reader
had to invent a rule for the case where both exist.

The full comparison is now stated in order: whether the scene has a
screenplay position at all, then that position, then `scene_number`,
then row id.

**The fixture cannot check this.** All thirteen scenes carry a heading,
so the fallback never fires. Given how much `conformance.md` §5.1 makes
of the three-orders property, the missing half is conspicuous, and a
single unheaded scene would pin it.

### §4.5 — the tie-break, and a closed vocabulary

Two rows can sit at one scene and neither pattern said which came first.
**Row id breaks the tie** — the only stable key available at a shared
position, and it means the row written later wins. Pattern 2 merges
oldest-first so a later row overrides key by key; pattern 3 takes the
highest row id at the winning position.

**`persistence` is closed at two values**, and a reader encountering
another **MUST treat the row as `scene_only`**. §10.1's general "ignore
what you do not understand" does not say whether the unknown field or
the whole row is ignored, and here the two readings differ in an unsafe
direction: defaulting to `until_resolved` would silently extend a state
the reader does not understand across the rest of the story.

### §12.9.1 — what "absent" is relative to

A step is assessed **at the position the query was asked about**, not
across the file. Unstated, and it is the difference between "does this
character have a vocal profile" and "does anything in this project have
one" — two questions with different answers on any real project.

A step's rows are narrowed by whichever of the target query's parameters
the step's entities declare as a column, with `filter` applied on top
and an `intent` step satisfied by a bundle of that intent carrying at
least one asset. An entity declaring none of them is assessed across the
file, because there is nothing to narrow it by.

### §12.17 — "the variant in force" now says what that means

`location_variant` declares `positionPattern: none`. It is not keyed to
a scene at all, so "in force" cannot mean what it means everywhere else
in this document, and §12.17 used the phrase anyway.

It means *the variant that best describes this scene*: score each
variant on three axes, take the highest, break ties toward
`is_baseline`, and **fall back to the first baseline when nothing
agrees** — because agreement is not what chose it, and the baseline is
the honest answer.

`mismatches` is an **array of strings** naming the axes where the chosen
variant disagrees with the scene. The fixture's chosen variant has none,
so a reader implementing this had nothing to check the shape against and
no way to know it was guessing. It guessed a different shape.

### §12.15 — which column makes a group

A dossier group is an entity "carrying a reference back to it", which
does not name the column, and an entity may declare several references
to the same target. It is **`<subject>_id`** — §2.3's ownership
convention — and only that one says *this row is about that subject*.

### §12.8 — `subject` meant two things, four lines apart

`parameters.subject` is a uuid, as §12.1.1 requires. `result.subject` was
the string `"character"` — the subject's *kind*. One key, two meanings,
in one document. A reader read it as the uuid, caught itself, and
observed that `subjectKind` would have cost nothing.

It is now **`subjectKind`**. It stays in the body rather than moving
wholly to the envelope because §12.16 nests this result without its
envelope, and the nested copy has to remain self-describing.

---

## 0.40 — 2026-08-23

*Describes schema 2.12.*

**Minor.** Two MUSTs corrected — both were wrong rather than incomplete
— and several things the document assumed a reader already knew.

This revision is the response to the **fourth independent reader run**,
which reproduced fourteen of sixteen queries and eleven of eleven
negative fixtures and declined an unqualified claim on the grounds that
two normative artifacts were non-conforming. It was right about both.

### §12.1.2 — the drop rule was deleting authored data

The rule read: *any remaining column whose name ends `_id` MUST be
dropped.* That is true of the four polymorphic references it was
written for. It is also true of **`external_id`** — a declared,
authored field on ten entities, with its own registry flag (§6.3) — and
of `clip.screenplay_line_start_id` and `_end_id`, ordinary references
whose target happens to be a screenplay table rather than a registry
entity. **Twelve legitimate columns, deleted from every projected row.**

**No published artifact could catch it.** The conformance fixture
authors no `external_id` and its `clip` table is empty, so §12.1.2's
omit-empties rule made a correct implementation and a data-losing one
produce byte-identical output on all sixteen results. It survived four
revisions and three reader runs, and the fourth found it by reading the
sentence and noticing what else it was true of.

The registry now declares which columns are polymorphic, through
**`polymorphicType`**, which names the sibling column that says where
the reference points. §12.1.2 drops those and nothing else. A rule that
pattern-matches on a name will eventually match something the name did
not mean; a rule that reads a declaration will not.

### §6.6 — two of six values

§6.6 said `lifecycle_status` marks a row `active` or `cut`. The
registry declares **six**: `active`, `draft`, `superseded`,
`deprecated`, `cut`, `archived` — and §2.1 says the registry wins, so
the specification and the artifact it defers to disagreed in the one
place a reader could not tell which was right.

All six are now stated, with **only `cut` excluded from resolution**
and the reason given: `cut` is the only one of the six making a claim
about the FILM, and the other five describe the row's editorial
standing. Two readers, one excluding `archived` and one not, would have
answered different questions and both believed they conformed.

### §12.1.4 — the member every derived record has

§12.1.2 established that a projected row has exactly two members and
that computed values sit beside it. **Nothing said what the row itself
sits under.** §12.1.4 now states the convention — named for the entity
it carries, unless the section says otherwise — and the five sections
that say otherwise now do: §12.11's `spine`, §12.13's `identification`,
§12.14's `attached`, §12.17's `blocking`, and §12.16's `subjectType`,
which its field table had simply omitted.

Five of sixteen queries could not be shaped correctly from the
document. A reader that guessed differently would answer the same
question with a structurally different result and nothing to warn it.

### §12.1.6 — an absolute that was false

It read *"Nothing in a result is in row order"*, and was contradicted by
two sections of this document (§12.5's `beats`, §12.10's `manifest`)
and by a published artifact (§12.5's `characters`, in junction row
order with nothing saying so).

**The problem was unstated reliance, not reliance.** Row order is never
the default and a section MUST NOT fall back on it silently; where rows
are peers with no story position of their own, the section states it.
§12.3 and §12.5 now state it.

### §12.9 — Q14 was never declared incomparable, and its table was too crude

Q14's messages carry judgement — *"Physical state persists here
(wounded) with no vocal state — does it color the voice?"* is an
observation, not a lookup — and requiring two implementations to agree
on that is requiring them to agree on a sentence.

§12.9 now says Q14 is the one query **not reproduced byte for byte**,
and that conformance is coverage, severity range and disclosed
departures. That has been claimed in the release checklist for months
and was written nowhere.

§12.9.1's table said an absent `optional` step is `suggestion`. The
published artifact reports `ok`, which is right — that is what optional
means, and a report raising a suggestion for every absent optional step
is mostly noise. The table now gives `optional` a range, and permits a
finding no single step produces, which is why the artifact carries seven
findings for a six-step rubric. **The rule was wrong, not the artifact**,
and the reader that followed the rule and got six was correct to say so.

### §5.4 — the selectors it promised now exist

`conformance.md` has always said parameters resolve from selectors
"recorded alongside the expectations, so another implementation can
resolve them for itself". Nothing shipped. They lived in two test files,
one covering only the eight queries with rendered markdown.

`fixtures/expectations/selectors.json` publishes seven selectors and all
sixteen queries' parameters, resolving by CONTENT rather than row id —
row ids are file-local (§6.2) and did change the last time the fixture
was rebuilt. The generator cross-checks every selector against every
published `parameters` block, and found six of my own assumptions wrong
while doing so.

**Q13's envelope omitted `intent`.** §12.1.1 says parameters record what
was asked so a result is self-describing; `intent` was asked, changes
the answer, and appeared only in the body. The fourth reader took it
from the result — reading the answer to learn the question. Fixed, with
`subjectType` alongside it.

### Prose is checked against the registry now

`schema/check_spec_references.py` validates every `entity.column` written
in the specification, in `conformance.md` and in `stability.md` against
`registry.json`. CI runs it.

0.29 wrote `character_state.name` and `asset_bundle_item.role_in_bundle`
into two field tables. **Neither entity exists** — they are
`performance_state` and `bundle_asset` — and both names were invented
while writing the sentence. 0.38 made the readiness rubric's entity
names checkable and refused to publish an unknown one, and left the
prose, which is where a reader looks first, entirely unchecked.

### Smaller

§4.5 described **three** position patterns; the registry declares four,
and the fourth, `none`, is what 93 of 99 entities carry. All four are
named, with the registry's own values.

§12.1.1 now gives `resultFormat`'s value. §12.10 now gives the density
threshold this specification uses, which it required a result to publish
and never stated.

`stability.md` carried two rows about the readiness rubric, three lines
apart, one of them describing the state before 0.38 fixed it.

---

## 0.39 — 2026-08-22

*Describes schema 2.12.*

**Minor.** §6.6 and §6.6.1 gain requirements that were true and unstated;
§8.3 states what it had left to the reader. One real defect fixed in the
reference implementation.

### §6.6.1 — a cut endpoint, and the mirror nobody had written down

§6.6.1 says **adding a cut row changes no answer**, and calls that the
test of a conforming implementation. It has a mirror: **cutting an
existing row MUST change the answer.** Both are now stated, and the
second is the load-bearing one — the test as written is satisfied by an
implementation that ignores `lifecycle_status` entirely, since nothing
it adds is ever looked at.

**The reference implementation failed the mirror.** `rows()` applies the
exclusion to everything fetched a table at a time, and five canonical
queries reached an entity THROUGH a junction in a single SQL join —
Q04's cast and props, Q03's costumes and motifs, Q02's costumes. Each
joined a junction that cannot be cut to an entity that can, and filtered
neither. **Marking a character cut left them in the scene's cast.**

Fixed at all five, plus `relationshipsFor`, through one exported
predicate rather than five local ones. `cutChangesTheAnswer.test.ts`
pins the property for each, and keeps a test for the original direction
too, because the fix could have been written as "filter everything and
report less".

§6.6.1 now says this outright: a link whose ENDPOINT is cut joins
nothing, whether or not the link itself can carry a status.

### §6.6 — why eleven link entities must not carry a status

§6.6 stated that eleven of the thirteen link entities MUST NOT carry
`lifecycle_status` and never said why, which left the neighbouring rule
about cut links looking like a rule about a state most of them cannot be
in.

**A link inherits its endpoints' lifecycle.** A junction is a
*connection*, and a connection to something not in the film is not in
the film either. A link needs a status of its own only when the row is a
**claim** rather than a connection — an actor's casting and a thematic
connection can both be cut while both endpoints survive, which is
exactly why those two carry it.

### §8.3 — `unmaterialised` is the environment's job

The state was defined and no implementation could produce it from
anything this specification said. Whether a path holds real bytes or a
cloud placeholder is not a property of the identifier or of the file; it
is a fact about the filesystem the session is attached to, and the
mechanisms differ per platform and per sync client. Any rule stated here
would be wrong somewhere.

So §8.3 now states the shape rather than the mechanism, as §0.3 does for
the root mapping: an environment that can distinguish a placeholder MUST
report `unmaterialised` and SHOULD document how it decides; one that
cannot MUST report `resolved` and MUST NOT report `missing`, because the
bytes are reachable and slow is not absent. **No role is required to
produce the state at all**, and `conformance.md` says so — there is no
fixture for it and there cannot be one.

The reference implementation's heuristic, a zero-length file carrying a
modification time, is recorded in `assetLocator.ts` and is explicitly
not normative.

### A documentation site

`site/` renders the repository's own Markdown to a static site, deployed
to Pages from `main`. It authors nothing but its landing page: a site
carrying its own copy of the specification would be this project's
recurring defect with the drifting copy on the internet.

**It makes §-references clickable, and a dangling one fails the build.**
The specification cross-references itself constantly and in plain
Markdown every one of those is dead text — three independent
implementations were written by people navigating this document by
scrolling. 1,208 references now resolve to 112 sections.

Resolving them means knowing which sections exist, which means knowing
when one does not. That check is the reason this is a generator rather
than a Jekyll configuration, and `ci.yml` runs it on every pull request:
a `§9.7` in prose when §9 stops at §9.6 is a defect in the
SPECIFICATION, and it now fails there rather than costing a reader ten
minutes.

The changelog is exempt, and only the changelog. §4.3.1 was added in
0.16 and deleted in 0.21, and both entries are correct about the
document as it stood — recording history is the one place a reference to
something gone is not a defect.

---

## 0.38 — 2026-08-22

*Describes schema 2.12.*

**Minor.** One MUST added in §5.4. The last three Unstable rows in
`stability.md` are closed.

### §12.9.1 — rubric steps resolve against the registry

A step carried a single free-text `label`, and several used it for
things the registry could not resolve: `costume + costume_scene` (two
entities), `bundle + *_asset_binding` (a pattern),
`performance_state (vocal)` (a filtered subset), `media: voice_identity`
(an asset intent, not an entity at all).

A step now carries **`entities`** — registry names, always — with an
optional **`filter`** (a field and a disjunction of values) and
**`intent`** (the asset intent whose bundle must resolve). `label` is
derived from those for display, and a consumer MUST NOT parse it.

`emit_normative_data.mjs` checks every name against the registry and
every `filter` field against the columns of the entities it names, and
refuses to publish otherwise.

**And the rubric was not the only description of what Q14 does.**
`readiness.ts` never walked `QUERY_PATHS`: it has a hand-written
assessment per query, so the published rubric was a second description
free to drift from the implementation it describes. `media:
voice_identity` is where it already had — Q14 reports that finding
against `bundle`, which no step named.

`readinessRubric.test.ts` pins the agreement rather than merging the
two. Merging would change what Q14 says, and its messages carry
judgement a rubric cannot — *"Physical state persists here (wounded)
with no vocal state — does it color the voice?"* is not something a
requirement level produces. The test asserts that every entity Q14
reports is one the rubric declares, which is the property a third party
actually depends on.

### §6.6.2 — `scf-check --cut`

`rowsIncludingCut` existed and nothing called it, so "inspectable" was a
claim. `scf-check --cut` now lists every cut row by uuid and name.

It is a **separate code path from the report**, which §6.6.2 asks for,
and the reason is worth stating: **a cut row is not a finding.** It is a
deliberate authorial act, not something wrong with the file, and
reporting it as a defect would say the opposite. Row identity survives
being cut (§6.1), so the uuid listed is the uuid that comes back if the
row is restored.

### §5.4 — the shadow rows stay, and nothing normative reads them

The question was whether `scene_sequence` should survive 1.0: it stores
a derived fact, which §3.1 forbids everywhere else.

It resolved differently than expected. **Q04 was reading the shadow.**
§12.17's lineage came from `scene_sequence` directly — a table this
section explicitly permits to be stale — so a normative query could
return a lineage the file's own boundaries contradict. The defect was
never that the rows exist; it was that a query treated them as truth.

Q04 now derives lineage from span boundaries via `deriveStructure`, and
§5.4 states that **a conforming reader MUST derive membership from
boundaries** rather than from these rows. What remains is a
compatibility surface for consumers outside this specification, with
`structure.shadow_row_unexplained` reporting rows no boundary explains.

The published Q04 result is **unchanged**: on the fixture the shadow and
the boundaries agree, which is exactly why nothing caught this.

### What this means, and what it does not

`stability.md` defines a 1.0 as the act of moving every Unstable row to
Provisional, and **there are none left.**

That is a fact about this document, not a claim that the format is
finished. What remains is outside it: documentation for people who are
not implementing the format, a second *maintained* implementation, and a
package that is published rather than merely publishable.
`docs/release-checklist.md` tracks those, and `stability.md` now says so
rather than letting an empty Unstable column imply more than it means.

---

## 0.37 — 2026-08-22

*Describes schema 2.12.*

**Editorial.** No requirement changes. Two reading aids, both generated.

### `entity-reference.md` and `query-reference.md`

The manifest goes to **44**. Neither document is normative and both say
so in their own first lines.

**The entity reference** carries all 99 entities and their fields from
`registry.json` — tier, category, subject, scope, position pattern,
ownership, what refines what, and for each entity the list of fields
that point at it, derived rather than declared.

**The query reference** puts all sixteen queries on one page: what each
answers, what it takes, what its result carries, and where §12 states
it. Every fact is read from the specification, the published
`.result.json` artifacts, or `queryPaths.ts`.

They are generated because the alternative is a fourth description of
the same sixteen queries and a second description of the registry, each
correct on the day it was written and drifting by the following week.
That is the shape of every recurring defect this project has found.

The query reference follows **§12's order**, which is not the numeric
order of the query ids — Q05 is §12.2 and Q00 is §12.12, because the
section builds from a single position outward to the whole story.
Sorting by id would have implied the spec was disordered.

### `tierLabels` joins the registry

Tier names — "Structural foundation", "Thematic tracking" and the rest —
existed as banner **comments** in `entity_registry.py` and nowhere a
generator could reach.

So the entity reference invented them, and **four of the seven were
wrong**. It put "Production" on tier 4, which is Thematic tracking, and
called tier 6 "Connections" when tier 6 *is* Production. Nothing in the
output would have looked wrong to a reader who did not already know.

`TIER_LABELS` is now declared in `schema_meta.py`, emitted into
`registry.json`, and read from there. The generator exits rather than
guess if the field is absent. Spec §2 says tier is descriptive and
carries no semantics, which makes the label free to state and pointless
to invent.

`registry.json` changes; the schema version does not, because nothing
structural moved.

### A parser that failed quietly, then loudly

The query reference reads each query's one-line summary from the bold
sentence under its §12 heading. §12.16's **wraps across two lines**, and
the first version of the match returned an empty string for it — a blank
cell in a generated table, which is exactly the kind of gap nobody reads
twice.

Fixed, and a missing summary is now fatal rather than blank: the
generator names the query and the section and exits. The same applies to
a query with no published result, and to §12 carrying any number of
query sections other than sixteen.

---

## 0.36 — 2026-08-22

*Describes schema 2.12.*

**Editorial.** No requirement changes. `stability.md` is corrected where
it had drifted, and the release checklist rejoins the repository.

### `stability.md` was describing a project that no longer exists

Three claims in it were false, in a document that is normative,
checksummed, and the one place a third party is told to look for what is
safe to build against.

**The queries row said "Nothing is specified yet. This is the largest
remaining piece of specification work."** §12 has been complete since
0.23, with all sixteen queries specified and each carrying a published
normative result; 0.29 added the shape conventions. The row was four
revisions stale and pointed a reader at the opposite of the truth.

**The summary listed "the remaining three queries — Q01, Q02, Q04.
Their compositions live in the app and must move to the core first."**
All three live in `canonicalQueries.ts` and have published results. The
same list numbered two of its items `4`, and counted five Unstable rows
where there are three.

**The finding catalog was described as 35 codes.** It has 36.

The corrected summary also separates two Provisional rows with known
gaps — the `scf-check` asset tally and the `scf-core` API surface — from
the Unstable rows that define a 1.0, so that "what stands between here
and 1.0" is a list of three things rather than an impression.

### The release checklist is in the repository

`docs/release-checklist.md`, at **rev 11**, regenerated from the tree
rather than edited forward from rev 10.

Rev 10 lived outside the repository and had drifted the way an untracked
description always does: it claimed spec 0.29, forty-one checksummed
files and a published `screenplay-tables.json` at a time when `main` had
0.28, twenty-five, and no such file. It had become a second place where
the project's state was written down, and it disagreed with the first.

Being in `docs/` does not make it true — nothing checks it — but it puts
it where the change procedure can reach it, in a diff, beside the things
it describes.

**What it records:** nine of eleven sections complete. Nothing that
remains is specification work. Section 7 — documentation for people who
are not implementing the format — has not moved since rev 10 called it
the largest untouched block, and everything else on that list has.

---

## 0.35 — 2026-08-21

*Describes schema 2.12.*

**Editorial.** No requirement changes. The conformance fixture becomes a
build output with a reviewable source.

### The fixture builds from nothing

`fixtures/build/build_fixture.py` takes three inputs and no existing
fixture: the published `scf-schema.sql`, a new
`hollow_creek.data.json` carrying the 375 authored rows, and the
screenplay. Two builds from the same source are **byte-identical**.

The old chain could not do this. `01_people_and_world` through
`04_screenplay_body` ran additively over a file whose origin was lost,
and `01` failed on its first statement against an empty database,
looking up a scene 12 nothing had created. Checklist §10's reproducible
build was unreachable.

**The reason that mattered was not reproducibility.** It was that the
fixture is a conformance artifact whose exact content eleven suites
assert against, and a pull request touching it showed one line saying a
binary file differed. Nobody could review a change to it. The loop is
now: author in `scf-app`, dump to JSON, **review the JSON diff**,
rebuild, commit both. CI checks that the rebuild still matches what is
checked in.

The four old scripts are kept unrun in `fixtures/build/history/`, with
a README recording what the data file cannot: scene 12 is pinned, name
anchors are relied on by both suites, scene numbers are deliberately not
sequential, and some gaps exist on purpose so §9.2's half-placed-data
requirement is actually exercised.

### Three bugs the rebuild found

None was visible while the fixture was never built from nothing.

**`screenplay_body.py` stamped `user_version = 2010`**, hardcoded. It
stayed there through schema 2.11 and 2.12, so every run backdated the
file's header by two schema versions. It went unnoticed because the
value in the checked-in fixture came from somewhere else and this line
quietly disagreed with it. The version is now read from `_scf_meta`.

**It deleted and re-inserted a performance beat without preserving its
row id**, so each run advanced `sqlite_sequence` and produced a
different file. The uuid was pinned; the row id was not, and row ids are
what every foreign key in the file points at.

**Generated screenplay lines took `CURRENT_TIMESTAMP`.** Two builds from
identical source, minutes apart, differed in 106 rows and agreed about
everything that means anything. Timestamps on generated rows are values,
not observations, and are now preserved or fixed.

### The fixture changed, and nothing noticed

Rebuilding reset `screenplay_lines` row ids from 228 to 1 — accumulated
autoincrement drift from repeated delete-and-reinsert, referenced by
nothing. `screenplay_prop_tags` anchors to lines by **uuid and
character offsets, never by row id**, and no foreign key targets that
table.

So the fixture's bytes changed and **every blessed artifact stayed
identical**: all sixteen query results, all eleven negative reports, 602
core tests and 248 app tests, unmoved. That is §12.1.2's rule — row ids
never appear in a result — demonstrated rather than asserted, on a
change that would have broken any artifact that had smuggled one in.

---

## 0.34 — 2026-08-21

*Describes schema 2.12.*

**Editorial.** No requirement changes. The package's public surface is
stated rather than accumulated.

### `src/index.ts` is an explicit list

It was twenty-six `export *` lines, which is not a surface but the
absence of one: every helper written for internal use was exported by
accident, and nothing distinguished a name meant for consumers from one
that happened to be reachable.

**259 names became 224.** Four modules are cut — `assetIndex` (browsing,
facets, the derived path tree), `preview` (display tiers), `assetImport`
(candidate and relink plans) and `bundling` (bundle mutations). They
appear in no conformance role, no query result and no published
artifact. They remain importable by deep path; they are simply not part
of what the package promises to keep working.

**The organising question was not "what does the editor use."** That
turned out to be the wrong question entirely: `scf-app` imports twenty-six
modules directly through a path alias and **has never gone through the
entry point at all**. The barrel served nobody. So the surface is
organised by `conformance.md`'s three roles instead, and the file is
sectioned to match — a reader can see which claim each group serves.

### The surface must be self-contained

`emit_api_surface.mjs` now enforces that **every type named in a public
signature is itself public**, and CI runs it.

This is the invariant that makes a surface usable rather than merely
small. If `q05Result()` is exported and `Q05Result` is not, a consumer
can call the function and cannot write down what it gave them — no
variable annotation, no wrapper signature, no re-export. The failure is
silent at this end and immediate at theirs.

It is checked on syntax rather than by walking resolved types: a type
reference written in a declaration is exactly what a consumer must be
able to name, and inferred structure they never spell out is not.

Writing the check found one real gap immediately — `NodeDatabase` on the
`./node` entry names `SqlExec`, which that entry does not export. It is
reachable from `.`, so the check compares against the union of the entry
points rather than each in isolation, which is what a consumer actually
experiences.

### What is left, and what it is not

`stability.md` moves the API surface off the Unstable list. What remains
is judgement rather than structure: a few rendering and browsing helpers
inside kept modules could still go — `referencesMarkdown`, `summaryLine`,
`browseUuids`, `actOutline`, `planRelink`/`applyRelink`. Each has an
argument both ways, none is a defect, and the route for changing one is
now `proposals/` rather than a quiet edit.

The package remains unpublished. Nothing about this revision changes
that, and the cut it makes is only cheap because of it.

---

## 0.33 — 2026-08-21

*Describes schema 2.12.*

**Editorial.** No requirement changes. Packaging, the public API surface,
and a licence carve-out.

### `schema-2.12` exists, and the addressing scheme is proven

The first tag in this repository's life. `spec/scf-spec.md` was fetched
at that tag over the published URL and its SHA-256 matched `SHA256SUMS`
exactly — so §2.1's addressing scheme is demonstrated end to end rather
than described. `stability.md` moves artifact addressing off the
Unstable list, where it had been solely because no tag existed.

### The package can be consumed

`@minimalhumans/scf-core` builds to `dist/` with declarations, and
`exports` points there instead of at `src/index.ts`.

That was not cosmetic. **A downstream TypeScript project that emits
JavaScript could not compile against this package at all.** The internal
imports carry `.ts` extensions, so a consumer's `tsc` failed with TS5097
on every one of them unless they set `allowImportingTsExtensions` —
which itself requires `noEmit`. The only consumers who could use the
package were ones that never compiled.

**And `npx scf-check` was broken**, for a different reason found only by
testing it: `scripts/scf_check.mjs` imported `../src/*.ts`, and Node
refuses to strip types for files under `node_modules`
(`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). It worked from a
checkout and failed once installed, which is the only way anyone else
would ever run it. It now resolves through the package's own entry
points, so the CLI consumes the library exactly as a stranger does — if
it ever needs something the entry points do not expose, that fails here
rather than in somebody else's project.

`scripts/pack_test.mjs` builds a real tarball, installs it into a
throwaway project, and checks all three: a JavaScript consumer, a
TypeScript consumer that emits, and the installed bin. CI runs it. Every
other check in this repository runs inside the repository, where the
source is on disk and Node strips types for us; none of that is true
downstream, and the gap is where both of the above were hiding.

**The package remains unpublished.** Publishing is a one-way door — npm
blocks unpublish after 72 hours — and the format is pre-1.0 with
everything disposable by policy (§11.0). Nothing is gained by pressing
it before the surface below has been decided.

### The API surface is pinned, and not yet decided

`spec/api-surface.json` joins the manifest, taking it to **42**. It
records every name importable from each entry point, with its kind:
**259 across two entry points**, of which 109 are types invisible to a
runtime import.

`index.ts` re-exports eighteen modules with `export *`, so that set
includes every helper written for internal use. **A name a consumer can
import is a name they will import**, and removing it afterwards is a
breaking change whether or not it was ever intended as API.

Pinning is not deciding. This artifact makes a change to the surface a
visible diff in review — the same guarantee the registry and the finding
catalog already have — and gives the cut a list to work from.
`stability.md` carries it as **Unstable** and expects it to shrink.

### `alexis-nexus.fountain` is not Apache-2.0

The public corpus tier previously shipped "under the repo's licence",
which put a feature-length original screenplay under a software licence
permitting anyone to redistribute and adapt it commercially.

It now carries its own narrow grant in
`corpus/public/scripts/LICENSE`: redistribution as part of this
repository or a fork, and use in developing or testing software.
Everything else is reserved — production, performance, adaptation,
standalone distribution.

The grant exists rather than a flat reservation because **an open format
that cannot be forked without infringing something is not open in any
way that matters.** `NOTICE`, `corpus/README.md` and `spec/LICENSE`
record the carve-out, and all three say the same thing: conformance
never depends on that file. The normative fixture is
`fixtures/hollow_creek.scf`, which is Apache-2.0.

### Build identity in the app

The topbar shows the app version beside the schema version, with commit
and build date in its tooltip, injected by Vite at build time. "Which
build am I looking at" is the first question anyone asks about a bug
report, and the app could not answer it. The commit is best-effort: a
build from a tarball has no git, and that is not a reason to fail.

---

## 0.32 — 2026-08-21

*Describes schema 2.12.*

**Editorial.** No requirement changes. Governance, licensing and a
process for proposing changes — none of it alters what a conforming
implementation must do.

### `spec/` is CC BY 4.0

Prose carries a different licence from code, stated in `spec/LICENSE`
and reflected in `NOTICE`, `README.md` and `CONTRIBUTING.md`. The
boundary runs between **written documents and generated data**, not
along directory lines: the four specification documents are CC BY 4.0,
while `scf-schema.sql`, `screenplay-tables.json`, the JSON artifacts and
`scf.magic` stay Apache-2.0 with the code that generates them. Fixtures
stay Apache-2.0 too — an attribution burden on a conformance fixture is
a burden on conformance.

Apache-2.0 is written for software: source and object form, derivative
works, patent grants. Applied to a specification it is at best awkward
and at worst unclear about the thing that matters most, which is whether
you may quote it. A format written to be implemented by other people
needs a documentation licence that answers that directly.

**The licence is enforced per file, not asserted in three documents.**
`tools/add_spdx_headers.py` now knows Markdown and stamps prose with
`CC-BY-4.0` instead of `Apache-2.0`, and CI checks it. 182 files carry a
header.

Two files are generated Markdown and are skipped: `ARTIFACTS.md`, which
now emits its own header from `artifact_manifest.py`, and the blessed
`fixtures/expectations/*.expected.md`, which are rewritten wholesale on
every bless. A header added to either by hand would survive until the
next regeneration and no longer.

One thing 0.31 broke and this revision repairs: that tool skipped every
file in `SHA256SUMS`, on the reasoning that a checksummed file is a
generated one whose generator owns its header. That held until 0.31,
when the four specification documents were added to the manifest —
hand-written prose, checksummed precisely so that readers can verify it.
"Checksummed" and "generated" stopped naming the same set, and the rule
silently kept the old meaning, skipping the licence header on the four
documents that most need to declare one. Markdown is now exempt from
that skip.

### Governance

`GOVERNANCE.md` names the maintainers, states what they weigh when
accepting a change, and says where each kind of decision is recorded. It
also says plainly that this is a two-person project with a bus factor of
two, because a governance document describing a process that does not
exist is worse than none — someone would rely on it.

`SECURITY.md` scopes the surface that actually matters: **reading a file
you did not write.** A malicious `.scf` is an ordinary SQLite database
that arrives from somewhere else, and §8.2's asset addressing has an
`out-of-root` state precisely because an address can point outside the
mapped root. It is equally explicit about what is NOT a security issue:
a file that is merely wrong is expected input, and the answer to every
one of them is a finding (§9). A reader that refuses one of the eleven
negative fixtures is the bug.

`CODE_OF_CONDUCT.md` is Contributor Covenant 2.1.

`NOTICE` gains a trademark statement. Naming the format in order to say
your software reads or writes it is fine and always will be — a format
nobody may name is a format nobody adopts. Implying endorsement is not.

### A proposal path

`proposals/` exists, with a template and a procedure. This closes the
most conspicuous gap in the release checklist: three independent
implementations were written against this specification, their authors
produced roughly seventy findings between them, and **none of them had
anywhere to file one.** Two sent prose that was read once and acted on
by one person, and the reasoning behind what was accepted and what was
not exists nowhere.

The distinction the directory insists on: **a defect is not a
proposal.** If the text is simply wrong, that is an issue, and it gets
fixed without ceremony — dozens were, and every one was worth having
quickly. Proposals are for changes where the answer is genuinely
arguable and the argument is the valuable part.

Declined proposals stay in the directory with their reasoning. A
rejected idea that leaves no trace gets proposed again, and the second
time nobody remembers what was wrong with it.

Issue templates route accordingly: a specification-defect form that asks
what the text says, what is wrong with it, and — the useful question —
**what you implemented instead, and how confident you were.** A guess
that happened to match the artifact is still a defect, and knowing it
was a guess is what makes it visible. A pull-request template checks the
steps of `conventions.md` §8 that are easiest to miss.

---

## 0.31 — 2026-08-21

*Describes schema 2.12.*

**Editorial**, with one addition to §2.1 that adds no requirement on an
implementation. No MUST changes.

### The manifest covers the specification

`ARTIFACTS.md` and `SHA256SUMS` went from twenty-six files to
**forty-one**: the four specification documents and the eleven blessed
negative reports joined the generated artifacts.

The specification documents were the conspicuous omission. Three
independent implementations have now been written from this prose, and
until this revision the manifest checksummed the data those readers
consumed while leaving the text that told them what it MEANT unstamped.
A reader could verify `registry.json` byte for byte and had no way to
confirm the specification it read alongside it was the one that was
published.

The negative reports were the other. `conformance.md` §5.3 turns a
conformance claim on reproducing all eleven exactly, which makes their
bytes as load-bearing as any generated artifact's, and they were not
covered.

**The list is now exhaustive in both directions.** Everything in
`ARTIFACTS.md` is checksummed and everything checksummed is described
there — no third category of file that is stamped but not published, or
published but not verifiable. Two lists would have been free to drift,
which is the failure this repository keeps finding. `ARTIFACTS.md` and
`SHA256SUMS` are necessarily absent from their own list; regenerating
them is what verifies them, and CI does that on every run.

The table is grouped rather than flat, because forty-one undifferentiated
rows is a list nobody reads.

### Releasing is annotated, not signed

`ARTIFACTS.md` and `conventions.md` §8 both instructed `git tag -s`.
That was written before anyone had run it, and it needs a signing key
this project has not set up. **A step nobody can run is a step that gets
skipped**, and a skipped step in a nine-step procedure is how the
procedure stops being followed at all.

Both now say `git tag -a`. A signature would add provenance — proof the
tag came from whoever holds the key — which matters once third parties
fetch artifacts by tag, and not before. `-s` substitutes wherever a key
is configured and nothing else about the release changes.

### Elsewhere

§2.1 records that the digests are over raw bytes, so a checkout that
converts line endings will not verify. `.gitattributes` now sets
`eol=lf` to prevent it. This is not hypothetical: it made
`artifact_manifest.py --check` fail on a clean Windows checkout that had
nothing wrong with it, and the failure message pointed at the one action
that would have made it worse.

`tools/add_spdx_headers.py` gained `--check`, and CI runs it. A one-off
run stamps what exists on the day it runs: a full run left 161 files
tagged, and three commits later six files had none — two of them created
by the same round that ran the tool. Coverage is only a property of the
repository if something checks it on every push.

The same tool had been skipping `fixtures/build/`, because `build` was
in its directory-name skip list and matched at any depth. Those three
files are not build output; they are the scripts that build the
conformance fixture. Build output is now named by full relative path, so
a directory called `build` cannot be excluded by accident again.

---

## 0.30 — 2026-08-21

*Describes schema 2.12.*

**Minor.** One MUST and one MUST NOT added, in §1.3.1. No requirement
removed or changed in meaning.

### §1.3.1 — the screenplay tables are published

`screenplay-tables.json` joins the manifest, taking it to twenty-six
artifacts. It carries both of §1.3's table lists with each table's
columns, types, nullability and defaults, dumped from a database created
by `initDatabase()` on the same reasoning as `scf-schema.sql`: a second
description of the same tables would be free to drift from the code
without anything noticing.

**`line_type` is now stated as a closed vocabulary of fifteen values.**
It was previously a TypeScript union — a value the compiler could see
and a generator, a test, or a third-party reader could not. §1.3 named
the tables, published the physical DDL, and said nothing about what may
go in the column.

The cost of that was measured. A third-party reader, building against
§1.3, wrote `scene_heading` for a scene heading. The correct value is
`heading`. Because `line_type` is free `TEXT`, no constraint rejected
it, no finding fired, and no test could have caught it — and because
story order is derived from this table (§4.1), the reader produced a
**confidently wrong story order in silence**. That is a worse failure
than a refusal, and §1.3.1 exists to close it.

So §1.3.1 requires two things this specification had never said: a
writer MUST NOT store a value outside the published set, and a reader
encountering one MUST treat the line as unknown content (§10.1) and
**MUST NOT map it to a value it resembles**. Resemblance is not a rule.

The requirement is on implementations rather than on files, and §1.3.1
says so: SQLite enforces nothing on a `TEXT` column, and **no finding is
raised for an unrecognised `line_type`**. That is deliberate, and stated
so that nobody reads its absence as permission.

`LINE_TYPES` in `fountain/types.ts` is now a runtime array with the type
derived from it, the artifact is generated from that array, and
`screenplayTables.test.ts` checks the published file back against the
code. Adding a member without regenerating fails CI.

### `shapes.json` is retired

It sketched the app runners' raw payload structure and predated §12: it
recorded a flat row with an unresolved `<row-ref>` where a result
carries `{ uuid, fields }` with the reference resolved (§12.1.2). Once
all sixteen queries had normative `.result.json` files it was asserting
a weaker version of the same property in a shape this specification does
not describe — two artifacts for one property, free to disagree.

`conformance.md` §5.4 records the retirement and now states the
expectation set once: a normative result for all sixteen, rendered
markdown for eight, a contract for none of the markdown.

### Elsewhere

`schema/entity_registry.py` had nine `help_text` and `description`
strings citing `conventions.md` for a **rule** — lifecycle status,
external ids, latest-wins position keying, state persistence, asset
identifiers. The README calls that a defect in as many words: the spec
states rules and the design record explains them, and a rule found only
in the design record is a defect. Each now cites the section of this
document that actually carries the rule. They regenerate into
`registry.json`, which is where a consumer reads them; the schema
version does not move, because nothing structural changed.

---

## 0.29 — 2026-08-21

*Describes schema 2.12.*

**Minor.** MUSTs are added, none removed or changed in meaning. Every
addition states a rule the published artifacts already demonstrated, so
no conforming implementation becomes non-conforming — but an
implementation built from 0.28's text alone could have guessed
differently on any of them, and three reader runs did.

### §12 — the shape conventions are stated

The third reader run reproduced fifteen of sixteen queries and marked
**seven of its eleven divergences `guessed`**: it matched the artifact
without being able to justify the choice from this document. Its closing
warning was that the `.result.json` files had become the specification
for §12, and that they were generated by the implementation they exist
to test. This entry is the answer to that, and the four subsections
below are what a reader had to guess.

**§12.1.2 now defines the projected row.** A row appears as `{ uuid,
fields }` — two members, both always present, `fields` present as `{}`
when empty. The shape was demonstrated by every blessed artifact and
defined nowhere, and a flat `{ uuid, ...fields }` was an equally good
reading of 0.28's "its `uuid` plus its authored fields".

**§12.1.2 now states the rule for polymorphic references.** Any column
ending `_id` that carries no `referenceEntity` is DROPPED. 0.28 required
references to resolve via the registry and forbade bare row ids, and
`thematic_connection.entity_id` and `motif_appearance.entity_id` fall
between the two: no `referenceEntity` for the first rule to act on, and
forbidden by the second. Q10 and Q15 both hit it. Where a query needs
the target, it resolves it BESIDE the projected row — §12.11 is the
worked example, and now says so.

**§12.1.4 separates derived records from projected rows, and the two
handle absence in opposite directions.** A projected row OMITS an empty
field; a derived record CARRIES it as null. This is why `"role": null`
sits in a published Q13 result while an unauthored `role` on a projected
row is simply gone — a difference visible in the artifacts, explicable
from neither them nor the text. A derived record has no registry behind
it, so an omitted member and a member with no value would be
indistinguishable.

**§12.1.5 closes the vocabularies and names the label lists.** Every
string in a result is a stored value, a member of a closed vocabulary,
or a bare label. The closed vocabularies of §12 are §8.3's resolution
states, §12.9's readiness severities, and §12.8's `provenance` — three,
and no others. Where a query carries a label list, its section names the
column the labels come from.

**§12.1.6 states ordering.** Every array's order is stated per query, and
an array whose order is not stated is in story order. Member order
within an object is NOT part of the answer: results compare as JSON
values, not bytes, on §11.6's reasoning. The published artifacts are
serialised to a fixed order so they can be regenerated and diffed, and
that is a property of the artifacts rather than a requirement on an
implementation.

**§12.1.3 moves.** It was sitting above §12.1 at the wrong heading
depth. Text unchanged.

### §12 — per-query

**§12.5 Q12** names the column behind each of its label lists:
`character_state.name`, `relationship_state.stage_label`,
`prop_state.whereabouts`. A consumer needing the rows themselves asks
§12.4 at either position — which is the point of a label list, and was
not previously stated anywhere.

**§12.8 Q13** states `provenance` as a closed vocabulary — `shot
override`, `anchor`, `bundle` — and gives each reference member a kind:
which are stored, which are closed, which are prose. `detail` is prose
and MUST NOT be parsed. It also states the **dedupe rule**: layers are
walked most specific first and an asset already carried is skipped, so
`provenance` names the strongest layer that reached an asset rather than
every layer that did. An asset both overridden at the shot and present
in the bundle appears once.

**§12.10 Q09** states what *related* means: **one hop** along
`motif.related_motif_id`, non-transitive. A closure was the other
available reading, and would grow with the project until the list
stopped being an aid to judgement.

**§12.11 Q10** points its polymorphic case at §12.1.2's new rule.

### §9.5 — the report's undefined terms

`clean` was listed among the report's required members and never
defined; a reader had to infer "no `error` findings", which is correct
and was nowhere written. It is now defined as exactly that, with the
part that is easy to get wrong said out loud: **`clean` does not mean
"no findings"**, and it never means the file was accepted.

`rowIds` and `count` were named in a sentence and left unexplained.
Both now have rules. `rowIds` MAY be empty, and an empty one is not an
absence of evidence. `count` is an occurrence count, not a row count,
and the two differ routinely. `title`, which every report carries, was
not mentioned at all.

**`rowIds` carries bare row ids, and §9.5 now says why that is correct
here and forbidden in §12.** A report names one file in `source` and
exists to send a person to a row in it; a result travels and describes a
story. The asymmetry looked like an inconsistency and is not one.

### Corrections

**§4.4.4 cited `project.scene_numbering`** in two MUSTs. The column was
renamed to `numbering_policy` in schema 2.11 and removed in 2.12, so
both requirements were keyed to something that does not exist. §4.3 had
been correct since 0.17; §4.4.4 was not updated with it.

`conformance.md` §2.2 carried the same stale name in a Writer
requirement, and cited **§4.2** for a rule that lives in **§4.3**.

`stability.md` carried two rows for one subject, one of them under the
removed name. Merged.

`conformance.md` §5.4 contradicted itself: a block quote stating all
sixteen queries have normative results, and a closing paragraph stating
eight do and the rest were "worth adding; not yet done". The count is
now stated once. The same section listed `shapes.json` beside the
`.result.json` files as though the two were the same kind of artifact.
They are not — `shapes.json` is an internal check over the app's runner
payloads, records a flat row with an unresolved `<row-ref>`, and
predates §12.1's result structure entirely. It is now scoped as
internal, with a third party told to ignore it.

---

## 0.28 — 2026-08-18

*Describes schema 2.12.*

**§12 is complete. All sixteen canonical queries are specified**, each
with a published normative result. Twenty-five artifacts.

**§12.15 Q01** — the dossier. Its `groups` are DERIVED, not listed: any
entity whose registry `subject` is this kind, at global scope, carrying
a reference back. Adding a new entity about characters puts it in every
character's dossier with no change to this section, which is what
`subject` and `scope` are for.

**§12.16 Q02** — and the one genuine exception to §12.1.3. Q02's media
layer *is* Q13's answer at a position, so it carries **Q13's result body
without its envelope**, with `fromQuery: "Q13"` naming where it came
from. An envelope inside an envelope would let an inner `resultFormat`
disagree with the outer one.

Nesting was withdrawn in 0.27 as a general rule because no query built
on another. Exactly one does, and this is it — so §12.1.3 now says so
rather than leaving the mechanism described but unused.

§12.16 also states that fields not applying to a subject's kind are
**null or empty, never omitted**. A consumer must be able to tell "not
applicable here" from "unauthored", and an absent key says neither.

**§12.17 Q04** — the scene package. It does **not** nest Q03 or Q07
despite covering some of the same ground: it assembles its own answer,
and the section says so rather than quietly implying a relationship the
implementation does not have.

Its `detail` list, like Q00's layers, is fixed by the section rather
than derived — what belongs in a scene package is an editorial choice,
not a fact the registry knows.

**The dossier composition moved to `scf-core`**, shared by Q01 and Q02,
for the reason Q03's and Q12's did: a normative result must not
re-derive what a renderer already derives. `dossierMarkdown` stayed in
the app, because that is rendering. Core composes, app renders, result
projects.

## 0.27 — 2026-08-18

*Describes schema 2.12.*

**§12.12 Q00, §12.13 Q11, §12.14 Q15.** Thirteen of sixteen specified,
twenty-two artifacts published.

**The nesting decision is withdrawn, and §12.1.3 says why.** It was
recorded on the premise that the six remaining queries were composites
that build on other queries' results. They are not: **no canonical query
calls another.** What look like composites assemble their own answers
from the same resolvers, and Q01 and Q02 share a helper rather than a
result. Nesting whole results would have invented a relationship the
implementation does not have.

Each query therefore defines its own result shape, and where two share a
composition the shared part is one function in one place. Nesting
remains available if a query is ever built by calling another.

**Q00 is the only query with an empty envelope**, which is worth having
tested: the envelope has to survive having nothing to put in it. Its
layer list is fixed by §12.12 rather than derived, because what belongs
in a brief is an editorial choice and not a fact the registry knows.

**§12.13 states that every part of an audience state may be absent**,
and that absence is null or empty and never invented. It also requires
that a file lacking one of these tables yields nothing for it rather
than failing — an older file predating an entity is not an error.

**§12.14 specifies the permissive matching** Q15 needs.
`affected_entities` is free-form and may hold a JSON array, an object,
or prose, so the accepted conventions are now written down:
`entity:id`, `entity#id`, a bare `entity`, and an object carrying an
entity kind with an optional id. `mentionsRow` moved from the app into
`scf-core` with it — Q15 is normative, so its matcher is too, and while
it lived in the app no independent implementation could know which
conventions counted.

§12.14 also requires the version-chain walk to terminate on a cycle
rather than follow it: a cycle is a finding, not a reason to hang.

## 0.26 — 2026-08-18

*Describes schema 2.12.*

Fixes 5, 6 and 7 of the second audit's list. All three were the same
failure as the four before them — **a normative fact that lived only in
code** — and all three are fixed the same way, which is now the third
time this move has been needed.

**§6.3's junction natural keys are published** as
`spec/junction-keys.json`. The section cited `junctionKeyFields()`, a
function, so an independent implementation could not compute a natural
key and therefore could not de-duplicate, merge or validate a junction
as §6.3 requires. Thirteen entities, with the derivation recorded in the
file.

**§5.4's finding now has a code.** It required unexplained
`scene_sequence` rows to be reported as a finding while §9.4's catalog —
closed — had no code for it, so the two sections could not both be
obeyed. `structure.shadow_row_unexplained` is added at `warning`, and
`collectFindings` detects them: the detection previously existed only
inside the editor's commit path as a count on a result object, which
means `scf-check`, the one tool a third party actually runs, never
mentioned them.

**§12.9.1 publishes Q14's rubric** as `spec/readiness-rubrics.json`,
with the requirement-to-severity mapping that turns it into findings.
§12.9 had defined the envelope and the severity scale and nothing about
what was assessed, so the second reader implemented an invented rubric
and correctly declined to claim anything for it.

**And an overclaim caught while publishing it.** The rubric's steps were
emitted under a field called `entity`, which asserts they resolve
against the registry. They do not: several are prose — `sound_cue /
music_cue`, `bundle + *_asset_binding`, `performance_state (vocal)` —
naming two entities, a pattern, or a filtered subset. The field is now
`label`, the file says which half is machine-readable, and §12.9.1 says
so too. Making the labels resolve is tracked as Unstable rather than
quietly implied to be done.

## 0.25 — 2026-08-18

*Describes schema 2.12.*

The first revision written in response to the **second** independent
implementation. It reproduced five of ten queries exactly, attempted a
conformance claim, and found that what was failing was no longer the
specification but its own artifacts.

**A blessed artifact named the wrong asset.** `Q13.result.json`'s anchor
reference carried the uuid of `eleanor_turnaround_v3.png`; the anchor
points at `eleanor_face_ref.png`, which appeared nowhere in the result.
The cause was a row id looked up in the wrong table — an `entity_anchor`
row's id resolved against `asset`. It produced a well-formed uuid, so
every portability test passed.

The fix is at the source rather than at the projection. §12.8 now states
that **an anchor contributes the asset it anchors, not itself**: an
`entity_anchor` names a place in an asset and carries no identifier of
its own, so reporting the anchor row would produce a reference that can
never resolve. The reference carries the asset's identity, with the
anchor's name in `anchorName`. `mediaReferences` no longer needs any
cross-table lookup, which removes the class of defect rather than this
instance of it.

§12.8 also states that **`trail` and `references` run in opposite
directions** — the trail broadest-first as an explanation, matching
§7.4, the references most-specific-first as an answer. The previous text
claimed both were most-specific-first, which was wrong about the trail.

**Reference maps MUST be derived from the registry.** §12.1.2 now says
so. Three results dropped a reference column §12.1.2 required, because
the implementation maintained a hand-written map per query — the exact
antipattern §2.3 warns against, inside the module implementing §12.1.2.
`scene.location_id` was projected in one result and silently dropped in
another; two reference columns on one motif row were treated
differently.

**`conformance.md` contradicted this specification** and has been
corrected. Its Reader requirements told an implementer to "treat a `cut`
row as present, pending §6.6" — §6.6.1 forbids exactly that, so the
document an implementer reads to learn what is required would have sent
a careful one to a wrong answer on every query. Its step 2 also still
named two specified queries when there are ten.

**`spec/scf-schema.sql` could not be executed as published.** It carried
`CREATE TABLE sqlite_sequence(name,seq)`, which SQLite rejects; the
emitter dumped `sqlite_master` without excluding SQLite's own tables. A
third party who did not know to strip it failed at the first negative
fixture. The emitter now excludes `sqlite_%`, and the published DDL
loads into an empty database unmodified.

## 0.24 — 2026-08-17

*Describes schema 2.12.*

**§12.10 Q09 and §12.11 Q10.** Ten of sixteen specified, seventeen
artifacts published.

**Q10 is the first query whose answer spans the whole story** rather
than a position, and it needed nothing new from the envelope — which is
the useful result. §12.11 states the rule that makes it worth having:
**the spine MUST include every scene, carriers or not.** A spine listing
only the scenes a theme reaches could not answer the question the query
exists for, which is where the theme is absent.

The spine is in story order and excludes cut scenes, and a carrier
reaching a cut scene reaches nowhere — so its scene list and the spine's
counts agree rather than disagreeing at one position.

**Q09 states its own heuristic.** `dense` is a flag, not a finding
(§9.1), and a result MUST publish the `densityThreshold` that produced
it so a consumer can see the number rather than infer it from a count. A
different implementation MAY choose a different threshold and MUST say
which. §12.10 also says a `candidate` is not an obligation: it is a
related motif absent from this scene, offered because a placement
decision is easier when you can see what is adjacent.

**A correction.** 0.23's notes claimed the specified queries were
"every query taking a position", and that the remaining eight enumerated
the project instead. That was wrong: Q02, Q04, Q09 and Q11 all take a
scene. The claim is removed from `conformance.md` and `stability.md`.
What the six remaining actually have in common is that they **compose
other queries** — a brief, a dossier, a scene package — so specifying
them means deciding whether a composite result nests the results it is
built from or restates them.

## 0.23 — 2026-08-17

*Describes schema 2.12.*

**Four more queries: §12.6 Q06, §12.7 Q08, §12.8 Q13, §12.9 Q14.** Eight
of sixteen are now specified, and fifteen artifacts are published.

**Q06 and Q08 cost almost nothing**, which was the point of taking them
next. Q06 is Q05 with a different modality and Q08 is Q07 with a fixed
leaf, so both became parameters of the existing builders rather than new
ones — one definition each, not two. §12.7 states that Q08 takes no
shot: sound is authored at the scene and there is no shot-level sound
entity to be a leaf, so `shot` is always null rather than an omission an
implementer discovers by finding nothing.

**Q13 dissolves the row-id defect.** The rendered form puts
`character #1` in its header and carries `AssetReference.id` through;
neither travels (§6.2). The result names its subject and every asset by
uuid.

§12.8 also states what `rootMapped` is for: it is a fact about the
SESSION, not the file. With no root mapping every reference is
`unaddressed` — not `out-of-root`, which is a property of an identifier
— so a result reporting zero resolved references and `rootMapped: false`
describes a healthy file nobody has pointed at a folder.

**Q14 needed a warning written into the specification, because I got it
wrong first.** `findings` includes `ok` entries: Q14 is a rubric, not a
problem list. The fixture's deliberately thin character produces FEWER
findings than the well-authored one, because fewer things are there to
be reported on at all. **Severity carries the answer**, and §12.9 says
so. It also restates that readiness severity is its own scale and must
not be conflated with §9.4's.

**§12.1.1 is refined.** It said every parameter is a uuid or null, which
was wrong as soon as a query took a literal: Q14's `target` is a query
id and Q13's `intent` is an enum value. It now says a parameter
identifying a ROW is its uuid, a literal appears as itself, and **a row
id MUST NOT appear** — so no parameter is a bare number, which is the
rule that actually matters and is what the portability test asserts.

## 0.22 — 2026-08-17

*Describes schema 2.12.*

**§12.4 Q03 and §12.5 Q12 are specified**, and blessed **away from scene
12**. Four of sixteen queries now have normative results.

The previous session found a live conformance bug — `sceneOrder`
deriving story order from `scene_number`, which §4.1 forbids — and the
uncomfortable part was that the whole suite passed before and after the
fix. Every blessed expectation targeted scene 12, where the forbidden
ordering and the required one agree.

So these two were blessed at positions where they do not:

- **Q03 at scene 19**, which sits before 16 in the script and after it by
  number.
- **Q12 diffing 19 → 16**, which is forward in the script and backward
  by number. §12.5 states the rule this pins: the two positions are
  ordered by §4.1, never by their scene numbers, because under `fixed`
  numbering a scene numbered 16 may play after one numbered 19 — and
  diffing them by number resolves every pattern-2 and pattern-3 state at
  the wrong position.

**Verified rather than assumed.** Reintroducing the old ordering makes
**four** tests fail, including a blessed expectation. Before this
session it made none.

§12.4 also states what a cut position answers: `scene` null and nothing
present, rather than an error (§9.2) — the query-layer face of §6.6.1.

**Q03 and Q12's composition moved into `scf-core`.** Q05 and Q07 could
wrap resolvers that already lived there; these two composed in the app's
runner, so a normative result would have had to re-derive "who is
present and what is true of them" a second time. The core now composes
rows, the runner renders them, and the result projects them — one
derivation, two consumers.

`ARTIFACTS.md` carries eleven artifacts.

## 0.21 — 2026-08-17

*Describes schema 2.12.*

**§6.6 is decided: a cut row is not in the film.** It was the oldest
open question in the document — `lifecycle_status` was authored on 88
entities and read by nothing, so "cut" was decorative and every consumer
would have answered the canonical queries differently.

New **§6.6.1**: a resolver MUST exclude cut rows, and the consequences
are stated rather than left to be inferred — a cut scene has no story
position, takes part in no span, and appears in no query result; a cut
state is in force nowhere; a cut row contributes no cascade layer.

A cut scene MAY keep its heading in the screenplay, because a cut scene
in a real script is struck through rather than deleted. An
implementation that rebuilt story order from headings alone would
resurrect it, and MUST NOT.

The section states the property that makes the rule testable: **adding a
cut row changes no answer.** The fixture now carries a cut scene *with a
heading*, and a cut performance beat inside the most heavily asserted
scene in the file.

New **§6.6.2**: excluding cut rows from resolution is not hiding them.
An implementation MAY read them back for a cut list or an audit view,
and SHOULD keep that path distinct from the resolvers. Identity survives
being cut — restoring a row restores the same row.

**§12.1.2** follows: a result MUST NOT contain a cut row.

**A live conformance bug, found by the rebuilt fixture.**
`resolution.sceneOrder` — the function every position-dependent answer
runs through — ordered scenes by `scene_number` and then by row id,
which §4.1 forbids in as many words, and its own doc comment said so.
Nothing caught it for as long as it existed because the fixture's three
orders coincided; the moment they differed it disagreed with the
specification on its first run. It now delegates to `scenePositions`,
and a test asserts the two agree.

That is the fixture rebuild paying for itself, and worth noting: the
entire suite passed both before and after the fix, because the blessed
expectations cluster on one scene.

## 0.20 — 2026-08-17

*Describes schema 2.12.*

**§12 exists.** The canonical queries were decided to be part of the
format and then defined nowhere; this is the first instalment.

**§12.1 defines what any query returns.** An envelope naming the query,
its own result-format version, the schema read, and the parameters —
each a uuid. Then §12.1.2, the rule that makes a result portable:

- row ids MUST NOT appear;
- `id`, `created_at`, `updated_at` are omitted;
- null and empty fields are omitted, so absence is unambiguous;
- reference columns are resolved to uuids — `scene_id` becomes
  `scene_uuid`;
- field names are the registry's own.

And the sentence the section turns on: **the normative answer is the
result structure. Any rendering of it is a convenience and is not
normative.** Two implementations that agree on the result and print it
differently are both conforming.

**§12.2 Q05** — baseline, states in force by pattern 2, merged
modulations, beats. A null baseline is stated as a well-defined absence
rather than an error.

**§12.3 Q07** — the cascade, with §12.3.1 stating that the leaf depends
on the PARAMETERS: `scene_color_palette` for a scene,
`shot_design` when a shot is named. That is what §7.1 means by the leaf
not being derivable from the data, said in the place an implementer will
look for it.

Q05 and Q07 were chosen because they stress different machinery. One
envelope and one projection rule served both, which is the evidence that
the shape is worth extending to the other fourteen.

`fixtures/expectations/Q05.result.json` and `Q07.result.json` are
blessed and published in `ARTIFACTS.md` — nine artifacts now.

**Still unspecified: fourteen queries**, and whether a result excludes
`cut` rows, which waits on §6.6.

---

## 0.19 — 2026-08-17

*Describes schema 2.12.*

**New §11.0: these rules take effect at 1.0.** §11.1 read as binding
today while §11.4 carried a note saying pre-1.0 removals were
permissible — the document contradicted how the format is actually being
built. It now says plainly that before 1.0 files written by earlier
schema versions are disposable, with `fixtures/hollow_creek.scf` the one
exception because it is a normative artifact.

The clause also says *why*, since "we may break things" reads worse than
it is: before 1.0 nobody has built on the format, so a deprecation
window protects nothing and leaves the format carrying two descriptions
of one fact. After 1.0 someone has.

**§4.3.1 is deleted, and schema 2.12 removes
`project.scene_numbering`.** The rename to `numbering_policy` shipped in
2.11 through §11.4's window: both columns present, writers mirroring into
the old one, removal scheduled. Under §11.0 that window protected only
pre-2.11 files, which are disposable — so it bought nothing and cost the
one place the format deliberately stored a fact twice. The window is
gone along with the column and the mirroring.

The deprecation machinery stays specified in §11.4. It becomes live at
1.0, when it earns its cost.

**§8.3's resolution states are corrected, and the implementation with
them.** The spec and the code had disagreed since the states were
written, and the audit flagged it as a wire-value conflict blocking any
external consumer.

The code reported an **unmapped root** as `out-of-root`. It is
`unaddressed` — §8.3 and §0.3 both said so, and §0.3 states outright
that a `.scf` opened with no root mapping is valid and resolves
everything to `unaddressed`.

`out-of-root` now means only what its name says: the identifier points
outside the project **by construction** — absolute, or containing `..`.
It is a property of the identifier and does not depend on the session.
`unaddressed` is a property of the session and says nothing about the
identifier. §8.3 gains a table of what each state means and what a user
does about it, because reporting an unmapped root as out-of-root told
people their paths were wrong when the truth was that no folder was
attached — and made every asset in a lone `.scf` look broken.

The two ways to be `unaddressed` — no identifier at all, or no mapping
for its root — are distinguished by findings rather than by state:
`asset.identifier_absent` covers the first.

The blessed Q13 moves with it, and one of its summary lines was wrong in
a way worth naming: it read `3 with no identifier` for three assets of
which two had identifiers. It now reads `3 unresolvable`.

**§0.2 now lists the query layer as §12**, and states that §12 is not
yet written: the queries are part of the format, the normative answer is
the result structure rather than any rendering, and until the section
exists the only definition of a canonical query is one blessed example
of its output. That is named as the largest known gap in the document.

---

## 0.18 — 2026-08-17

*Describes schema 2.11.*

**§4.3's field is renamed: `scene_numbering` → `numbering_policy`.** It
governs act, sequence and scene numbers and shot codes, and was named
after one of the four.

New **§4.3.1** states the deprecation window. A reader MUST prefer
`numbering_policy` and MUST fall back to `scene_numbering`; a writer MUST
mirror into the old column while it exists. The mirroring is an explicit,
time-boxed exception to §3.1, and the section says why: a reader knowing
only the old column would otherwise see a stale `derived` on a locked
project and renumber a shot list already on paper.

The rename is **additive** — schema 2.11 adds the new column, 2.12
removes the old — so no file needs converting. An earlier note in this
document called the rename non-additive and "before 1.0 or never"; that
was wrong, and §11.4's window is exactly the mechanism for it.

Appendix A gains a row for §4.3.

---

## 0.17 — 2026-08-17

*Describes schema 2.10.*

The first revision written in response to an **independent
implementation**. A Python reader built from `spec/` alone reproduced all
eight blessed query expectations and reported 33 gaps. This closes the
three most serious.

**§7 is rewritten. The previous text was wrong.** It described the
cascade as `project → sequence → scene → shot`; those are positional
scopes, and the cascade is not ordered by them. The reader's proof:
`look_development` is `scope: global` and appears fifth in Q07's chain.

§7 now states what the cascade actually is:

- **§7.1** A cascade is identified by its **leaf entity**, supplied by
  the caller — it is not derivable from the data or the registry, and
  any interface offering direction resolution must take it as an input.
- **§7.2** The chain is the `refines` closure, walked depth-first
  post-order, parents in declared order. `refines` had never been
  mentioned in this specification despite being the mechanism.
- **§7.3** One row per entity, with the selection rules stated —
  including that a scene-level match excludes rows carrying a `shot_id`,
  so a shot-level row never also arrives as a scene layer.
- **§7.4** "Every contributing layer" means every entity in the chain
  that supplied a row, not every row in the file that might have
  applied.

**§9.4's catalog is published.** `spec/finding-catalog.json`, generated
from the implementation, with all 35 codes, their severities, the
severity meanings, and the report ordering. §9.4 made the catalog
normative and it existed only in TypeScript, so no independent
implementation could satisfy it — the reader invented 21 codes of its
own and correctly described its clean exit code as "semantically empty".

**§1.3 no longer flags SQLite's own tables.** Names beginning `sqlite_`
are excluded from the known-table test. `sqlite_sequence` exists in every
conforming file, because the framework columns declare `AUTOINCREMENT`,
so the rule as written put a finding on every SCF in existence.

**§2.3 and §0.7 now document the registry fields that carry meaning.**
`refines` is load-bearing and defines the cascade; `scope` and `subject`
are described, and `scope` is explicitly *not* what orders the cascade.

`conformance.md`: both previously unperformable Reader claim steps are
now performable — step 1 against the published catalog, step 3 against
`fixtures/negative/CASES.json`, which publishes each negative case's
statements so a third party can build the databases rather than guess
the reports.

**§4.3 now covers all four numbers.** It governed scene numbers and shot
codes; `act.act_number` and `sequence.sequence_number` were unmentioned,
so an implementation could renumber acts on a locked project and remain
conforming. All four are authored, none is derived from position, and
`project.scene_numbering` governs all four.

The section also now says what the two modes are *for*: `derived` while
a writer is still moving the story, `fixed` once the numbers have left
the building on schedules and call sheets and become identifiers. A
scene numbered 12 that plays after scene 45 is correct under `fixed`,
and §4.1's warning is the same fact seen from the reader's side.

**The fixture is now a screenplay, not only an outline.** It carried
eleven sluglines, eight section headers and no body text at all, which
left §3.4 with no artifact behind it — there was no scene text to walk.
Four scenes now carry action and dialogue and the rest stay sluglines,
because an SCF is legitimately either and a reader meets both in one
file.

**The fixture's three orders now differ**, which is the more consequential
half. Scene `12A` sits mid-script with the highest row id; scene `16`
follows `19` in the script and keeps its number, legal precisely because
the project is `fixed`. Until now screenplay order, scene-number order
and row-id order coincided, so a reader ordering by `scene_number` alone
— the one thing §4.1 forbids — passed every blessed expectation. Three
new invariant tests pin the difference.

**The fixture's `scene_number` column was rebuilt as TEXT.** The registry
and `scf-schema.sql` had declared it text since schema 2.9; the fixture's
column was still INTEGER, so `ARTIFACTS.md`'s claim that the published
DDL cannot drift was false, and §4.2's grammar was unexercised by the
artifact meant to demonstrate it.

The rebuild immediately caught two consequences, both of which are §4.2
behaving as designed: a test helper binding scene numbers as JS numbers
matched nothing, because the driver binds numbers as doubles and `12`
arrived as `"12.0"`; and a fixture-invariant test ordering by the raw
column got `1, 10, 11, 12, 16, 19, 21, 24, 3, 7` — the lexicographic
failure §4.2.2 exists to prevent. Both are fixed, and the invariant test
now orders by §4.2.2 and pins the column's storage class.

`conformance.md` §5.4 records a decision not yet implemented: the
canonical queries are part of the format, and **the normative answer is
the structure, not the prose**.

---

## 0.16 — 2026-08-16

*Describes schema 2.10.*

**§11.6 is new: document equality.** `conformance.md` §3 had named this
as an open question — the Writer role rests on "open, save, lose
nothing" and nothing said what the comparison is performed on. It is a
canonical dump, never bytes: SQLite reorders pages and reuses freelist
space without any row changing, so byte-different files routinely say
the same thing.

The dump includes tables this specification does not define, which is
the point rather than an oversight: one that skipped unknown content
could not detect the loss §10.1 forbids.

A conforming Writer MUST produce an equal document when it opens a file
and writes it back unedited.

**Appendix A is complete**, with two entries marked *unpinned on
purpose*: §11.1 and §11.4 are policies about how the format may change,
not properties of a file, and no test can check that a future change
will be additive.

---

## 0.15 — 2026-08-16

*Describes schema 2.10.*

**§1.3's known table set is now two lists.** It defined the file's tables
as the registry plus `UUID_EXTRA_TABLES`, which conflated "is this table
SCF's" with "does this table carry row identity". The registry declares
`ownedTables` alongside `uuidExtraTables` as of schema 2.10, and a
reader MUST test unknown content (§10.1) against the union rather than
assembling its own list.

`screenplay_title_page` and `screenplay_version_title_page` are the
first members: a title page is a property of the screenplay rather than
a row in its own right, so they carry no uuids.

**§9.5 is new: the serialised report.** Required fields, both schema
versions, per-finding spec references, and — the load-bearing
requirement — byte-identical output across two runs over an unchanged
file, with volatile fields omitted by default. A report that differs on
every run cannot serve as a baseline.

§9.5 also requires a tool to distinguish a file it could not open from a
file it read and found errors in. Unreadable is not a finding.

The old §9.5 (reports accompany exports) is renumbered §9.6.

Appendix A gains rows for the negative fixtures and the report format.

---

## 0.14 — 2026-08-16

*Describes schema 2.9.*

**§9.4 is new: findings are enumerated.** This was the largest normative
gap left in the document. Findings were produced by six modules with no
shared codes, no severity scale and no serialised form, which made a
validator unspecifiable — `conformance.md` §4 has said so since it was
written.

- Codes are `area.condition`, lowercase and dotted, drawn from a closed
  catalog. Adding one is a change to this specification.
- Severity comes from the catalog, not from the point the finding is
  raised, so two producers cannot disagree about how bad the same
  condition is.
- The scale is `error` / `warning` / `info`, and it describes the DATA.
  `error` means two conforming readers would disagree about what the
  file says. It is explicitly not a reason to refuse the file.
- Reports MUST be deterministic over an unchanged file, ordered by
  severity, code, table, then lowest row id. A report that reorders
  itself cannot be diffed.
- The vocabulary is scoped to well-formedness and MUST NOT be conflated
  with readiness, which answers a different question.

The old §9.4 (reports accompany exports) is renumbered §9.5.

Appendix A gains a row for §9.4.

---

## 0.13 — 2026-08-16

*Describes schema 2.9.*

**§10.1 gains a MUST that was previously only implied**, and the whole
of §10 stops being an untested promise.

- §10.3 now states explicitly that a writer MUST preserve `x_` content
  across a write cycle on the same terms as any other unrecognised
  content, and notes that the distinction is intent rather than
  protection: unknown content is preserved because it is unknown,
  whether or not its author followed the convention.
- §10.3 also records that the reference implementation's linter rejects
  any registry name claiming the prefix.
- §1.3 points at `scf-schema.sql`, the published physical DDL.
- §2.1 points at `registry.schema.json` and `ARTIFACTS.md`.

`spec/ARTIFACTS.md` is new: an addressing scheme (`schema-X.Y` tag plus
raw URL) and SHA-256 for every published artifact. It states that `main`
MUST NOT be used to pin a version.

Appendix A gains rows for §2.1, §10.1 and §10.2–10.3. §10.1's
preservation requirement had never been verified; it now is, including
across five repeated write cycles.

---

## 0.12 — 2026-08-15

*Describes schema 2.9.*

**§1.2 file identification is now concrete, and implemented.** It had
said a writer MUST set `application_id` to "the registered SCF value"
without saying what that was — a requirement nobody could satisfy.

- `application_id` = `0x53434631` (`1396917809`), `SCF1` as big-endian
  ASCII. Checked against SQLite's `magic.txt` registry: no collision
  with any of its eleven entries.
- `user_version` = `major * 1000 + minor`; schema 2.9 → `2009`.
- The trailing `1` is the container generation, not the schema version.
  GeoPackage set the precedent by registering both `GPKG` and `GP10`.
- Reader tolerance restated as a MUST NOT: no file may be rejected for
  lacking the stamps.
- Header/`_scf_meta` disagreement is a finding, with `_scf_meta` as the
  authority.
- The `magic(5)` stanza ships as `spec/scf.magic`.
- The media type is `application/vnd.minimalhumans.scf` — vendor tree,
  so no registration is required.

Note that **no schema version was bumped for this**. The header stamps
are physical format, not the entity/field set, which is what the two
tracks in §0.6 exist to keep apart.

Appendix A gains a row for §1.2.

---

## 0.11 — 2026-08-15

*Describes schema 2.9.*

**No requirement changed.** 0.11 records that the implementation caught
up with 0.10 and that the registry now agrees with §4.2.1.

§4.2.3's registry note is rewritten: schema 2.9 declares `scene_number`
as text, so the declared type and the grammar no longer differ. Files
written before 2.9 need no conversion — affinity is a hint, and §4.2.3
already defined the behaviour for any value.

Appendix A gains real entries for §4.2 and §4.4, which were marked
unpinned in 0.10. `sceneNumbers.test.ts` pins the grammar, the ordering,
and — the case worth naming — that the TypeScript comparison and its SQL
twin order the same list identically.

The §11.4 note now records both pre-1.0 non-additive changes rather than
just 2.8's.

---

## 0.10 — 2026-08-15

*Describes schema 2.8.*

**Added: §4.2 scene-number grammar.** `scene_number` had been specified
only as "a label, MAY have gaps, MAY be non-numeric", which is not
enough to implement against. It now carries an ABNF canonical form
(optional bijective base-26 prefix, digits, optional suffix), a total
ordering rule for the §4.1 fallback case, and an explicit statement that
a value which does not parse is opaque rather than invalid.

Ordering yields `A12 < B12 < 12 < 12A < 12B`.

**Added: §4.4 shot codes.** Previously the format defined shot codes
only in code. The section states the canonical form, the zero-based
bijective base-26 letter run, allocation (continue past the highest, do
not backfill), and restamping under `project.scene_numbering`.

**Added: §4.4.2, a new MUST — shot codes are parsed relative to their
scene.** A shot code is read by removing its scene's `scene_number` from
the front, never by taking the trailing letter run in isolation. The two
readings diverge as soon as a scene number ends in a letter, which
§4.2.1 now permits: shot `12AB` in scene `12A` is ordinal 1 under the
correct reading and ordinal 27 under the incorrect one.

This is the change that makes 0.10 a minor rather than a patch.

**Renumbered.** §4.3 (position patterns) is now §4.5; the numbering
policy paragraph that had been folded into §4.2 is now §4.3 in its own
right.

**Editorial.** Scope list in §0.2 names the two new grammars. Appendix A
gains rows for §4.2 and §4.4, both marked with what is and is not pinned.

---

## 0.9 — 2026-08-15

*Describes schema 2.8.*

Initial draft. Extracted from `docs/conventions.md`, which becomes the
design record and states no rules from this version onward.

Sections: §0 scope (including the unit of interchange, what is outside
1.0, the three version tracks, and a glossary), §1 physical format, §2
the entity model, §3 derived versus stored, §4 position and ordering,
§5 structure, §6 identity, §7 the direction cascade, §8 assets and
addressing, §9 findings, §10 extensibility, §11 versioning. Appendix A
maps sections to the tests that pin them.

Newly written rather than extracted: §1, §2, §9, §10, §11. These were
facts about the reference implementation with no document behind them.

Known normative gaps at first draft, tracked in
[stability.md](stability.md): §6.6 (whether resolvers exclude `cut`
rows), the finding vocabulary, and §1.2 file identification.
