<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# The SCF Format Specification

**Version 1.0-rc.8 — release candidate.**
Describes schema version **2.25**.
Editors: Christopher Smallfield, Jesse Kretschmer (Minimal Humans).

| | |
|---|---|
| Status | Release candidate for 1.0. §11.0's pre-1.0 clause holds until the release. Section stability is stated in [stability.md](stability.md). |
| Conformance | Roles and requirements in [conformance.md](conformance.md). |
| Changelog | [CHANGELOG.md](CHANGELOG.md). |
| Rationale | Design record: [../docs/conventions.md](../docs/conventions.md). |
| Registry | `scf-core/registry/registry.json`, generated from `schema/entity_registry.py`. |

This document states what SCF *is*. It does not explain why, argue for
any decision, or describe the reference implementation's internals.
Those belong to the design record, which cites this document by section
and never restates a rule.

---

## 0. Scope

### 0.1 What SCF is

SCF (Story Context Framework) is a file format for describing a film's
intent in enough structural detail that a human or a machine can answer
a specific question about a specific moment: what a character sounds
like in a given scene, what is in force at a given point in the story,
what a shot is for.

An SCF file describes **what is in the film**. It is not a revision
history, not an archive of alternatives, and not a production database.
External version control covers history; SCF describes the current
intent.

### 0.2 What this document specifies

Normative:

- the physical encoding of a `.scf` file (§1);
- the entity model and the registry that defines it (§2);
- which facts are stored and which MUST be derived (§3);
- story position, ordering, and the scene-number and shot-code
  grammars (§4);
- narrative structure as spans (§5);
- row and cross-file identity (§6);
- the direction cascade (§7);
- asset addressing and resolution (§8);
- the findings model — how a conforming implementation reports problems
  rather than refusing data (§9);
- extension and reserved names (§10);
- versioning and compatibility (§11);
- **the canonical queries (§12)** — the sixteen questions SCF exists to
  answer, and what a conforming implementation returns for each.

All sixteen are specified, each with a published normative result.

### 0.3 The unit of interchange

**The unit of interchange is the `.scf` file.** A single `.scf` is a
complete, self-describing SCF document. Everything a consumer needs in
order to answer a question about the story is inside it.

Asset identifiers inside a `.scf` may be root-relative (§8), and a
resolver needs a mapping from a root name to a location before it can
fetch bytes. That mapping is supplied by the consuming environment; it
is not part of the document, and its absence does not make the document
incomplete. A `.scf` opened with no root mapping is a valid SCF
document in which every **rooted** identifier resolves to `unaddressed`.
An absolute identifier, or one containing `..`, is `out-of-root` whatever
the session supplies, because that state is decided by the identifier
before any mapping is consulted (§8.2, §8.3).

The reference editor asks the user for a project folder and derives
`@project` from it. That is a workflow, not a property of the format. No
conforming implementation is required to use folders, and this
specification defines no packaged or archive form.

### 0.4 What is outside version 1.0

The following are explicitly **not** specified by SCF 1.0. A file MAY
contain them; a conforming reader MUST NOT rely on them, and MUST ignore
what it does not understand (§10).

| Area | Status |
|---|---|
| Version / snapshot system (`screenplay_versions`, `screenplay_version_lines`) | Outside 1.0, and may never enter it. The function belongs to external tooling. Tables MAY be present; conforming readers MUST ignore them. |
| Layers — a `.scf` referencing another `.scf` | Reserved (§8.8). The word is claimed; nothing else is specified. |
| Cross-file merge | Not specified. Depends on natural keys (§6.3), which are specified, but the algorithm is not. |
| Packaging / archive format | Not specified and not planned. |
| Editor behaviour, UI, and import heuristics | Never in scope. Proposal extraction is an authoring aid, and §9.3 states the only requirement the format places on it. |
| Metadata query | Deliberately impossible (§8.7). Content facts are read from files, never stored, and therefore cannot be filtered on. |

### 0.5 Requirement keywords

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD
NOT, RECOMMENDED, MAY, and OPTIONAL are to be interpreted as described in
RFC 2119.

Requirements are addressed to **implementations**, in the roles defined
in [conformance.md](conformance.md). Where a requirement applies to only
one role, the role is named.

### 0.6 Versions

Three numbers, deliberately independent:

- **Specification version** — this document, stated in its header.
  Increments when the normative text changes.
- **Schema version** — the entity/field set, `SCHEMA_VERSION` in
  `schema/schema_meta.py`; the one this document describes is stated in
  its header. Increments on any non-cosmetic registry change.
- **Implementation version** — any given tool's own release number. Not
  governed here.

This specification describes schema **2.25**, exactly. What a reader
does with a file at another schema version — an older one, or a later
compatible 2.x revision — is governed by §11, not by this section.

### 0.7 Terminology

**entity** — one of the row types defined by the registry (§2.1). A
table.

**link entity** (also **junction**) — an entity whose purpose is to
connect two others: those whose `subject` is `link`.

**tier** — a registry-declared depth band, 0–6, grouping entities by how
far they sit from the bedrock nouns. Tier is descriptive; it carries no
semantics in this specification.

**scope** — a registry-declared positional grain (`global`, `act`,
`sequence`, `scene`, `shot`, `moment`). Descriptive. It does **not**
order the direction cascade (§7.2).

**subject** — the registry-declared entity a row is about. Load-bearing
for §6.5's carve-out and nothing else in this document.

**refines** — a registry-declared list of the entities an entity adds
detail to. Load-bearing: it defines the direction cascade (§7).

**span** — an act or a sequence: a run of contiguous scenes defined by
its start alone (§5).

**position** — a scene's place in story order (§4.1).

**in force** — a state row applies at a given position, under that row's
position pattern (§4.5).

**cascade** — the ordered resolution of direction from broad to specific
(§7).

**identifier** — an asset's stored, portable address (§8.1).

**root** — a name, written `@name`, standing in for a location an
identifier is relative to (§8.2).

**resolver** — the component that maps an identifier to bytes.

**finding** — a reported problem in the data that does not prevent the
data being read (§9).

**derived** — computed from other stored facts at read time, never
written back (§3).

---

## 1. Physical format

### 1.1 Container

An SCF document is a **SQLite 3 database file**. Implementations MUST NOT
assume any particular SQLite page size, journal mode, or encoding beyond
what SQLite itself guarantees.

The conventional file extension is `.scf`.

### 1.2 File identification

SQLite reserves two 32-bit header slots for exactly this purpose:
`application_id` at byte offset 68, `user_version` at offset 60. Both
lie in the first 100 bytes, so a `.scf` can be identified from its first
page without a SQL engine — and, more usefully, told apart from the
thousands of unrelated SQLite databases on a machine.

A conforming writer MUST set:

| Slot | Value |
|---|---|
| `application_id` | `0x53434631` (`1396917809`) — `SCF1` as big-endian ASCII |
| `user_version` | the schema version as `major * 1000 + minor` (schema 2.12 → `2012`) |

The trailing `1` in `SCF1` is the **container generation**, not the
schema version. It changes only if the physical encoding ever breaks
compatibility. The schema version lives in `user_version`, where it
moves freely. This follows the convention of SQLite's own `magic.txt`
registry, in which GeoPackage registered both `GPKG` and `GP10`.

**A conforming reader MUST NOT reject a file that lacks either stamp.**
Every file written before this requirement carries neither. The stamps
are an identification aid, never a gate.

**`_scf_meta` is a key/value table**, with the columns `key` and
`value`, and it holds no other shape. Wherever this document writes
`_scf_meta.schema_version` it means the `value` of the row whose `key` is
`schema_version` — a string such as `2.25`. A file with no such row
states no schema version.

Where the header's `user_version` and `_scf_meta.schema_version`
disagree, `_scf_meta` is the authority and the disagreement is a finding
(§9). **A `user_version` of 0 is an absent stamp, not a disagreement**:
it is SQLite's default, and every file written before the stamp existed
carries it.

The registered `magic(5)` stanza ships as [`scf.magic`](scf.magic).

The media type is `application/vnd.minimalhumans.scf`. It is a vendor-tree
type and requires no registration; the conventional extension is `.scf`.

### 1.3 Tables

A conforming file contains one table per registry entity, named for the
entity, plus the screenplay infrastructure tables. Column sets are
defined by the registry (§2).

The registry declares those infrastructure tables in two lists, because
being SCF's and carrying row identity are different properties:

| List | Meaning |
|---|---|
| `uuidExtraTables` | Not registry entities, but they carry uuid row identity on the same terms (§6.1). |
| `ownedTables` | SCF's, and carrying no identity. A title page is a property of the screenplay rather than a row in its own right. |

**The known table set is the registry entity names, both lists, and
`_scf_meta`.** Anything else is unknown content under §10.1. A reader
MUST test against the union rather than assembling its own list.

Tables whose names begin `sqlite_` are **excluded from that test**. They
are SQLite's own — `sqlite_sequence` is created automatically for any
`AUTOINCREMENT` column, and the registry's framework columns declare
one, so every conforming file has it. Reporting them as unknown content
would put a finding on every SCF in existence.

A file MAY contain further tables. A conforming reader MUST ignore any
table it does not recognise, and MUST NOT treat its presence as an
error (§10).

The physical DDL for the current schema version is published as
[`scf-schema.sql`](scf-schema.sql). It is dumped from a database created
by the reference implementation rather than written by hand, so it
cannot drift from what that implementation produces. It is the physical
schema only: a database created from it alone is structurally conforming
and semantically empty.

#### 1.3.1 The screenplay tables

The infrastructure tables are published as
[`screenplay-tables.json`](screenplay-tables.json): both lists, each
table's columns with types, nullability and defaults, and what each
table is for. Their columns are not in the registry, because they are
not registry entities, and until 0.30 nothing published them.

**`line_type` is a closed vocabulary of fifteen values, published in
that file.** It is carried by `screenplay_lines.line_type` and
`screenplay_version_lines.line_type`, both of which default to `action`.

A writer MUST NOT store a value outside the published set. A reader
encountering one MUST treat that line as unknown content (§10.1) and
**MUST NOT map it to a value it resembles**. The set is closed and the
resemblance is not a rule: a scene heading is `heading`, and
`scene_heading` is not a synonym for it.

The column is declared `TEXT` and SQLite enforces nothing, so the file
cannot carry the constraint. **A validator MUST report a line whose
`line_type` is outside the published set as `line.type_unknown`**, at
severity `error` (§9.4), naming the line's uuid and the value; the line
is still kept as unknown content. Story order is derived from this table
(§4.1), so a reader that guesses wrong produces a wrong answer
confidently, and the finding is what keeps it from being silent. Only
`screenplay_lines` is checked: the version tables are not read (§0).

**A `section` line MAY name the span it declares.** It does so in its
`metadata`, as

```json
{"structureRef": {"kind": "act", "uuid": "<the act's uuid>"}}
```

where `kind` is `act` or `sequence`. **By uuid, not by row id**: row ids
are file-local and a writer may renumber them (§6.2, §12.1.2), and a
binding that survives a rebuild has to be keyed to something that does.
A reader MUST accept the legacy form `{"kind": …, "id": <row id>}`,
which is what schema 2.14 and earlier wrote.

**The line's label is its text after the leading `#` marks and
surrounding whitespace**, compared exactly and case-sensitively with the
span's `name`, also trimmed; that comparison is what
`structure.section_mismatch` reports (§9.4).

**The record answers; the line is the handle.** `start_scene_id` and
`name` on the `act` or `sequence` row are the stored facts (§5.1), and a
reader MUST answer from them. An editor MAY update the record from the
line at commit — renaming a section renames the span it names, which is
how a writer expects an outline to behave. Between commits the two
legitimately differ, so a disagreement is `structure.section_mismatch`
(`info`), not an error.

What a section line MEANS — whether `### Midpoint` is an act, a sequence
or neither — is an editor convention and is deliberately not specified.
A writer that binds its own lines never depends on it.

### 1.4 Missing columns

A reader that intends to write MUST tolerate a file lacking columns the
registry defines, and SHOULD add them on open rather than refusing the
file. Outside the changes §11.0 lists, every schema change has been an
additive optional field, and §11 requires that this remains true.

---

## 2. The entity model

### 2.1 The registry is normative

The set of entities, their fields, types, and reference targets are
defined by `registry.json`, generated from `schema/entity_registry.py`.
The registry is a normative part of this specification; where this
document and the registry disagree about a field, the registry is
correct and this document is in error.

The registry's own STRUCTURE is described by
[`registry.schema.json`](registry.schema.json), a JSON Schema, so that a
consumer can read the field set without running the reference
implementation. That document constrains shape only — which entities
exist is the registry, and what they mean is this specification.

Every published artifact is addressable by tag and checksummed: the
registry and what is generated from it alone by the schema version's
tag, `schema-X.Y`, and everything else by the specification version's,
`spec-X.Y`. See [ARTIFACTS.md](ARTIFACTS.md).

Two generated reading aids accompany this document and are **not
normative**: [entity-reference.md](entity-reference.md), every entity
and field from the registry, and [query-reference.md](query-reference.md),
all sixteen queries on one page. Both are derived and checked in CI.
Where either disagrees with this document or with the registry, they are
wrong. **The manifest covers this document and
the other three specification documents**, so a reader can verify that
the prose it built against is the prose that was published — every
reader run [stability.md](stability.md) lists has written an
independent implementation from these files, and until 0.31 nothing let
them confirm they had read the same bytes.

The digests are over raw bytes. A checkout whose working tree converts
line endings will not match, which is a property of the checkout rather
than of the artifacts.

The registry defines the entities across tiers 0–6;
`spec/entity-reference.md`, generated from it, lists them with their
count.

### 2.2 Framework columns

Every entity carries `uuid` (§6.1). Entities additionally carry
framework columns where the registry declares them:
`lifecycle_status`, external-id columns, and version columns. An
implementation MUST determine which apply from the registry rather than
from a hand-maintained list.

### 2.3 Deriving behaviour from the registry

Several rules in this specification are stated in terms of registry
metadata rather than enumerated lists, and implementations MUST derive
them the same way, so that adding an entity requires no code change:

- **Ownership.** A field named `scene_id` means the row BELONGS to that
  scene and MUST be deleted with it. Any other reference to `scene`
  means the row POINTS AT the scene and MUST retain its identity with
  the reference cleared. `act.start_scene_id` and
  `sequence.start_scene_id` are excluded from both and MUST be
  re-anchored (§5.4). **A clip is not deleted with its scene**: footage
  outlives the script, so `clip.slated_scene_id` is named to point, and
  deleting the scene clears it and keeps the clip. Until 2.24 the column
  was `clip.scene_id`, and this rule deleted recorded footage because of
  how a column was spelled (proposal 0002).
- **Link labels.** Where a link entity declares its `nameField` as
  `hidden: true`, that column is not a name and MUST NOT be displayed as
  one (§3.2).
- **Asset usage.** Every field anywhere in the schema whose
  `referenceEntity` is `asset` counts as a use of that asset for the
  purpose of §8.6. **A polymorphic column counts too**: where a column
  declares a `polymorphicType` and the sibling it names holds `asset` on
  a given row, that row uses the asset its column points at. Both are
  derived from the registry and neither may be written as a list.
- **Direction cascades.** An entity's `refines` list is its parents in
  the direction cascade, and the cascade chain is the closure of that
  list (§7.2). `refines` is the most semantically loaded field in the
  registry and carries this meaning alone.

---

### 2.4 Open and closed vocabularies

A `select` or `multiselect` field's `options` are its vocabulary. Most
are **closed**: the listed values are the only ones the field may hold.

A field the registry marks **`open: true`** is different. Its options
are the **known** values, and:

- a writer MAY store any other string;
- **a reader MUST accept an unlisted value, treat it as the value, and
  MUST NOT map it onto a listed one or blank it**;
- an implementation SHOULD report it as `vocabulary.unlisted_value`
  (§9.4), which is `info`: nothing is wrong, and the tail of unlisted
  values is how a maintainer learns which one to promote into the list.

Open fields arrived in 2.14; among them are `prop.story_function`,
`project.genre` and `technical_specs.resolution`. Each of them ended in
`other` until 2.14, and `other` recorded that the vocabulary had failed
while discarding the value that would have said how. A production
shooting 12K stored `other` and lost the number.

**The closed vocabularies are closed for a reason, and it is the same
reason in every case: something resolves over them.** §12.17 ranks a
location variant by its agreements on `time_of_day`, `weather` and
`season`; §6.6.1 excludes a row on `lifecycle_status`; §9.4's severities
and §12's own vocabularies decide result shapes. A finite set is what
makes those answers the same in two implementations.

**An open vocabulary may still be resolved over, on its known values
only.** `bundle.intent` selects bindings by exact value and picks an
anchor type (§12.8); `asset_relationship.relationship_type` `poster`
places the film's poster (§8.6). An unlisted value matches only itself
and means nothing beyond what those sections say of it. A value a
resolver must be able to enumerate belongs in a closed vocabulary; one
it only matches belongs in either.

#### 2.4.1 Presence

A subject at a position is there in one of three ways. This is its
**presence**:

| Presence | Means |
|---|---|
| `seen` | It can appear on screen. |
| `heard` | It can be heard and is not seen. |
| `named` | It is referred to, and is neither seen nor heard. |

**A vocabulary that says whether a subject is on screen declares each
value's presence in the registry**, as the field's `optionPresence`
(§2.1). It is total over the options. Four columns declare
one: `scene_character.role_in_scene`, `scene_prop.significance`, and
`framing` on both `shot_character` and `shot_prop` (§4.6). The mapping is
published in [entity-reference.md](entity-reference.md), generated from
the registry, and is not restated here. So, for example, a `mentioned`
character is `named` and a `voiceover` is `heard`.

An implementation MUST take a value's presence from `optionPresence` and
MUST NOT infer it from the value's name. **A link with no value is
`seen`**, which is the reading every file written before 2.17 assumes. A
value the vocabulary does not list is also `seen`: §9.2 wants an answer,
and it is the one that withholds nothing a consumer could use.

Presence is about **what the file says is on screen**. A `named`
character is still at the position: they are in its cast, their states
are in force, and continuity follows them. They are simply not in the
picture, and nothing that describes the picture asks after them.

**A presence link is authored, not derived from the screenplay.** A
`scene_character` or `scene_prop` row is valid whether or not the
subject has a cue line, or any line, in the scene, and a writer MUST
NOT refuse it on that ground. A link and the script may disagree; that
is a question an authoring tool MAY put to its user, never a finding
(§9.4), and never a reason to refuse a write.

### 2.5 Lists of strings

A field whose `fieldType` is **`string_list`** holds a **JSON array of
strings**. Null and `[]` mean the same thing: nothing. Twenty-nine
fields carry one — `visual_identity.primary_materials`, `asset.tags`,
`color_script_entry.key_colors` and the rest.

**§12.1.2 projects a `string_list` as an array**, not as the text that
holds it. A consumer parsing JSON out of a JSON document was the old
behaviour, and a reader could not tell a list from a paragraph that
happened to start with a bracket: the type said `json`, which is also
what a keyed map and an attachment column said. A malformed value is
carried as the text it holds rather than dropped (§9.2).

## 3. Derived versus stored

### 3.1 The rule

**If a value can be computed from another stored value, it MUST be
computed and MUST NOT be stored.**

A stored copy of a derivable fact is a second truth that nothing detects
when the original changes.

### 3.2 Values that MUST be derived

| Value | Derived from |
|---|---|
| A scene's display label | `sc {scene_number} — {name}`, at render time |
| A link row's label | the rows it points at |
| Act and sequence membership | the span's start boundary (§5) |
| Story order | the screenplay position of each scene's heading (§4.1) |
| An asset's format | its identifier's extension (§8.5) |
| An asset's path tree position | its identifier's segments |
| A file's content metadata | the file, read at display time (§8.7) |

### 3.3 The one exception

`shot.shot_number` IS stored and IS authored. A shot number is an
identifier issued to a crew, not a display label. Consumers MUST NOT
rewrite it.

An implementation MAY compute a derived shot code and MAY present it
alongside an authored one that disagrees, so a list can be reissued
deliberately.

A shot moved to a different scene MUST be renumbered. The rule protects
a number against its scene renumbering; it does not protect a number
that names the wrong scene.

### 3.4 Derived-but-stored

`screenplay_lines.scene_id` is threaded onto body lines when the
screenplay is committed. It is derived state that happens to be stored,
and it is absent for lines typed since the last commit and for files
written before the threading existed.

