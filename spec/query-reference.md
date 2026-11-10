<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# Query reference

**16 canonical queries.** Spec §12.

**Generated. Not normative, and not hand-edited.** §12 states the
rules and each query's result shape; this is an index over it. Every
fact below is read from the specification, from the published
`.result.json` artifacts, or from `queryPaths.ts`.

The order is §12's, which builds from a single position outward to
the whole story. It is not the numeric order of the ids.

## At a glance

| § | Query | Answers | Takes |
|---|---|---|---|
| 12.2 | **Q05** Voice direction | How this character's lines should sound in this scene. | `character`, `scene` |
| 12.3 | **Q07** Look resolution | What a frame in this scene, or this shot, should look like. | `scene`, `shot` |
| 12.4 | **Q03** World state | Everything true at one position. | `scene` |
| 12.5 | **Q12** Continuity | What changed between two positions. | `from`, `to` |
| 12.6 | **Q06** Physical direction | How this character moves and behaves in this scene. | `character`, `scene` |
| 12.7 | **Q08** Soundscape | What this scene sounds like. | `scene` |
| 12.8 | **Q13** Media resolution | Which assets are in force for a subject and an intent. | `subjectType`, `subject`, `intent`, `scene`, `shot` |
| 12.9 | **Q14** Readiness | What is missing for another query to answer well. | `target`, `character`, `scene` |
| 12.10 | **Q09** Motif manifest | Which motifs should be perceivable in this scene, and how. | `scene` |
| 12.11 | **Q10** Thematic accounting | Where a theme lives across the whole story, and where it does not. | `theme` |
| 12.12 | **Q00** Brief | What film is this, and what are its rules. | *no parameters* |
| 12.13 | **Q11** Audience state | What the audience knows and should feel at a position. | `scene` |
| 12.14 | **Q15** Provenance | Why is this value what it is, and who touched it. | `entityType`, `row` |
| 12.15 | **Q01** Subject dossier | Everything about a subject, before any scene bends it. | `subjectType`, `subject` |
| 12.16 | **Q02** Subject in context | Everything needed to realise a subject in a scene, and optionally a shot. | `subjectType`, `subject`, `scene`, `shot` |
| 12.17 | **Q04** Scene package | The complete context for a scene, as a unit of work. | `scene` |

Every result carries the envelope of §12.1.1 — `query`,
`resultFormat`, `schemaVersion`, `parameters`, `result` — and the
members listed below are those of `result`.

**Rows appear as `{ uuid, fields }`** (§12.1.2). Row ids never appear;
references resolve to uuids; empty fields are omitted. Values that are
not rows follow §12.1.4, where an absent member is carried as `null`
rather than dropped.

---

## Q05 — Voice direction

**How this character's lines should sound in this scene.**

Specified in **§12.2**. Normative result: [`fixtures/expectations/Q05.result.json`](../fixtures/expectations/Q05.result.json).

Parameters: `character`, `scene`.

Result members: `modality`, `baseline`, `states`, `modulations`, `beats`.

### What it needs

From `queryPaths.ts`, which `readinessReport` walks to
produce Q14. **Absence is not an error** — a missing
`required` entity means the answer is impoverished and Q14
says so (§12.9).

Names are registry entities, except a media step, which
names the asset intent whose bundle must resolve.

| Step | | Why |
|---|---|---|
| `vocal_profile` | required | the voice baseline |
| `media: voice_identity` | required | reference audio to condition on |
| `performance_state (vocal)` | optional | modulation; absence = baseline holds |
| `performance_beat (vocal)` | recommended | per-line direction |
| `dialogue_rhythm` | recommended | scene speech rhythm |
| `sound_perspective` | optional | whose ears we use |

---

## Q07 — Look resolution

**What a frame in this scene, or this shot, should look like.**

Specified in **§12.3**. Normative result: [`fixtures/expectations/Q07.result.json`](../fixtures/expectations/Q07.result.json).

Parameters: `scene`, `shot`.

Result members: `leaf`, `layers`.

### What it needs

From `queryPaths.ts`, which `readinessReport` walks to
produce Q14. **Absence is not an error** — a missing
`required` entity means the answer is impoverished and Q14
says so (§12.9).

Names are registry entities, except a media step, which
names the asset intent whose bundle must resolve.

