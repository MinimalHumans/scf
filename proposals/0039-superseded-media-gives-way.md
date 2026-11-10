<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# 0039 — Superseded media gives way to its successor

| | |
|---|---|
| **Status** | draft |
| **Author** | Drafted with Claude, from production use on a short film |
| **Opened** | 2026-11-10 |
| **Affects** | §12.8 (Q13) and everything that reads it (Q14's media, `shot_media`); §6.6 gains a sentence; Q13 `resultFormat`; published `Q13-*` results; the conformance fixture |

## The problem

An author who replaces an asset does what the format asks: marks the old
row `superseded` and points `superseded_by_id` at the new one (§6.6,
§12.14). Q13 then goes on returning the old row as though nothing had
happened.

This bit in production. A film had 213 assets, and 95 of them were
`superseded`, every one with a successor: storyboard passes,
generation takes, a replaced character sheet. Asked for a character's
`visual_identity`, Q13 returned the superseded sheet with
`"state": "resolved"` and `"provenance": "bundle"`, right beside the
sheet that replaced it, which the anchor also carried. The two sheets
show **different actors**. An agent writing a prompt from that result
attaches both.

There was no way to tell from the result. A reference is a derived
record with fixed members (§12.8), and none of them is the asset's
lifecycle. The consumer has to know to go back and read every asset row,
and then has to decide what `superseded` means for itself. That is
exactly the "two readers answer different questions and both conform"
problem §6.6 says it guards against.

§6.6 is deliberate about this. Only `cut` is excluded from resolution,
because only `cut` claims something about the FILM. The rest describe
the row's editorial standing. That reasoning holds for the film as a
whole: a superseded storyboard is still part of the record, and Q15
should still walk to it. But Q13 asks a narrower question, **which media
to use here**, and for that question "replaced by that one" is an
answer, not a side note.

## The proposal

Two changes to §12.8, and neither one touches §6.6.1's exclusion rule.

**1. A superseded reference gives way to its successor.** After the
layers are walked and before the at-most-once rule applies, each
reference whose asset has `lifecycle_status = superseded` is replaced by
the asset at the end of its forward version chain. Follow
`superseded_by_id` until you reach a row that is not `superseded`,
stopping on a cycle (§9.2, `identity.chain_cycle`). Replacement wording
for §12.8:

> **A superseded asset gives way to its successor.** Where a layer
> brings an asset whose `lifecycle_status` is `superseded`, the
> reference names instead the last asset on its forward version chain:
> `superseded_by_id` followed until a row that is not `superseded`, or
> until a row already visited. The successor keeps the layer's
> `provenance`, `role` and `anchorName`, and its `supersedes` member
> names the asset it stands in for. The at-most-once rule then applies
> as written, so a successor that another layer already carries appears
> once, under the stronger layer. A superseded asset with no successor
> stays, as it is: the resolver is total (§9.2), and
> `identity.superseded_without_successor` already reports the gap.
>
> This is not exclusion. §6.6.1 excludes a row from the film; this
> answers which version of a file to use, and Q15 still walks the whole
> chain. A cut successor is excluded by §6.6.1 like any other cut row,
> and the reference is then dropped, not walked back.

**2. Every reference carries its asset's lifecycle.** Add two members to
the reference record:

| Member | Kind | |
|---|---|---|
| `lifecycleStatus` | Stored value | The referenced asset's `lifecycle_status`, unset read as `active`. |
| `supersedes` | Identity or null | The uuid of the superseded asset this reference stands in for, where (1) replaced one. Null otherwise. |

`deprecated`, `archived` and `draft` stay in force, unchanged. Item 2
makes them visible so a consumer can choose what to do, rather than
having to rediscover them.

§6.6 gains one sentence after "Only `cut` is excluded from resolution":

> §12.8 resolves a superseded asset to its successor; that is a
> substitution inside one query, not an exclusion, and is stated there.

## What it breaks

- **Q13's result shape.** Two new reference members means a
  `resultFormat` bump and regenerating every published `Q13-*` result,
  even though no value changes for the current fixture.
- **Q13's answers on real files.** A file with superseded bound media
  gets different references. That is the point, but it is a change:
  anything that cached the old references sees new uuids.
- **Q14 and `shot_media`**, which resolve media through §12.8, change in
  the same way.
- **The conformance fixture proves nothing yet.** Its only version chain
  (`kitchen_night_plate_v1` → `v2`) leaves v1 `active`, so an
  implementation that ignores this rule passes every case. The fixture
  needs a bound asset that is `superseded` with a successor, and a
  second whose successor is already carried, to exercise the
  at-most-once interaction. That follows §6.6.1's two-halves argument:
  superseding a bound asset MUST change the answer.

## Alternatives

| Option | For | Against |
|---|---|---|
| **Do nothing**; authors cut what they mean to drop | No change | `cut` says "not in the film", which is false for a replaced storyboard that belongs in the record. Authors either lie in one column or get stale media in every prompt. The production file had 95 of these. |
| **Exclude `superseded` outright** in §12.8 | Simpler; no chain walk | Loses the media whenever the successor sits in a different bundle or binding from the original. A replaced asset should hand over its place, not leave a hole in it. |
| **Only add `lifecycleStatus`** (item 2 without item 1) | Purely additive | Every consumer re-implements the chain walk, and the readers diverge, which is the problem §6.6 names. Worth doing anyway, which is why it is item 2. |
| **Exclude `archived` and `deprecated` too** | One rule for every non-active status | `deprecated` is "discouraged for new authoring", not "replaced", and has no successor to give way to. Left to Unresolved. |

## Unresolved

- **Key on `lifecycle_status` or on `superseded_by_id`?** The fixture
  has an `active` row with a successor. This draft keys on the status,
  the author's explicit claim, so that row is unaffected. Is an active
  row with a successor a contradiction that deserves a finding of its
  own?
- **`archived`** is "not in the working film". Should Q13 drop it as
  well, or at least report it in `trail`? This draft leaves it in force
  and only labels it.
- **Should the replaced asset appear in `trail`**, as excluded layers
  do, so the substitution can be seen without diffing references?
  `supersedes` carries it on the reference, and a trail record would
  repeat it.
- The production file's chains all lack `superseded_at`, and the
  successor of the replaced sheet has no `parent_id`. Both already have
  codes (`identity.successor_without_timestamp`,
  `identity.chain_asymmetric`). Does this rule make either one weigh
  more?

---

<!-- A maintainer fills this in when the proposal is resolved. -->

## Resolution

*Left empty until the proposal is accepted, declined or deferred.*