**Implementations MUST NOT rely on it.** To read a scene's text, find the
heading line linked to that scene and take every line up to the next
heading.

**A heading names its scene by its own `scene_id`, and on a `heading`
line that column is authoritative**: it is the link this section and
§4.1 mean by "the heading linked to that scene", written when the
heading is. The rule above is about every other line type, whose
`scene_id` is threaded onto it after the fact.

### 3.5 Line anchors

**A line anchor names a screenplay line by its uuid.** It is stored as
text, never as a row id. A line's row id does not survive the screenplay
being rewritten, which a writer may do wholesale; its uuid does, through
any revision that diffs before writing (§6.1).

**A field that is a line anchor is declared so in the registry**, as
`lineAnchor: true` (§2.1), so that every consumer finds the anchors from
the registry rather than from a list of its own. One anchor is not a
registry field, because its table is a screenplay table (§1.3.1):
`screenplay_prop_tags.line_uuid`.

**A writer that splits or merges a line SHOULD re-anchor every anchor
that named it**, to the line that now carries the text the anchor was
about. It is a SHOULD because it is a writer's behaviour, and the
failure is visible either way: **an anchor whose uuid names no line is
ORPHANED**. It is kept, and reported as `line.anchor_orphaned` (§9.4).

---

## 4. Position and ordering

### 4.1 Story order

Everything positional is keyed to a **scene**. Scenes are ordered by
their position in the screenplay: the `line_order` of the heading that
carries each scene.

A scene the screenplay does not contain has no screenplay position, and
implementations MUST fall back to `scene_number` — unnumbered scenes
last — and then to row id.

**Every scene the screenplay contains precedes every scene it does
not.** The two populations have no shared axis — a scripted scene has a
line position and an unscripted one has a number — so they cannot be
interleaved, only concatenated, and the script is what §4.1 says order
comes from. A scene with no heading is one nothing has placed yet, and
placing it after everything that has been placed is the reading that
does not invent a position for it.

**`structure.scene_not_in_script` reports such a scene**, at `info`,
**only where the file has a screenplay** — at least one `heading` line.
A file with no heading at all has placed nothing; its scenes are ordered
by number (§4.2) and none of them is out of place.

The full comparison, in order: whether the scene has a screenplay
position at all (those that do, first); then that position; then
`scene_number` by §4.2.2; then row id.

The conformance fixture exercises this: scene **17** carries a number
and no heading, and sorts after scene 24. A reader that ordered by
`scene_number` alone would put it between 16 and 19, and the published
Q10 spine says otherwise.

**Implementations MUST NOT order scenes by `scene_number` alone.** Doing
so is wrong for any file written without a screenplay, and for any scene
moved since the last commit.

### 4.2 Scene numbers

`scene_number` is a label for a position, not the position itself
(§4.1). Two scenes MAY carry the same label, and a scene MAY carry none.

#### 4.2.1 Canonical form

```abnf
scene-number  = [prefix] digits [suffix]
prefix        = 1*3ALPHA
digits        = 1*DIGIT
suffix        = 1*3ALPHA
```

Examples: `1`, `12`, `101`, `12A`, `A12`, `12AB`.

A prefix marks a scene inserted before the numbered one; a suffix marks
a scene inserted after it. Both letter runs are **bijective base-26**
(`A`=1, `Z`=26, `AA`=27) and are compared case-insensitively; the
canonical form is uppercase.

#### 4.2.2 Ordering

Where §4.1's fallback reaches `scene_number`, implementations MUST order
by the tuple:

```
(digits, prefix-present ? 0 : 1, prefix-index, suffix-index)
```

with `prefix-index` and `suffix-index` the bijective base-26 values, and
`0` where the run is absent. This yields `A12 < B12 < 12 < 12A < 12B`,
which is the convention the notation exists to express.

#### 4.2.3 Non-conforming values

A `scene_number` that does not match §4.2.1 is **opaque**. It is valid
data and MUST NOT be rejected (§9.1). Implementations MUST NOT order it
by §4.2.2 and MUST fall through to the next term in §4.1's chain.

**A `scene_number` is read with surrounding whitespace trimmed**, and
one that is empty after trimming — the empty string included — is
**absent**, not opaque: ` 12` is the label `12`, and `''` says nothing
about the scene. The stored value is not rewritten.

**Where §4.1 orders by number, three groups follow one another**:
conforming numbers by §4.2.2, then opaque ones, then scenes with no
number. Within each of the last two, the next term — row id — decides.
An opaque label says something about the scene; an absent one says
nothing, so it goes last.

> **Registry note.** Schema 2.9 declares `scene_number` as text, so the
> declared type and this grammar agree. Files written before 2.9 carry an
> integer-affinity column; no conversion is needed, since affinity is a
> hint and §4.2.3 defines the behaviour for any value either way.

### 4.3 Numbering policy

**All four numbers are authored and stored**: `act.act_number`,
`sequence.sequence_number`, `scene.scene_number` and `shot.shot_number`.
None of them is derived from position, and none may be inferred from one.

`project.numbering_policy` governs whether an implementation recomputes
them:

- `derived` (default) — act, sequence and scene numbers and shot codes
  are recomputed at commit to match story order;
- `fixed` — authored numbering is preserved, in full.

An implementation that recomputes any of the four on a `fixed` file is
non-conforming.

The two modes are the two halves of a project's life. While a writer is
still moving the story around, renumbering by hand is tedious and the
numbers carry no external commitment, so `derived` keeps them tracking
the page. Once a production is greenlit the numbers leave the building —
on schedules, call sheets, shot lists — and become identifiers rather
than labels. From that point `fixed` holds them still, and a scene
numbered 12 that plays after scene 45 is **correct**: it is scene 12,
and every document in the production office says so.

§4.1's warning is the same fact from the reader's side. Under `fixed`, a
scene's number stops predicting its position, which is why story order
is derived from the screenplay and never from the number.

### 4.4 Shot codes

`shot.shot_number` is authored and stored (§3.3). This section defines
the form a conforming implementation generates and how any
implementation MUST read one.

#### 4.4.1 Canonical form

```abnf
shot-code  = [scene-prefix] letter-run
letter-run = 1*ALPHA
```

`scene-prefix` is the `scene_number` of the shot's scene, reproduced
verbatim. `letter-run` encodes a **zero-based** ordinal in bijective
base-26: `A`=0, `Z`=25, `AA`=26, `AB`=27.

A shot in a scene with no `scene_number` has no prefix, and its code is
the letter run alone.

Codes are compared case-insensitively; the canonical form is uppercase.

#### 4.4.2 Parsing is relative to the scene

**A shot code MUST be parsed by removing its scene's `scene_number` from
the front and reading the remainder as the letter run. An implementation
MUST NOT parse a shot code by taking its trailing letter run in
isolation.**

The two readings differ whenever a scene number ends in a letter, which
§4.2.1 permits. For a shot `12AB` in scene `12A`:

| Reading | Prefix | Letters | Ordinal |
|---|---|---|---|
| Correct — strip the scene number | `12A` | `B` | 1 |
| Incorrect — trailing run | `12` | `AB` | 27 |

A shot code whose prefix does not match its scene's number is
**unparseable**, not an error: it is valid data, MUST NOT be rejected,
and MUST be left unchanged by any operation that would otherwise
renumber it.

#### 4.4.3 Allocation

A newly created shot SHOULD take the code one past the **highest**
ordinal already used in its scene, not the first unused one. A shot
number may already be held by a crew, so a cut `42B` MUST NOT be reissued
to a different setup while any sibling above it exists.

This is a guard, not a guarantee. Nothing records codes that once
existed, so deleting the highest-numbered shot in a scene frees its code
again. An implementation requiring the stronger promise needs a stored
counter, which this version does not define.

#### 4.4.4 Restamping

When a scene's number changes and `project.numbering_policy` is
`derived`, an implementation MUST restamp each of that scene's shot
codes onto the new number, preserving the ordinal (§4.4.2).

When `numbering_policy` is `fixed`, shot codes MUST be left unchanged
along with the scene numbers. That is the state a distributed shot list
requires.

An implementation MAY display a derived code alongside an authored one
that disagrees, so that a list can be reissued deliberately (§3.3).

### 4.5 Position patterns

Each entity declares a `positionPattern`. **Four values exist**, and the
registry's names for them are `none`, `explicit`, `sparse_persistence`
and `latest_wins`:

| Registry value | | |
|---|---|---|
| `none` | Not positioned | Almost every entity. The row is not keyed to a scene, so nothing below applies to it. |
| `explicit` | Pattern 1 | One row per scene. |
| `sparse_persistence` | Pattern 2 | Keyed at a scene, in force onward per its `persistence` field. |
| `latest_wins` | Pattern 3 | The most recent row at or before a position is in force. |

This section described three until 0.40 and never named `none`, which
is what almost every entity declares — so a reader matching the
registry against the prose found a fourth value the specification did
not mention and had to decide for itself whether that was an error in
the registry or in the document.

The three numbered patterns are the ones a resolver acts on, and it
MUST apply the one the registry declares.

**Pattern 1 — explicit rows.** One row per scene. What is in force is
what is written. No inference.

**Pattern 2 — persistence.** A state row is keyed at a scene and carries
`persistence`. **Its position is its `scene_id`**: a row with none — one
recorded against a shot alone — has no position and is in force
nowhere by this pattern.

**`persistence` is a closed set of two values**, and the registry
declares them:

- `scene_only` — in force at its own scene and nowhere else;
- `until_resolved` — in force from its scene forward until
  `resolved_at_scene_id` (exclusive), or to the end of the story. A
  state whose `resolved_at_scene_id` is at or before its own scene is
  resolved before it begins and is **in force nowhere**, its own scene
  included; a `resolved_at_scene_id` naming a cut scene names no
  position (§6.6.1) and resolves nothing.

**A reader encountering any other value — null included — MUST treat
the row as `scene_only`.** This is a narrower rule than §10.1's general "ignore
what you do not understand", because §10.1 does not say whether the
unknown FIELD or the whole ROW is ignored, and here the two readings
differ in an unsafe direction: ignoring the field would leave the
default, and defaulting to `until_resolved` would silently extend a
state the reader does not understand across the rest of the story.
Treating it as `scene_only` confines the damage to the scene the author
keyed it at.

Where several persistent states apply at one position, implementations
MUST merge them oldest-first, so a later state overrides an earlier one
field by field.

**Two rows can sit at one scene**, and both patterns below need an order
for them. **Row id breaks the tie**: it is the only stable key available
at a shared position, and it means the row written later wins — which is
what an author doing the writing would expect. Pattern 2 merges them
oldest-first, so a later row's value overrides an earlier one key by
key; pattern 3 takes the highest row id at the winning position. This
holds wherever pattern 3 is applied — a state table, and a `latest_wins`
layer of the direction cascade (§7.3 step 1) alike — and the published
`Q07-scene3` shows it. Row id is file-local (§6.2), so this is a rule
about resolving within a file and never about comparing across them.

**A `resolved_at_scene_id` naming a scene with no story position** — cut
(§6.6.1), or not in the file — resolves nothing: the state stays in force
to the end of the story. A resolution point that is not in the film is
not reached.

**Pattern 3 — latest wins.** A state row exists at each scene where the
value changed. The answer at any position is the most recent row at or
before it. There is no resolution point; the next row supersedes.

### 4.6 Presence at a shot

**A subject is at a shot if a `shot_character` or `shot_prop` row puts
it there.** Its presence is its `framing`'s (§2.4.1): `full` and
`cropped` are seen, `off_screen` is heard. A row with `framing` unset
puts the subject on screen with its framing unrecorded.

How a seen subject reads is two more closed fields, independent of each
other and of `framing`:

- `facing` (characters only): `toward`, `profile` or `away`;
- `focus`: `sharp` or `soft`.

**An unset field is unknown, not a default.** `facing` and `focus`
describe what is on screen, so they are empty when `framing` is
`off_screen`.

**If `shot.presence_complete` is true, the shot's rows are its whole
frame.** A subject with no row is not in the shot, and a shot with no
rows has nobody and nothing in it.

**Otherwise every subject the shot's scene links and no row names is
also at the shot, with its scene presence** (§2.4.1) and framing, facing
and focus unknown. Such a subject is **inherited**, and one a row names
is **recorded**. A result that reports presence at a shot MUST say which
each subject is. A shot with no rows and `presence_complete` unset is
**unrecorded**, not empty: it answers exactly as its scene does. A
consumer MUST NOT read the absence of rows as a frame with nobody in it.

**Presence at a shot is never wider than presence at its scene.** Per
§9.2, these are kept and reported rather than refused:

| Finding (§9.4) | Raised when |
|---|---|
| `presence.shot_subject_not_in_scene` | A shot row names a subject its scene does not link. |
| `presence.named_but_on_screen` | A shot row puts on screen a subject its scene link makes `named`. |
| `presence.off_screen_described` | An `off_screen` row sets `facing` or `focus`. |
| `presence.complete_but_empty` | `presence_complete` is true and the shot has no rows. An empty frame is legitimate; a flag set by mistake empties the shot silently, so it is made visible. |

**A shot is at its scene's location.** A shot has no location of its
own. A change of place is a new scene, including a flashback and each
side of an intercut. This cuts across screenplay convention, where an
intercut is often written as one scene, and it is deliberate: the cost
falls once on the writer who splits it, instead of on every reader of
every shot, who would otherwise have to ask where each shot is.

### 4.7 The lines a shot covers

A shot names the screenplay it covers with two line anchors (§3.5),
`line_start_ref` and `line_end_ref`. **It covers the lines of its scene
from the first to the last inclusive, in script order** (§4.1), located
by the heading as §3.4 requires. Whole lines only. With `line_end_ref`
unset, the range is the one line at `line_start_ref`. A clip names the
lines it covers the same way, and they need not be its shot's.

**Ranges may overlap, and usually will.** A scene is covered from several
angles and resolved in editing: a master and two singles of one exchange
each cover the same lines, and none of them owns them. A range says what
a shot is FOR, not where the cut falls. Nothing in the format partitions
a scene's lines between its shots, and **a consumer MUST NOT read
overlapping ranges as a contradiction.**

**A shot with no range is unrecorded, not empty.** Unlike presence
(§4.6), an unrecorded shot does not inherit its scene's lines: that
would give a three-second insert every line of the scene. Neither a line
no shot covers, nor a scene whose shots record no ranges, is a finding.

Kept and reported rather than refused (§9.2):

| Finding (§9.4) | Raised when |
|---|---|
| `line.range_outside_scene` | A range names a line that is not in its own scene. |
| `line.range_reversed` | `line_end_ref` comes before `line_start_ref` in script order. |
| `line.end_without_start` | `line_end_ref` is set and `line_start_ref` is not. |

A range with an orphaned end is reported once, as `line.anchor_orphaned`
(§3.5), not again as a range problem.

### 4.8 The variant in force

A subject may have **variants** — `character_variant`, `prop_variant`,
`location_variant`: a different design of the same subject, built,
dressed or cast separately (the character as a child, the prop after it
breaks, the room at night). A variant is a standing fact with no
position of its own. **Which variant is in force at a position is
determined by the subject's kind:**

| Kind | The variant in force at a scene |
|---|---|
| Location | The variant §12.17 selects for the scene — and only if it is a variant of THIS location. A scene set elsewhere puts none of this location's variants in force. |
| Character | The variant named by `variant_id` on the character's `scene_character` link at that scene. |
| Prop | The variant named by `variant_id` on the prop's `scene_prop` link at that scene. |

For a character or prop, **no variant is in force** where the subject
has no presence link at the scene, where the link's `variant_id` is
null, where it names a cut variant (§6.6.1), or where it names a variant
of **another** subject. The last is reported as
`presence.variant_foreign` (§9.4); the others are ordinary states of a
file.

Q03, Q04 and Q12 report it on each character and prop they list, and
Q02 for its subject: a scene package that lists a character without
saying which version appears is wrong for anyone casting or dressing it.

**At a shot, the variant in force is its scene's.** No shot-level column
exists. **With no position, no variant is in force** for any kind.

The presence vocabulary (§2.4.1) does not affect this: a `mentioned`
character's link may name a variant, and it is in force for whatever
reads it.

A variant is not a performance state. `performance_state` modulates a
performance and persists (§4.5 pattern 2); a variant is a design,
switched per appearance. The two compose: a variant may be wounded.

`variant_id` on a presence link is a **qualifier** (§6.3): it says which
version of the subject appears, not which rows the link joins, so it is
not part of the link's natural key. A scene cannot link one character
twice as two variants; a scene showing both is not expressible at scene
level.

---

## 5. Structure: spans

### 5.1 Spans are defined by their start

An act **begins** at a scene and runs until the next act begins. A
sequence likewise. `act.start_scene_id` and `sequence.start_scene_id`
are the only stored facts. Membership MUST be derived.

### 5.2 Spans are contiguous

A span covers every scene from its start to the start of the next span
of the same kind. Non-contiguous membership is not expressible. An
implementation MUST NOT invent a representation for it.

"Every scene" is in story order (§4.1), so **a scene the screenplay does
not contain belongs to whichever span of each kind runs to the end**:
§4.1 sorts it after every scripted scene, and a span covers the scenes
up to the next start. The fixture's scene 17 is in the last act and the
last sequence, and its shadow row says so.

### 5.3 Acts and sequences are independent

Acts and sequences are independent spans, **not** a hierarchy. A scene
MAY be in an act with no sequence, and a sequence MAY begin in one act
and end in another. Both are legal and MUST NOT be rejected.

An implementation presenting acts and sequences as nested MUST group an
act's scenes into runs of sequence, so that a crossing sequence appears
in each act as the part of it that belongs there. Grouping by "sequences
whose start falls in this act" is incorrect.

### 5.4 Shadow rows

`scene_sequence` rows MAY be materialised at commit so that queries
written against them keep working. The boundary is the truth and those
rows are its shadow; they MAY be stale between commits.

**No canonical query reads them.** §12.17's lineage is derived from span
boundaries, and until 0.38 it was not: Q04 read `scene_sequence`
directly, which let a normative answer come from a table this section
permits to be stale. A shadow is a compatibility surface for consumers
outside this specification, and **a conforming reader MUST derive
membership from boundaries** (§5.1) rather than from these rows.

Rows that no boundary explains MUST be reported as
`structure.shadow_row_unexplained` (§9.4), and MUST NOT be silently
deleted. **The membership they are checked against is derived over every
scene, cut ones included** (§9.5): a cut scene keeps the position its
heading gives it, so a shadow row placing it in the span around that
position is explained. The fixture's cut scene 12B has one. Deleting authored data to satisfy a derivation is not a
migration.

### 5.5 Half-placed structure is valid

An act with no boundary, a boundary on a deleted scene, two acts on one
scene, and scenes before the first act are all valid file states. Each
MUST produce a usable structure and a finding.

**Two spans of one kind starting at one scene** are ordered by row id,
and the later one takes the scenes: the earlier is empty, and that is
what `structure.boundary_shared` reports.

**A span whose start scene is cut covers no scene.** A cut scene takes
part in no span (§6.6.1), so in every answer about the film the boundary
anchors nothing, exactly as an absent one would: the scenes it would
have begun belong to the span of its kind before it, or to none. It is
not re-anchored at the next scene — a cut scene has no story position
(§4.1) to be next to, and a re-anchoring rule would make an act's
membership depend on where a scene no longer in the film used to sit.
Restoring the scene restores the span. **It is reported as
`structure.boundary_cut`**: findings derive membership over every scene,
cut ones included (§9.5), so without its own code the validator sees the
span anchored and the re-parenting is silent. The negative case
`span-boundary-cut` pins it.

---

## 6. Identity

### 6.1 Row identity

Every row in every entity, junctions included, carries a `uuid` that is
unique within its table. Implementations that open a file for writing
MUST backfill missing uuids.

A uuid answers the **lineage** question: is this the same row as before,
across export, re-import, and being read by another tool. Row ids are
local to a file and MUST NOT be treated as meaningful outside it.

### 6.2 Uuids do not identify across files

A uuid is minted per file. Two files describing the same production will
carry different uuids for the same real link. Implementations MUST NOT
match rows across files by uuid.

### 6.3 Natural keys

Across files, a junction is identified by its **natural key**: the rows
it joins, plus the polymorphic target where it has one, plus `domain`
where present.

The natural key of every link entity is published as
[`junction-keys.json`](junction-keys.json). Any implementation that
merges, de-duplicates or validates junctions MUST use those keys.

