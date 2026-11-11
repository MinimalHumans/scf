<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# 0041 — Silent presence, and relationships in the dossier

| | |
|---|---|
| **Status** | **implemented** — spec Unreleased (the candidate after 1.0-rc.7), `resultFormat` 1.1; schema 2.25 unchanged. See Resolution |
| **Author** | Found in the alexisNexus parsing pass (2026-11-04); drafted with Claude |
| **Opened** | 2026-11-09 |
| **Affects** | §2.4.1, §12.15, §12.16, §6.5 (pointer only); `stability.md` (§12.15 row); seven published results (`Q01`, the six `Q02-*`); `query-reference.md`, `SHA256SUMS`, `CHANGELOG.md`. Code: `scf-core` (integrity gate, dossier, markdown), `scf-host` (dry-run payload), `scf-mcp` (plan risks, polymorphic translation), `scf-app` (dossier view) |

This proposal answers three items from the parsing-pass report: **F3**,
together with its tooling halves E1, M2 and M3; **F2**; and **M1**. It
deliberately does **not** answer **F1**, for reasons given under
Alternatives.

> **Related, 2026-11-10.** C1 below has landed (commit `201075f`:
> `scf-mcp/src/writeTools.ts`, with a test in
> `scf-mcp/test/writeTools.test.ts`), after the same defect broke an
> `asset_relationship.entity_id` link on another film. F1 is now drafted
> on its own as [0040](0040-a-reference-to-nothing.md).

## The problem

### 1. A character who is in a scene and does not speak cannot be linked to it by an agent

The parsing pass tried to write 94 `scene_character` links for characters who act in a scene without speaking. Mags is in 29 scenes, E in 19, and Alexis, Six, Gutenberg and others are in several more. Most of them are named in the action lines. **The MCP refused every one of them.** The plan came back as `blocked: true`, saying "linked to scene N but has no cue there".

The format already says these links are legitimate:

- **§2.4.1** defines presence as `seen`, `heard` or `named`, and says that a `named` character "is still at the position: they are in its cast".
- **`role_in_scene`** declares `background`, `mentioned` and `voiceover`, each with an `optionPresence`. A link with no value is `seen`. Nothing ties any of these to speech.
- **§9.1** says a row is reported, never rejected on write.
- **§0.4** puts editor behaviour and import heuristics out of scope.
- **The finding catalog** has no code for a link without a cue.

The refusal does not come from the format. It comes from
`scanIntegrity`'s unjustified-link check (R96). That check is an editor
review aid, and **`ops/integrityGate.ts` promoted it to a hard block on
agent writes.**

The gate does not run the §9.4 validator. It diffs four kinds of
finding of its own:

- `detached_tag`, `orphan_beat` and `orphan_anchor` are all the catalog's `line.anchor_orphaned` (§3.5). They are real dangling references.
- `unjustified_link` is not a catalog code at all. It is a judgement about whether the cast agrees with the dialogue.

So the tools contradict the format, and they contradict each other:
`character_presence` describes a silent link as "often right, a question
rather than an error", while the write side refuses it (report item M3).

### 2. The dossier never says who a character's relationships are with

Q01's `groups` (§12.15) collects the global entities about a subject.
It does that through the column named `<subject>_id`.
`character_relationship` passes the subject test and the scope test,
and fails only that column-name test, because its endpoints are
`character_a_id` and `character_b_id`.

§12.15 justifies the column test with "only one of them says *this row
is about that subject*". That is false for this table, where both
endpoints are about the subject. It also cuts against **§6.5**, which
already says consumers MUST read relationships from both columns.

**The gap carries through to Q02.** `relationshipStates` carries each
state with only a `character_relationship_uuid`. So neither Q01 nor Q02
says who the other party is, what kind of relationship it is, or which
way it reads. Q02 calls itself "everything needed to realise a subject
in a scene".

On the fixture, Eleanor's published dossier omits all three of her
relationships: with Marcus, with Ada and with Shaw.

### 3. A polymorphic reference written through the MCP is stored as a raw uuid

`create_row` and `update_row` translate each `referenceEntity` column
from a uuid to a row id, and they refuse a uuid that does not resolve
(`scf-mcp/src/writeTools.ts`, around line 161). They skip polymorphic
columns.

In the pass, all 17 `thematic_connection.entity_id` values were stored
as uuid strings in an INTEGER column, and none of them ever resolved
(report item M1). The 17 rows were corrected by hand during the pass.
The next agent pass would break them the same way.

