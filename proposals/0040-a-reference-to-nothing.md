<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# 0040 — A reference to nothing is a finding

| | |
|---|---|
| **Status** | draft |
| **Author** | Drafted with Claude, from production use on a short film |
| **Opened** | 2026-11-10 |
| **Affects** | §9.4.1 (new code `reference.dangling`); `finding-catalog.json` (`codeCount` 54 → 55, `catalogVersion`); §9.1's paragraph on required references; §12.1.2's "not a finding" clause. Code: `scf-core` (`scanIntegrity`, `ops/integrityGate.ts`). Related: [0041](0041-silent-presence-and-dossier-relationships.md) |

## The problem

A reference column that holds a value but names no row is reported by
nothing, unless it happens to be one of two columns with codes of their
own.

The catalog covers the neighbouring cases. `junction.endpoint_absent`
and `field.required_absent` cover a required reference that is **null
or empty** (§9.1). `relationship.endpoint_absent` covers
`character_relationship`'s two endpoints, and
`structure.boundary_dangling` covers a span's start scene. For every
other reference column, including all five polymorphic ones, a value
that resolves to nothing is silent. Resolvers handle it (§9.2 makes
them total), so every query answers, and the link quietly isn't there.

This bit in production, through the MCP write path. `create_row` on
`asset_relationship` was given the character's uuid for `entity_id`, as
its description invites. A defect in the tool skipped polymorphic
columns when turning uuids into row ids, so the uuid was stored as TEXT
in an integer column. The plan reported no risks and
`"integrity": {"wouldAdd": []}`. The link showed in the asset's
`where_used` and not in the character's, and it was only found by
reading the database. The alexisNexus parsing pass hit the same defect
on all 17 of its `thematic_connection.entity_id` writes
([0041](0041-silent-presence-and-dossier-relationships.md), item M1).

The tool defect is fixed separately (0041 C1). Two things are still
missing, and neither one is enough without the other:

- **The format has no word for it.** No §9.4 code covers this, so no
  conforming report shows it, whether the bad write came from the
  editor, an importer, the MCP or a script.
- **The host's integrity gate does not check for it.** The gate
  (`scf-core/src/ops/integrityGate.ts`) does not read the §9.4 catalog.
  It compares four kinds of its own from `scanIntegrity`: three line-anchor
  orphans and `unjustified_link`. None of them is a dangling reference,
  so the gate passed this write, and a catalog code by itself would not
  change that. 0041 makes the same point.

## The proposal

Add one code to §9.4.1:

| Code | Raised when | `table` | `rowIds` | `count` |
|---|---|---|---|---|
| `reference.dangling` | A reference column holds a non-empty value that names no row of its target, cut or not. The target is the field's `referenceEntity`, or for a polymorphic column (§12.1.2) the table `polymorphicTarget` gives for the row's sibling value. A value that is not an integer names no row. Where a more specific code covers the column (`relationship.endpoint_absent`, `structure.boundary_dangling`), that one is raised instead, not as well. One finding per column. | the entity | those rows | their number |

Severity **`warning`**, the same as `junction.endpoint_absent`. Every
conforming reader resolves the value the same way, to nothing, so it is
not an `error` by §9.4's definition. But it is almost never what the
author meant.

What it does **not** cover:

- **A reference to a cut row.** That row exists, and §6.6.1 already
  says what a link to it means.
- **A polymorphic column whose sibling is unset, or names no registry
  entity.** That is a sibling problem, not a target problem. See
  Unresolved.
- **Version columns** (`parent_id`, `superseded_by_id`). The `identity.*`
  codes already cover their chains, including one that names a row that
  does not exist (`identity.chain_asymmetric`).

§9.1's paragraph on `junction.endpoint_absent` gains a sentence:

> A required reference that holds a value naming no row is
> `reference.dangling`, not `junction.endpoint_absent`: the column is
> filled, and what it is filled with points nowhere.

§12.1.2 currently ends its polymorphic paragraph with "that is a
legitimate answer and not a finding (§9.2)". The query's answer does not
change. The report does. Replacement wording:

> A polymorphic reference whose kind is not a registry entity, or whose
> row is absent, resolves to a null `targetUuid`. That is a legitimate
> answer (§9.2): the query does not fail. Where the kind is a registry
> entity and the row is absent, the report carries
> `reference.dangling` (§9.4.1).

**The gate learns it too.** Without this, the code is reported but
never refused, and the write that started this would still go through.
A dangling reference is unambiguously a write that makes the file worse.
That is not true of `unjustified_link`, which 0041 takes off the
blocking list. There are two ways to do it:

- **Now:** `scanIntegrity` gains a dangling-reference check, and
  `GateFinding.kind` gains `"dangling_reference"` as a **blocking**
  kind. The key is the table, row and column. This is a small change
  beside 0041's A2.
- **Later:** 0041 recommends rewiring the gate to diff §9.4 findings
  rather than `scanIntegrity` kinds. Under that rewiring this code
  blocks with no extra work, and the interim kind is removed.

This draft proposes the first now and leaves the second to that later
proposal.

## What it breaks

- **The catalog.** One new code means `codeCount` 55 and a
  `catalogVersion` bump. Every implementation's reporter has a check to
  add, and §9.4 makes the code set closed, so an implementation that
  doesn't add it no longer conforms.
- **Published reports: none today.** A read-only check of every
  reference column (ordinary and polymorphic) in
  `fixtures/hollow_creek.scf` found no dangling values, so
  `hollow_creek.report.json` is unchanged. The production film, after
  the bad link was repaired, also had none.
- **Writes that used to succeed.** Through the host's gate, a write
  that leaves a reference pointing nowhere is now refused. That is the
  intent, but a script that writes a link before its target exists, in
  two steps, will have to write them in the other order. The editor does
  not gate, so it reports the finding and writes anyway (§9.1).
- **Gate tests.** A test that a dangling write is refused, and one that
  a file which already had one does not block an unrelated write (the
  gate diffs by identity).
- **The fixture proves nothing yet.** A conforming reporter and one
  that never checks agree on a clean file. Following §6.6.1's
  two-halves argument, a negative fixture needs at least an ordinary
  dangling reference, a polymorphic one, and a TEXT value in an integer
  reference column.

## Alternatives

| Option | For | Against |
|---|---|---|
| **Do nothing**; fix writers as their defects are found | No spec change | The gate exists because writers have defects. This one passed a plan that reported no risks. The next one will too. |
| **Defer it, as 0041 does**, until the gate is rewired onto §9.4 | One gate change, not two | 0041 is right that a catalog code alone would not have stopped its M1, which is why this draft adds the gate kind as well. Meanwhile the editor and third-party writers keep leaving dangling references unreported, and 0041 itself asks for that to be recorded as a known gap. |
| **Widen `junction.endpoint_absent`** to cover dangling values | No new code | Different condition, different fix ("fill it in" versus "it points nowhere"). It also only covers link entities and required columns, and the polymorphic `entity_anchor.subject_variant_id` is neither. |
| **Make it `error`** | Stops the gate from being bypassed under any lenient policy | §9.4 reserves `error` for data two readers resolve differently. These resolve identically. |
| **Enforce with SQLite foreign keys** | Caught at write | Polymorphic columns can't carry one, and §9.1 says SCF describes rather than enforces. |

## Unresolved

- **A polymorphic sibling naming no entity.** `asset_relationship
  .entity_type` is plain text with no known set (§8.6), so not even
  `vocabulary.unlisted_value` fires on a misspelt kind. A row whose
  kind names no registry entity **and** whose id is set resolves to
  nothing, and is reported by nothing. Should that be
  `reference.dangling` too, or a sibling code of its own?
- **Should the finding name the target?** `rowIds` gives the rows, but
  a reader fixing one wants "no `character` with id 7". §9.5's merging
  of one code on one table loses that. Is a per-row detail worth a
  report-format change?
- **Optional references.** `shot.story_beat_id` and the like are not
  required, and this draft covers them too: a value naming nothing is
  wrong whether or not the column is required. Is there a column where
  that is too strict?

---

<!-- A maintainer fills this in when the proposal is resolved. -->

## Resolution

*Left empty until the proposal is accepted, declined or deferred.*