The keys are derived from the registry — every non-auto-injected
reference field the entity declares that is not marked `qualifier`, then
`entity_type`, `entity_id` and `domain` where present — and the file
records that derivation. A **qualifier** is a reference that says
something about the link rather than naming one of the rows it joins:
`scene_character.variant_id` (§4.8) is one. Two rows differing only in a
qualifier are one link written twice, which §6.4 reports. It is
published rather than described because an earlier revision cited a
function instead of an artifact, and an independent implementation could
not compute a natural key at all.

### 6.4 Duplicates are findings

Nothing in the schema prevents two rows sharing a natural key.
Duplicates MUST be reported as findings (§9), and MUST NOT be rejected
on write. Duplicates whose content disagrees MUST be reported distinctly
from duplicates that are identical.

**Key columns compare as values, and two nulls are equal.** Two motif
appearances on one prop at no scene — `scene_id` and `domain` null in
both — are one link written twice, not two links. SQL's `=` says
otherwise (`NULL = NULL` is not true), so an implementation comparing
keys with it reports nothing; grouping, as `GROUP BY` does, is the
comparison this section means. The negative case `junction-key-null`
pins it.

### 6.5 Relationships

`character_relationship` has no constraint on its two character columns
and no convention about ordering.

`directionality` carries the symmetry fact: `mutual` (unordered) or
`a_to_b` (reads A → B).

**Consumers MUST read relationships from both character columns** and
MUST NOT assume the character of interest occupies `character_a_id`.
Q01's `relationships` (§12.15) is the worked example.

`character_relationship` is not a link entity — its
`subject` is `character` — so junction tooling does not cover it.
Implementations MUST report, separately:

- one pair entered twice as `mutual` — duplicate;
- two `a_to_b` rows in opposite directions — two legitimate facts;
- the same direction twice — duplicate;
- one row `mutual` and another directed for the same pair —
  contradiction;
- rows with no `directionality`;
- rows naming one character twice;
- rows pointing at a character not present in the file.

### 6.6 Lifecycle status

`lifecycle_status` records where a row stands. **The registry declares
the vocabulary** (§2.1) and currently holds six values:

| value | |
|---|---|
| `active` | In the film. The default. |
| `draft` | In the film, and not settled. Treated as `active` by every derivation. |
| `superseded` | Replaced by another row, which its version chain names (§12.14). |
| `deprecated` | Kept for compatibility, discouraged for new authoring. |
| `cut` | **Not in the film** (§6.6.1). |
| `archived` | Retained for the record and not in the working film. |

**Only `cut` is excluded from resolution.** Every other value, including
`archived` and `superseded`, is in force as far as §6.6.1 is concerned.
That is a deliberate narrowness rather than an oversight: `cut` is the
only one of the six that makes a claim about the FILM, and the rest
describe the row's editorial standing. A resolver that also excluded
`archived` would be answering a different question from one that did
not, and both would believe they conformed.

§12.8 resolves a superseded asset to its successor; that is a
substitution inside one query, not an exclusion, and is stated there.

This section said "`active` or `cut`" until 0.40, naming two of the six
the registry declares. A reader implementing from it had to decide for
itself what an `archived` scene's story position was, and §2.1 already
said the registry wins — so the specification and the artifact it
defers to disagreed in the one place a reader could not tell.

`scene`, `act` and `sequence` also carry **`status`**, which is a
**writing stage** — how far the author has taken the row, from
`outline` to `locked`. It makes no claim about whether the row is in the
film and **MUST NOT affect resolution**. A row leaves the film through
`lifecycle_status = cut` and in no other way.

`status` listed `cut` among its values until 2.14, and that value did
nothing: §6.6.1 excludes on `lifecycle_status` alone, so a scene an
author had marked cut in the field labelled Status stayed in the film,
kept its position, and appeared in every query. Nothing reported it
either, because nothing had a reason to look. The value was removed
rather than honoured, because two columns saying the same thing can
disagree and one of them then has to win.

Where the registry declares it, an implementation MUST preserve it. Of
the link entities only `actor_character_role` and
`thematic_connection` carry it; the others MUST NOT.

**A link inherits its endpoints' lifecycle.** That is why every other
link entity has no `lifecycle_status` of its own and must not gain one:
a junction is a *connection*, and a connection to something that is not
in the film is not in the film either. It needs a status of its own only
when the row is a **claim** rather than a connection — an actor's
casting and a thematic connection are both assertions that can be cut
while both endpoints survive, which is exactly why those two carry it.

#### 6.6.1 A cut row is not in the film

**A resolver MUST exclude rows whose `lifecycle_status` is `cut`.** The
point of marking something cut rather than deleting it is that it stops
being considered while remaining inspectable — so nothing that answers a
question about the film may see it.

This applies to every derivation in this specification, and the
consequences are meant to reach that far:

- a cut scene has **no story position** (§4.1), takes part in no span
  (§5), and appears in no canonical query result (§12);
- a cut state is in force nowhere (§4.5);
- a cut row contributes no layer to a cascade (§7.3);
- a cut link joins nothing — **and so does a link whose ENDPOINT is
  cut**, whether or not the link itself can carry a status (§6.6).

That last one is the easiest to get wrong, and the reference
implementation had it wrong until 0.39. A resolver that filters rows one
table at a time is not enough: a query that reaches an entity *through*
a junction in a single join sees the junction, which cannot be cut, and
the entity, which can — and filters neither unless it is written to.
Five canonical queries did exactly that, and a cut character stayed in
the scene's cast.

A cut scene MAY still carry its heading in the screenplay — a cut scene
in a real script is struck through, not deleted. An implementation that
derived story order from headings alone would resurrect it, and MUST
NOT.

Because a cut row is excluded everywhere, **adding one to a file changes
no answer.** That is the test of a conforming implementation, and the
conformance fixture is built to make it: it carries a cut scene, with a
heading, and a cut performance beat in its most heavily asserted scene.

**The mirror is also required: cutting an existing row MUST change the
answer.** Stated on its own, the test above is satisfied by an
implementation that ignores `lifecycle_status` entirely — nothing it
adds is ever looked at, so nothing it adds ever changes anything. Both
halves are needed, and the second is the one that catches a resolver
which filters some paths and not others.

#### 6.6.2 Reading what was cut

Excluding cut rows from resolution is not hiding them. An
implementation MAY offer a view that reads them back — a cut list, an
audit trail, a history panel — and SHOULD keep that path distinct from
the resolvers, so that the two cannot be confused at a call site.

The reference implementation offers `scf-check --cut`, which lists every
cut row by uuid and name. It reads through `rowsIncludingCut`, the one
function in the library that sees past §6.6.1's exclusion, and is a
separate code path from the report: **a cut row is not a finding.** It
is a deliberate authorial act, not something wrong with the file, and
reporting it as a defect would say the opposite.

Row identity survives being cut (§6.1): a cut row keeps its uuid, and
restoring it restores the same row rather than creating a new one.

## 7. The direction cascade

Direction — how something should look, sound or be played — is authored
at several levels of generality and resolved from the broadest to the
most specific. This section defines that resolution.

An earlier revision of this section described the cascade as
`project → sequence → scene → shot`. **That was wrong**: those are
positional scopes, and the cascade is not ordered by them. It was
corrected in specification 0.17 after an independent implementation
demonstrated the contradiction.

### 7.1 A cascade is identified by its leaf

There is no single cascade. A cascade is named by its **leaf entity**,
and the caller supplies it — for the canonical queries, the query names
it. Q07 resolves the leaf `shot_design`; Q08 resolves
`scene_music_design`.

The leaf is **not derivable** from the data or from the registry. Two
entities can both be about sound, both be populated, and only one be part
of the soundscape cascade. Any interface offering direction resolution
MUST take the leaf as an input.

### 7.2 The chain is the `refines` closure

Each entity declares `refines`: a list of the entities it adds detail
to. Most declare an empty one.

The chain for a leaf is produced by walking `refines` **depth-first,
post-order**, so that an entity's parents precede it and the leaf is
last. Where an entity refines several parents, they are visited in
declared order. An entity already in the chain is not revisited.

```
chain(leaf):
    for parent in leaf.refines:   # declared order
        chain(parent)
    append(leaf) if not already present
```

This is the whole ordering rule. It is a graph walk, not a scope
ordering — which is why a `scope: global` entity can appear after a
`scope: scene` one, as `look_development` does in the Q07 chain.

### 7.3 One row per entity, most specific first

For each entity in the chain, a resolver selects **at most one row**.
The steps are tried in order. **A shot with no row of its own falls
through from step 2 to step 3 and takes the scene's row**; step 1 does
not fall through, so a `latest_wins` entity with no row at or before the
scene contributes nothing. **Where step 2, 3 or 4 matches several rows,
it takes the lowest row id. Step 1 is §4.5's pattern 3 and takes the
highest row id at the winning position**, as every pattern-3 resolution
does: the row written later at a position is the one in force there. The
fixture holds the tie — two `color_script_entry` rows at scene 1 — and
the published `Q07-scene3` pins it.

1. If the entity's `positionPattern` is `latest_wins` and a scene is
   given, the row is the latest at or before that scene in story order
   (§4.5).
2. Otherwise, if a shot is given and the entity has a `shot_id` column,
   a row matching that shot.
3. Otherwise, if a scene is given and the entity has a `scene_id`
   column, a row matching that scene **whose `shot_id` is empty** — so a
   shot-level row never also arrives as a scene-level layer.
4. Otherwise, if the entity has neither column, its first row.
5. Otherwise, nothing.

An entity contributing no row is **skipped**, not represented as an
empty layer. Absence is well-defined and is not a finding.

### 7.4 What resolution returns

An ordered list of `(entity, row)` pairs, root-first, with the last pair
the most specific opinion.

A resolver MUST return **every contributing entity**, not only the
last, so a consumer can determine where a value came from. "Every
contributing layer" means every entity in the chain that supplied a row
under §7.3 — not every row in the file that might have applied.

Returning only the resolved value makes an answer unarguable and
unexplainable at once; the chain costs nothing and turns the cascade
into something a person can reason about.

## 8. Assets and addressing

### 8.1 An asset is a reference

An asset row addresses content; it does not contain it. A conforming
file MUST NOT embed asset bytes. Query output and exports MUST carry
references, never bytes.

### 8.2 Identifiers and roots

An asset row stores an **identifier**: portable, root-relative, and the
thing that is committed and diffed.

```
@project/characters/eleanor/face_ref.png
```

Grammar:

- An identifier beginning `@` is **rooted**. The root name runs from the
  `@` to the first separator; the remainder is the path below it.
- A root name MUST NOT be empty.
- Separators are normalised to `/`. Empty and `.` segments are removed.
- A path containing a `..` segment escapes its root and MUST NOT be
  resolved.
- An identifier not beginning `@` is treated as **absolute**. It MUST
  NOT be silently adopted into `@project`.

`@project` is the root of the document's own content and is the only
root that appears in the common case. Root names other than `@project`
are reserved (§10.2); the mapping from a root name to a location is
supplied by the consuming environment and MUST NOT be stored in the
`.scf`.

Absolute paths are representable. They MUST be flagged non-portable and
MUST resolve to `out-of-root`.

**This is a statement about portability, not a prohibition.** An
absolute identifier is legal, `asset.identifier_absolute` is a
**warning** rather than an error, and a conforming implementation MUST
NOT refuse a file for carrying one. A path containing `..` is the
different case: it is an error (§9.4) and MUST NOT be resolved, because
where it lands depends on where its root happens to sit; its §8.3 state
is `out-of-root`, whatever the session's roots.

An implementation **MAY** attempt to locate an absolute path and report
its size, and MUST keep the state at `out-of-root` if it does — the
address is reachable here and nowhere else, which is what that state
means. An implementation whose environment cannot open one, such as a
browser, reports `out-of-root` with nothing found, and is conforming.

### 8.3 Resolution states

Every asset resolves to exactly one state:

| state | meaning |
|---|---|
| `resolved` | bytes reachable now |
| `missing` | does not resolve under its root |
| `unmaterialised` | cloud placeholder; appears on access |
| `out-of-root` | absolute or foreign root; resolvable but non-portable |
| `unaddressed` | nothing to resolve against: the row carries no identifier, or this session supplies no mapping for its root |

`unmaterialised` MUST NOT be reported as a kind of `missing`. A synced
project full of placeholders is healthy.

**Detecting it is the environment's job, and this specification does
not say how.** Whether a path holds real bytes or a cloud placeholder is
not a property of the identifier, of the file's name, or of anything in
the `.scf` — it is a fact about the filesystem the session is attached
to, and the mechanisms differ per platform and per sync client. Any rule
stated here would be wrong somewhere.

So:

- An implementation whose environment **can** distinguish a placeholder
  MUST report it as `unmaterialised`, and SHOULD document how it decides.
- An implementation whose environment **cannot** distinguish one MUST
  report the file as `resolved`, and **MUST NOT** report it as `missing`.
  The bytes are reachable — fetching them may be slow, and slow is not
  absent.
- **A conforming implementation is not required to produce
  `unmaterialised` at all.** A resolver that never emits it is
  conforming; one that emits `missing` for a placeholder is not.

This is the same shape as §0.3's root mapping: a property of the
consuming environment rather than of the format, stated so that its
absence is not mistaken for a defect. The reference implementation's
heuristic — a zero-length file that carries a modification time — is
recorded in `assetLocator.ts` and is **not normative**; it is one
environment's answer, and a deliberately imprecise one, because being
wrong there costs a label and reporting a synced project as broken would
cost the user's trust in the report.

`unaddressed` is the state of every **rooted** identifier in a session
with no root mapping (§0.3). An implementation MUST distinguish it from
`missing`, and MUST NOT report it as `out-of-root`. **The order is the
identifier's first**: an absolute identifier, or one containing `..`, is
`out-of-root` before any mapping is consulted, so it is `out-of-root` in
a session with no mapping too. The published `Q02-locket-scene25` shows
both in one answer: the locket's rooted references are `unaddressed` and
its absolute one is `out-of-root`. The three are
different facts and lead to different actions:

| state | what it means | what a user does |
|---|---|---|
| `unaddressed` | nothing to resolve against | attach a project folder, or give the row an identifier |
| `missing` | resolved, and the bytes are not there | find the file |
| `out-of-root` | the identifier points outside the project **by construction** — absolute, or containing `..` | fix the identifier, or accept it will not travel |

`out-of-root` is a property of the identifier and does not depend on the
session. `unaddressed` is a property of the session and says nothing
about the identifier. Reporting an unmapped root as `out-of-root` tells
a user their paths are wrong when the truth is that no folder is
attached, and makes every asset in a lone `.scf` look broken.

The two ways to be `unaddressed` are distinguished by findings, not by
state: a row with no identifier raises `asset.identifier_absent`
(§9.4). A resolver reporting the state alone need not tell them apart;
one that wants to MUST use the finding.

Four cases at the edges of §8.2's grammar, each one line:

- **An identifier that does not parse** — `@`, `@/x`, an empty root
  name — names nothing, so it is `unaddressed` and raises
  `asset.identifier_absent`, as no identifier does.
- **A root name is compared exactly**: `@Project` and `@project` are two
  roots, and a mapping for one does not resolve the other.
- **A bare root** — `@plates` with no path — is rooted and names the
  root's own directory.
- **An identifier with a scheme** — `https://…`, `file://…` — is
  absolute, and so `out-of-root`.

Resolution MUST stay total. A document in which nothing resolves MUST
open, list everything, and report findings.

### 8.4 Purpose lives on the link

There is no intrinsic-purpose column on `asset`, and a conforming
implementation MUST NOT add one within the `asset` namespace (§10.1).

Use is a property of the link: `bundle_asset.role_in_bundle` and
`asset_relationship.relationship_type` carry it. A file used twenty ways
is twenty edges and one row.

`tags` is a freeform, user-controlled field. It is not a taxonomy and
MUST NOT be interpreted as one.

### 8.5 Format is a hint

An asset's format is derived from its identifier's extension. It MAY
dispatch preview and coarse filtering.