## The proposal

### A. Silent presence

**A1. Spec: one paragraph appended to §2.4.1.**

> **A presence link is authored, not derived from the screenplay.** A
> `scene_character` or `scene_prop` row is valid whether or not the
> subject has a cue line, or any line, in the scene, and a writer MUST
> NOT refuse it on that ground. A link and the script may disagree; that
> is a question an authoring tool MAY put to its user, never a finding
> (§9.4), and never a reason to refuse a write.

**A2. scf-core: `unjustified_link` stops blocking.**

`currentFindings` in `ops/integrityGate.ts` keeps the three line-anchor
kinds as blocking findings. It returns unjustified links in a separate,
non-blocking list. `GateFinding.kind` loses `"unjustified_link"`, and the
file's header comment changes "must not ADD a finding" to "must not add
a *blocking* finding". Nothing else in the gate changes.

**A3. scf-host and scf-mcp: the question becomes a plan risk.**

- The dry-run result gains a `noted` list beside `added`.
- `makePlan` adds each noted item to `risks`, for example "Mags has no cue in scene 12", and does **not** set `blocked`.
- The agent and the person reviewing the plan still see the question at plan time. This keeps the original purpose of the check, which was guarding against an agent inventing cast, without refusing a correct write.

**A4. The editor is unchanged in this proposal.** Its integrity panel
keeps showing unjustified links as questions, as R96 intended. See
Unresolved for what that will look like on alexisNexus.

### B. `relationships` on Q01

**B1. Spec, §12.15: one row added to the field table**, after
`thematicConnections`.

| Field | |
|---|---|
| `relationships` | For a character subject: each `character_relationship` naming them in either `character_a_id` or `character_b_id`, as `{relationship, other, side}`. `relationship` is the row, projected. `other` is the character at the other end, projected, or null where that character is absent. `side` is `"a"` or `"b"`, the column the subject occupies. In the row order of the `character_relationship` rows. For any other subject kind, `[]`. |

**B2. Spec, §12.15: two paragraphs added after "`groups` is derived, not listed".**

> **Relationships are carried beside the groups, not in them.**
> `character_relationship` is about both of its characters equally, so
> no single column says *this row is about that subject*, and §6.5
> requires a consumer to read both. It is carried as its own member,
> as `motifCarriage` and `thematicConnections` are, with the other party
> resolved and the subject's side named, because `a_to_b` reads A → B
> and a consumer cannot interpret directionality without knowing which
> end it is on.
>
> A relationship whose other character is **cut** is absent: a
> relationship to someone not in the film joins nothing (§6.6.1). One
> whose other character is **absent from the file** is kept, with
> `other` null (§9.2), and is reported as `relationship.endpoint_absent`
> as before. A relationship naming the subject twice appears once, as
> side `"a"`, with `other` the subject.
>
> **References from other subjects are not dossier content.** A prop's
> `associated_character_id`, a story beat's `pov_character_id`, and
> links such as `scene_character` point *at* the subject without being
> *about* it. Q15 and a where-used walk find them.

**B3. Spec, §12.16: one paragraph added after the existing `arcStates` paragraph.**

> `relationshipStates` likewise carries the stage in force on each
> relationship, and **not the relationships themselves**, which are
> standing facts and are in `dossier.relationships`. Each state's
> `character_relationship_uuid` is the `uuid` of one of those entries.

**B4. Spec, §6.5: one sentence added after "Consumers MUST read relationships from both character columns".**

> Q01's `relationships` (§12.15) is the worked example.

**B5. Q02 has no other change.** It carries Q01's body, so it gains
`dossier.relationships` without a new member.

**B6. Implementation.**

- **`scf-core/src/canonicalQueries.ts`:**
  - `composeDossier` reads `character_relationship` by either column, through `rows()` so that §6.6.1's exclusion applies.
  - It resolves the other character through `rows()` too, so a cut one is dropped. An unmatched id stays as `other: null`.
  - `DossierComposition`, `Q01Result` and the Q01 projection gain the member.
- **`scf-core/src/queryMarkdown.ts`:** a "Relationships" section beside "Motif carriage" and "Thematic connections", one line per entry giving the other party, the relationship type and the directionality read from the subject's side.
- **`scf-app/src/ui/queries/composedViews.tsx`:** a Relationships block in the dossier view.

**B7. Artifacts.** Re-bless the seven published results that contain a
dossier:

- `Q01.result.json` (Eleanor) gains three entries, all side `"a"`.
- `Q02.result.json` (Eleanor) gains the same three.
- `Q02-marcus-scene25` gains two: with Eleanor as side `"b"`, with Ada as side `"a"`.
- `Q02-church-scene16`, `Q02-kitchen-scene10`, `Q02-ridge-scene21` and `Q02-locket-scene25` gain `relationships: []`.

Then regenerate `query-reference.md` and, **after** the prose edits,
`SHA256SUMS`. `selectors.json` does not change. Check `api-surface.json`
in case `Q01Result` is in the surface.

### C. Polymorphic references through the MCP (report item M1)

**C1. scf-mcp: translate polymorphic columns.** In `writeTools.ts`,
extend the existing reference translation to columns that declare
`polymorphicType`:

- Read the sibling's value from the same write. Where the row already exists and the write does not set the sibling, read it from the row.
- Resolve the target table with `polymorphicTarget()`, which honours `polymorphicTargets`.
- Translate the uuid to a row id there, and **refuse a value that does not resolve**, exactly as ordinary references are refused today.
- Refuse a polymorphic id that has no sibling value, since the target table cannot be known.

This is a tool fix and changes no rule. §12.1.2 already says how a
polymorphic reference resolves.

## What it breaks

- **Agent safety.** An agent can now link someone who is not in a
  scene, and the write goes through. The plan risk (A3) is the only
  remaining guard. That is a deliberate trade: the format says the link
  is legitimate, and refusing correct writes is the worse failure.
- **Gate tests.** `scf-core/test/opTable.test.ts` and
  `scf-host/test/agent.test.ts` use `unjustified_link` as their example
  of a blocked write. They need a different example, and an orphaned
  line anchor is the obvious one. New tests assert that a silent link is
  applied and reported in `risks`. `integrity.test.ts` and
  `characterPresence.test.ts` are unaffected.
- **Q01 and Q02 consumers.** An added member breaks a consumer that
  rejects unknown members. Any consumer of the seven re-blessed
  artifacts sees new bytes.
- **`docs/scf-write-ownership.md`** describes the gate as running
  `scanIntegrity` and rolling back on any new finding (around lines 155
  and 258). That becomes "any new blocking finding".
- **`docs/editor-mvp.md` §7c** (the R96 record) should say the
  unjustified-link check is advisory to agents.
- **MCP tool descriptions.** `subject_dossier`'s description should
  mention relationships if it lists the dossier's contents.
  `character_presence`'s wording ("often right, a question") already
  matches and stays.
- **No `.scf` file is broken.** No schema change, no registry change, no
  fixture row change.

## Alternatives

**Rewire the gate to diff §9.4 findings instead of `scanIntegrity`
kinds.** This is the cleaner foundation. It would end the two
vocabularies, give the gate real severities, and drop
`unjustified_link` on its own because no catalog code exists for it.
It is not proposed here because it changes the gate wholesale, and
needs a severity threshold and a check on the cost of a full report per
dry run. Neither goal of this proposal depends on it. **Recommended as a
later proposal**, together with F1.

**Add `reference.dangling` to the catalog now (report item F1).** No
§9.4 code exists for a reference column that names no row. That holds
for ordinary references as well as polymorphic ones; only span starts,
relationship endpoints and line anchors are covered today. It is
deferred because:

- on its own it would not have stopped M1, since the gate does not read the catalog;
- C1 closes the one path that actually produced dangling references in practice;
- adding it properly needs §12.1.2's "not a finding" sentence rewritten, negative fixtures, and a decision on how it relates to the specific endpoint codes.

What deferring costs: the editor and third-party writers can still leave
dangling references unreported, which is the situation today. **This
should go into `stability.md` or the release checklist as a known gap
when this proposal lands.**

**Add an `info` catalog code for a link without a cue.** Declined. It
would make "silent presence is worth reporting" a format claim, when the
alexisNexus evidence shows silent presence is the normal case.

**Include `character_relationship` in `groups` by declaration**, with a
registry flag marking which reference columns make a row about its
target. This is more general, and closer to §12.1.2's lesson about
reading declarations rather than names. It is declined for now: a row in
a generic group cannot say which side the subject is on or who the other
party is, so every consumer would need a second lookup. It also needs a
registry change and a schema bump.

**Document the exclusion only.** This changes no artifact, but it leaves
Q02 unable to say who a relationship is with. Declined.

