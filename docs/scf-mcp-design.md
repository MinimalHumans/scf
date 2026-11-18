<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# `scf-mcp` — design note

An MCP server over a `.scf`, so an agent can answer questions about a
film and assemble a shot prompt without being handed a schema and told
to write SQL.

**Status: built.** `scf-mcp/` implements it; its tools are listed at the
top of `scf-mcp/src/mcpServer.ts`. Since 2026-10-19 it runs only inside
the SCF Editor desktop app, one server per agent in the app's window,
reached through the app's `scf-editor mcp` pipe
([`scf-write-ownership.md`](scf-write-ownership.md)); it is no longer a
Node process, nor to be published to npm (`release-checklist.md` §A10).

Written for Jesse as a proposal, checked against spec 0.51 / schema 2.13,
when it sat post-MVP behind three unexercised Part 3 features (see
[`editor-mvp.md`](editor-mvp.md)). It is kept as the design record —
why the server is shaped the way it is. Where it and the code disagree,
the code is current. It moved from `spec/` to `docs/` in spec 0.63: it
is not normative, and it had sat beside the documents that are.

---

## 1. What it is for

One sentence, and the whole design falls out of it:

> A user says *"SeeDance 2.5 prompt for shot 10A"* and gets prompt text
> plus a list of reference files to attach.

That is **four tool calls**, not fifteen:

    find("shot", "10A")        → uuid
    shot_context(uuid)         → the frame: framing, look, who, lines
    shot_media(uuid)           → what to attach
    shot_readiness(uuid)       → what is thin

The agent then renders those payloads into SeeDance's format using a
template file. Which model is being targeted is knowledge that lives in
**one markdown file the user owns** — not in the format, not in this
server.

### The boundary, stated once

**SCF is the ground truth of the film. It is not the workflow for making
it.** A generated prompt is a fact about a production process, and it
belongs to the tool that generated it. It comes back into the `.scf`
only if it becomes a fact about the film — a character sheet generated
from SCF descriptions and then adopted as the reference is a film fact;
the prompt that produced it is not.

This server therefore **reads**, and writes only the facts about the
film that someone asked it to. *(This section used to say it had no
write tools. It now has seven, held to the rules in
[`scf-write-ownership.md`](scf-write-ownership.md): a plan before
anything changes, an apply that is refused if the film has moved or the
change would add an integrity finding, a snapshot before an agent's
change, and a journal of who wrote what. `--read-only` removes them.
Prompts, notes on how a shot was made and other workflow still belong in
the tool that produced them.)*

---

## 2. Shape

    scf-core/                     (existing)
      src/naturalKey.ts           NEW — label → uuid
      src/shotContext.ts          NEW — the composite
      test/shotContext.test.ts    NEW — parity against blessed results

    scf-mcp/                      NEW package
      src/server.ts               stdio MCP server, four tools
      src/config.ts               .scf path, root→location map

    templates/
      seedance-2.5.md             NEW — yours, not the format's

**Why the two modules are in `scf-core` and not in the server.** The
fixture and the blessed expectations are in `scf-core`, and the
composite's whole safety property is a test that compares it against
them (§4.3). Put it in the server and the test cannot be written where
it belongs.

**Why `scf-mcp` is a separate package and not a folder in `scf-core`.**
`scf-core` is what a conforming implementation is graded on, and its
`index.ts` is an explicit public surface, recorded in
`spec/api-surface.json` with a CI check over it. An MCP server has no conformance status. Mixing them makes that
check mean less than it does today.

---

## 3. `resolveNaturalKey` — the part that is easy to get wrong

```ts
// scf-core/src/naturalKey.ts
export interface KeyHit { uuid: string; entity: string; label: string; }

export async function resolveNaturalKey(
  ctx: ScfContext, entityType: string, label: string,
): Promise<KeyHit[]>;
```

**Returns an array. Always — including when exactly one row matches.**

That is the entire design decision, and it is deliberate. §6.4 says a
reader MUST report duplicate natural keys rather than reject them. A
signature returning `KeyHit | null` makes that rule something the caller
has to remember; a signature returning `KeyHit[]` makes it something the
caller cannot avoid. The agent sees two hits and asks which one.

**Read the keys from the registry, not from a table in this file.**
§6.3 defines natural keys and `junctionKeyFields` already exposes the
machinery. A hand-written map is a second description that will drift —
`queryPaths.ts`'s `entity` field drifted for twelve revisions and
published blank tables the whole time (spec 0.50).

**Three traps the fixture already contains.** Test against it and these
are free:

| | |
|---|---|
| Scene `12A` exists | §4.2.1's grammar is not "an integer" |
| Scene numbers have gaps — 1, 3, 7, 9 | Do not infer position from the label |
| Scene `16` follows `19` in story order | A number is a **label**, never identity or order (§4.2) |

Add a fourth in the test itself: a deliberate duplicate must come back
as two hits, not one.

### Why this exists at all

`selectors.json` is in `fixtures/expectations/` because a third party
being graded on the queries had no way to name a row except by reading
parameters out of the artifact it was being graded against. An agent
handed the string `"10A"` has exactly that problem. This is that file,
at runtime.

---

## 4. `shotContext` — the composite

```ts
// scf-core/src/shotContext.ts — three calls, one version (§4.4, §4.7)
export interface ShotContext {          // the frame
  contextFormat: "3.0";
  shot:      ListedRow;             // the shot's own row, as `list` returns it
  look:      Q07Result;             // the frame at this shot
  presence:  ShotPresenceMember;    // who is at the shot, spec §4.6
  lines:     ProjectedRow[] | null; // the lines it covers, §4.7; null if unrecorded
  physical:  Q06Result[];           // per character seen
}
export interface ShotMedia {            // what to attach
  contextFormat: "3.0";
  shotUuid:  string;
  subject:   string | null;         // one subject, or every subject at the shot
  media:     Q13Result[];           // per subject × intent that has something to say
  swept:     SweptSubject[];        // every subject, the intents asked, which were empty
  related:   RelatedAsset[];        // assets about the scene or shot (§8.6)
}
export interface ShotReadiness {        // what is thin
  contextFormat: "3.0";
  shotUuid:  string;
  readiness: Q14Result[];           // per target and character (§4.6)
}

export async function shotContext(ctx, shotUuid): Promise<ShotContext>;
export async function shotMedia(ctx, shotUuid, locate?, rootMapped?,
                                subjectUuid?): Promise<ShotMedia>;
export async function shotReadiness(ctx, shotUuid): Promise<ShotReadiness>;
```

The scene package (Q04) and the brief (Q00) are not members: they are
their own queries, asked with `shot.fields.scene_uuid` and with nothing.

### 4.1 It composes and derives nothing

Every member is the **unmodified return of a canonical query**. No
filtering, no merging, no re-ordering, no picking a winner.

`shot`, like `swept` and `related`, is not a canonical query's return:
none is scoped to a shot's own row. It is the row `listEntities` returns for
that shot, found in the scene's list rather than projected again, so
`shot_context` and `list` cannot describe one shot two ways.

The queries already resolved everything: Q07 returns the direction
cascade's `leaf` and its `layers`; Q13 returns the `trail` and what is
in force at the end of it. **Hand the agent the leaf.** The trail is
useful as explanation for a human reading the prompt, but if the model
chooses from the trail then a normative resolution has been moved into a
nondeterministic component and two runs will disagree.

Any line of resolution logic inside `shotContext` is a second
description of a normative answer. The editor's query pages once held
exactly that — their own Q04 payload rather than a call to `q04Result` —
and now render scf-core's `qNNResult()` instead. A composite with six
members has six chances to diverge.

### 4.2 It does the fan-out because the fan-out is expensive

Q13's parameters are `subjectType`, `subject`, `intent`, `scene`, `shot`
— **one call per subject per intent**. A shot with three characters, a
location and two props is a dozen calls. Left to the agent that is a
dozen round trips it has to plan; done here it is a loop. Splitting the
answer into three calls (§4.7) keeps this: each call still works out
who is at the shot and what to ask about each.

The subject list comes from `presence` (spec §4.6): the shot's own
`shot_character` and `shot_prop` rows, plus the scene's subjects unless
the frame is complete, plus the scene's location, which a shot always
shares. How each is present decides what it is asked for: a **seen**
subject every intent and, for a character, physical direction; a
**heard** one its voice and acoustic intents only; a **named** one
nothing, reported in `swept` with a note.

**The intents are per subject, not per subject KIND.** The first
implementation took them from the declared query paths, which key on
`<subjectType>_id`; only `character` has one, so the location and the
props were collected into the subject list and asked for nothing, and
the payload came back looking complete. Writing a prompt for shot 3B
that hid the DOP's framing plate for the scene, which is bound to the
location.

So: what a query path declares for the kind, UNION what the file binds
to that subject — every intent a live binding or shot override puts in
force for it — with the subject's anchors as a last resort where it has
neither. Both halves, because a declared path asking for `motion` on a
character with no motion bundle returns an empty answer, and an empty
answer is the difference between "there is no motion reference" and
"nobody asked".