| Step | | Why |
|---|---|---|
| `project_color_palette` | required | the direction cascade's color root |
| `visual_identity` | required | material/aesthetic root |
| `color_script` | optional | the color script's summary |
| `color_script_entry` | recommended | position-keyed color intent (latest-wins) |
| `scene_color_palette` | recommended | scene color opinion |
| `look_development` | optional | look development root, on the shot cascade |
| `lighting_design` | recommended | scene/shot lighting |
| `shot_design` | optional | shot-level composition |
| `character_appearance_profile` | recommended | each character seen at the position (§2.4.1, §4.6) |

---

## Q03 — World state

**Everything true at one position.**

Specified in **§12.4**. Normative result: [`fixtures/expectations/Q03.result.json`](../fixtures/expectations/Q03.result.json).

Parameters: `scene`.

Result members: `scene`, `characters`, `props`, `motifs`.

---

## Q12 — Continuity

**What changed between two positions.**

Specified in **§12.5**. Normative result: [`fixtures/expectations/Q12.result.json`](../fixtures/expectations/Q12.result.json).

Parameters: `from`, `to`.

Result members: `from`, `to`, `characters`, `relationships`, `props`.

---

## Q06 — Physical direction

**How this character moves and behaves in this scene.**

Specified in **§12.6**. Normative result: [`fixtures/expectations/Q06.result.json`](../fixtures/expectations/Q06.result.json).

Parameters: `character`, `scene`.

Result members: `modality`, `baseline`, `states`, `modulations`, `beats`.

### What it needs

From `queryPaths.ts`, which `readinessReport` walks to
produce Q14. **Absence is not an error** — a missing
`required` entity means the answer is impoverished and Q14
says so (§12.9).

Names are registry entities, except a media step, which
names the asset intent whose bundle must resolve.

| Step | | Why |
|---|---|---|
| `physical_character_profile` | required | movement baseline |
| `scene_blocking + action_sequence` | recommended | staging container |
| `performance_state (physical)` | optional | modulation; absence = baseline holds |
| `performance_beat (physical)` | optional | moment direction |
| `character_environment_physicality` | optional | how they relate to this place |
| `media: motion` | optional | motion reference |

---

## Q08 — Soundscape

**What this scene sounds like.**

Specified in **§12.7**. Normative result: [`fixtures/expectations/Q08.result.json`](../fixtures/expectations/Q08.result.json).

Parameters: `scene`.

The envelope also carries `shot` as null: the published result was computed without it. Whether the query accepts it at all is stated in the section above, not here.

Result members: `leaf`, `layers`.

### What it needs

From `queryPaths.ts`, which `readinessReport` walks to
produce Q14. **Absence is not an error** — a missing
`required` entity means the answer is impoverished and Q14
says so (§12.9).

Names are registry entities, except a media step, which
names the asset intent whose bundle must resolve.

| Step | | Why |
|---|---|---|
| `sonic_identity` | required | the sound world's root |
| `scene_music_design` | recommended | authored silence beats accidental silence |
| `location_sound_profile` | recommended | the room itself |
| `dialogue_sound_design` | optional | speech treatment |
| `sound_cue + music_cue` | optional | specific cues |

---

## Q13 — Media resolution

**Which assets are in force for a subject and an intent.**

Specified in **§12.8**. Normative result: [`fixtures/expectations/Q13.result.json`](../fixtures/expectations/Q13.result.json).

Parameters: `subjectType`, `subject`, `intent`, `scene`, `shot`.

Result members: `subjectKind`, `intent`, `trail`, `references`, `counts`, `rootMapped`.

### What it needs

From `queryPaths.ts`, which `readinessReport` walks to
produce Q14. **Absence is not an error** — a missing
`required` entity means the answer is impoverished and Q14
says so (§12.9).

Names are registry entities, except a media step, which
names the asset intent whose bundle must resolve.

| Step | | Why |
|---|---|---|
| `bundle + character_asset_binding + costume_asset_binding + location_asset_binding + prop_asset_binding` | required | something to resolve |
| `entity_anchor (verified)` | recommended | identity pinning |
| `character_shot_override + location_shot_override + prop_shot_override` | optional | shot-specific swaps |

---

## Q14 — Readiness

**What is missing for another query to answer well.**

Specified in **§12.9**. Normative result: [`fixtures/expectations/Q14.result.json`](../fixtures/expectations/Q14.result.json).

Parameters: `target`, `character`, `scene`.