**Do nothing.** The 94 links stay out of the film, and the dossier keeps
omitting what §6.5 says every consumer must read.

## Unresolved

1. **Noise in the editor after the 94 links land.** The alexisNexus
   integrity panel will then show roughly 95 "linked but no cue"
   questions. Two follow-ups, neither in this proposal:
   - Exempt `named` and `heard` presence, read through `optionPresence`. This only helps where `role_in_scene` is `mentioned` or `voiceover`; what roles `ops_D.json` uses has not been checked.
   - Settle R96's open decision so that a whole-word name match in the scene's action lines counts as justification. The report says most of the 94 are named in action lines, so this would clear most of them. It needs `cueMatchesEntity` moved from scf-app into scf-core.
2. **Fixture coverage for B2's edge cases.** Hollow Creek's four
   relationships exercise both sides and both directionalities. None of
   them has a cut, absent or repeated other party, so the cut, absent and
   self-pair rules would be stated but checked by nothing. That is the
   invisible-rule class R92 closed for §4.1. Adding a relationship to the
   cut deputy would exercise the cut rule. Decide whether that belongs in
   this change or a later fixture pass.
3. **`actor_character_role` (who plays the character)** is also absent
   from the dossier. It is `subject: link`, and the fixture has no rows,
   so nothing shows the gap. Out of scope here; worth deciding before
   1.0.
4. **The order of the plan risk text.** `risks` is currently sorted
   alphabetically. Check that the noted items stay legible when there
   are many of them, for example by grouping them under one line per
   scene.

## Implementation order

1. **A1–A3 and C1**, with the gate test swaps. No artifacts move. Can land on its own.
2. **Re-run `ops_D.json`** serially. Report item M4 still applies, so expect about 190 calls; watch for item M8's dropped film.
3. **B1–B7** as one reviewed round: spec text, then core and renderers, then re-bless the seven artifacts, then regenerate `query-reference.md` and `SHA256SUMS`, then CHANGELOG under Unreleased and the `stability.md` row.
4. **Record F1 and the gate rewiring** as known open items.

---

## Resolution

**Accepted and implemented, 2026-11-10**, in the Unreleased section
of `spec/CHANGELOG.md` (the candidate after 1.0-rc.7). No registry
change, no schema change, no fixture row change.

- **A, silent presence.** §2.4.1 has the paragraph (A1). The gate
  returns unjustified links as `noted`, beside `added`, and no longer
  blocks on them (A2). The host's dry run carries `noted`, and the MCP
  plan lists it under `risks` without setting `blocked` (A3). The editor
  is unchanged (A4).
- **B, relationships.** Q01 has `relationships` (§12.15), §12.16 and
  §6.5 have their sentences, and the dossier's markdown and the
  editor's dossier view show them. The seven published results came out
  as B7 predicted: three entries for Eleanor on side `"a"`, two for
  Marcus with one on each side, and `[]` for the four non-character
  cases. `api-surface.json` was regenerated; `query-reference.md` and
  `selectors.json` did not change.
- **C, polymorphic references through the MCP.** Landed earlier, in
  commit `201075f`.

**`resultFormat` is `1.1`.** The draft did not ask for a bump. 0039
added members to Q13's references in the same change, and one bump
covers both.

**The gate tests' example changed twice over.** With
[0040](0040-a-reference-to-nothing.md) implemented alongside, the
refused write in `opTable.test.ts`, `agent.test.ts` and
`writeTools.test.ts` is a reference to a row that does not exist, not
an orphaned line anchor. Each also asserts that a silent link is
applied and reported as a note.

**F1 is no longer deferred.** It is 0040, implemented in the same
change, so the "known gap" this proposal asked to be recorded is
closed except for a polymorphic sibling that names no entity
(`stability.md`). Rewiring the gate onto §9.4 is still a later
proposal.

**Not done here.** Re-running `ops_D.json` on alexisNexus
(implementation step 2) is work on that film, not on this repository.

The open questions, as settled or left:

1. **Editor noise** after the 94 links land: not addressed. Both
   follow-ups stand.
2. **Fixture coverage for B2's edge cases**: the fixture is unchanged.
   The cut, absent and self-pair rules are pinned by
   `scf-core/test/dossierRelationships.test.ts` on a copy of the
   fixture, and by no published result.
3. **`actor_character_role`** is still absent from the dossier. Open.
4. **The plan risk text** is one line however many links are noted, so
   it cannot bury the other risks.
