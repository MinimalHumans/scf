<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# 0038 — The project poster

| | |
|---|---|
| **Status** | **implemented** — spec 0.65, schema 2.23 (tagged 2026-10-12). See Resolution |
| **Author** | Found while laying out the editor's Project tab; drafted with Claude |
| **Opened** | 2026-10-09 |
| **Affects** | `schema/entity_registry.py` (`asset_relationship.relationship_type`); `registry.json`, `entity-reference.md`; §8.6; §12.12 and Q00's published result |

## The problem

**A film has key art, and the file has nowhere to say which asset it
is.**

Hollow Creek carries its one-sheet as an asset
(`@project/promotional/poster01.png`), with the textless master it was
laid out over. Nothing says either is the poster. A brief, a pitch
page or an editor's Project tab that wants to show the film's face has
to guess from a filename.

## The proposal

**Add `poster` to `asset_relationship.relationship_type`**, which stays
open-valued. A poster is related to the **project row**:
`entity_type` = `project`, `entity_id` = that row.

**Several are allowed, and §8.6's order ranks them.** The first is the
poster; any after it are alternatives — a teaser, a festival cut, a
territory's version. No new column: `order` (0037) already says which
comes first.

**§8.6 gains a sentence** saying so. The member is not restricted by
`entity_type`, but nothing defines what a poster of a character or a
scene would mean.

**Q00 (§12.12) gains `posters`**: the related assets, projected, in
§8.6's order, empty when there are none. It is a brief's answer to
"what does this film look like on a wall", and a consumer that only
wants one takes the first.

**Fixture:** Hollow Creek's project row relates `poster01.png` (asset
51) as its poster. The asset is already in the fixture, so no file is
added. The published Q00 result carries it.

## What it breaks

- **Schema version.** None of its own: it joins the untagged **2.23**
  batch (release checklist §A7). The column set is unchanged, so
  `scf-schema.sql` is unchanged.
- **Q00's published result** gains a member. Result format stays 1.0:
  a member added to a result is additive.
- **Files already written** need nothing. A file with no poster row
  answers `posters: []`.
- **Readers written against an earlier 2.23 draft** see a value they do
  not know in an open vocabulary, which §10.1 already covers.

## Alternatives

**`project.poster_asset_id`.** One reference column, simplest to edit.
It allows exactly one poster, adds a column for one entity, and is a
second way to say "this asset is about that row" beside the one §8.6
already defines.

**A `poster` bundle.** A bundle belongs to the subject cascade (§7); no
binding reaches a project, so it would raise `asset.bundle_unbound`.

**`final`.** Already a member, but it means the finished version of
whatever the asset depicts, not the film's key art.

## Unresolved

- **Should Q13 or `media_resolution` report whether the poster is on
  disk?** Q00 has no root to resolve against, so it projects the asset
  row and says nothing about bytes. Not proposed.

---

<!-- A maintainer fills this in when the proposal is resolved. -->

## Resolution

**Implemented 2026-10-09, accepted 2026-11-10**, as spec 0.65 on
schema 2.23. It was built ahead of formal acceptance, as 0036 and 0037
were; the acceptance was recorded in the 2026-11-10 pass over this
directory. Schema 2.23 was tagged and
pushed with it on 2026-10-12 (`schema-2.23`). The fixture project
relates `poster01.png` as its poster, and Q00's normative result
carries it in `posters`.