The envelope also carries `subjectType`, `subject`, `intent`, `shot` as null: the published result was computed without it. Whether the query accepts it at all is stated in the section above, not here.

Result members: `target`, `targetName`, `findings`, `counts`.

---

## Q09 — Motif manifest

**Which motifs should be perceivable in this scene, and how.**

Specified in **§12.10**. Normative result: [`fixtures/expectations/Q09.result.json`](../fixtures/expectations/Q09.result.json).

Parameters: `scene`.

Result members: `scene`, `manifest`, `candidates`, `dense`, `densityThreshold`.

---

## Q10 — Thematic accounting

**Where a theme lives across the whole story, and where it does not.**

Specified in **§12.11**. Normative result: [`fixtures/expectations/Q10.result.json`](../fixtures/expectations/Q10.result.json).

Parameters: `theme`.

Result members: `theme`, `carriers`, `spine`.

---

## Q00 — Brief

**What film is this, and what are its rules.**

Specified in **§12.12**. Normative result: [`fixtures/expectations/Q00.result.json`](../fixtures/expectations/Q00.result.json).

Takes no parameters — it answers about the whole project.

Result members: `layers`, `themes`, `posters`.

---

## Q11 — Audience state

**What the audience knows and should feel at a position.**

Specified in **§12.13**. Normative result: [`fixtures/expectations/Q11.result.json`](../fixtures/expectations/Q11.result.json).

Parameters: `scene`.

Result members: `scene`, `information`, `identification`, `emotionalBeats`, `toneMarkers`, `emotionalCascade`.

---

## Q15 — Provenance

**Why is this value what it is, and who touched it.**

Specified in **§12.14**. Normative result: [`fixtures/expectations/Q15.result.json`](../fixtures/expectations/Q15.result.json).

Parameters: `entityType`, `row`.

Result members: `entityType`, `row`, `versionChain`, `attached`.

---

## Q01 — Subject dossier

**Everything about a subject, before any scene bends it.**

Specified in **§12.15**. Normative result: [`fixtures/expectations/Q01.result.json`](../fixtures/expectations/Q01.result.json).

Parameters: `subjectType`, `subject`.

Result members: `subjectType`, `subject`, `groups`, `motifCarriage`, `thematicConnections`, `relationships`.

---

## Q02 — Subject in context

**Everything needed to realise a subject in a scene, and optionally a shot.**

Specified in **§12.16**. Normative result: [`fixtures/expectations/Q02.result.json`](../fixtures/expectations/Q02.result.json).

Parameters: `subjectType`, `subject`, `scene`, `shot`.

Result members: `subjectType`, `subject`, `scene`, `dossier`, `costumes`, `relationshipStates`, `arcStates`, `performanceStates`, `beats`, `characterVariant`, `locationVariant`, `propVariant`, `propState`, `media`.

### What it needs

From `queryPaths.ts`, which `readinessReport` walks to
produce Q14. **Absence is not an error** — a missing
`required` entity means the answer is impoverished and Q14
says so (§12.9).

Names are registry entities, except a media step, which
names the asset intent whose bundle must resolve.

| Step | | Why |
|---|---|---|
| `character_appearance_profile` | recommended | static appearance baseline |
| `physical_character_profile` | recommended | movement/face baseline |
| `vocal_profile` | optional | voice baseline |
| `costume + costume_scene` | recommended | what they wear here |
| `relationship_state` | optional | where their relationships stand |
| `performance_state` | optional | scene-scoped modulation (absence = baseline holds) |
| `media: character=visual_identity, prop=visual_identity, location=environment` | required | assets to condition on |

---

## Q04 — Scene package

**The complete context for a scene, as a unit of work.**

Specified in **§12.17**. Normative result: [`fixtures/expectations/Q04.result.json`](../fixtures/expectations/Q04.result.json).

Parameters: `scene`.

Result members: `scene`, `lineage`, `storyBeats`, `cast`, `props`, `location`, `locationVariant`, `detail`, `blocking`, `stagingBeats`, `screenplay`.

---

## A note on the ones without a resolution path

6 of the 16 declare a path in
`queryPaths.ts`. The rest are **analytic**: they read whatever exists
and have no readiness semantics of their own beyond those of the
queries they are built from. That is a property of what they do, not
an omission.

Generated by `scf-core/scripts/emit_query_reference.mjs`.