`swept` records every subject and the intents asked for. A composite
that quietly returns a partial answer is worse than one that refuses,
and the only way a caller can see a partial answer is if it says so.

### 4.3 The test is the point

`test/shotContext.test.ts` runs against `hollow_creek.scf` and asserts
**each member is byte-identical to the corresponding blessed
`.result.json`**.

This buys drift protection without publishing a seventeenth normative
artifact. A composite that can only be wrong by disagreeing with a
published result cannot quietly rot. It is the cheapest available
version of the property the whole conformance suite is built on.

### 4.4 Version the payload

`contextFormat`, on its own track — the same reasoning as
§12.1.1's `resultFormat`, which exists because envelopes needed to
version independently of the schema. Adding a version later is a
breaking change to whatever is already consuming it; adding it now costs
one field.

**A new member is additive and keeps the version; a member that changes
type moves it.** `shot`, `presence`, `lines`, `swept` and `related` all
arrived within 1.0. `readiness` changing from one Q14 result to a list
(§4.6) is `2.0`. Splitting the composite into three calls and dropping
`scene` and `brief` (§4.7) is `3.0`, shared by all three calls.

### 4.5 Not a Q16

§12.0 is explicit that defining the sixteen does not preclude asking
others, so a composite needs no spec change and gets none.

Promote it only if a **second implementation** needs it. §12 is for
things every conforming reader must agree on; until someone else wants
it, this is one tool's convenience.

---

### 4.6 Readiness covers the shot, not only its look

`shot_readiness`'s `readiness` is the pre-flight for everything the
shot calls carry: a Q14 result per target and subject, each unmodified,
in a fixed order.