**The format string is exact**, because Q13 carries it and results are
compared. Take the identifier as stored; drop anything from its first
`?`; take what follows the last `/` or `\`; within that, the text after
the **last** `.`, lowercased. There is no leading dot, and a multi-dot
name is read by its last extension alone — `scan.tar.gz` is `gz`. A name
with no `.`, a name whose only `.` is its first character (`.env`), and
a name ending in `.` have no format, and the format is **null**. It is **never** a claim about
purpose.

An unrecognised extension MUST NOT be treated as an error, and MUST NOT
be handed to a renderer on the assumption that it will decode.

### 8.6 Orphans

An asset referenced by no field anywhere in the schema is an **orphan**.
Orphan detection MUST be derived from the registry (§2.3), not from a
maintained list.

`asset`'s own version columns MUST be excluded from the usage count: a
row whose only inbound reference is its own successor is still an
orphan.

**A polymorphic reference is a reference.** `asset_relationship.entity_id`
is polymorphic on `entity_type`, and `entity_type` is not a closed set,
so a row may legitimately relate one asset to another — a plate to the
concept painting it came from. Reading §2.3's first sentence alone
excludes such a row from the usage count and reports as an orphan an
asset the file plainly references. An implementation MUST resolve the
`polymorphicType` sibling per row and count the reference where it
resolves to `asset`.

Until schema 2.13 the fixture's `asset_relationship` table was empty, so
an implementation that got this right and one that did not produced
identical `asset.orphan` findings on every published case. It now
carries a textless poster master reachable only through that column.

**An asset may be about a SCENE or a SHOT rather than about a subject.**
A DOP's framing plate for one scene belongs to no character, prop or
location in it, and the media cascade (§7) starts at a subject, so a
binding is the wrong shape for it. Such an asset is related to the scene
or the shot through `asset_relationship` (`entity_type` = `scene` or
`shot`), and a consumer assembling everything in force at a position
SHOULD include those rows. There is deliberately no fourth binding
table: a binding carries precedence, baselines and filters, and none of
them means anything for "this picture is of that scene".

**What it is to the shot is the relationship type.** Four of
`relationship_type`'s members exist for this case: `storyboard` (a
panel planning the shot), `start_frame` and `end_frame` (the frames it
opens and closes on), and `previs` (a moving rough). Anything else a
shot or scene points at — a reference clip, a sound, a scan — is
`reference`, and §8.5 says what kind of file it is.

**Rows relating assets to the same entity are ordered** by
`asset_relationship.order` ascending, rows with no `order` after rows
with one, then by row id. An implementation listing them MUST present
them in that order. `order` positions a row among **all** of that
entity's related assets, not only those of its own `relationship_type`,
so a storyboard's panels keep their sequence whatever sits beside them.
Row id alone records when a file was attached, not where it falls.

**The film's poster is related to the project.** An asset related to
the `project` row with `relationship_type` `poster` is the film's key
art. A project may relate several: the first in the order above is the
poster, and any after it are alternatives. Q00 returns them (§12.12).
The member is not restricted by `entity_type`, but this section gives
it no meaning on any other entity.

**A bundle no binding reaches is the orphan one level up.** Its assets
are referenced — `bundle_asset` points at each of them — so no
`asset.orphan` finding is raised, and yet the media cascade (§7) starts
at a subject and never arrives: no query at any position returns them.
An implementation SHOULD report `asset.bundle_unbound`, at `info`, for a
bundle that no `*_asset_binding` and no `*_shot_override` reaches. It is
`info` and not a warning because a bundle assembled before anyone has
decided what it is for is a normal state of an unfinished film, and
§9.2's division is between a file that cannot be read and a file that is
not finished.

Which rows reach a bundle MUST be derived from the registry, as orphan
detection is: an entity declaring a reference to `bundle`, whose own
declared `subject` is an entity that it also references, binds that
subject to it. `costume_asset_binding` arrived in 2.16 through that
rule and not through an edit here — before it, a bundle of costume
references was unbindable by construction, which is what the fixture's
only such finding was.

### 8.7 Content metadata is read, never stored

`size_bytes` and `source_mtime` are stored, because they are hints about
the **reference** going stale.

Dimensions, channels, compression, duration, generator, and every other
fact about the **content** MUST be read from the file when shown and
MUST NOT be stored. There is no width column and a conforming schema
MUST NOT add one.

The accepted consequence is that content metadata cannot be queried.

### 8.8 Layers are reserved

A `.scf` that references another `.scf` is performing **composition**,
not reference. That is outside 1.0 (§0.4).

An implementation MUST NOT represent another `.scf` as an `asset` row.
The term for the eventual mechanism is **layer**; nothing else about it
is specified.

---

## 9. Findings

### 9.1 SCF describes; it does not enforce

The schema constrains almost nothing. A field the registry marks
`required` is one a row is **incomplete** without: a writer MUST NOT
refuse a row for lacking it, and a reader MUST report the absence
(§9.4). A value is absent when it is null, or text that is empty after
trimming. Duplicates, contradictions, and gaps are likewise
**findings** — reported, never rejected on write.

Two codes carry it, because §9.4 takes a severity from the catalog and
the two cases do not share one. `field.required_absent` (`info`) is an
unfinished row. `junction.endpoint_absent` (`warning`) is a link entity
missing a required reference: a connection with a missing end connects
nothing. Where a more specific finding already covers the same column —
`relationship.endpoint_absent` for `character_relationship`'s endpoints
(§6.5) — that one is raised instead, not as well.

A required reference that holds a value naming no row is
`reference.dangling`, not `junction.endpoint_absent`: the column is
filled, and what it is filled with points nowhere. `reference.dangling`
(`warning`) covers every reference column, required or not: every
conforming reader resolves such a value the same way, to nothing
(§9.2), and it is almost never what the author meant.

The flag said nothing at all until 2.15. The DDL declares no `NOT
NULL`, no finding existed, and the only consumer anywhere was a form
drawing an asterisk, so one implementation could refuse a row that
another wrote — and `shot.scene_id` is `required`, which made an
unplaced shot idea either conforming or corrupting depending on who
read it. §5.5 already says half-placed structure is valid and reported.
This says the same thing about a missing value.

A half-entered document is a normal state of work, not an error.

### 9.2 Resolvers are total

Every resolver MUST return a usable answer for missing, dangling, and
contradictory data, and MUST report the problem separately. A resolver
that throws on half-placed data is non-conforming.

Consumers MUST NOT assume a row is well-formed because it exists.

### 9.3 Extracted content is a proposal

Anything a tool extracts from a screenplay is a **proposal**, not a
fact. A writer MUST NOT create entities from extraction without user
confirmation, except where its own confidence model marks a proposal as
certain.

Props are the standing exception: **a prop MUST NOT be created by
automatic acceptance.** A prop is created only by explicit user action.

### 9.4 Findings are enumerated

Every finding a conforming implementation reports MUST carry a **code**
drawn from the catalog published as
[`finding-catalog.json`](finding-catalog.json), and MUST take its
**severity** from that catalog rather than assigning one at the point the
finding is raised.

The catalog carries its own version, on its own track: a code added to it
is a change to this specification, but the file's shape can change
without one.

Codes are `area.condition`, lowercase, dotted. They are a closed set:
adding one is a change to this specification, with a catalog entry naming
the section it derives from.

Severity describes the DATA, never acceptance of the file:

| | Meaning |
|---|---|
| `error` | The data contradicts itself or this specification, and two conforming readers would resolve it differently. **Not** a reason to refuse the file (§9.1) — a reason to fix it before anyone relies on the answer. |
| `warning` | Resolvable, and probably not what the author meant. |
| `info` | Worth reporting; nothing is wrong. |

A report over one unchanged file MUST be deterministic: the same
findings, in the same order, on every run. Ordering is by severity
(`error`, `warning`, `info`), then code, then table — both compared by
code point, a null table first — then lowest row id, a finding with no
row ids first. Without this a report cannot be
diffed, which is most of what reporting is for.

#### 9.4.1 What raises each code

**Every code's `table`, `rowIds` and `count` are stated here**, in the
two tables below. Where another section states the condition, the row
cites it, and that section governs when the code is raised; this one
governs what the finding carries. `count` and `rowIds` are as §9.5
defines them, per finding before §9.5 merges one code on one table into
one — so where this table says "one finding per row", the published
report holds one finding per table, its `rowIds` every such row and its
`count` their sum.

| Code | Raised when | `table` | `rowIds` | `count` |
|---|---|---|---|---|
| `header.application_id_absent` | The header's `application_id` is not SCF's (§1.2). | null | empty | 1 |
| `header.schema_version_mismatch` | The header's `user_version` encodes a schema version and `_scf_meta.schema_version` states a different one. | null | empty | 1 |
| `header.schema_version_newer` | `_scf_meta.schema_version` is a higher major.minor than the version the reader implements (§11.2). | null | empty | 1 |
| `extension.unknown_table` | A table that is not a registry entity, a §1.3.1 table or `_scf_meta`, `x_` tables included (§10.1). | that table | empty | 1 |
| `identity.table_absent` | A registry entity's table is not in the file. A §1.3.1 table that is absent is not a finding: a file with no screenplay has none. | that table | empty | 1 |
| `identity.uuid_column_absent` | A registry table, or a `uuidExtraTables` table (§1.3), that holds rows has no `uuid` column. Every check below on uuids covers the same tables. | the table | empty | its rows |
| `identity.unique_index_absent` | A table with a `uuid` column has no UNIQUE index whose one column is `uuid`. | the table | empty | 1 |
| `identity.uuid_missing` | Rows whose `uuid` is null or empty. | the table | those rows | their number |
| `identity.uuid_malformed` | Rows whose non-empty `uuid` is not 8-4-4-4-12 hexadecimal, either case. | the table | those rows | their number |
| `identity.uuid_duplicate` | A non-empty `uuid` on more than one row of one table, compared exactly. | the table | every row carrying a shared uuid | the number of shared uuids |
| `junction.duplicate_key` | Rows of a link entity share every natural-key column (§6.3) and agree on every other authored column. | the link table | those rows | 1 per key |
| `junction.duplicate_key_conflicting` | As above, and they disagree on at least one. | the link table | those rows | 1 per key |
| `structure.boundary_absent` | An act or sequence has no `start_scene_id`. | `act` or `sequence` | the span | 1 |
| `structure.boundary_dangling` | A `start_scene_id` names no scene in the file, cut or not. | `act` or `sequence` | the span | 1 |
| `structure.boundary_cut` | A span that is not itself cut has a `start_scene_id` naming a scene that is present and cut, so it covers no scene (§5.5). | `act` or `sequence` | the span | 1 |
| `structure.boundary_unnumbered` | A span starts at a scene with no `scene_number`. | `act` or `sequence` | the span | 1 |
| `structure.sequence_act_mismatch` | A sequence's scenes (§5.2) fall in more than one act (§5.3). | `sequence` | the sequence | 1 |
| `structure.scenes_before_first_act` | At least one act boundary resolves, and scenes precede the earliest. No act resolving is `structure.boundary_absent` or `structure.boundary_dangling`, not this. | `scene` | those scenes | their number |
| `structure.boundary_shared` | Two spans of one kind start at the same scene (§5.5). One finding for each span after the first in span order, the first keeping the scene. | `act` or `sequence` | that span | 1 |
| `structure.scene_not_in_script` | A scene has no heading line in the screenplay (§4.1). One finding per scene. | `scene` | the scene | 1 |
| `structure.shadow_row_unexplained` | `scene_sequence` rows that no sequence's derived membership explains (§5.4). One finding for all of them. | `scene_sequence` | those rows | their number |
| `structure.section_mismatch` | A section line's `structureRef` names a span not in the file, its label differs from the span's `name`, or it sits above a different scene than the span's `start_scene_id` (§1.3.1). One finding per line and per disagreement. | `screenplay_lines` | the line | 1 |
| `field.required_absent` | A `required` column is null or empty on rows of an entity that is not a link entity (§9.1). One finding per column. | the entity | those rows | their number |
| `junction.endpoint_absent` | As above, on a link entity (§9.1). | the link table | those rows | their number |
| `reference.dangling` | A reference column holds a non-empty value that names no row of its target, cut or not (§9.1). The target is the field's `referenceEntity`, or for a polymorphic column (§12.1.2) the table `polymorphicTarget` gives for the row's sibling value; a polymorphic column whose sibling is unset, or names no registry entity, is not checked. A value that is not an integer names no row. The version columns `parent_id` and `superseded_by_id` are not checked: the `identity.*` codes cover their chains. Where a more specific code covers the column (`relationship.endpoint_absent`, `structure.boundary_dangling`), that one is raised instead, not as well. One finding per column. | the entity | those rows | their number |
| `vocabulary.unlisted_value` | An open field holds a value outside its known set (§2.4); a `multiselect` is split on commas first. One finding per field and value. | the entity | the rows carrying it | their number |
| `relationship.endpoint_absent` | `character_a_id` or `character_b_id` is null or names no character in the file (§6.5). One finding per row; such a row is checked for nothing else. | `character_relationship` | the row | 1 |
| `relationship.self_pair` | Both endpoints name one character. One finding per row; checked for nothing else. | `character_relationship` | the row | 1 |
| `relationship.directionality_absent` | `directionality` is null. One finding per row. | `character_relationship` | the row | 1 |
| `relationship.duplicate_pair` | Two or more `mutual` rows describe one unordered pair, or two or more `a_to_b` rows one ordered pair. One finding per such group. | `character_relationship` | the group's rows | 1 |
| `relationship.contradictory_pair` | One unordered pair has both a `mutual` row and an `a_to_b` row. One finding per pair. | `character_relationship` | every row of the pair | 1 |
| `asset.identifier_absent` | An asset's `identifier` is null, empty, or does not parse under §8.2. One finding per asset. | `asset` | the asset | 1 |
| `asset.identifier_escapes_root` | The identifier's path contains a `..` segment (§8.2). One finding per asset. | `asset` | the asset | 1 |
| `asset.identifier_absolute` | The identifier is absolute (§8.2) and has no `..`. One finding per asset. | `asset` | the asset | 1 |
| `asset.orphan` | Nothing references the asset (§8.6). One finding per asset. | `asset` | the asset | 1 |
| `asset.bundle_unbound` | No binding and no shot override reaches the bundle (§8.6). One finding per bundle. | `bundle` | the bundle | 1 |
| `binding.baseline_replaces` | §12.8.2. One finding per binding. | that `*_asset_binding` | the binding | 1 |
| `binding.replace_tie` | §12.8.2. One finding per `replace` binding, naming only itself; the binding it ties with is in the message. | that `*_asset_binding` | the binding | 1 |
| `line.type_unknown` | A `screenplay_lines` row's `line_type` is outside §1.3.1's set. One finding per line. | `screenplay_lines` | the line | 1 |
| `line.anchor_orphaned` | A line anchor (§3.5) names no line of the screenplay. One finding per anchoring row and column, filed under the **anchoring** table. A range whose end is orphaned is reported here and not again below. | the anchoring entity | that row | 1 |
| `line.range_reversed`, `line.end_without_start`, `line.range_outside_scene` | §4.7, on a row with a line range and a scene to read it against. One finding per row, filed under the row's own table — `shot` and `clip` separately. | `shot` or `clip` | that row | 1 |
| `presence.shot_subject_not_in_scene`, `presence.named_but_on_screen`, `presence.off_screen_described` | §4.6, on a shot presence row. One finding per row. | `shot_character` or `shot_prop` | that row | 1 |
| `presence.complete_but_empty` | §4.6. One finding per shot. | `shot` | the shot | 1 |
| `presence.variant_foreign` | §4.8. One finding per scene link. | `scene_character` or `scene_prop` | that link | 1 |

**A merged finding's `message` is its first finding's**, followed by a
note of how many more there are. The others' messages are not carried —
two open fields of one table, both with unlisted values, report the
first field's sentence — and nothing is lost by it: a message is never
parsed (§9.5), and `rowIds` and `count` carry every occurrence.

**Seven codes describe a single row's version chain or external id**,
and are raised by inspecting that row rather than the whole file. A
validation report is not required to compute them, and the reference
validator's does not; an implementation that reports them uses these
conditions, on a row of a versionable entity:

| Code | Raised when |
|---|---|
| `identity.self_parent` | `parent_id` names the row itself. |
| `identity.chain_cycle` | Following `parent_id`, or `superseded_by_id`, returns to a row already visited. |
| `identity.chain_fork` | More than one row names this row as its `parent_id`. |
| `identity.chain_asymmetric` | `parent_id` or `superseded_by_id` names a row that does not exist, or `superseded_by_id` names a row whose `parent_id` is not this row. |
| `identity.successor_without_timestamp` | The row has a `superseded_by_id` and no `superseded_at`. |
| `identity.superseded_without_successor` | The row's `lifecycle_status` is `superseded` and it has no `superseded_by_id`. |
| `identity.external_id_without_namespace` | The row has an `external_id` and no `external_id_namespace`. |

`field.required_absent` and `junction.endpoint_absent` are raised once
per required column, so a row missing two required values counts twice
in `count` and appears once in `rowIds`.

This vocabulary covers **whether a file is well-formed**. It does not
cover whether a given query can be answered well from it — that is
readiness, a different question with a different audience, and the two
scales MUST NOT be conflated. A flawless file may still have too little
authored for a query to say anything useful.

### 9.5 The serialised report

A validation report MUST carry:

- `reportFormat` — the version of the report shape itself, on its own
  track. A consumer parsing a report needs to know how to read the
  REPORT, which changes for reasons unrelated to the format reported on.
- `toolSchemaVersion` and `fileSchemaVersion` — what the tool knows, and
  what the file claims. They differ routinely and both matter.
- `source` — identifies the file reported on, never its contents.
- `counts` — how many findings — objects in `findings` — were raised at
  each severity of §9.4. Not the sum of their `count`s: two orphaned
  assets are one finding (below), and `counts.info` is 1.
  **Every severity is a key, including those with a count of zero**, so
  a consumer never has to distinguish an absent key from a zero.
- `clean` — **true when `counts.error` is zero**, and false otherwise.
  It is a restatement of the error count, not a second judgement:
  warnings and info findings do not affect it. **`clean` does not mean
  "no findings"**, and it never means the file was accepted or refused
  — §9.1 leaves that to the consumer. It says only that no two
  conforming readers would disagree about what this file says.
- `findings` — the findings, in §9.4's order.

Each finding carries:

| | |
|---|---|
| `code`, `severity` | From the catalog (§9.4). |
| `title` | The catalog's one-line title for the code, so a report reads without one. Carried on the finding rather than looked up, because a report is read where the catalog is not. |
| `table` | The table the finding is about, or **null** where it is file-wide. |
| `rowIds` | The rows at fault. |
| `message` | One sentence, written for a person. **MUST NOT be parsed** — `code` is the machine-readable answer. |
| `count` | How many occurrences this finding stands for. |
| `spec` | The section of this document the finding derives from. |

**`rowIds` is an array and MAY be empty.** It is empty when the finding
is about a table or the file rather than about particular rows, and
carries several ids when the finding is inherently about a set — two
rows sharing a key, a contradictory pair. **An empty `rowIds` is not an
absence of evidence**, and a consumer MUST NOT treat it as one; `table`
and `message` locate a finding that no single row is at fault for.

**`rowIds` carries bare row ids, and this is the one place in SCF where
that is correct.** §6.2 and §12.1.2 forbid them in a query result
because a result travels and describes a story. A report does not
travel: it names one file, in `source`, and its whole purpose is to send
a person to a row in that file. Publishing uuids instead would be
useless at exactly the moment the report is read.

**`count` is an occurrence count, not a row count**, and the two differ
routinely: a finding standing for one duplicated uuid across two rows
has a `count` of 1 and two entries in `rowIds`. A finding MUST NOT be
raised more than once for the same condition on the same table — that is
what `count` is for — and `count` is **1** for a finding that stands for
a single occurrence, never 0. **One code on one table is one
condition**: two orphaned assets are one `asset.orphan` with `count` 2
and both rows in `rowIds`, ascending — not two findings, and not one
row. A finding about particular rows names every one of them; only a
finding about a table or the file has an empty `rowIds`.

**Findings are computed over every row, cut ones included.** §6.6.1 says
what a query answers, not what a validator reads: a reference from a cut
row still uses its asset, and a link to a cut scene is still a link. The
same holds for what a finding derives: story order and span membership
are derived over every scene, cut ones included, wherever a finding
depends on them (§5.4). A
cut row is not itself a finding (§6.6.2).

A report MUST be byte-identical across two runs over an unchanged file.
Any volatile field — a timestamp above all — MUST be omitted by default,
because a report that differs on every run cannot serve as a baseline,
which is most of what reports are for.

A tool reporting on a file it could not open MUST distinguish that from
a file it read and found errors in. Unreadable is not a finding: a
finding is something the implementation has an opinion about, and it
never got to look.

### 9.6 Reports accompany exports

Every export whose content includes asset references MUST carry a
resolution report naming what was referenced, what resolved, and what
did not. Silently omitting an unresolvable reference is non-conforming.

---

## 10. Extensibility and reserved names

### 10.1 Unknown content

A conforming reader MUST ignore tables, columns, and rows it does not
recognise, and MUST NOT treat their presence as an error.

A conforming writer MUST preserve unknown tables and columns across a
read-modify-write cycle. Data loss on round-trip is non-conforming.

### 10.2 Reserved names

Reserved to this specification, and MUST NOT be used by third-party
extensions:

- every table name defined by the registry, and every name in
  `UUID_EXTRA_TABLES`;
- every column name defined by the registry;
- the root name `@project`, and the root names `@plates` and `@nas`;
- the table-name prefix `scf_`.

### 10.3 Extension namespace

Third-party tables and columns MUST be prefixed `x_`. A name so prefixed
will never be claimed by this specification, and the reference
implementation's linter rejects any registry name that claims it.

A conforming writer MUST preserve `x_` tables, columns and rows across a
write cycle, on the same terms as any other unrecognised content
(§10.1). The distinction is one of intent, not of protection: unknown
content is preserved because it is unknown, whether or not whoever wrote
it followed the convention.

Third-party root names MUST NOT be introduced without registration,
since a root name that later becomes reserved would silently change
meaning.

---

## 11. Versioning and compatibility

### 11.0 When these rules take effect

**This section becomes binding at 1.0.** Before then, files written by
earlier schema versions are disposable: a change may remove a column,
alter a type, or rename a field outright, and no migration path is owed
to anything already written.

The one exception is `fixtures/hollow_creek.scf`, which is a normative
artifact (`conformance.md` §5.1) and is migrated with every change that
would otherwise invalidate it.

This is not a licence to be careless — it is a statement about *when*
the cost of compatibility is worth paying. Before 1.0 nobody has built
on the format, so a deprecation window protects nothing and leaves the
format carrying two descriptions of one fact. After 1.0 someone has, and
every rule below is expensive to violate.

Changes taken under this clause, each without the window §11.4 would
otherwise require:

- schema 2.9 widened `scene.scene_number` from integer to text;
- schema 2.12 removed `project.scene_numbering` one version after
  renaming it;
- schema 2.14 removed `scene.characters_present`, four other JSON
  columns holding names and the three `conditions_json` columns, and
  removed `cut` from the three `status` vocabularies and `continuous`
  from `scene.time_of_day`;
- schema 2.15 replaced two JSON columns with rows
  (`costume_progression.progression_stages`,
  `staging_beat.character_positions`);
- schema 2.21 removed `entity_anchor`'s three state columns;
- schema 2.24 removed `sequence.act_id`, renamed `clip.scene_id` to
  `clip.slated_scene_id` so that a clip outlives its scene, and dropped
  the per-entity `queries` member from `registry.json`.

`docs/schema-changelog.md` records each in full.

### 11.1 Schema changes are additive

A schema change MUST be an additive optional field wherever that is
possible. No conforming schema change may require existing files to be
converted.

### 11.2 Forward compatibility

A reader encountering a file with a higher schema version than it knows
MUST read what it recognises and ignore the rest (§10.1). It MUST NOT
refuse the file on version grounds alone.

### 11.3 Backward compatibility

A writer MUST preserve every table, column, and row it did not
originate, including those from a schema version it does not know
(§10.1).

### 11.4 Removal

A field MAY be removed only after being marked deprecated in a released
schema version, and MUST remain readable for at least one subsequent
version.

> **Note.** Several changes so far would not be permissible after 1.0
> and were taken deliberately before it, under §11.0: schema 2.8 removed
> `asset.asset_type` and `asset.file_path` one version after deprecating
> them in 2.7; 2.9 widened `scene_number` from integer to text, which
> SQLite cannot do to a column in place; and 2.12 removed
> `project.scene_numbering` immediately rather than carrying the window
> this section describes.

### 11.5 The specification version

Editorial changes to this document that do not change a requirement
increment the patch component only. Any change to a MUST or MUST NOT is
a minor version at minimum, and MUST be recorded in the specification
changelog.

A **release candidate** carries `-rc.N` after the version it precedes:
`1.0-rc.1` was the first candidate for 1.0, and `1.0-rc.4` is the fourth. Its requirements are the
release's unless a later candidate changes them, and each candidate is
recorded in the changelog like any version. §11.0 holds until the
release itself, so a defect found in a candidate is fixed in the next
candidate rather than carried as a compatibility cost.

### 11.6 Document equality

Two SCF documents are **equal** when their canonical dumps are equal.
Equality is never a byte comparison: SQLite reorders pages, reuses
freelist space and changes file size without any row changing, so
byte-different files routinely say the same thing.

A canonical dump is produced by:

- taking every table, sorted by name, **including tables this
  specification does not define** — a dump that skipped unknown content
  could not detect the loss §10.1 forbids;
- sorting each table's rows by `uuid` where the table has one, and by
  their full sorted content where it does not;
- sorting each row's columns by name;
- excluding row ids, which are file-local and are not identity (§6.2);
- excluding `_scf_meta`, whose `updated_at` changes on every save
  without the document changing.

A conforming Writer MUST produce an equal document when it opens a file
and writes it back without editing anything.

---

## 12. The canonical queries

### 12.0 What this section is

The sixteen canonical queries are part of the format. They can be
reinvented from §1–§11, but the point of SCF is to describe a film's
structure, and shipping the questions is that description. Defining them
does not preclude anyone asking others.

**All sixteen are specified below**, each with a normative result
published in `fixtures/expectations/`, and with a normative case result
(`<Q>-<case>.result.json`) wherever one position cannot show a member —
a variant, a vocal state, a prop or location subject, a version chain
(`conformance.md` §5.4). The rendered markdown in the same directory is
a convenience and is not a contract for any of them.

### 12.1 What a query returns

#### 12.1.1 The result envelope

Every canonical query returns:

| Field | |
|---|---|
| `query` | The query's id, e.g. `"Q05"`. |
| `resultFormat` | Version of this envelope, on its own track. A field added here is not a change to SCF. **Currently `1.1`**, and every published result carries it. |
| `schemaVersion` | The schema version the answering implementation implements — its registry's — not the file's `_scf_meta.schema_version`. A result describes the answer, and the answer is shaped by the schema the implementation knows. |
| `parameters` | What was asked. A parameter identifying a ROW is its **uuid**; a literal parameter — a query id, an enum value — appears as itself. **A row id MUST NOT appear**, so no parameter is a bare number. |
| `result` | The query's own structure, defined per query below. |

`parameters` makes a result self-describing: a reader handed one can
tell which question it answers without being told. **Every parameter
the query declares appears**, and an optional one that was not supplied
is **null** — never omitted, so a result asked without a shot says so.

#### 12.1.2 Rows in a result

**The normative answer is the result structure. Any rendering of it —
markdown, HTML, prose — is a convenience and is NOT normative.** Two
implementations that produce the same result and print it differently
are both conforming.

**The projected row.** Wherever a result carries a row, it carries an
object with exactly two members:

| Member | |
|---|---|
| `uuid` | The row's identity (§6.1), or **null** when the row carries none. |
| `fields` | An object holding that row's values under the registry's own column names. |

Both members are ALWAYS present, and `fields` is present even when it
holds nothing, as `{}`. A row with nothing authored is a row that
exists, and collapsing it to null would say something else.

**Nothing else appears beside them.** A projected row is not a place to
hang a derived value, because a consumer walking `fields` has to be able
to assume that every name in it is a registry column. Values a query
computed are §12.1.4's business, and belong next to the projected row
rather than inside it.

The shape is nested rather than flat so that identity and content never
share a namespace: in a flat shape a registry that one day declared a
column named `uuid` would overwrite the row's identity, and nothing
would notice.

**What `fields` contains:**

- **Row ids MUST NOT appear.** They are local to a file (§6.2) and a
  writer may renumber them. A result carrying one describes the file
  rather than the story.
- `id`, `created_at` and `updated_at` MUST be omitted. They differ
  between two files that say the same thing.
- **A value that is null, absent, or the empty string MUST be omitted**,
  so absence is unambiguous, and so is a `string_list` holding `[]`
  (§2.5). **Zero and `false` are values, not absences**, and MUST be
  kept — a `false` dropped as empty would be read back as unauthored.
- **A `boolean` column is carried as stored**: the SQLite integer, `0`
  or `1`. SQLite has no boolean type and the file holds the integer;
  `true` and `false` would be one implementation's reading of it.
- A column holding JSON is carried **as stored**, as the column's text,
  unparsed. The registry declares a column's type, not a schema for its
  contents, so a parsed value would be one implementation's reading of
  an opaque string rather than the value the file holds.
- **Reference columns MUST be resolved to uuids**: `scene_id` becomes
  `scene_uuid`, carrying the referenced row's uuid. A reference that
  cannot be resolved is omitted.
  **Which columns are references is declared by the registry**
  (`referenceEntity`, §2.3) and MUST be derived from it. An
  implementation maintaining its own list will project a column in one
  query and drop it in another, and nothing will notice.
- Field names are the registry's own column names. A result is made of
  registry fields; a second vocabulary for them would be a second thing
  to keep in step.

**A column the registry declares POLYMORPHIC MUST be dropped.** A
polymorphic reference — `motif_appearance.entity_id`,
`thematic_connection.entity_id`, `asset_relationship.entity_id`,
`entity_anchor.subject_id` and `subject_variant_id` — has its target
table chosen per row by a sibling column, so it carries no
`referenceEntity` for the previous rule to act on and holds a bare row
id that must not travel. **The registry says which columns these are**,
through `polymorphicType` (§2.3), which names that sibling column. The
sibling itself — `entity_type`, `subject_type` — is an ordinary stored
value and is kept.

**The sibling's value names the target table unless the column declares
`polymorphicTargets`**, a map from each of the sibling's values to the
target entity. `entity_anchor.subject_variant_id` is the one column that
does: keyed by `subject_type`, it points into `character_variant`,
`prop_variant` or `location_variant` — never into the table
`subject_type` names. A reader resolving it as the sibling's table reads
a variant id as a subject id, and on a file where both ids exist nothing
fails. Wherever this document resolves a polymorphic reference — §6.6.1,
§8.6, §12.8, a where-used walk — it resolves it this way.

A reference MAY target a table in `uuidExtraTables` (§1.3.1) rather than
one of the registry's entities, since those tables carry uuid identity on
§6.1's terms, and it resolves to `<name>_uuid` like any other reference.
A screenplay LINE is the exception: it is never referenced by row id but
named by a line anchor (§3.5), whose stored value is already its uuid.

**A column whose name merely ends `_id` MUST NOT be dropped on that
basis.** Until 0.40 this section said the opposite, and the difference
is not academic: `external_id` (§6.3) is a declared, authored field on
sixteen entities, and the clip's two line references of the time were
ordinary references whose target was a screenplay table rather than a
registry entity. The old rule silently deleted twelve legitimate
columns from every projected row.

**No published artifact could catch that**, which is why it survived
four revisions and three reader runs: the conformance fixture authored
no `external_id` and its `clip` table was empty, so the omit-empties
rule above makes a correct implementation and a data-losing one produce
byte-identical output on all sixteen published results. A rule that
pattern-matches on a name will eventually match something the name
did not mean; a rule that reads a declaration will not.

**Where a query needs the target itself, it MUST resolve it and carry it
beside the projected row, never inside it.** §12.11 is the worked
example: Q10 keeps `entity_type` in the connection's `fields`, drops
`entity_id`, and publishes `targetEntity`, `targetUuid` and `targetName`
as members of the carrier record. A polymorphic reference whose kind is
not a registry entity, or whose row is absent, resolves to a null
`targetUuid`. That is a legitimate answer (§9.2): the query does not
fail. Where the kind is a registry entity and the row is absent, the
report carries `reference.dangling` (§9.4.1).

**A result MUST NOT contain a cut row** (§6.6.1). It carries
`lifecycle_status` on the rows it does contain, because an
implementation may legitimately mark something cut between one answer
and the next, and a consumer holding a result should be able to see what
it was told.

#### 12.1.3 Composition

An earlier note recorded a decision that a composite query's result
would **nest** the result bodies of the queries it is built from. That
decision has not been applied, because the premise was wrong: no
canonical query calls another. What look like composites assemble their
own answers from the same resolvers, and Q01 and Q02 share a helper
rather than a result.

So each query defines its own result shape. Where two queries genuinely
share a composition — as Q01 and Q02 do — the shared part is one
function in one place, and both results state the same structure for it.
Nesting remains available where a query genuinely is built by calling
another, and carries the inner `result` body without its envelope.
**Exactly one query does this**: Q02's media layer is Q13's answer at a
position (§12.16), and it carries Q13's result body with the query it
came from named.

#### 12.1.4 Values that are not rows

Not every member of a result is a projected row, and the difference is
normative, because the two obey **opposite rules about absence**.

A **derived record** is an object a query composes rather than reads. It
mixes values drawn from several rows with values a resolver computed, so
no single registry column set describes it. §12.8's `references` entries
are the clearest case: the asset's `identifier` comes from the asset
row, `anchorName` from the link that reached it, `state` and `detail`
from the resolver, and `sizeBytes` from the filesystem.

**A derived record has a fixed member set, declared by the query's
section below, and every declared member MUST be present. An absent
value is carried as null and MUST NOT be omitted.** §12.1.2's
omit-empties rule does not apply here and MUST NOT be applied to it.

The asymmetry is deliberate. In a projected row, an absent field means
"not authored", and a consumer can discover which fields could have been
there by reading the registry. A derived record has no registry to ask,
so an omitted member and a member that legitimately has no value would
be indistinguishable, and a consumer could not tell a reference with no
role from a reference whose role it failed to parse. This is why
`"role": null` appears in a published Q13 result while an unauthored
`role` on a projected row is simply gone.

**A derived record that carries a projected row names that member for
the entity**: §12.4's entries carry `character` and `prop`; §12.10's
manifest entries carry `motif`, `appearance` and `state`; §12.11's
carriers carry `connection`. **A section MAY name it otherwise and then
MUST say so**, and every section that does is listed here: §12.5's
`relationship`, §12.13's `beat` and `arc` and its `identification`'s
`row`, §12.15's `appearance`, and §12.17's `lineage`, whose entries are
`{entity, row}` because one array holds two kinds. §12.14's top-level
row is `row`, because it may be of any entity.

This was unstated until 0.40, and it is the member every derived record
has. A reader could see from §12.1.2 that a projected row has exactly
two members and that computed values sit beside it rather than inside
it, and had nothing telling it what the row itself sits under. Five of
the sixteen sections could not be shaped correctly from the document,
and a reader that guessed differently would answer the same question
with a structurally different result and nothing to warn it.

A **label list** is an array of bare strings naming rows the result does
not carry — §12.1.5.

A **scalar** — a count, a boolean, a threshold — is itself. Where a
scalar is a **judgement rather than a fact**, the query MUST publish
whatever produced it alongside it, so a consumer can see the basis
instead of inferring it: §12.10 requires `densityThreshold` beside
`dense` for exactly this reason.

#### 12.1.5 Vocabularies and label lists

Every string in a result is one of the following, and each query's
section below MUST say which each of its strings is:

| | |
|---|---|
| **A stored value** | Carried through from a column. Its vocabulary, where it has one, is the registry's, and this section adds nothing to it. |
| **A closed vocabulary** | A fixed set of strings **this specification** defines and a conforming implementation MUST produce exactly. Adding a member is a change to this specification. |
| **A label list** | An array of bare strings, each the `name` of a row the result does not otherwise carry. |
| **A formatted string** | Built from stored values by a format its section states exactly, and compared byte for byte. §12.17's `mismatches` is the only one. |
| **Prose** | Written for a person, MUST NOT be parsed, and compared only as present or null (`conformance.md` §6.1): §12.8's `detail` and `excluded.reason`, and §12.9's finding messages. |

The closed vocabularies of §12 are: the resolution states of §8.3, as
they appear in §12.8's `state` and in every `counts` keyed by them; the
readiness severities of §12.9; and §12.8's `provenance`, a trail entry's
`layer`, and `excluded.by`. There are no others. A string not covered
by one of them is one of the other kinds above, and is named as such
where it appears.

**A label list is a convenience, not an identity.** A bare name cannot
be resolved back to a row — two rows may carry the same one, and a name
may be edited without the thing it names changing. **A consumer needing
identity MUST ask the query that carries the rows themselves**, which
for §12.5's lists is §12.4 at either position.

They exist because the queries that use them are **diffs**, and a diff
whose two sides are full projections is unreadable at the moment a
person most wants to read it. Where a query carries a label list, its
section below MUST name the column the labels are taken from.

#### 12.1.6 Order within a result

**Where a section takes "the" row of an entity a file may hold more than
one of** — Q00's layers, Q05's `baseline`, a cascade layer (§7.3) — **it
is the lowest row id among the rows that qualify**, cut rows excluded
(§6.6.1). The fixture holds one of each of those, so no published result
shows the lowest-row-id rule; it is stated so that two implementations
agree on a file that holds two. A `latest_wins` cascade layer is the
exception §7.3 states: it is §4.5's pattern 3, and takes the highest row
id at its position, which the published `Q07-scene3` pins.

**Every array in a result is ordered, and each query's section below
states the order for each of its arrays.** An array whose order is not
stated there is in **story order** (§4.1) where its members have a
story position — a scene, or a row keyed to one — by that position and
then row id; and where they have none, in **row order**, or registry
order for an array of entities.

**Row order is a last resort, and a section MUST NOT rely on it
silently.** The fallback above exists so that two implementations agree
on an array whose order no section states, and the sections below state
each array's order where a reader could otherwise take two — rows
reached through a junction say which table's row order they take. Row
order is a fact about the file rather than about
the story, so a result that falls back on it is answering with
something the story does not contain. Where a section needs it — because the rows are
peers with no story position of their own, as §12.2's `beats` within a
`beat_order`, the `characters` of §12.4 and §12.5, and §12.10's
`manifest` are — that section states it.

This paragraph read "Nothing in a result is in row order" until 0.40,
which was flatly contradicted by both of those sections and by a
published artifact: §12.5's `characters` were emitted in junction row
order while nothing said so. The absolute was the wrong shape for the
rule — the problem is unstated reliance, not reliance.

**Member order within an object is not part of the answer.** Results
compare as JSON values, not as bytes, on the same reasoning as §11.6.
An implementation MAY serialise members in any order and remain
conforming.

The **published artifacts** are nonetheless serialised to a fixed order
so that they diff cleanly and can be regenerated and checked byte for
byte: envelope members in the order §12.1.1 lists them, `fields` keys
ascending by code point. That is a property of the artifacts, not a
requirement on an implementation, and conformance is never a byte
comparison against them.

#### 12.1.7 Positions, and questions that are not answered

**A shot fixes the position at its own scene.** A query that takes
`shot` answers at the shot's scene: asked with a `shot` and no `scene` —
Q13, and Q14 for Q13, where `scene` is optional — the shot's scene is
the position, exactly as if it had been asked; the envelope still
records `scene` as null, because §12.1.1 records what was asked. The
published `Q13-shot1204` shows it: the scene-ranged binding applies
there as it does at scene 12, where reading "no scene" as "no position"
would have excluded it as `not_baseline`. **A `shot` that is not in the
`scene` asked** — Q07, Q02, Q13 or Q14 — is a question that contradicts
itself, and **is not answered**. Nothing in the data is wrong, so it is
not a §9.2 case; answering it would mix one scene's palette with
another's shot design.

**A `scene` naming a cut scene is a position with nothing at it**
(§6.6.1): every query asked there answers as at an empty position, as
Q03 always has (§12.4). Its `scene` member is null, and every member
read at the position is null or empty — rows still keyed to the cut
scene are not cut themselves, and are not read. What a query reads
independently of the position still answers: the subject itself, a
character's baseline (Q05), a cascade's project-level layers (Q07, Q11),
a baseline binding (Q13). Q12 with one side cut compares an empty
position with the other. This is §9.2: the data is what it is, and the
answer is total. A shot of a cut scene is at that empty position.

**A question that is not answered has no result.** No envelope is
returned and nothing is compared: an implementation reports the refusal
the way it reports any malformed call — an error, a refused tool call —
and MUST NOT return an envelope with a null `result`, which would read
as an answer. The cases are this section's contradictory shot and
scene, and §12.9's Q14 for Q02 or Q13 with no subject or for Q13 with
no `intent`.

### 12.2 Q05 — Voice direction

**How this character's lines should sound in this scene.**

Parameters: `character`, `scene`.

The result composes three things a consumer would otherwise have to
assemble: the character's standing description, whatever is temporarily
true of them here, and anything authored line by line.

| Field | |
|---|---|
| `modality` | `"vocal"`. Q06 is the same query with `"physical"`. |
| `baseline` | The character's `vocal_profile` — for Q06, their `physical_character_profile` — projected per §12.1.2, or **null** when none is authored. |
| `states` | `performance_state` rows of this modality in force at this scene, resolved by §4.5 pattern 2, **oldest first**. |
| `modulations` | The states' `modulations` merged oldest-first, so a later state overrides an earlier one key by key. Derived; carries no identity. |
| `beats` | `performance_beat` rows for this character, scene and modality, in `beat_order` — an unset one as 0, as §12.17's beat arrays take it — then row order. |

A null `baseline` is a well-defined absence, not an error (§9.2). It is
what a readiness report exists to warn about — the fixture leaves one
character deliberately thin for that reason.

`modulations` is a merge of an opaque JSON column. Where two states
carry the same key, the later one wins; §4.5's "field by field" means
keys within that object.

### 12.3 Q07 — Look resolution

**What a frame in this scene, or this shot, should look like.**

Parameters: `scene`, and `shot` — optional.

| Field | |
|---|---|
| `leaf` | The cascade's leaf entity (§7.1). |
| `layers` | Root first, each `{ entity, row }`, the last being the opinion in force (§7.4). |

#### 12.3.1 The leaf depends on the parameters

| Given | Leaf |
|---|---|
| scene only | `scene_color_palette` |
| scene and shot | `shot_design` |

This is what §7.1 means by the leaf not being derivable from the data:
it is a property of the question. A conforming implementation MUST use
the leaf this table gives, and MUST resolve the chain by §7.2's
`refines` closure — not by any ordering of `scope`.

#### 12.3.2 Layers

Each layer is one entity's contribution, selected by §7.3. An entity in
the chain that supplies no row is **absent from `layers`**, not present
and empty.

`layers` MAY be empty. A scene with no authored look is a legitimate
answer and not a finding.

### 12.4 Q03 — World state

**Everything true at one position.**

Parameter: `scene`.

| Field | |
|---|---|
| `scene` | The scene itself, projected. Null when the position does not resolve — including when the scene is cut (§6.6.1). |
| `characters` | Each character present, with their `presence` (§2.4.1), the `variant` in force there (§4.8; projected, or null), the `states` in force there — `performance_state` rows of every modality, resolved by §4.5 pattern 2, oldest first, each projected — and the `costumes` they are wearing — each a projected `costume`, in the row order of this scene's `costume_scene` rows. In the row order of this scene's `scene_character` rows (§12.1.6). |
| `props` | Each prop present, with its `presence` (§2.4.1), its `variant` in force (§4.8; projected, or null) and its `state` at this position by pattern 3, or null where none is yet established. In the row order of this scene's `scene_prop` rows. |
| `motifs` | Motif appearances at this position: name and domain. These come from a join rather than a table and carry no identity of their own. In the row order of the `motif_appearance` rows. |

Presence is authored, not inferred: a character is at a position
because a `scene_character` link says so, not because a state mentions
them. **What the link says about being seen is its presence (§2.4.1)**,
and each character and prop carries it as `presence`. A `mentioned`
character is at the position and is not on screen.

A cut scene answers as an empty position rather than an error (§9.2):
`scene` null, and no characters, props or motifs.

### 12.5 Q12 — Continuity

**What changed between two positions.**

Parameters: `from`, `to`.

| Field | |
|---|---|
| `from`, `to` | The two scenes, projected. |
| `characters` | Each character present at either position, projected, with `presenceFrom` and `presenceTo` (§2.4.1; null at a position that does not link them), `variantFrom` and `variantTo`, and `statesFrom` and `statesTo`. The `scene_character` rows of both positions are pooled in row-id order, and each character is placed at its first row — not `from`'s characters and then `to`'s. These are peers with no story position of their own (§12.1.6). |
| `relationships` | Each relationship with a stage at either position: `{relationship, stageFrom, stageTo}`, the relationship projected, each stage its `stage_label` or null. In row order. |
| `props` | Each prop with a state at either position, projected, with `presenceFrom` and `presenceTo` (§2.4.1; null at a position that does not link it), `variantFrom` and `variantTo`, and `whereFrom` and `whereTo`. In `prop` row order. |

A row appears when it has something to say at **either** position, so an
appearance and a disappearance are both visible.

**The paired members are labels, not rows** (§12.1.5), and each names
the column it is taken from:

| Member | Kind | Taken from |
|---|---|---|
| `statesFrom`, `statesTo` | Label list, resolved by §4.5 pattern 2, **oldest first** | `performance_state.name` |
| `stageFrom`, `stageTo` | A single label, or **null** where no stage is in force | `relationship_state.stage_label` |
| `variantFrom`, `variantTo` | A single label, or **null** where no variant is in force (§4.8) | `character_variant.name` / `prop_variant.name` |
| `whereFrom`, `whereTo` | A single label, or **null** where no state is in force | `prop_state.whereabouts` |

Each is a derived record member under §12.1.4, so a null is carried
rather than omitted. **A consumer needing the state rows themselves MUST
ask §12.4 at either position**, which returns them projected.

**The two positions are ordered by §4.1, never by their scene numbers.**
Under `fixed` numbering a scene numbered 16 may play after one numbered
19, and diffing them by number resolves every pattern-2 and pattern-3
state at the wrong position. The conformance fixture is built so that
this is not hypothetical: its blessed Q12 result diffs 19 → 16, which is
forward in the script and backward by number.

### 12.6 Q06 — Physical direction

**How this character moves and behaves in this scene.**

Q05 with `modality` `"physical"`. Same parameters, same result
structure, different content: **`baseline` is the character's
`physical_character_profile`**, `states` and `beats` are those of
modality `physical`. It is one definition rather than two
because two would be two places for the shape to change.

### 12.7 Q08 — Soundscape

**What this scene sounds like.**

Parameter: `scene`. **No shot.** Sound is authored at the scene, and
there is no shot-level sound entity to be a leaf (§7.1), so `shot` is
always null in the envelope. That is stated rather than left for an
implementer to discover by finding nothing.

Leaf: `scene_music_design`. Result structure as §12.3.

### 12.8 Q13 — Media resolution

**Which assets are in force for a subject and an intent.**

Parameters: `subjectType`, `subject` — a character, prop, location or
costume — `intent`, and `scene` and `shot`, both optional; a `shot`
alone fixes the position at its scene (§12.1.7). All five appear in the
envelope, as §12.1.1 requires: `intent` and `subjectType` were carried
only in the result until 0.40, which left the envelope unable to say
what question it answered.

| Field | |
|---|---|
| `subjectKind` | The subject's KIND — `character`, `location`, `prop`, `costume` — echoing `subjectType`. **Not its uuid**, which the envelope's `subject` carries. It was itself named `subject` until 0.41, four lines from an envelope member of the same name meaning something else. |
| `intent` | The intent asked for, echoed. |
| `trail` | Every layer the cascade considered, **broadest first**, matching §7.4's root-first convention: one derived record per binding, anchor and shot override, below. |
| `references` | Each asset in force, **most specific first** — shot overrides, then anchors, then bundles in §12.8.2's order. |
| `counts` | References per resolution state, keyed by §8.3's states. Every state is a key, including those with a count of zero. |
| `rootMapped` | Whether the session had a root mapping at all. |

**A reference names its asset by uuid**, never by row id (§12.1.2).

**Each reference is a derived record** (§12.1.4), not a projected row.
Its members are fixed, and one absent is carried as **null**:

| Member | Kind | |
|---|---|---|
| `uuid` | Identity | The asset's own uuid, taken from the asset row. Never resolved from a row id — see below. |
| `name`, `identifier`, `format` | Stored values | From the asset. |
| `role` | Stored value | `bundle_asset.role_in_bundle` where the cascade reached this asset through a bundle. Free-form; the registry constrains it, this section does not. Null otherwise. |
| `anchorName` | Stored value | `entity_anchor.name` where the reference came from an anchor. Null otherwise. |
| `intent` | Literal | Echoes the `intent` asked for. |
| `provenance` | **Closed vocabulary** | Which layer put this reference in force: `shot override`, `anchor`, `bundle`. |
| `state` | **Closed vocabulary** | The resolution state, §8.3. |
| `detail` | Prose | Why, for anything not `resolved`. Written for a person and **MUST NOT be parsed**; `state` carries the machine-readable answer. Null when `state` is `resolved`. |
| `sizeBytes` | Number | Read from the resolved file. Null unless `state` is `resolved`. |
| `lifecycleStatus` | Stored value | The referenced asset's `lifecycle_status`, unset read as `active`. |
| `supersedes` | Identity or null | The uuid of the superseded asset this reference stands in for, where the paragraph below replaced one. Null otherwise. |

**An asset appears at most once.** The layers are walked most specific
first and an asset already carried is skipped, so `provenance` names the
**strongest** layer that reached it rather than every layer that did. An
asset both overridden at the shot and present in the bundle appears once,
as `shot override`. Reporting it twice would make `counts` disagree with
the number of distinct assets a consumer has to fetch.

**A superseded asset gives way to its successor.** Where a layer
brings an asset whose `lifecycle_status` is `superseded`, the
reference names instead the last asset on its forward version chain:
`superseded_by_id` followed until a row that is not `superseded`, or
until the chain names no further row. The successor keeps the layer's
`provenance`, `role` and `anchorName`, and its `supersedes` member
names the asset the layer brought. The at-most-once rule then applies
as written, so a successor that another layer already carries appears
once, under the stronger layer. The rule keys on the status, the
author's explicit claim: an `active` asset that has a successor is
left as it is.

A superseded asset with no successor stays, as it is, and so does one
whose `superseded_by_id` names a row that is not in the file or whose
chain returns to a row already visited: the resolver is total (§9.2),
and `identity.superseded_without_successor`,
`identity.chain_asymmetric` and `identity.chain_cycle` already report
each gap.

This is not exclusion. §6.6.1 excludes a row from the film; this
answers which version of a file to use, and Q15 still walks the whole
chain. A cut successor is excluded by §6.6.1 like any other cut row,
and the reference is then dropped, not walked back. `deprecated`,
`archived` and `draft` assets stay in force, unchanged;
`lifecycleStatus` makes them visible so that a consumer can choose
what to do rather than rediscover them.

**Each trail entry is a derived record** (§12.1.4):

| Member | Kind | |
|---|---|---|
| `layer` | **Closed vocabulary** | `binding`, `anchor` or `shot override`. |
| `uuid`, `name` | Identity, stored value | The binding, anchor or override row's. |
| `bundle` | Derived record or null | `{uuid, name}` of the bundle a binding or an override brings; null for an anchor. |
| `excluded` | Derived record or null | Null when the layer contributed. Otherwise `{by, value, reason}`. |

`excluded.by` is a **closed vocabulary**, one code per reason a layer
does not contribute:

| `by` | `value` | |
|---|---|---|
| `not_baseline` | null | No position was asked about, and the binding is not a baseline. |
| `before_scene_range`, `after_scene_range` | null | The position is outside the binding's scene range. |
| `time_of_day_filter`, `physical_state_filter`, `vocal_state_filter` | The filter's value | The filter does not hold here (§12.8.1). |
| `variant_id` | The filtered variant's uuid | The variant the binding names is not in force (§4.8). |
| `replaced` | The replacing binding's uuid | A `replace` binding of higher precedence is in force (§12.8.2). |
| `variant_not_in_force` | The variant in force's uuid, or null | An anchor naming a variant that is not the one in force. |
| `displaced` | The variant in force's uuid | A subject's own anchor, set aside by its variant's anchor of the same type. |
| `canonical_status` | The anchor's status | An anchor that is not verified. |

**Each excluded layer carries ONE `by`, the first that applies.** For
a binding: `not_baseline`; then `before_scene_range`,
`after_scene_range`; then `time_of_day_filter`, `variant_id`,
`physical_state_filter`, `vocal_state_filter`; then `replaced`, which
only a binding passing every filter can be. For an anchor:
`canonical_status`, then `variant_not_in_force` or `displaced`. So an
unverified anchor that a variant would also have displaced reports
`canonical_status`, as the published `Q13-scene25` shows.

**Anchors appear in `trail` in three runs**, each in row order: those
excluded by `canonical_status`, then those excluded by
`variant_not_in_force` or `displaced`, then those that contribute.

**`excluded.reason` is prose**, written for a person, and like
`detail` it MUST NOT be parsed and is not compared (`conformance.md`
§6.1); `by` and `value` are the answer. A binding or override whose
bundle is of another intent, and an anchor of another anchor type, is
not considered and has no entry. **Neither is one whose bundle or asset
is cut**: a link whose endpoint is cut joins nothing (§6.6.1), so a
binding to a cut bundle and an anchor on a cut asset are absent from
`trail` as well as from `references`, and an anchor on a cut asset
displaces nothing. A bundle or asset that is ABSENT is different: the
row reaching it is still in the film, dangling, and is considered.

**`trail` and `references` run in opposite directions**, and both are
deliberate: the trail reads as an explanation, broadest first, the way
§7.4 returns a cascade; the references read as an answer, most specific
first, so the opinion in force is at the top.

**An anchor contributes the asset it anchors**, not itself. An
`entity_anchor` row names a place in an asset — a face, a frame, a
region — and carries no identifier of its own, so reporting the anchor
row as the reference would produce something that can never resolve.
The reference carries the asset's identity and the anchor's name in
`anchorName`.

**An intent is answered by anchors of one type**, and only anchors of
that type are considered. An intent the table does not list — the
registry's `behavior`, or an unlisted value of the open vocabulary —
is restricted to no type: every anchor of the subject is considered.

| `intent` | `anchor_type` |
|---|---|
| `visual_identity`, `surface`, `environment` | `visual` |
| `voice_identity`, `acoustic` | `audio` |
| `motion`, `performance` | `motion` |

**Only a verified anchor contributes**: one whose stored
`canonical_status` is `verified`, or is null or empty, which this
section treats as verified. The vocabulary's other members —
`candidate` and `rejected` — mark an anchor still being decided or
turned down, and identity cannot rest on it; such an anchor is
considered, does not contribute, and appears in `trail` excluded by
`canonical_status`. **A row inserted without naming the column is not
null**: it takes the registry's default, `candidate`, and so does not
contribute.

**An anchor naming a variant contributes only where that variant is in
force (§4.8).** `entity_anchor.subject_variant_id` names it, as a row of
the subject kind's variant table — `character_variant`, `prop_variant`
or `location_variant`, per the registry's `polymorphicTargets`
(§12.1.2), never the table `subject_type` names. An anchor naming none
is the subject's own. **Only a verified variant anchor displaces**: one
excluded by `canonical_status` sets nothing aside. **Where a variant is in force and has
at least one anchor of the requested anchor type, the subject's own
anchors of that type do not contribute.** An anchor is identity — "this
is her face" — and two faces at one position contradict rather than
combine; where the variant has no anchor of that type, the subject's own
still apply. **With no position, only the subject's own anchors
contribute.** An anchor that does not contribute MUST appear in `trail`
with the reason, as an excluded binding does (§12.8.1).

Until 0.60 `subject_variant_id` was declared and read by nothing, so an
anchor recorded for a variant was returned as the subject's own at every
position, and no published result could show it.

**A bundle contributes its assets in `bundle_asset` order**: by
`order` ascending, rows without one last, then by row id — §8.6's rule,
applied to a bundle's members. Each reference's `role` is that
`bundle_asset` row's `role_in_bundle`.

**A shot override contributes its `bundle_override_id` bundle**, at the
shot asked about, when that bundle's intent is the one asked for; its
`role`s come from the bundle as above. `override_types`,
`variant_target_id` and the `*_delta` columns describe the override for
a reader and change nothing Q13 returns: no shot-level variant is put in
force by one (§4.8).

**An anchor has no state filter.** It applies wherever this section
says, and its `condition_description` describes the asset for a reader;
it never scopes the anchor. Media for a subject in a particular
performance state is a binding with a state filter (§12.8.1); a
different design of the subject is a variant (§4.8). Until 0.61
`entity_anchor` declared `physical_state`, `vocal_state` and
`environmental_state`, free text that nothing read, so an anchor
"scoped" by one applied everywhere; they were removed (proposal 0034).

**An anchor's audio span** is `audio_offset_start_sec` and
`audio_offset_end_sec`: non-negative seconds from the start of the
asset's playable audio, t = 0 at its first sample. The span is
start-inclusive and end-exclusive, and where both are set the end MUST
exceed the start. A null bound is open — a null start runs from the
beginning, a null end to the end, and both null are the whole recording.
On an asset with no audio the two are meaningless and a reader MUST
ignore them. They locate the part of the recording the anchor names;
like the region, they do not change which references are in force.

#### 12.8.1 A binding applies where every filter it declares is satisfied

A `*_asset_binding` row may narrow when it applies. **A binding is in
force at a position only where EVERY filter it declares is satisfied**;
the filters compose as AND, and a filter left null is no condition at
all. A conforming implementation MUST evaluate every filter the registry
declares on that entity.

| Filter | On | Satisfied where |
|---|---|---|
| `scene_range_start_id` / `scene_range_end_id` | all | the position is within the range, in **story order** (§4.1) |
| `time_of_day_filter` | `location_asset_binding` | the scene's `time_of_day` equals it, compared trimmed and case-insensitively, over `scene.time_of_day`'s vocabulary |
| `variant_id` | `character_asset_binding`, `prop_asset_binding`, `location_asset_binding` | §4.8 puts that variant in force at the position |
| `physical_state_filter` / `vocal_state_filter` | `character_asset_binding` | a `performance_state` of that modality is in force at the position (§4.5) and its **name** matches, trimmed and case-insensitively |

**Asked with no position, only baselines apply and no positional filter
is evaluated.** There is nothing to evaluate one against, and a baseline
declaring one is answering a question nobody asked.

**A binding excluded by a filter MUST appear in `trail`, with the filter
that excluded it.** An absence is an answer, and the reason is the part
a consumer cannot reconstruct: a binding that simply vanishes is
indistinguishable from one that was never written. Until 2.16 six
columns narrowed a binding and the cascade read one of them, so a
binding scoped to a variant or a time of day applied everywhere and its
trail line said it fired (proposal 0027).

`rootMapped` is a fact about the SESSION, not the file. With no root
mapping every reference with a rooted identifier is `unaddressed` (§0.3,
§8.3) — not `out-of-root`, which is a property of an identifier, and
which an absolute or `..` identifier keeps whatever the session. A result reporting
zero resolved references and `rootMapped: false` is describing a
perfectly healthy file that nobody has pointed at a folder.

**A result carries references, never bytes** (§8.1).

#### 12.8.2 When several bindings are in force

Several bindings can be in force for one subject and one intent at one
position. **They are taken in order of `precedence`, highest first**;
equal precedence is ordered by row id, lower first. A null `precedence`
is 0. That is the order of
the bundle layer in `references`. **`trail` lists the same bindings in
the reverse order**, lowest precedence first, before the anchors and the
shot overrides, so that it runs broadest first (§12.8).

**`precedence` is the author's ranking, and higher is the more specific
opinion.** The format does not rank bindings by what they filter on:
whether a scene range is more specific than a physical state has no
answer, so the author says. A baseline SHOULD have precedence 0, so that
every binding scoped to something ranks above the one that applies
everywhere. This is a recommendation, not a rule, and the ordering
answers either way.

**Precedence only orders.** Two bindings in force both contribute,
unless one replaces the other. A binding declares which with `combine`:

- **`add`** (the default): it contributes alongside the others in force.
  A binding that never sets `combine` answers exactly as bindings did
  before 2.18.
- **`replace`**: while it is in force, every binding for the same subject
  and intent **with lower precedence** is excluded, and MUST appear in
  `trail` as excluded, naming the binding that replaced it (§12.8.1's
  rule that an absence carries its reason). Where several `replace`
  bindings are in force above it, the one named is the **first** in
  the order above — the highest precedence, then the lowest row id. A binding already excluded
  by one of its own filters is reported with that filter instead.

**Replacing reaches the bundle layer only.** Anchors and shot overrides
are never replaced by a binding: an anchor is the identity the other
references agree with, and a shot override is already the most specific
thing the file can say. **Equal precedence is never replaced**: a tie is
ordered, not resolved.

Neither global rule would do. Taking everything hands a night scene its
location's day plates; letting the most specific binding win drops a
character's identity references wherever a state bundle adds a look. A
night plate replaces and a wounded look adds, and only the binding's
author knows which it is.

These are reported rather than refused (§9.2), checked on the bindings
as written, not at a position:

| Finding (§9.4) | Raised when |
|---|---|
| `binding.baseline_replaces` | A baseline has `combine = replace`. It applies everywhere, so it excludes every lower binding for its subject at every position. |
| `binding.replace_tie` | A `replace` binding shares its subject, its bundle's intent and its precedence with another binding. Equal precedence is never replaced, so the `replace` does nothing against it. |

### 12.9 Q14 — Readiness

**What is missing for another query to answer well.**

Parameters: `target` — the query being assessed, a literal — and **the
target's own parameters**, under Q14's names for them:

| Target | Asked with |
|---|---|
| Q05, Q06 | `character`, `scene` |
| Q07 | `scene`, and `shot` — optional |
| Q08 | `scene` |
| Q02 | `subjectType` and `subject` — a character, prop or location — `scene`, and `shot` — optional |
| Q13 | `subjectType`, `subject` — a character, prop, location or costume — `intent`, and `scene` and `shot` — optional |

Q14 declares all seven — `target`, `character`, `subjectType`,
`subject`, `intent`, `scene`, `shot` — so **all seven appear in its
envelope** (§12.1.1), each as it was asked: null where it was not given.
A parameter the target does not take is recorded there and otherwise
ignored, except `shot`, below. For Q02 and Q13, `character` alone stands
for `subjectType` `character` with that subject. A Q14 for Q02 or Q13
with no subject, or for Q13 with no `intent`, has nothing to assess and
is not answered (§12.1.7). **Its `shot` and `scene` fix the position for
every target** as §12.1.7 fixes a query's: a shot alone is at its scene
— for Q02, Q05, Q06, Q07 and Q08 as for Q13 — and a shot outside the
scene asked is not answered. **The shot fixes the position for every
step, the media step's Q13 answer included** (§12.9.1): Q05 and Q06 take
no shot, but a Q14 for either asked at a shot asks its media step's Q13
at that shot, so a `voice_identity` bundle applied there by a
`character_shot_override` meets Q05's media step. Until 1.0-rc.7 the
media step said "at the query's scene and shot", which read as either.

**At a cut scene**, an empty position (§12.1.7), Q14 assesses what its
target answers there: a step narrowed to the position finds nothing and
reports its absence by §12.9.1's table, and a step its target reads
independently of the position — a character's baselines, a baseline
binding, a project-level root — is assessed as anywhere. No character is
seen at an empty position, so a step about how one looks does not apply
there.

| Field | |
|---|---|
| `target`, `targetName` | The query assessed. |
| `findings` | Each with `severity`, the `entity` it concerns, and a message. **Ordered by severity**, `blocker` first and `ok` last; within one severity the order is the implementation's, and is not compared. |
| `counts` | Findings per severity: every severity a key, zeros included. |

**`entity` names one entity the step declares**: the one whose rows
decided the finding — `costume` where a character has no costumes at
all, `costume_scene` where it has some and none is assigned here — and
for a step decided by no particular rows, the first the step names. **A
media step names `bundle`**, whichever binding, anchor or override
decided it, because its answer is the subject's Q13 references rather
than any one table's rows. A cross-step finding names an entity the
rubric declares (§12.9.1). `entity` is not compared — severity and
coverage are — but a reader should not have to guess it.

**Q14 is the one query that is NOT reproduced byte for byte.** Its
messages are written for a person and carry judgement — *"Physical state
persists here (wounded) with no vocal state — does it color the voice?"*
is an observation, not a lookup. Requiring two implementations to agree
on that wording would require them to agree on a sentence, which is not
something a specification can ask for.

Conformance for Q14 is therefore **coverage, severity range and
disclosed departures**: every step of §12.9.1's rubric MUST be assessed
and reported, each finding's severity MUST fall within what §12.9.1
permits for that step, and an implementation MUST disclose any finding
it raises beyond one per step. The published `Q14.result.json` is a
worked example of a conforming answer, not the only one.

**A step about how characters look is assessed for the characters SEEN
at the position**: at a shot, by §4.6; at a scene, by §2.4.1. A
character who is only heard or only named has no look to design, and a
finding asking for one could not be acted on. **The rubric marks each
such step `appliesTo: "seen"`** (§12.9.1): Q02's appearance, physical
and costume steps, and Q07's `character_appearance_profile`.

- **Where the target has no subject** — Q07 — the step is assessed for
  each character seen at the position, and with none seen it is met.
- **Where the subject is a character** — Q02 — the step applies only if
  that character is seen at the position. One who is heard, named, or
  not there at all reports it as not applying (§12.9.1), whatever is
  authored for them. The published `Q14-Q02-ada-scene3` shows it: Ada is
  mentioned at scene 3, so her appearance, physical and costume steps
  do not apply, and her other steps are assessed as for anyone.

Q02's media step is not marked: Q02 nests a Q13 answer whatever the
subject's presence (§12.16). Until 1.0-rc.6 only the `purpose` of Q07's
step said any of this, and nothing said how it met Q02's subject.

#### 12.9.1 The rubric

What Q14 assesses is published as
[`readiness-rubrics.json`](readiness-rubrics.json). Each rubric names a target query and the things it depends on, each
marked `required`, `recommended` or `optional`.

**Every step resolves against the registry.** A step carries:

| Member | |
|---|---|
| `entities` | One or more **registry entity names**. Never prose. |
| `satisfiedBy` | Present where only some of `entities` can satisfy the step: those. Absent, every entity named can. The others are context — they name a finding (§12.9) and cannot satisfy it. |
| `requirement` | `required`, `recommended` or `optional`. |
| `filter` | Present where the step is about a subset of those rows: a `field` and a disjunction of `values`. Where the target reads an unset value as one of them, so does the step: Q13 reads an anchor with no `canonical_status` as verified (§12.8), and so does Q13's `entity_anchor` step. |
| `intent` | Present on a media step (below): the asset intent whose bundle must resolve. The entity is `bundle` either way. |
| `intentBySubjectType` | Present on a media step instead of `intent` where the intent depends on the kind of subject asked about: each kind mapped to its intent. Q02's maps a location to `environment` and a character or prop to `visual_identity`, as the Q13 answer Q02 nests is asked (§12.16). A media step with neither — Q13's own first step — takes the target's `intent` parameter. |
| `appliesTo` | `"seen"` on a step about how characters look: assessed only for characters seen at the position (§12.9). Absent, the step applies whatever anyone's presence. |
| `resolvedBy` | Present where the step's rows are ones a canonical query resolves: that query. The step is satisfied by what that query's answer lets contribute at the position, and by no other row (below). Q13's `entity_anchor` step and its shot-override step carry `"Q13"`. |
| `purpose` | Why the step is there. Prose, for a person. |
| `label` | **Derived** from the members above, for display. A consumer MUST NOT parse it. |

Each rubric also lists its target's `params` under §12.9's names, `?`
marking an optional one.

Until 0.38 a step carried a single free-text `label` and nothing else,
and several used it for things the registry could not resolve —
`costume + costume_scene`, `bundle + *_asset_binding`,
`performance_state (vocal)`, `media: voice_identity`. A third party
could reproduce the severities but had to read the labels as a person
would, which is not a specification. The generator now checks every name
in `entities` against the registry, and every `filter` field against the
columns of the entities it names, and refuses to publish otherwise.

A conforming implementation MUST assess every step in that file, and
MUST keep each finding's severity within the range the step permits:

| Step | If absent | If present |
|---|---|---|
| `required` | `blocker` | `ok` |
| `recommended` | `warning` | `ok` |
| `optional` | `ok`, or `suggestion` where the absence is notable | `ok` |

**A step is assessed AT THE POSITION THE QUERY WAS ASKED ABOUT**, not
across the file. This was unstated, and it is the difference between
"does this character have a vocal profile" and "does anything in this
project have one" — two questions with different answers on any real
project.

**A step's rows are narrowed as its target narrows**, to the subject and
the position asked about. Readiness that narrowed differently from its
target would report a gap the answer does not have, or miss one it does.
Some steps name an entity their target does not itself read — among
them Q07's `visual_identity` and `character_appearance_profile`, Q05's
`dialogue_rhythm` and `sound_perspective`, Q08's
`location_sound_profile` — because whoever acts on the answer needs it
beside the answer; they are narrowed by the same rules. Until 1.0-rc.6
this said a step's rows were "the rows its target reads", which those
steps are not. Concretely, each entity a step can be satisfied by (its
`satisfiedBy`, or every entity it names) is narrowed to the subject and
to the position.

**To the subject**, by the first of these it has:

- **a column naming it** — `<subjectType>_id`: `character_id` for a
  character, `prop_id` for a prop — or, where the entity's subject
  column is polymorphic (§12.1.2), as `entity_anchor`'s is, rows whose
  sibling column holds `subjectType` and whose subject column holds the
  subject, where that sibling's options include the kind at all;
- **one declared reference away** — a reference to an entity that has
  a reference to the subject's kind (§6.5), whatever that column is
  named: `relationship_state` reaches a character through
  either of `character_relationship`'s character columns, and
  `costume_scene` through `costume.character_id`.

**A reference to `scene` or `shot` is a position, never a route to a
subject.** `scene` declares `location_id`, but a `dialogue_rhythm` keyed
to a scene is not thereby keyed to its location, and a binding's
scene-range columns do not key it to one either. Until 1.0-rc.6 nothing
said so, and read literally every scene-keyed entity was one reference
away from a location: Q05's `dialogue_rhythm` did not apply to any
character, and Q02's costume step applied to a location.

**To the position**, by the first of these that applies:

- **a position pattern** (§4.5), not `scene_id` equality: a
  `performance_state` that persists from an earlier scene is in force
  here and satisfies the step, and one keyed to this scene that has
  since been resolved does not exist here;
- **a shot's fall-through**: where the target takes a shot, an entity
  declaring both `scene_id` and `shot_id` is narrowed as §7.3 reads a
  cascade layer — at a shot, the shot's own rows if it has any, and
  otherwise the scene's rows with no shot; with no shot asked, the
  scene's rows with no shot. A shot with no lighting of its own is
  therefore ready on the scene's, which is what Q07 answers there; the
  published `Q14-Q07-shot12A` shows it. Narrowing by `shot_id` equality
  reported a missing layer the target returns;
- **a column naming a parameter the target takes** — `scene_id`, or
  `shot_id` — by equality. A shot Q14 received for a target that takes
  none fixes the position and narrows no column: Q08's `sound_cue` is
  narrowed by its `scene_id`;
- **`location_id`**, to the scene's location through `scene.location_id`.

An entity with nothing to narrow it to the subject or the position is
assessed across the file in that respect, because there is nothing to
narrow it by.

**A step over rows a query resolves is satisfied by what that query
resolves**, at the position, and not by the rows the routes above
reach. The rubric marks such a step with `resolvedBy`. Q13 resolves
anchors and shot overrides: its `entity_anchor` step counts exactly the
anchors Q13 lets contribute at the position — verified, of the intent's
anchor type (§12.8's table), and, by §4.8, an anchor naming a variant
only where that variant is in force, the subject's own anchors of the
type displaced where an in-force variant has one — and its shot-override
step only overrides whose bundle has the intent. The published
`Q14-Q13-marcus-scene12` shows it: Marcus's one verified anchor names
his young variant, which is not in force at scene 12, and his own anchor
is a `candidate`, so Q13 there returns no anchor and the step is a
`warning`. Until 1.0-rc.7 the step's only narrowing was its `filter`
and the subject routes, which found that verified anchor and called him
pinned at every scene but 25, where the variant is in force.

**A media step** — one whose satisfying entities are `bundle` alone —
is satisfied when **the subject asked about** has at least one reference
of the step's intent in force at the position: its own Q13 answer
(§12.8) at the scene and the shot Q14 was asked about, whether or not
the target takes a shot (§12.9). A bundle bound to some other
subject does not satisfy it, and **neither does a binding of the
subject's own that is excluded at the position**: Q13's first step names
the four binding tables as context and is satisfied by `bundle` alone.
The published `Q14-Q13-windchime-scene12` shows it: the wind chime's one
`visual_identity` binding is scene-ranged from scene 24, so at scene 12
it resolves nothing and the step is a `blocker`. Q02's media step takes
its intent from `intentBySubjectType`, the intent of the Q13 answer Q02
nests (§12.16): `environment` for a location. The published
`Q14-Q02-kitchen-scene10` shows it: the fixture gives the kitchen
`visual_identity` bundles and no `environment` one, so the step is a
`blocker`.

Until 1.0-rc.6 Q13's first step had no `satisfiedBy`, so a binding
excluded at the position met it as one of several entities while the
media rule called it a `blocker`; and Q02's step said `visual_identity`
for every subject while this section said `environment` for a location.

**A step does not apply where every entity that could satisfy it is
keyed to something the question does not have**: to a subject it cannot
be narrowed to by either route above — a subject of another kind — or
to a shot or a location the position lacks. **An entity that reaches the
subject asked about applies, whatever else it names**: `costume_scene`
names a costume, and reaches a character through `costume.character_id`,
so it applies to a character and not to a location. An entity keyed to
no subject at all, as `dialogue_rhythm` is, is not of another kind; it
is narrowed by the position alone. A step marked `appliesTo: "seen"`
also does not apply to a character subject who is not seen at the
position (§12.9). A step that does not apply is still reported —
coverage is every step — as `ok`, saying so: Q02's character steps asked
about a prop or a location; its look steps asked about a character only
heard or named there; Q13's `entity_anchor` step and its shot overrides
asked about a costume, since `entity_anchor.subject_type` does not offer
`costume` and the registry declares no costume shot override; a
shot-keyed step with no shot asked; a location-keyed one at a scene with
no location. The published `Q14-Q02-locket-scene25`,
`Q14-Q13-shawl-scene12` and `Q14-Q02-ada-scene3` show it, and
`Q14-Q13-eleanor-shot1204` a Q13 target with every step reported.

**A step naming several entities is satisfied by any of its satisfying
entities with rows here**, each narrowed as above. Where the step
carries a `filter`, it applies on top. Q02's costume step is satisfied
by a `costume_scene` for this character at this scene and by nothing
else: a character with costumes and none assigned here is a `warning`
naming `costume_scene`, and one with none at all a `warning` naming
`costume`. The published `Q14-Q02-eleanor-scene7` shows the first,
beside a `relationship_state` step met one reference away.

Until 1.0-rc.5 this section said a step naming several entities was
"satisfied by any of them unless its `purpose` says otherwise" — a
condition no reader could execute — and narrowed only by columns, so
that a relationship state did not apply to the character it belongs to
and a shot's lighting was missing where Q07 found it.

**An absent `optional` step is `ok` by default.** That is what optional
means, and a report that raised a `suggestion` every time one was absent
would be mostly noise on any real project. An implementation MAY raise
`suggestion` instead where something about *this* position makes the
absence worth remarking on, and MUST say what in the message.
`readiness-rubrics.json`'s `requirementToSeverity` gives the severity
for a notable absence, not for every absence.

**An implementation MAY raise a finding that no single step produces**,
where it observes something across steps — a physical state in force
with no vocal state beside it is the worked example, and it is why the
published result carries seven findings for a six-step rubric. Such a
finding MUST name an entity the rubric declares, and MUST be disclosed
under §12.9's conformance terms.

Until 0.40 this table read `optional` → `suggestion` absolutely, and
the published artifact disobeyed it in exactly the way described above
while a test checked only that reported entities were declared ones.
An independent implementation followed the table, produced six findings,
and was right to say the artifact was non-conforming to the rule as
written. The rule was wrong, not the artifact.

**Only some queries have a rubric.** A query with a generative or
pre-flight consumer — one you act on before shooting or rendering — has
readiness semantics of its own. An analytic query reads whatever exists
and has none beyond the walkable queries it is built from; asking Q14
about one is answered by assessing those.

Until this file was published, §12.9 defined the envelope and the
severity scale and nothing about what was assessed, and an independent
implementation correctly declined to claim anything for the rubric it
had to invent.

**`findings` includes `ok` entries.** Q14 is a rubric, not a problem
list: it reports what is present as well as what is missing, so a
consumer counting findings would read it backwards — a thin subject can
produce FEWER findings than a well-authored one, because fewer things
are there to be reported on at all. **Severity carries the answer.**

Readiness severity is its own scale — `blocker`, `warning`,
`suggestion`, `ok` — and is not the finding-vocabulary severity of §9.4.
That vocabulary answers whether a file is well-formed; this answers
whether a query can be answered well from it, and §9.4 forbids
conflating them.

### 12.10 Q09 — Motif manifest

**Which motifs should be perceivable in this scene, and how.**

Parameter: `scene`.

| Field | |
|---|---|
| `scene` | The scene, projected. |
| `manifest` | Each motif placed here: the `motif`, its `appearance` at this position, and its evolved `state` there by pattern 3 (§4.5). |
| `candidates` | Motifs related to something placed here that are **not** placed here, projected. |
| `dense` | Whether the manifest exceeds the density threshold. |
| `densityThreshold` | The threshold that produced `dense`. **This specification's threshold is 3**; an implementation MAY use another and MUST publish the one it used. |

**Related means one hop along `motif.related_motif_id`**, and nothing
else. A motif is a candidate when some motif in `manifest` points at it
through that column and it is not itself placed in this scene. **The
relation is followed exactly once and is not transitive**: a motif
reached only through another candidate is not a candidate. A closure
would grow with the project until the list stopped being an aid to
judgement, which is the only thing it is for.

`candidates` carries **each motif once**, in the order the manifest
first reaches it. `manifest` is in the row order of the appearances at
this scene.

A **candidate is not an obligation.** It is a related motif absent from
this scene, offered because a placement decision is easier to make when
you can see what is adjacent to it. Nothing is wrong with a scene that
places none of them.

`dense` is a **heuristic, not a finding** (§9.1). A result MUST publish
the threshold alongside the flag, so a consumer can see what produced it
rather than inferring a number from a count. A different implementation
MAY use a different threshold and MUST say which.

### 12.11 Q10 — Thematic accounting

**Where a theme lives across the whole story, and where it does not.**

Parameter: `theme`. This is the first query whose answer spans the
entire spine rather than a position.

| Field | |
|---|---|
| `theme` | The theme, projected. |
| `carriers` | Each `thematic_connection` projected, plus `targetEntity`, `targetUuid`, `targetName` and `sceneUuids` in story order. |
| `spine` | **Every scene in story order**, each with the number of carriers reaching it: `sceneUuid`, `sceneNumber`, `carriers`. It carries no projected scene — a spine is a shape, and §12.17 is where a scene is answered. |

**The zeroes are the point.** A spine listing only the scenes a theme
reaches could not answer the question this query exists for, which is
where the theme is absent. A conforming result MUST include every scene,
carriers or not.

The spine is in **story order** (§4.1), never scene-number order, and
excludes cut scenes (§6.6.1). A carrier reaching a cut scene reaches
nowhere, so its `sceneUuids` and the spine's counts agree.

**`thematic_connection.entity_id` is polymorphic**, so §12.1.2 drops it
from the projected connection and this query resolves it into the three
`target*` members beside it. `entity_type` stays in the connection's
`fields` as an ordinary stored value. A connection whose `entity_type`
is not a registry entity, or whose row is absent, carries a null
`targetUuid` and `targetName` and reaches no scenes. **A connection whose
target row is cut is not a carrier**: a link whose endpoint is cut joins
nothing (§6.6.1), so it is absent from `carriers` and counts nowhere,
though the connection itself is not cut. Absent and cut differ the way
§6.6.1 says they do: an absent target is a dangling reference in the
film, a cut one is a deliberate removal from it. The fixture's cut
deputy carries the theme, so the published `Q10` shows the rule.
`carriers` are in the row order of the `thematic_connection` rows.

**An act or a sequence whose start scene is cut covers no scene**
(§5.5), so as a carrier it reaches none, and the scenes it would have
begun count for the span before it.

**A carrier reaches the scenes it is placed in.** A scene carries the
theme at itself; **an act or a sequence carries it at every scene of its
derived membership** (§5.1); anything else carries it wherever the file
places it, which is one of exactly two shapes:

- a **link entity** (§0.7) declaring both `scene_id` and the subject's
  own reference column — `scene_character`, `scene_prop`,
  `motif_appearance`, `costume_scene`;
- **`scene` declaring a reference to the subject** — `scene.location_id`.

A link ASSERTS that the subject is there; that is what a link is. An
entity that merely names both a scene and the subject DESCRIBES it
there — `performance_beat`, `prop_state`, `makeup_hair_design` — and
describing a subject in a scene is not the same claim as placing it, so
those rows place nothing. A conforming implementation MUST read both
shapes from the registry rather than from a list of entity kinds: a
subject kind that gains a placement link is reached the day it is
declared.

A carrier the file places nowhere reaches no scenes, which is a
legitimate answer and not a finding.

**The span case is derived, never stored.** "Act 2 is where the story
argues about forgiveness" is a claim an author makes about the act, and
a scene moved across an act boundary — which happens by editing the
script, with no write to any link (§5.1) — moves its count with it. A
writer that instead fanned the claim out to one connection per scene
would be storing a derivation (§3.1) and would be wrong the moment the
boundary moved.

### 12.12 Q00 — Brief

**What film is this, and what are its rules.**

No parameters. The only canonical query with an empty envelope.

| Field | |
|---|---|
| `layers` | The project-level entities, **broadest first**, each `{ entity, row }`. |
| `themes` | Every theme in the project, projected, in row order. |
| `posters` | The assets related to the project row as `poster` (§8.6), each projected, in §8.6's order. Empty when there are none. The first is the poster. |

The layer list is an editorial choice about what a brief *is*, not a
fact the registry knows, so it is fixed by this section rather than
derived: `project`, `project_vision`, `project_tone`, `visual_identity`,
`project_color_palette`, `cinematographic_philosophy`, `sonic_identity`,
`look_development`, `costume_design_philosophy`, `technical_specs`.
Adding one is a change to this section.

An unauthored layer is **absent** from `layers`, not present and empty.

### 12.13 Q11 — Audience state

**What the audience knows and should feel at a position.**

Parameter: `scene`.

| Field | |
|---|---|
| `scene` | The scene, projected. |
| `information` | The information strategy here, or null. |
| `identification` | The identification strategy, or null: `{row, primary, secondary}` — the strategy, and the characters its two references name, each projected, either character null where unset. Named `row` rather than for an entity, per §12.1.4, because the strategy is what the record is about. |
| `emotionalBeats` | Each beat with the arc it belongs to: `{beat, arc}`, each projected, `arc` null where none. In row order. |
| `toneMarkers` | `tone_marker` rows at this scene, projected, in row order. |
| `emotionalCascade` | The direction cascade for leaf `scene_emotional_target`, root first (§7). |

Every one of these may be absent, and absence is **null or empty, never
invented** (§9.2). A scene with no authored audience design is a
legitimate answer.

**Rows are at this scene by their `scene_id`.** `emotional_beat` and
`tone_marker` may instead be keyed by `sequence_id`; a row keyed by its
sequence alone describes the sequence, is not at any one scene, and is
in neither member — not spread across the sequence's derived
membership, which only Q10 does, for a carrier, because a theme's
presence is the claim it makes. The fixture's "Held breath" marker is
keyed to the sequence holding scene 12, so the published `Q11` shows it
absent.

A file that does not contain one of these tables yields nothing for it
rather than failing — an older file predating an entity is not an error.

### 12.14 Q15 — Provenance

**Why is this value what it is, and who touched it.**

Parameters: `entityType` — a literal — and `row`.

| Field | |
|---|---|
| `entityType`, `row` | The row asked about. |
| `versionChain` | The row's version chain, **oldest first**, walked back to the root and then forward. Empty when the entity is not versionable. |
| `attached` | An object, **not an array**: `decisions` and `notes`, each a list of projected rows that mention this one, in row order. |

Walking the chain MUST terminate on a cycle rather than following it
(§9.2). A cycle is a finding (`identity.chain_cycle`), not a reason to
hang.

**A writer SHOULD record `affected_entities` as a JSON array of strings
`"<entity>:<uuid>"`**, one per attached row, where `<entity>` is a
registry entity name and `<uuid>` is the row's uuid (§6.1). **A writer
MUST NOT write a row id**: row ids are file-local and renumberable
(§6.2, §12.1.2), so an attachment keyed to one is re-pointed at a
different row by any rebuild that renumbers — and the fixture's own
build is such a rebuild.

**Reading stays permissive**, because the column is free-form and may
hold a JSON array, a JSON object, or prose. An implementation MUST
accept `entity:<uuid>`, `entity#<uuid>`, an object carrying an entity
kind with a `uuid` member, a bare `entity` meaning the kind in general,
and the legacy row-id spellings of the first three. The two string forms
are told apart by the value's shape: a canonical uuid is a uuid and an
integer is a row id, and they cannot collide. A provenance trail that
silently omitted a note would be worse than one that included a doubtful
one — §9.1, SCF describes.

