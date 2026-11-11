<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# 0042 — MCP writes take values shaped like their field

| | |
|---|---|
| **Status** | draft — written after the change; implemented in the working tree, not yet committed. See Resolution |
| **Author** | Drafted with Claude, from production use on a short film |
| **Opened** | 2026-11-11 |
| **Affects** | No format change. Code: `scf-mcp` (`src/writeTools.ts`: the `values` input schema of `create_row` and `update_row`, `normalise`, `assertInVocabulary`). Reads §2.4 (open and closed vocabularies) and §2.5 (lists of strings) as they stand. Related: [0040](0040-a-reference-to-nothing.md), [0043](0043-batch-writes-and-row-scoped-plans.md) |

## The problem

`asset.tags` could not be written through the MCP at all.

While adding a generated still for shot 1A of the Hollow Creek demo,
`create_row` on `asset` with `tags: ["shot"]` failed before the planner
ran:

```
MCP error -32602: Input validation error: Invalid arguments for tool
create_row: Invalid input at values.tags
```

The `values` schema let each value be a string, number, boolean or null
and nothing else. So an array was refused in every field. The asset was
added without tags.

The obvious workaround was worse. `tags: "shot"`, a plain string, was
accepted with no risks and would have been stored as the text `shot` in
a column that §2.5 says holds a **JSON array of strings**. Readers
project a `string_list` as an array (§12.1.2), and a malformed one is
carried as text (§9.2). So the write would have succeeded, and the tag
would have quietly turned into a paragraph. Every existing asset row in
the fixture stores `tags` as an array, e.g. `["location","kitchen","night"]`.

Two smaller things turned up in the same code:

- The MCP schema the server advertised for `values` did not match what
  its own validation accepted.
- `assertInVocabulary` checked a `multiselect` value, which is stored as
  comma-separated text, as one string. So `"a, b"` was compared against
  the option list as a single value. No multiselect in schema 2.25 is
  closed, so this has not bitten anyone yet.

## The proposal

**The transport accepts any JSON value, and the registry decides what a
field can hold.** The planner checks each value against its field's
`fieldType` and stores it in that field's storage shape. A mismatch is
refused at plan time, with a message that names the field and the shape
it wants.

| `fieldType` | Accepts | Stored as |
|---|---|---|
| `string_list` | an array of strings; JSON text already holding one | its JSON text; `[]` is null (§2.5: they mean the same) |
| `json` | an array or object; a string that is already JSON | its JSON text |
| `multiselect` | an array of strings; comma-separated text | comma-separated text, as the editor writes it |
| `integer`, `float` | a number; a string that is one | the number |
| `boolean` | `true`/`false`; `1`/`0` | `1`/`0` |
| reference, polymorphic reference | a uuid or an id | the row id (unchanged, see 0040 and 0041 C1) |
| every other field | one value | as given; an array or object is refused |

So `tags: "shot"` is refused with `give an array of strings, e.g.
["shot"]`, and `description: [...]` is refused because the field holds
one value. Each value in a closed `multiselect` is checked on its own.

The advertised input schema for `values` names the same union: string,
number, boolean, null, array, object. A test pins the two together.

## What it breaks

- **A caller that wrote a plain string into a `string_list` field now
  gets a refusal** instead of a silently malformed row. That is the
  point of the change. Any such row already in a file stays as it is,
  and readers carry it as text (§9.2).
- **A string that is not a number, written to an `integer` or `float`
  field, is now refused.** Before, it was passed through to SQLite,
  where column affinity kept it as text.
- **A string other than `1`/`0` written to a `boolean` field is now
  refused.**
- No `.scf` file changes, and the editor's write paths are untouched.

## Alternatives

- **Coerce a bare string into a one-item list.** That is friendlier for
  `tags: "shot"`. But it guesses, and the same guess turns
  `"kitchen, night"` into one tag, not two. A refusal that shows the
  right shape costs one retry.
- **Flag the mismatch as a risk instead of refusing it.** Risks are for
  things a person should weigh, such as a silent character linked to a
  scene. A value no reader can parse as its type is not a judgement
  call. `normalise` already refuses what it would silently lose (an
  unknown field, a value outside a closed vocabulary), and this belongs
  with those.
- **Do nothing.** Then no `string_list` field (29 of them) and no `json`
  field can be written through the MCP, and the workaround corrupts the
  data.

## Unresolved

- Should the multiselect storage shape be specified? Today the editor
  writes comma-separated text, and §9.4's `vocabulary.unlisted_value`
  splits on commas, but the spec does not say so. A `multiselect` holding
  a JSON array, like `string_list`, would be cleaner. That would be a
  format change and belongs in its own proposal.
- `json` fields accept any JSON. Some have an expected shape
  (`entity_anchor.region_box` is a box). Should the registry describe
  those shapes so writers can check them?

---

## Resolution

*Implemented before the proposal was written, at the user's request, to
unblock tagging assets. The change is in `scf-mcp/src/writeTools.ts`
with tests in `scf-mcp/test/writeTools.test.ts`: list, json and
multiselect values are accepted and stored correctly, the wrong shapes
are refused, and the advertised schema admits arrays and objects. It is
uncommitted pending review, and the status should move once it is
reviewed.*