| Target | Asked for |
|---|---|
| Q07 | the shot: its look |
| Q08 | the scene: its sound |
| Q02, Q06 | each character SEEN at the shot (§4.2's `presence`): subject in context, which alone checks costume, and physical direction |
| Q05 | each character who SPEAKS in the shot's `lines` |

The characters come in `presence` order, each with Q02, Q06 and Q05 as
they apply, and then Q05 for anyone who speaks in `lines` and is not at
the shot: an off-screen line in a frame recorded without its speaker.

**Who speaks is read from the script.** Only a cue line names its
character, so a line of dialogue is spoken by the nearest cue above it in
the scene, which may sit just outside the shot's range. With no `lines`,
everyone seen or heard at the shot counts as speaking. A named character
gets nothing.

**Only Q07 is asked at the shot.** The other rubrics take a character
and a scene, and the envelope records exactly the parameters asked, so a
Q06 result does not claim a shot it never used.

**Q13 is not asked.** `media` and `swept` already say when a subject
has no binding or a file is missing, which is all its rubric checks.

**Overlapping rubrics are not merged.** Q02 asks about appearance, which
Q07 also asks about, and both results say so, each under its own
target. Merging them would be the second description of a normative
answer that §4.1 rules out.

### 4.7 Three calls, each small enough to take whole

One call answered everything, and for a shot of three characters, three
props and a room it was 68 KB as a client displayed it, past the limit
some clients put on a single tool result. Such a client saves the rest
to a file, and an agent that does not go and read it works from half an
answer without knowing.

So the composite is three calls, grouped by what a prompt writer does
with them:

| Call | Answers | Members |
|---|---|---|
| `shot_context` | the frame: what is in it and how it reads | `shot`, `look`, `presence`, `lines`, `physical` |
| `shot_media` | what to attach | `media`, `swept`, `related` |
| `shot_readiness` | what is thin | `readiness` |

**The scene and the brief are not repeated.** Q04 is the largest member
the single call had, and it was already its own tool (`scene_package`),
as Q00 was (`brief`). A shot's own lines are in `lines`; the scene's
whole text is one call away.

**`shot_media` leaves out results with nothing to say**: no references
and an empty trail, such as a motion intent for a character nothing
binds motion to. `swept` names each one under its subject's `empty`, so
the absence is still reported. A result whose trail explains an absence
(a binding EXCLUDED, and why) is kept: that is an answer.

**`shot_media` can take one subject at a time.** Media grows with the
scene, not the shot: one Q13 per subject and intent. A crowded shot can
outgrow one result however it is grouped, so `subjectUuid` asks about
one subject, which must be at the shot.

**Each answers from the file as it is when the call runs** (§5.1), and
each names the shot it answers for. If the film is saved between two of
the calls, the later one sees the save. That is the right answer to
give: an agent should prompt from what the file says now, not from a
copy held since its first call.

None of this is a ceiling. Shots will carry more context and clients
will accept more; the split is about taking an answer whole today, and
the per-subject call is the room left for growth.

## 5. The server

*(The server is a client of the SCF host — `scf-host`, found or started
on demand by `nodePlatform.ts` — not a process that opens files itself.
Reads are SQL on the host's read-only connection; writes are the host's
named ops. The write tools, their plan/confirm protocol and the host's
safeguards are in `writeTools.ts` and `docs/scf-write-ownership.md`.)*

The shipped server is wider than this section first planned; where the
two disagree, `scf-mcp/src/mcpServer.ts` is what runs.

### 5.1 No handle outlives a call

`open` remembers a film's path and roots, and opens nothing. Each tool
call connects to the SCF host on a connection of its own, has the host
open the film for it, answers, and disconnects, however the call ends
(`withProject`, `projectCache.ts`). The host lets go of a film when its
last client does, so the effect is the same as before the host existed:
nothing is held open between calls.

The server is a process the client keeps for its whole session. Holding
a file open for that long is holding it locked: on Windows an open
handle stops any other program renaming, replacing or deleting the file.
An earlier server kept the last four films it had opened, so a film
stayed locked against the editor saving it, and the fixture build
rewriting it, until the client quit. Opening a database costs
milliseconds. `scf-mcp/test/smoke.test.ts` opens a film through the
server, queries it, then renames and deletes it while the server runs.

### 5.1.1 A film is named by its session

`open` returns a `file_id`, and every tool except `open` and
`recent_files` takes one. A call is routed by it and by nothing else
(`withProject`, which every film tool goes through, looks the session up
before the tool does anything).

The server used to answer from "the film opened most recently". That
holds only while one conversation has the server to itself, and it does
not: a client may run every conversation it has on one server process
(Claude Desktop does), and stdio gives the server nothing to tell them
apart by. Two conversations with a film each were then one `open` away
from reading, and writing, each other's.

- **An id is never given twice.** It is a count kept in `app.db`, put
  through a permutation keyed by a salt and written in base 36, four
  characters at first (`sessionId.ts`). The count outlives the server, so
  an id left in an old conversation is unknown to a new server and
  cannot have become another film's. The salt starts from the machine's
  identifier; a salt that has given every id it has is replaced, and the
  count starts again.
- **One session per film per server.** Opening a film that is already
  open returns the session it has, and the answer does not say which
  case it was.
- **One error.** A `file_id` that is missing, malformed, unknown, or
  whose file is gone is `invalid_session` (`session.ts`): a tool error
  whose text is JSON with `code`, `message`, `rejected_file_id`,
  `open_sessions` (`file_id` and `path` of each) and `recent_files`.
  The way on is always `open`.
- **`--scf` opens a session at startup**, and the server's instructions
  give its id, so a single-film setup still needs no `open` call.

| Tool | | |
|---|---|---|
| `open`, `recent_files`, `set_root` | | which film, and where its assets are |
| every tool below, and `set_root` | `file_id` | which film (§5.1.1) |
| `find` | `(entityType, label)` | → `resolveNaturalKey` |
| `list` | `(entityType, filter?)` | → `listEntities` |
| `where_used` | `(entityType, uuid)` | → `whereUsed` |
| `shot_context` | `(shotUuid)` | → `shotContext`, the frame (§4.7) |
| `shot_media` | `(shotUuid, subjectUuid?)` | → `shotMedia`, what to attach |
| `shot_readiness` | `(shotUuid)` | → `shotReadiness`, what is thin |
| one tool per query | each query's own params, and `format?` | Q00–Q13, Q15; `format: "markdown"` is the prompt-ready block (`scf-core` `queryMarkdown`) |
| `readiness` | `(queryId, params, format?)` | Q14 directly, for pre-flight |
| `shot_list` | `(sceneUuid?, includeCut?)` | → `readShotlistRows` + `buildSheets`, what the editor prints |
| `gallery` | `(sort?, filter?, includeHistory?, limit?)` | → `loadGallery`, assets ranked by what they carry |
| `character_presence` | `(characterUuid)` | → `readScriptPresence` + `presenceByScene`, links vs cues |
| `recent_changes` | `(limit?)` | the host's journal: who changed what |
| `editor_help` | `(topic?, section?)` | how to use the editor, from its manual (`docs/editor-*.md`, bundled by `editorManual.ts`); needs no film |
| `create_row`, `update_row`, `delete_row`, `add_shot`, `set_shot_cut`, `move_shot`, `set_title_page_key` | each tool's own, and `confirm?` | writes, plan first (`writeTools.ts`; omitted by `--read-only`) |

The last three read rows are the editor's own: the shot list, gallery and
presence reads live in `scf-core` and the editor calls the same
functions, so a client and the person at the editor see the same thing in
the same order.

**`query(id, params)` is gone.** With `params` a loose string map, an
agent had no way to know which keys an id needed short of guessing.
The sixteen dedicated tools replace it, each with its own schema, so a
wrong parameter is rejected before the call is sent.

**`list` and `where_used` are the two directions of navigation.** `list`
enumerates forwards, in story order where the rows have one; `where_used`
runs backwards, which nothing else here does. Every canonical query
answers "given a subject and a position, what is in force", so a row
that appears in a listing and in no answer — a bundle no binding
reaches — was invisible: finding one meant diffing a full asset list
against a resolution per subject per intent, by hand.

Transport is **stdio**. `scf-core/node` supplies `openNodeDatabase`,
which is what conformance CI and the scripts already use.

### 5.2 Root mapping is configuration, and its absence is an answer

`q13Result` already takes a `FileLocator` and a `rootMapped` flag, so
the seam exists — the server's job is to supply it from config or the
shared project store:

```json
{ "scf": "/path/to/film.scf",
  "roots": { "project": "/vol/film", "plates": "/vol/plates" } }
```

**The stored pairing (`app.db`).** When no explicit root mapping is
configured, the server queries the desktop app's shared store (`app.db`
in the application data directory):
- If the film path has an `asset_root` remembered there (from an earlier
  session in the editor or MCP), it attaches automatically.