**Prose is matched on uuids alone.** A row id inside prose is not a
reference: `scene:1` is a substring of `scene:12`, and a bare entity
name is a substring of ordinary words — `prop` is inside "appropriate".
A matcher permissive enough to read prose has to key on something that
cannot be a coincidence.

### 12.15 Q01 — Subject dossier

**Everything about a subject, before any scene bends it.**

Parameters: `subjectType` — a literal — and `subject`.

| Field | |
|---|---|
| `subjectType`, `subject` | The subject and its kind. |
| `groups` | Entities authored about this subject, each `{ entity, rows }`: the groups in registry order, each group's rows in row order. |
| `motifCarriage` | Motif appearances that name this subject: `{appearance, motif}`, each projected, the motif null where it is absent. **In story order** by the appearance's scene, then row id; one with no story position last. |
| `thematicConnections` | Thematic connections that name it, projected, in row order. |
| `relationships` | For a character subject: each `character_relationship` naming them in either `character_a_id` or `character_b_id`, as `{relationship, other, side}`. `relationship` is the row, projected. `other` is the character at the other end, projected, or null where that character is absent. `side` is `"a"` or `"b"`, the column the subject occupies. In the row order of the `character_relationship` rows. For any other subject kind, `[]`. |

**`groups` is derived, not listed.** A group is any entity whose
registry `subject` is this kind, at `scope: global`, carrying a
reference back to it **through the column named `<subject>_id`** —
`character_id` for a character, `location_id` for a location. That is
§2.3's ownership convention, and naming the column matters because an
entity may declare several references to the same target and only one
of them says *this row is about that subject*. The subject's own entity
is not a group of itself.

