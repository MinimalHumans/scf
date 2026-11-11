<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# 0043 — Batch writes, in-batch references and row-scoped plans

| | |
|---|---|
| **Status** | draft — implemented in the working tree alongside this text, with tests; uncommitted pending review |
| **Author** | Drafted with Claude, from production use on a short film |
| **Opened** | 2026-11-11 |
| **Affects** | No format change. Code: `scf-core` (op table: new `record.batch` op, new `batch` argument kind, optional `uuid` on `record.create`; `createRecord` takes an optional uuid; `savepointExec` exported). `scf-mcp` (new `write_batch` tool; `create_row`, `update_row` and `delete_row` plans bound to the rows they touch, not the film revision; slimmer plan responses). The editor's write paths and `Session.write`'s revision check are unchanged. Related: [0042](0042-mcp-writes-take-field-shaped-values.md) |

## The problem

Adding 21 small rows to a film took about 45 sequential tool calls.

The task was to add seven storyboard frames to Hollow Creek. For each
one that meant three writes: an `asset`, an `asset_relationship` with
`relationship_type: "storyboard"` linking it to its shot, and an update
to the shot's `description`. Every write is plan, then confirm. That is
intended and stays. But three things made it far worse than 21 × 2:

1. **Every plan is bound to the whole film's revision.** The `planId`
   hashes `basedOn`, the film revision at planning time. Once the first
   approved plan was applied, every other approved plan came back
   `plan_changed`, even though its content was identical and it touched
   different rows. So each change was re-planned and re-confirmed one at
   a time, and the person's single approval of the whole set counted for
   nothing.
2. **A row that does not exist yet cannot be referenced.** The
   `asset_relationship` cannot be planned until its `asset` has a uuid.
   So "add this frame and link it to 1A" cannot go into one approval,
   and a failure halfway leaves an asset with no link.
3. **Responses are bloated.** `update_row` echoes the whole row in
   `op.args.values`, because `record.update` writes every field. A
   one-field change returns every field of the shot.

## The proposal

### 1. One plan for many writes: `write_batch`

A new MCP tool takes an ordered list of operations:

```json
{ "ops": [
  { "op": "create", "entityType": "asset", "ref": "frame1",
    "values": { "name": "1A_board.png", "identifier": "@project/1A_board.png",
                "tags": ["storyboard"] } },
  { "op": "create", "entityType": "asset_relationship",
    "values": { "asset_id": "$frame1", "entity_type": "shot",
                "entity_id": "<shot 1A uuid>", "relationship_type": "storyboard" } },
  { "op": "update", "entityType": "shot", "uuid": "<shot 1A uuid>",
    "values": { "description": "…" } }
] }
```

It follows the same two steps as every write tool. Called as it stands,
it returns **one plan**: every change, the risks of every operation
together, the integrity findings of the batch as a whole, and **one
`planId`**. Called again with `confirm`, it applies the batch **in one
transaction through the integrity gate**. Either every operation is
written or none is.

Each operation is checked as its single-row tool would check it: field
shapes (0042), vocabularies, references, and for a delete, what points
at the row. A batch may not touch the same existing row twice.
A batch with any delete is destructive.

### 2. In-batch references

A `create` may carry a `ref`, a name for the row it creates. A later
operation in the same batch can then put `"$<ref>"` in a reference
field, plain or polymorphic. The planner checks that the ref is
declared earlier in the batch and that its entity is the one the field
points into. The op carries the reference as `{"$ref": "<name>"}`, and
the core resolves it to the new row's id when it writes. The result
lists each created row's `ref`, entity, id and uuid.

A `$` reference is only read in a reference field. No reference field
holds a string starting with `$`, so the marker cannot be ambiguous.

### 3. A plan is stale when its rows change, not when the film does

For `create_row`, `update_row`, `delete_row` and `write_batch`, the
`planId` no longer hashes the film revision. It hashes:

- the plan's content (changes, risks, op, integrity), as before;
- **a digest of every existing row the plan reads or writes**: the
  rows it updates or deletes, and the rows its references resolve to.

At `confirm`, the plan is made again from the current film, as it is
today. If nothing it touches has changed, the `planId` is the same and
it is applied, however far the film's revision has moved. If a row it
touches has changed, the `planId` differs and the plan comes back
`plan_changed`, as now.

Applying still passes `expectedRevision`, set to the revision the plan
was just re-made at. So the window between re-checking and writing is
still guarded. Only the window between planning and approving is
widened, and only for rows the plan does not touch.

`add_shot`, `set_shot_cut`, `move_shot` and `set_title_page_key` keep
the whole-film binding. They renumber or reorder rows around the one
they address, so the film is the honest scope for them.

### 4. A caller-supplied uuid on create

`create_row`, and a `create` in `write_batch`, may give a `uuid`. It
must be a well-formed uuid that is not already in use in that table. It
is part of the request, so the plan stays deterministic. In `scf-core`,
`record.create` gains an optional `uuid` argument, and `createRecord`
an optional uuid parameter. With no uuid given, behaviour is exactly
as today.

### 5. Slimmer responses

The plan a write tool returns shows only the fields being changed in
`op.args.values`, not the full row. `verbose: true` returns the full op.
The `planId` is still computed over the full op, so what is approved is
exactly what is applied.

## What it breaks

- **Two approved single-row plans can now both apply**, where before
  the second was refused. That is the point. It does mean the second is
  applied without the person re-reading the film in between. The
  guarantee is now "nothing this plan touches has changed", not
  "nothing has changed".
- **A plan's `basedOn` still names the revision it was made at**, but
  for these four tools it no longer decides staleness. A client that
  compared `basedOn` itself would have to stop.
- **`op.args.values` in an `update_row` plan is no longer the full
  row** unless `verbose` is set. A client that read the full row from
  the plan has to ask for it.
- **The core op table gains one op and one argument kind.** The host
  lists ops to clients (`ops`), so `record.batch` appears there. The
  editor does not call it.
- No `.scf` file changes.

## Alternatives

- **Keep whole-film binding but let one approval cover a list of
  plans.** That fixes the re-confirming but not the dependency, since an
  asset and its link still cannot be planned together. It also gives up
  atomicity.
- **Let the agent pick uuids for every new row and skip `$ref`.** Item
  4 allows that, and it is enough for a careful client. But it is easy
  to get wrong (reusing a uuid, linking to a row in a batch that later
  fails). `$ref` makes the dependency explicit and checkable.
- **Row-level revisions in the file.** That is a format change, and the
  digest of the touched rows gives the same answer without one.
- **Do nothing.** Twenty rows cost forty-five calls, approvals are
  thrown away, and a half-applied set of related rows is the normal
  failure.

## Unresolved

- **Natural-key collisions between plans.** Two `create_row` plans for
  the same new character name both stay valid, and both would apply. A
  natural-key check at plan time would catch the second, but it would
  have to read the table, and the whole table is a wider scope than "the
  rows I touch". Should a create's reads include the rows sharing its
  natural key?
- **Updating a row created in the same batch.** It is not allowed
  here: update and delete name existing uuids. Is there a real case for
  it?
- **Batch size.** No limit is set. The integrity gate scans the film
  once before and once after the batch, not per op, so a large batch
  costs no more to gate than one row.

---

## Resolution

*Left empty until the proposal is accepted, declined or deferred.*
