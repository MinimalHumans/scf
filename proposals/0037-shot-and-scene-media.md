<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# 0037 — Shot and scene media

| | |
|---|---|
| **Status** | **implemented** — spec 0.64, schema 2.23 (tagged 2026-10-12). See Resolution |
| **Author** | Found while storyboarding a project in the editor; drafted with Claude |
| **Opened** | 2026-10-09 |
| **Affects** | `schema/entity_registry.py` (`asset_relationship`); `registry.json`, `scf-schema.sql`, `entity-reference.md`; §8.6; `shotContext`'s `related` member and its published result |

## The problem

**A shot can have its storyboard attached, but nothing can say it is the
storyboard, and a storyboard of six panels has no order.**

§8.6 already puts media about a scene or a shot on `asset_relationship`
(`entity_type` = `scene` or `shot`), and `shotContext` already returns
those rows as `related`. So the row shape exists. Two things are
missing:

1. **What the file is for.** `relationship_type` offers `reference`,
   `documentation`, `concept`, `inspiration` and `final`. The things a
   storyboard artist or a generation pipeline attaches to a shot are
   storyboard panels, a start frame, an end frame and previs. None of
   them is in the list. The field takes other values, so a file could
   store `storyboard` today, but every implementation would spell it
   differently, and no consumer could rely on it.

   **Start and end frames are the case that matters most.** A video
   generator conditioned on a first and a last frame has to know which
   image is which. Calling both `reference` makes that impossible to
   read back.

2. **Order.** `bundle_asset` has `order`; `asset_relationship` does not.
   A storyboard is a sequence: panel 3 comes after panel 2, and the
   filename is not a reliable way to say so. Today the only stable
   order is the row id, which records when a panel was attached, not
   where it falls.

**This has actually bitten.** The project was being storyboarded in
another session, and the editor had nowhere to put the panels. The
reference boards cover characters, costumes, locations and props, and
the Shoot tab's shot row had no media at all. The editor half of the fix
is UI. This proposal covers the half that belongs to the format.

## The proposal

**Add four members to `asset_relationship.relationship_type`**, which
stays open-valued:

| Value | Means |
|---|---|
| `storyboard` | A storyboard panel: a drawing or frame planning the shot. Several are ordered by `order`. |
| `start_frame` | The frame the shot opens on, as planned or generated. |
| `end_frame` | The frame the shot closes on. |
| `previs` | A moving rough: an animatic, a blocking render or a previs clip. |

Everything else attached to a shot, such as a reference clip, a sound,
a 3D scan or a lighting plate, is `reference`. §8.5 says the format
comes from the identifier, so a `.wav` reference and a `.glb` reference
need no member of their own.

**Add `asset_relationship.order`**, an optional integer with the same
meaning it has on `bundle_asset`: position among the rows relating
assets to the same entity, ascending.

**§8.6 gains the ordering rule:**

> Rows relating assets to the same entity are ordered by `order`
> ascending, with rows that have none after rows that do, then by row
> id. An implementation listing them MUST present them in that order.
> `order` positions a row among all of that entity's related assets,
> not only those of its own `relationship_type`, so a storyboard's
> panels keep their sequence whatever else sits beside them.

**`shotContext`'s `related` member** carries `order`, and lists scene
rows then shot rows, each in that order.

**Fixture:** Hollow Creek's first shot gains two ordered storyboard
panels and a start frame. They resolve to assets the fixture already
has (the textless master and the poster), so no files are added. The
published `ShotContext` result shows them coming back in order.

## What it breaks

- **Schema version.** It joins the **2.23** release batch, which the
  release checklist (§A7) says carries every registry change in one
  bump. 2.23 is not tagged, so nothing published changes.
- **Generated artifacts.** `registry.json`, `scf-schema.sql`,
  `entity-reference.md` and their `SHA256SUMS` entries.
- **The published `ShotContext` result** gains three `related` rows,
  each with `order`.
- **Files already written** gain the column on open (§1.4). It is null
  until written, and null rows sort by row id, which is the current
  behaviour.
- **Readers written against 2.22** see an unknown column (§10.1) and
  preserve it. One that ignores `order` shows storyboard panels in
  attachment order. That is wrong but harmless.
- **Spec 0.64 is a minor version**, because the ordering rule is a MUST.

## Alternatives

**Do nothing; write `storyboard` as an open value.** This works today,
and the editor could ship on it. It leaves every implementation to
invent its own spelling, and leaves panel order to filenames.

**A `shot_asset` link entity** with its own roles and order. §8.6
already refuses a fourth binding table for this case, and a dedicated
link would duplicate `asset_relationship` for one `entity_type`. Scenes
would need the same thing again.

**A bundle per shot**, with `bundle_asset.role_in_bundle` and `order`.
The order would be free. But a bundle belongs to the subject cascade
(§7). No binding would reach it, so it would raise
`asset.bundle_unbound`, and a shot's storyboard is not something with
precedence or filters.

**Order scoped per `relationship_type`.** Each group would count from
1 on its own. Every reader would then have to group before sorting, and
moving a panel from `storyboard` to `start_frame` would need two
renumberings. One sequence per entity is simpler, and grouping is still
possible by sorting within a type.

## Unresolved

- **Should two `start_frame` rows on one shot raise a finding?** They
  could be alternatives under consideration, and a finding would nag
  about a normal stage of work. Not proposed.
- **Should `start_frame`/`end_frame` on a scene mean anything?** The
  members are not restricted by `entity_type`. A scene's start frame
  reads naturally as its first shot's, but nothing here says so.
- **Should `shot_readiness` notice a shot with no storyboard?** Only
  where a pipeline needs one. That belongs to a rubric, not to the
  format.

---

<!-- A maintainer fills this in when the proposal is resolved. -->

## Resolution

**Implemented 2026-10-09, accepted 2026-11-10**, as spec 0.64 on
schema 2.23. It was built ahead of formal acceptance, as 0036 was; the
acceptance was recorded in the 2026-11-10 pass over this directory.
Schema 2.23 was tagged and pushed with
it on 2026-10-12 (`schema-2.23`), which is why the release batch that
followed is 2.24. Shot 12-04's storyboard panels exercise it in the
fixture, their `order` running against their row ids.