Adding a new entity about characters puts it in every character's
dossier with no change here — which is what `subject` and `scope` are
for (§0.7).

A group with no rows is omitted rather than carried empty.

**Relationships are carried beside the groups, not in them.**
`character_relationship` is about both of its characters equally, so
no single column says *this row is about that subject*, and §6.5
requires a consumer to read both. It is carried as its own member,
as `motifCarriage` and `thematicConnections` are, with the other party
resolved and the subject's side named, because `a_to_b` reads A → B
and a consumer cannot interpret directionality without knowing which
end it is on.

A relationship whose other character is **cut** is absent: a
relationship to someone not in the film joins nothing (§6.6.1). One
whose other character is **absent from the file** is kept, with
`other` null (§9.2), and is reported as `relationship.endpoint_absent`
as before. A relationship naming the subject twice appears once, as
side `"a"`, with `other` the subject.

**References from other subjects are not dossier content.** A prop's
`associated_character_id`, a story beat's `pov_character_id`, and
links such as `scene_character` point *at* the subject without being
*about* it. Q15 and a where-used walk find them.

### 12.16 Q02 — Subject in context

**Everything needed to realise a subject in a scene, and optionally a
shot.**

Parameters: `subjectType`, `subject`, `scene`, and `shot` — optional.

| Field | |
|---|---|
| `subjectType` | Which kind of subject was asked about. Echoes the parameter, as §12.15 does. |
| `subject`, `scene` | Projected. |
| `dossier` | Q01's result body — what is true of the subject before this scene. |
| `costumes` | For a character subject: each `costume` of theirs assigned to this scene, projected, in the row order of the `costume_scene` rows. |
| `relationshipStates` | For a character subject: for each `character_relationship` naming them on either side, in its row order, the `relationship_state` in force here by §4.5 pattern 3, projected; a relationship with none in force contributes nothing. |
| `arcStates` | For a character subject: for each of their `character_arc` rows, in its row order, the `character_arc_state` in force here by pattern 3, projected; an arc with none contributes nothing. |
| `performanceStates` | For a character subject: `performance_state` rows of every modality in force here by pattern 2, projected, oldest first, as §12.4's `states`. |
| `beats` | For a character subject: `performance_beat` rows for them at this scene, every modality, projected, in `beat_order` — an unset one as 0 — then row order. |
| `characterVariant` | For a character subject: the variant §4.8 puts in force, projected, or null. |
| `locationVariant` | For a location subject: the variant in force and any mismatches. |
| `propVariant` | For a prop subject: the variant §4.8 puts in force, projected, or null. |
| `propState` | For a prop subject. |
| `media` | **Q13's result body**, asked at this scene and shot for intent **`environment`** for a location subject and **`visual_identity`** for any other, with one member added to it: `fromQuery`, the string `"Q13"`. A flat object — Q13's members and `fromQuery` side by side — not a wrapper around them. |