- Calling the `set_root` tool saves the mapping back to `app.db`, so
  folder associations made by an agent persist into the editor.
- The `recent_files` tool queries `recentProjects()` from `app.db`,
  giving agents the same persistent history the editor displays on its
  start screen.

`FileLocator` (via the host's `assets` module) returns `undefined` for a
root it does not know, which is deliberately different from `null` for a
file that is not there. Keep that distinction all the way out to the
agent: §8.3's `unaddressed` for an unmapped root, `missing` for a mapped
root with nothing at the path.

**Do not omit unresolvable references.** "I know what is in force but
cannot locate it" is different information from "there is nothing," and
the second is a lie. This is the same reason a Reader that does not
resolve assets MUST report `unaddressed` rather than `missing`.

The root map is not in the `.scf` on purpose (§0.3, §8.2). The file is
portable; where the bytes live is not.

---

## 6. The template

`templates/seedance-2.5.md` — prompt structure, camera vocabulary, how
reference images are passed, length limits. The agent reads it beside
the payload and writes to it.

**Not in `scf-core`. Not in the server.** If `shot_context` took a
`target: "seedance-2.5"` parameter, the server would ship a new version
every time a model updated, and the query layer would start accumulating
opinions about video generators. Keep the server returning film facts.
`veo-4.md` then sits next to it and nothing else moves.

---

## 7. Order to build

1. **`resolveNaturalKey`.** Nothing works without label → uuid, and it
   is where the conformance traps are.
2. **`shotContext` + the parity test.** Write the test first; it is the
   design.
3. **The server.** By then it is plumbing.
4. **The template**, once the payload is real enough to write against.

### 7.1 Do (1) and (2) and stop for a moment

Pointing an agent at the query layer and asking it for a shot prompt is
**a reader run of its own, and the most adversarial kind.** It will
find shape gaps of exactly the kind runs 4 and 5 found by hand — a
member whose form cannot be inferred, a parameter that cannot be
supplied, an empty answer that reads as an error — in minutes, and for
nothing.

Do that before the template exists. The findings are worth more than the
feature.

---

## 8. What stands in the way

- Nothing now: the server ships inside the desktop app, so it waits on
  no npm publish. (It once did: `scf-core` is held until 1.0, and
  `scf-mcp` was to follow it to npm.)

---

## 9. Open questions

- **Does `shot_context` need a scene-level sibling?** Q07 takes a null
  shot and answers for the scene. A `scene_context` is the same
  composite minus the shot leaf — probably yes, probably trivial, but
  worth confirming against a real request rather than assumed.
- **What does the agent do with `readiness`?** Refuse to write a prompt
  when a `required` step is missing, or write it and say what is thin?
  Second, most likely — Q14's own framing is that absence is not an
  error — but it is a product decision, not a technical one.
- **How much of Q04's screenplay member belongs in a shot prompt?**
  Answered by spec §4.7: a shot names the lines it covers, and the
  payload carries them as `lines`. The scene's whole text is Q04's
  (`scene_package`), one call away for a caller that wants it.