`arcStates` carries the stage in force on each of the character's arcs
(§4.5), and **not the arcs themselves**: a `character_arc` is a standing
fact about the character, so it is already in `dossier.groups`, and
§3.1 asks for it in one place rather than two. What the scene changes is
which stage is in force.

`relationshipStates` likewise carries the stage in force on each
relationship, and **not the relationships themselves**, which are
standing facts and are in the dossier's `relationships`. Each state's
`character_relationship_uuid` is the `uuid` of one of those entries.

**Fields that do not apply to a subject's kind are null or empty, never
omitted.** A consumer must be able to tell "not applicable here" from
"unauthored", and an absent key says neither. Which, per member:

| Member | Applies to | Elsewhere |
|---|---|---|
| `costumes`, `relationshipStates`, `arcStates`, `performanceStates`, `beats` | a character | `[]` |
| `characterVariant` | a character | null |
| `propVariant`, `propState` | a prop | null |
| `locationVariant` | a location | null |

Where it applies and nothing is authored, an array member is `[]` and a
single member null, as for any derived record (§12.1.4).
**`locationVariant` for a location that is not the scene's** is
`{variant: null, mismatches: []}`: §12.17 chooses among the variants of
the scene's location, and a location asked about elsewhere has none
dressing this scene.

This is the one query built by calling another (§12.1.3). The media
layer carries Q13's body without its envelope: an envelope inside an
envelope would let an inner `resultFormat` disagree with the outer one.

### 12.17 Q04 — Scene package

**The complete context for a scene, as a unit of work.**

Parameter: `scene`.

| Field | |
|---|---|
| `scene` | Projected. |
| `lineage` | Act and sequence the scene belongs to by §5.1, **broadest first**: `{entity, row}`, `entity` being `act` or `sequence` and `row` projected. A scene in no act or no sequence has no entry for it. |
| `storyBeats` | `story_beat` rows of this scene, by `beat_order` ascending — an unset `beat_order` as 0 — then row order. |
| `cast`, `props` | Present by authored link, not inference: `{character, presence, variant}` and `{prop, presence, variant}`, as §12.4's entries are — the subject projected, its `presence` (§2.4.1), and `variant`, the variant in force (§4.8), projected, or null. In the row order of this scene's `scene_character` and `scene_prop` rows. |
| `location`, `locationVariant` | The location, and `{ variant, mismatches }` — see below. |
| `detail` | Design entities keyed to this scene, each `{ entity, rows }`, in the list order below, each group's rows in row order and empty groups omitted. **Every row whose `scene_id` is this scene**, shot-level rows included — this is a package of what the scene holds, not §7.3's selection of one layer. |
| `blocking` | This scene's `scene_blocking` rows, projected, in row order. **An array** — a scene may carry several. |
| `stagingBeats` | The scene's `staging_beat` rows, projected — see below. |
| `screenplay` | The scene's own text — §12.17.1. |

The `detail` list is fixed by this section rather than derived — what
belongs in a scene package is an editorial choice, as Q00's layer list
is: `scene_emotional_target`, `scene_color_palette`, `lighting_design`,
`scene_music_design`, `dialogue_sound_design`, `set_dressing`,
`tone_marker`.

**The variant in force is chosen by axis agreement, not by position.**
`location_variant` declares `positionPattern: none` (§4.5) — it is not
keyed to a scene at all — so "in force" here means *the variant that
best describes this scene*:

1. For each variant of the scene's location, note which of three axes,
   **in this order**, it agrees with the scene on: `scene.time_of_day`
   against `location_variant.time_of_day`, then
   `scene.weather_conditions` against `weather`, then `scene.season`
   against `season`. An axis agrees only where **both** sides carry a
   value, compared case-insensitively and trimmed. An absent value on
   either side is not a disagreement. **A variant whose `time_of_day` is
   `varies` agrees with any scene that carries a time of day**: it is a
   wildcard, not a time — a scene with none still agrees with nothing,
   as above — and scoring it as a mismatch made the only value that says
   "this dressing holds at any hour" the one value that could never win.
2. **Compare the variants axis by axis, in that order.** A variant that
   agrees on an earlier axis beats one that does not, whatever either
   says about the later ones; only between variants equal on an axis
   does the next one decide. Light is what the camera sees first: a
   night variant built for autumn dresses a winter night before a
   winter-morning baseline does. Counting the axes equally made those
   two tie, and the tie went to the morning.
3. Between variants equal on all three, prefer `is_baseline`, then the
   lowest row id.
4. **If the winner agrees on no axis, take the `is_baseline` variant
   with the lowest row id.** Nothing agreed, so agreement is not what
   chose it, and the baseline is the honest answer. A location with no
   baseline keeps the step 2–3 winner.

**`time_of_day` is a light axis** — what the camera sees: `day`,
`dawn`, `morning`, `midday`, `afternoon`, `dusk`, `night`. It is not the
heading's grammar. CONTINUOUS, LATER and MOMENTS LATER are continuity
relations to the preceding scene rather than times, and they stay in the
heading text where a screenplay puts them; `scene.time_of_day` carried
`continuous` until 2.14, where it could never match a variant, because
no variant can be continuous with anything. `day` is unrefined
daylight — the value a heading-only import writes, and the one an author
then refines to `morning` or `midday` if they care to. The fixture shows
that refinement: half its headings read DAY and the records say
otherwise, which is the record being more precise than the script rather
than disagreeing with it.

`mismatches` lists the axes where the CHOSEN variant disagrees with the
scene — both carry a value and the values differ. It is a report rather
than a rejection: a variant can be the best available and still be
wrong, and saying so is more useful than choosing nothing.

**`mismatches` is an array of formatted strings** (§12.1.5), one per
disagreeing axis in step 1's order, each exactly

```
<axis>: scene=<scene value> variant=<variant value>
```

where `<axis>` is the SCENE's column name — `time_of_day`,
`weather_conditions` or `season` — and each value is the stored value,
untrimmed and in its stored case, written as a JSON string: in double
quotes, with JSON's escapes. **Exactly those escapes and no others**: `"`
and `\` are escaped, control characters below U+0020 are written
`\b`, `\f`, `\n`, `\r` or `\t` where JSON has a short form and
`\u00XX` with lowercase hex otherwise, and every other character —
non-ASCII included — is written as itself, never as `\uXXXX`. So the
fixture's scene 12 carries
`season: scene="winter" variant="autumn"`. It is compared byte for byte
(`conformance.md` §6.1), and a `varies` time of day never appears in it,
because it never disagrees.

The fixture exercises this too. Scene 12's kitchen dressing was built
for an autumn night and reused in winter: it still wins on time of day
and weather, and the published Q04 result carries the season it is wrong
about. Until 0.42 the chosen variant agreed on everything, so a reader
had nothing to check the shape against and no way to know it was
guessing — and one did guess, differently.

**A staging beat reaches its scene through its container.**
`staging_beat` has no `scene_id`: each row names exactly one container,
a `scene_blocking` (`scene_blocking_id`) or an `action_sequence`
(`action_sequence_id`), and the container carries the scene.
`stagingBeats` is **every beat of either kind of container whose
`scene_id` is this scene**, cut containers and cut beats excluded
(§6.6.1), ordered by `beat_order` ascending — an unset `beat_order` as
0 — then by row id. Both paths are taken: an action sequence's beats are
the scene's staging as much as its blocking's are. The published
`Q04-scene21` shows the second path, where the scene has no blocking and
its two beats are the storm pursuit's.

**Q04's `detail` is not prose.** It is a list of projected rows; the prose member of that name is §12.8's, on a
Q13 reference, and nothing else in §12 is prose by its name alone
(§12.1.5).

Q04 does **not** nest Q03 or Q07 despite covering some of the same
ground. It assembles its own answer, and §12.1.3 explains why that is
described rather than changed.

#### 12.17.1 The screenplay member

**`screenplay` is an array of projected rows from `screenplay_lines`,
ordered by `line_order` ascending.**

Which lines: **the scene's heading line, and every line after it up to
but not including the next heading line by `line_order`.** Two lines
sharing a `line_order` are taken in row id order. **A line whose
`line_type` is outside §1.3.1's closed set is not in the member**: it is
a row the reader does not recognise, which §10.1 says to ignore, and
§1.3.1's finding reports it; it is kept in the file. It is not a heading,
so it bounds nothing. This is §3.4
restated as a result, and the rule it restates is a MUST NOT: body
lines carry a `scene_id` threaded at commit, and an implementation
answering this member from that column will answer wrongly for any line
typed since the last commit and for every file written before the
threading existed.

The **terminating bound is the next heading, whichever scene owns it**.
A cut scene's heading still bounds the preceding scene's text, and its
lines are absent from this member because the bound stops before them
rather than because anything filtered them — §6.6.1 is about rows in a
result, and a screenplay line carries no `lifecycle_status` to filter
on.

**`screenplay` is `[]` when the scene has no heading line**, and that is
an answer rather than an absence: a scene authored in the database that
the screenplay has not reached yet. Scene 17 of the conformance fixture
is exactly this case. Where a scene has no heading but some line carries
its `scene_id`, an implementation MUST start at the lowest such
`line_order` — the derived column is not a source of truth, but it is
better than answering nothing when it is the only anchor present.

**Projection.** `screenplay_lines` is a `uuidExtraTable` (§1.3) and
carries uuid identity on §6.1's terms, so its rows are **projected rows
under §12.1.2** like any other: `{ uuid, fields }`, `id`, `created_at`
and `updated_at` omitted, nulls and empty strings omitted, `metadata`
carried as stored text. The only difference is where the column names
come from — `screenplay-tables.json` (§1.3.1), not the registry.

Because the registry cannot declare them, **this section declares the
reference columns**, and they are the whole set:

| Column | Resolves to |
|---|---|
| `character_id` | `character_uuid` |
| `location_id` | `location_uuid` |

**`scene_id` MUST be omitted.** It is neither resolved nor carried. It
is a stored derived value under §3.4 and publishing it in a normative
answer would hand a consumer the one column the specification tells
implementations not to trust.

`line_type` is a **stored value**, and its vocabulary is §1.3.1's closed
fifteen — this section adds nothing to it. `content` is a stored value
and is carried verbatim, including whatever the file holds; a blank line
is a row whose `content` is empty, so §12.1.2's omit-empties rule leaves
it with a `line_type` and a `line_order` and nothing else, which is
correct and is what the published result shows.

**Why the member exists at all.** Q04 is the scene as a unit of work,
and until 0.49 it answered with everything addressed to a scene except
the scene. The gap was visible in the reference editor, which printed
*"Screenplay text joins this package when Part 3 lands"* in its rendered
view and in the prompt-ready block a writer pastes into an assisted
writing session — a note referring to a work package that had shipped.
A result that carries the design, the cast, the props and the staging
but not the words is not the complete context for a scene.

---

## Appendix A — Conformance test map

Where a rule is machine-checkable, the test that pins it is named. A
change to one without the other is a defect.

| Section | Pinned by |
|---|---|
| §3.4 derived-but-stored | `scf-app/test/sceneScript.test.ts` |
| §1.2 file identification | `scf-core/test/fileIdentity.test.ts` |
| §2.1 registry structure | `scf-core/test/registrySchema.test.ts` |
| §9.4 finding vocabulary | `scf-core/test/findings.test.ts`, `spec/finding-catalog.json` |
| §4.3 numbering policy | `scf-core/test/numbering.test.ts` |
| §9.4 finding behaviour on broken files | `scf-core/test/negativeFixtures.test.ts` (19 cases) |
| §9.1 `reference.dangling` | `scf-core/test/references.test.ts`, `fixtures/negative/reference-dangling.expected.json` |
| §12.8 a superseded asset gives way | `scf-core/test/supersededGivesWay.test.ts` |
| §12.15 relationships in the dossier | `scf-core/test/dossierRelationships.test.ts`, `fixtures/expectations/Q01.result.json` |
| §9.5 serialised report | `scf-core/test/report.test.ts` |
| §11.1 additive-only schema changes | *unpinned — a policy, checked by review* |
| §11.2–11.3 forward and backward compatibility | `scf-core/test/extensibility.test.ts`, `scf-app/test/roundTrip.test.ts` |
| §11.4 deprecation window | *unpinned — a policy, checked by review* |
| §4.1 resolution agrees with story order | `scf-core/test/conformance.canonical.test.ts` |
| §6.6 cut rows excluded everywhere | `scf-core/test/conformance.canonical.test.ts`, `scf-core/test/lifecycle.test.ts` |
| §12.1 result envelope and row projection | `scf-core/test/canonicalQueries.test.ts` |
| §12.2–12.17 — all sixteen queries | `scf-core/test/canonicalQueries.test.ts`, `fixtures/expectations/*.result.json` |
| §12.0 case results — every member of every result carries data | `scf-core/test/resultCoverage.test.ts`, `fixtures/expectations/<Q>-<case>.result.json` |
| §12.17 ranked variant axes | `scf-core/test/conformance.canonical.test.ts` |
| §11.6 document equality | `scf-core/src/canonical.ts`, exercised by `scf-app/test/roundTrip.test.ts` |
| Round-trip integrity (`conformance.md` §3) | `scf-app/test/roundTrip.test.ts` |
| Canonical query expectations (`conformance.md` §5.4) | `scf-app/test/queryExpectations.test.ts`, `fixtures/expectations/` |
| §10.1 unknown-content preservation | `scf-core/test/extensibility.test.ts` |
| §10.2–10.3 reserved namespaces | `scf-core/test/registrySchema.test.ts`, `schema/lint_registry.py` |
| §4.2 scene-number grammar and ordering | `scf-core/test/sceneNumbers.test.ts` — including a case asserting the TypeScript comparison and its SQL twin order the same list identically |
| §4.4 shot codes | `scf-core/test/shots.test.ts` |
| §4.5 pattern 2 | `scf-core/test/conformance.canonical.test.ts` → "persistence rule" |
| §4.5 pattern 3 | `scf-core/test/conformance.canonical.test.ts` → "pattern 3 (latest-wins)" |
| §2.4.1 presence of a vocabulary value | `schema/lint_registry.py` (total over the options), `scf-core/test/presence.test.ts` |
| §4.6 presence at a shot | `scf-core/test/presence.test.ts` |
| §3.5 line anchors, §4.7 the lines a shot covers | `scf-core/test/lines.test.ts` |
| §12.8.1 binding filters | `scf-core/test/bindingFilters.test.ts` |
| §12.8.2 how bindings combine | `scf-core/test/bindingCombination.test.ts` |
| §5 spans | `scf-core/test/structure.test.ts` |
| §6.3–6.4 natural keys | `scf-core/test/junctions.test.ts` |
| §6.5 relationships | `scf-core/test/relationships.test.ts` |
| §7 cascade | `scf-core/test/conformance.canonical.test.ts` → Q07, Q08, Q11 |
| §8.2 identifiers | `scf-core/test/assets.test.ts` |
| §8.3 resolution states | `scf-core/test/assets.test.ts` |
| §8.5 format hint | `scf-core/test/preview.test.ts` |
| §8.6 orphans | `scf-core/test/assetIndex.test.ts` |
| §8.7 metadata | `scf-core/test/fileMetadata.test.ts` |
| §9.6 resolution report | `scf-core/test/mediaReferences.test.ts` |

Sections with no entry are not yet pinned, and two entries above say
*unpinned* on purpose: §11.1 and §11.4 are policies about how the format
is allowed to change, not properties of a file. No test can check that a
future change will be additive; only review can.

The remaining gap is §2 — the registry's own content, as opposed to its
structure (§2.1) and the behaviour derived from it (§2.3, pinned
throughout). See [conformance.md](conformance.md) §5.
