<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# The editor MVP — what remains

Consolidated from the second-implementation design doc
(`20260715_SCF_Second_Implementation.md`, never in the repository) and
checked against `SCF_studio@main`, 2026-08-26 — spec 0.51, schema 2.13.
**Updated 2026-10-08** (spec 0.63, schema 2.22): §7b's open decision is
closed, and §9 is answered — the editor is not part of the format's 1.0
(`release-checklist.md` §A10).
**Re-checked 2026-10-16** (spec 1.0-rc.1, schema 2.24): §2's remaining
duplicate is gone, §3 is mostly closed, §6's proposals are resolved, and
§7e's costume gap is filled. Sections 7a–7g are the record of work as it
landed; counts in them describe the fixture at the time.

It lives here rather than as an upload for the same reason rev 11 of the
release checklist does: *rev 10 lived outside the repository and had
drifted into describing a project that did not exist.* Every `Part N`
reference in the source pointed at a document no contributor could open,
which is exactly how this document came to be written.

✅ done · ◑ partial · ○ not started · ⚠️ decision needed

---

## 1. The vocabulary, so it stops getting lost

The design doc split the second implementation into four Parts plus a
foundation. **They are work packages, not versions**, and they were
deliberately built out of numeric order.

| | Package | Built in | Status |
|---|---|---|---|
| — | `scf-core` + conformance parity | 1st | ✅ |
| **Part 1** | Entity browser / editor — form generator, both navigation modes, position-aware editing | 2nd | ✅ Schema + Subjects tabs |
| **Part 2** | Fountain/FDX parser + golden corpus — pure library, no UI | 4th | ✅ three stages, repair pass, re-import differ |
| **Part 3** | **Screenplay editor** — row-native CodeMirror 6, line identity in editor state, beats/prop-tags/versions | 5th (last, on purpose) | ✅ landed |
| **Part 4** | Query page — all sixteen canonical queries, three consumer modes each | 3rd | ✅ |

**Part 3 is the screenplay editor.** It was scheduled last because it
was the highest-risk UI and because it depended on all three others:
the row model as its document state, Part 2's proposals to stage,
Part 1's entities to link against.

It landed. `scf-app/src/editor/` is 4,907 lines across eleven modules
(`lineState`, `screenplayDoc`, `features`, `importPipeline`,
`structureCommit`, `sceneMove`, `sceneOps`, `shootOps`, `pasteLines`,
`extensions`, `integrity`), `ScriptView.tsx` is 1,448 lines, and the
Script tab is the first tab in the app.

*Since then the editor-independent modules have moved to `scf-core`
(`src/ops/`, `src/screenplay/`); `scf-app/src/editor/` keeps
`lineState`, `extensions`, `pasteLines`, the `EditorState` wrapper in
`screenplayDoc`, and two read helpers (`assetStanding`,
`characterPresence`).*

**Nothing is waiting on "Part 3" any more.** Where the phrase still
appears in a comment it is a historical reference and should be read as
one; where it appears in *output*, it is a bug — see §2.

---

## 2. ✅ Q04 carries the scene's text — spec 0.49

Four sites told the user that screenplay text was coming:

> *Screenplay text joins this package when Part 3 lands.*

Part 3 had landed. The sentence was false in the shipped product and in
every copy-as-context block a user pasted into an LLM session.

**Resolved by adding the member rather than deleting the note.** The
alternative — stating in §12.17 that Q04 deliberately excludes the text
— was cheaper and defensible, since the Script tab is one click away.
It was rejected because it would have left the app free to render
something the normative result does not carry, which is the
two-descriptions-drift failure mode this project has paid for twice.

**§12.17.1** now defines the member. What it had to settle, and did:

- **Which lines.** The scene's heading and every line after it up to but
  not including the next heading by `line_order` — §3.4 restated as a
  result. The terminating bound is the next heading whichever scene owns
  it, **including a cut one**: those lines are absent because the bound
  stops before them, not because §6.6.1 filtered them, and a screenplay
  line carries no `lifecycle_status` to filter on.
- **The shape.** `screenplay_lines` is a `uuidExtraTable` carrying uuid
  identity on §6.1's terms, so its rows are ordinary projected rows
  under §12.1.2 — the only difference being that the column names come
  from `screenplay-tables.json` (§1.3.1) rather than the registry. That
  avoided inventing a sixth derived-record shape, which is what run 4's
  G-10 finding was about.
- **`scene_id` is omitted, not resolved.** §3.4 says implementations
  MUST NOT rely on it. A normative answer carrying it would invite
  exactly that.
- **The empty case is an answer.** Fixture scene 17 has no heading line
  — a scene authored in the database the screenplay has not reached —
  so `[]` is exercised and cannot be guessed as "never empty".

The derivation moved from `scf-app/src/editor/shootOps.ts` into
`scf-core/src/screenplay/sceneScript.ts`, and the app re-exports it. It
described a MUST NOT and existed in one place; now it describes a MUST
NOT and a normative member, and still exists in one place. (`shootOps.ts`
itself has since moved to `scf-core/src/ops/`.)

`Q04.result.json` is re-blessed and carries scene 12's twenty lines.

**One thing this did not fix, since closed.** The app's
`runnersComposed.ts` built its own Q04 payload rather than calling
`q04Result` from `scf-core` — two descriptions of one answer, one of
them normative. Every query page now renders scf-core's `qNNResult()`
and `runnersComposed.ts` is deleted (`release-checklist.md` §B1).

## 3. ◑ Part 3 features the fixture never showed

Five reader runs have each found at least one defect that no published
artifact could catch, because the fixture had no rows of the relevant
kind. The pattern is now well understood: **a feature the fixture does
not exercise is a feature no independent implementation ever sees, and
a conforming and a broken reader are byte-identical on it.**

Proposal 0001 was the last instance — `clip`'s screenplay line columns
were undetectably wrong while the `clip` table was empty. Adding two
rows closed it.

The three headline Part 3 features were in that state. Two are closed
(`release-checklist.md` §B2, spec 0.67); versions stay unauthored on
purpose, because §0.4 puts the version tables outside 1.0 and no
normative result reads them:

| Feature | Code | Fixture | Cost to close |
|---|---|---|---|
| **Beat anchoring (G5)** — `performance_beat.line_ref` → a line's uuid | ✅ `scf-core/src/ops/features.ts`, wired in `ScriptView` | ✅ **7 of 14** beats anchored; the other seven quote no script line | done |
| **Prop tags** — line uuid + offsets, revalidated on edit | ✅ `scf-core/src/ops/features.ts`, `validateTags` | ✅ one `screenplay_prop_tags` row | done |
| **Versions** — publish a snapshot, diff against current | ✅ `publishVersion`, `diffVersionAgainstCurrent` | ○ `screenplay_versions` and both version tables **empty** | one published version; outside 1.0 (§0.4) |

All three are authored *from the editor*, which is why the fixture
builder never produced them: `hollow_creek.data.json` predates them.
The R85 dump/rebuild loop exists for exactly this — author in the app,
dump, review the JSON diff, rebuild, commit both.

Optional, and cheap once you are in there: thread `scene_id`
**deliberately wrong** on one body line. §3.4 says implementations MUST
NOT rely on it; nothing currently proves that a reader doesn't. It is
the same two-sided trick as §6.6.1's mirror — the rule that a *correct*
reader's answer must not change.

---

## 4. Deferred UI — in or out of MVP?

Both were named as deferred when Part 4 closed and neither has been
built. Neither is referenced in the spec.

- ○ **Editing from the spine.** Click a cell in Q10's thematic
  accounting to key a state at that position.
- ○ **Q15's "why?" affordance.** Provenance reachable from a resolved
  value inside another query's answer, rather than only as its own
  query. `ProvenanceView` exists; the entry point from elsewhere does
  not — `composedViews.tsx` and `QueryRunner.tsx` carry three
  `onClick` handlers between them, so the query surface is read-only
  by construction today.

**Decided: both out of MVP.** They make the editor nicer to use;
neither demonstrates a capability of the *format* that is otherwise
undemonstrated, which is the bar everything else on this list clears.
Worth saying so explicitly in the doc rather than leaving them on an
implicit list, because an unstated deferral is indistinguishable from
an oversight — which is the whole reason this document exists.

---

## 5. Documentation debt inside the editor

- ✅ **`scf-app/README.md` said "Six tabs".** There are seven — Assets
  was added and the table was not. Fixed.
- ✅ **`docs/release-checklist.md` was stamped rev 12, spec 0.42, schema
  2.12** against a main at 0.48 / 2.13. **Rev 13** re-checked against
  the tree: section 7 turned out to be complete, and one item had
  regressed — **`schema-2.13` shipped in 0.47 and is not tagged.** Rev
  13 has since been superseded: **rev 14** (2026-10-06, decisions
  settled 2026-10-08) is the current list, and the release questions
  this file used to carry live there.
- ✅ **No editor design document in the repository.** The `Part N`
  references in the source pointed at an upload. This file closes that,
  and `scf-app/README.md` now points at it.

---

## 6. Format proposals that touch the editor

Neither blocks the editor MVP; both change what the editor does if
accepted.

- **0002 — ownership by declaration** — implemented in its narrow form
  in schema 2.24: a clip points at its scene through
  `clip.slated_scene_id` and outlives it. Moving ownership to
  declarations is deferred past 1.0.
- **0003 — absolute paths resolve** — deferred past 1.0, waiting on
  named-root support in the editor. Affects `assetLocator.ts` and the
  Assets tab; roots beyond `@project` are reserved in the grammar and
  unimplemented.

---

## 7. Explicitly not the editor's MVP

Listed so they stop being weighed against it: publishing
`@minimalhumans/scf-core` at 1.0 (held deliberately — npm blocks
unpublish after 72 hours), the MCP server, the docs site beyond what
ships, and section 7 prose, which is now largely written
(`what-is-scf.md`, `authoring-guide.md`, `walkthrough.md`, `faq.md`,
`glossary.md` are all in `docs/`).

---

## 7a. ✅ Attaching the folder to an open file

> **Superseded in the desktop app (file-management-plan.md).**
> The browser folder handles, `classifyRootPairing()`, and IndexedDB
> handle storage described below were replaced by native OS dialogs,
> path-based asset resolution through the host's `assets` module, and
> persistent app-level pairing in `app.db`.

The folder-first open (`openProject()`) is one gesture when directory
listing works and a diagnostic panel when it does not. The awkwardness
was never the UI; it was that the app had to *work out* which `.scf` in
the folder was the project, and could not when the scan came back blind.

The `.scf` can now be opened first and its folder attached afterwards,
from the `no folder` indicator in the topbar. The reason this is better
rather than merely different is that the pairing can be **checked**:
`FileSystemDirectoryHandle.resolve()` reports whether a named folder
holds a given file handle, and where. Discovery guesses; this does not.
The full reasoning, including the three-row `resolve()` table, is in
`docs/conventions.md` §9 under "The other order: the file first".

What landed:

- `classifyRootPairing()` in `scf-core/src/project.ts` — the rule, kept
  browser-free like `chooseProjectFile()` so it is testable without a
  directory handle. `at-root` accepts; `below-root` and `outside-root`
  are refused with a message naming both the file and the folder.
- `attachRoot()` on the adapter. Uses `startIn` so the picker opens
  inside the file's own folder, and retries once without it rather than
  costing the user the gesture if the option is rejected.
- The attach path asks for a **`read`** grant, not `readwrite` — the
  write handle came from the file picker. Grant mode is now carried with
  the handle, because querying a `read` grant for `readwrite` reports
  `prompt` and would show a working folder as needing reconnection.
- `applyRoot()` and `probeTraversal()` extracted from
  `finishFolderOpen()`, so both acquisition orders run the identical
  tail. Conventions §9 already claimed the resulting sessions are
  identical; now the code says it once instead of twice.
- `environmentRevision`, bumped when the *environment* changes rather
  than the data. Asset resolution and Q13 depend on the root and must
  re-run; `revision` could not carry it, because
  `revision !== lastSavedRevision` is what marks a project unsaved and
  attaching a folder writes nothing.

**Two defects found while doing it**, both live before this change and
both invisible in use:

1. `openFromPicker()` never cleared `projectRoot`. Opening a plain
   `.scf` while a folder session was live left the new project holding
   the old project's folder, addressing every asset against another
   film's disk. A stale root resolves perfectly well, so nothing
   reported it.
2. `resumeLast()` recalled the file handle and the root independently,
   reproducing (1) across a reload. Roots are now stored as
   `{file, root, mode}` pairs and looked up by `isSameEntry()`, which
   also means reopening a known project costs one re-grant click instead
   of another trip through the folder picker.

**Consequence for the demo, unplanned but useful.** A session with no
`.scf` on disk cannot have its pairing checked — there is no file for
the folder to contain. Rather than refuse, the root attaches and the
session is marked `folder unverified` in the topbar. So the Hollow Creek
demo can be pointed at a downloaded asset folder by hand, and the nine
identifiers the fixture already carries resolve without a single change
to the fixture, the manifest or any published result.

**Not done, deliberately.** The start screen still lists
"Open project folder…" above "Open an .scf file…", and `openProject()`,
`chooseProjectFile()` and the "Why it could not find it itself" panel are
all still there. If file-first becomes the front door, that ordering is
wrong and roughly 150 lines of scan-fallback machinery become dead —
but retiring the folder-first entry point is a product decision, not a
cleanup.

## 7b. ✅ Thumbnails, and the first reader of `region_box`

Asset previews existed in exactly one place: the asset row's own form.
Everywhere a file is *chosen* — a bundle's members, a binding, the asset
browser, a character — it was a filename.

**A thumbnail is not a small preview**, and the difference is the whole
reason `AssetThumb` is a separate component from `AssetPreview`. A
previewer is one of a kind on screen and can afford to read a file the
moment it mounts. `AssetPreview`'s own header names the hazard —
*"an asset browser walked through a few hundred plates would hold all of
them"* — and thumbnails make that the normal case. Three consequences:

- Nothing loads until the row is **on screen** (`IntersectionObserver`,
  200px margin). A bundle of two hundred plates nobody scrolls costs two
  hundred resolutions and zero reads.
- Object URLs come from a **refcounted cache** keyed by root handle plus
  path, with a grace period before revoking. The same plate can be in a
  bundle list, on a binding, behind a subject's anchor and in the asset
  browser at once; four URLs for one file is four things to revoke and
  three chances to leak. The cache is flushed when the root changes or
  the project closes — a URL into the *previous* folder returns bytes
  from a project the user has left, which is worse than a blank
  thumbnail because it looks like it worked.
- **Images only**, and the fallback chip is the *same box* as an image.
  A slot that collapses for a `.zip` makes every list reflow as it
  loads, and three of the nine assets in Hollow Creek are not natively
  viewable. `previewCapability`'s third tier is a real tier, not a
  failure.

Placed on: bundle members and the add-assets picker, the asset browser
list, `*_asset_binding` rows (as a strip of what the bundle puts on
screen — the binding names a bundle, and the bundle is a name), and
character / prop / location, in both the entity form header and the
subject view.

### `region_box`

The subject thumbnail is the **anchor**, not the cascade: a bundle is
everything gathered for an intent, while an anchor is somebody pointing
at one image and saying "that is her". Anchors are position-independent,
so it needs no scene picker.

Eleanor's anchor points at a reference *sheet*. Showing the sheet as her
thumbnail is nearly useless; showing `region_box` is the actual answer —
so the crop is the default, with a toggle back to the whole frame,
because a crop with no way back hides the evidence that the box is
wrong. `parseRegionBox` is the field's first reader anywhere in the
repository, and the coordinate space it defines is written down in
`docs/conventions.md` §9 rather than left living in TypeScript.

**The fixture now exercises it.** `entity_anchor` 1 gained
`region_box` and `region_label` — a two-line diff through the R85
dump/rebuild loop, and it moved no published result. Third entry in the
same class as §4.1's unscripted scene and §12.17's mismatches: a rule
the format states that no artifact demonstrated. The locket anchor is
deliberately left alone — it points at a `.glb`, which is preview tier 2,
so it exercises "the anchor is correct and there is still nothing to
show".

### Why the second visit was slow

Leaving the assets tab and coming back rebuilt every thumbnail, badly
enough to be the highest-priority complaint about the feature. The
object URL cache was only hiding a fifth of the cost. **Three things ran
on every mount and only the third was cached at all:**

1. **Resolution.** `resolveIdentifier` walks `getDirectoryHandle` /
   `getFileHandle` from the root and calls `getFile()`, *once per
   asset*. Forty rows is forty round trips through the browser's file
   system layer every time the tab is opened, and on Windows with an
   antivirus filter in the path none of them is cheap. This was the bulk
   of the lag and it was cached nowhere.
2. **Decode.** A full-size plate decoded to a bitmap so it could be
   drawn into a 28-pixel box, then thrown away on unmount.
3. The object URL, with a five-second grace period — right for a React
   remount, far too short for "switch tabs and come back".

`thumbnailCache` resolves once per session and decodes **once ever**. A
generated thumbnail is a few KB of WebP at 176px (twice the largest
display size, so one raster serves all three and stays sharp on HiDPI),
which is small enough to hold hundreds of in memory and small enough to
persist. It goes to IndexedDB keyed on **root name + path + mtime +
size**, so a reload no longer pays for the decode either and a file
edited outside the app regenerates rather than showing a stale picture.
After the first visit the list touches no files at all.

Two consequences worth recording:

- **The crop moved out of CSS and into generation.** The first version
  scaled and offset the full image inside a clipping box, which meant
  holding a whole plate decoded to show 176 pixels of it. It also could
  not distinguish "no region" from "a region that did not fit" — both
  rendered as the whole frame. Generation returns `regionApplied`, so
  `AnchorThumb` now says *region does not fit* for a box measured
  against a different file, which is an authoring error that was
  previously invisible.
- **`AssetPreview` moved onto the shared URL cache.** Without that the
  cache had no consumer left and would have been dead code with thirteen
  tests attached to it. It is also the right home: stepping back and
  forth between two assets used to re-read both every time, and the
  component's own header had warned about holding hundreds of files at
  once — a bound it could not enforce while each instance owned its URL.

**A keying bug the tests found.** The first version keyed on path,
mtime and size alone. `path` is *relative to the project root*, so
`assets/hero.png` in two different projects is the same string. That
triple is the standard file-identity heuristic and a collision would
almost always be two copies of one file — but "almost always" is the
wrong standard when being wrong means showing one film's frame under
another film's asset. The root's name is in the key now; its *handle*
is not, because persisted entries have to survive a reload where every
handle is new.

Mutation-tested like the URL cache: ignoring the environment epoch,
dropping mtime and size from the key, and removing the in-flight dedup
each fail a test. Three of the thirteen also passed for the wrong reason
until a cache reset was added between them — module-level state outlives
a test file.

### A leak the tests did not catch until they were attacked

`objectUrlCache` has 13 headless tests (no view imported, fake timers).
All thirteen passed first run, which is not evidence of anything, so
three deliberate defects were introduced to see whether they bite:
trusting an in-flight read after its holder released (caught), revoking
with no grace period (caught two tests), and **deleting the refcount
guard in `release` (caught nothing)**.

Tracing why exposed a real leak in the original code. The scheduled
revoke returned early when something still held the URL, without
clearing its own timer handle. Nothing could reach that state, because
`acquire` always clears a pending timer — but the two guards were
covering for each other, and with one removed the sequence is: release
one of two holders, the timer fires and declines to revoke while leaving
`timer` set, then the last release sees a non-null timer, takes the
early exit, and schedules nothing. The URL lives for the rest of the
session with nobody holding it.

Fixed by having the callback clear its own handle before deciding, and
pinned by a new test — verified against the *original* code plus the
mutation, where it fails. The `release` guard is now honestly a fast
path rather than a second line of defence, which is what it should have
been all along.

**One decision, deferred on purpose — closed in schema 2.16.** The
definition belongs in the registry's help text, not in
`conventions.md` — §2.1 makes the registry the authority on fields, and
help text is generated into `entity-reference.md` and checksummed.
Writing it there changes `registry.json`, which was the one artifact
pinned to the `schema-2.13` tag, so `check_pin` failed: the live tag
would have served different bytes than `SHA256SUMS` claimed. It waited
for a schema bump, and `entity_anchor.region_box` has declared its
`{x, y, w, h}` shape in the registry since 2.16. `check_pin` caught the
conflict immediately, which was the best argument for its existence.

## 7c. ✅ Two review surfaces that cried wolf

Both found by opening the demo and reading what it said. Both were
telling an author that correct data was wrong, on the fixture the
project publishes as its example.

### The commit review offered to break every correct link

`planCommitLinks` compared a cue to its linked entity with string
equality. A cue is a **short form** by convention, so `ELEANOR` above a
line belonging to `Eleanor Cade` read as a mismatch — all eleven cue
lines in the fixture, every one of them correctly linked.

Worse than the false positive was the default. Each conflict offered
`break link; create/match "ELEANOR"` or `rename entity to "Eleanor"`,
with the first preselected and **no third option meaning "both are
right"**. Confirming the dialog as presented would have created a
duplicate `ELEANOR`, unlinked eleven lines from `Eleanor Cade` and
`Marcus Cade`, and — if the file were then dumped — written all of it
into the fixture.

Fixed in two independent places, deliberately:

- `scf-core/src/screenplay/cueMatch.ts` — `cueMatchesEntity`, agreement by a contiguous
  run of **whole words** in the entity's name. `ELEANOR`, `CADE` and
  `ELEANOR CADE` agree with `Eleanor Cade`; `JORGE` does not agree with
  `George Wells`, and `OLD ELEANOR` does not agree with `Eleanor Cade`
  because it carries a word the name does not — a real question, not
  noise. Whole words, never substrings: `ADA` is inside `Adam Shaw`.
- A `keep` resolution, defaulted. The predicate change removes the
  false positives that exist today; the default removes the *class* of
  harm, because the next detector to be too eager will not be as
  visible. A flagged cue is a question, and a dialog whose confirm
  button acts destructively on an unanswered question is wrong however
  good the detection gets.

`cueMatchesEntity` is deliberately **not** used to choose an entity for
an *unlinked* cue. There the evidence runs the other way — `CADE` is
consistent with three characters in the fixture, and picking one would
be a guess. Here a link already exists and is authored truth; the only
question is whether the cue contradicts it. It is also not in the
format: the spec says nothing about cue shorthand and nothing in a
`.scf` depends on the answer, so it lives in the app.

### The integrity panel read the column §3.4 forbids

`scanIntegrity`'s unjustified-link query matched cue lines with
`l.scene_id = sc.scene_id`. Only headings carry `scene_id` in a file
this editor did not write — the fixture leaves it null on all eleven cue
lines — so the `NOT EXISTS` was **always satisfied** and the check
reported every cast link in a scene that had a heading. Spec §3.4 says a
scene's text runs from its heading to the next one and a reader MUST NOT
rely on `screenplay_lines.scene_id`; this was relying on it. The visible
symptom was that the same file gave different answers depending on who
wrote it last: eighteen findings on a freshly built fixture, twelve
after one commit in this app, because `linkAndCreateAtCommit`
back-fills the column.

Same shape as Q04 reading `scene_sequence` in R88 — a query treating a
permitted-to-be-stale shadow as truth. Fixed by deriving the scene from
the nearest heading above the line, the walk `syncPropSceneLinks`
already uses, defined once and used by both subqueries.

Second change, a judgement rather than a defect: a link is only
questioned where the scene **shows something**. Under a heading with
nothing below it, "not written yet" and "written without them" are the
same file, and the fixture is mostly that shape on purpose. Body types
are the ones a scene shows — `action`, `character`, `dialogue`,
`parenthetical`, `transition`, `centered`, `lyric` — excluding
`section`, `synopsis` and `note`, which are written *about* the script.
The existing deleted-dialogue test keeps its action line so the case it
was written for still reports.

**On the fixture: 11 conflicts → 0, and 12 unjustified links → 6.** The
six are all silent presences, and they are the state Chris asked for
rather than a backlog: `Ada Cade` in sc 3 and sc 19 — dead before the
film starts, so she can never carry a cue line — plus `Marcus Cade`
alone on the road in sc 1 and on the ridge in sc 21, and `Eleanor` and
`Marcus` on the porch in sc 24, where the reunion is wordless on
purpose. A panel that shows six defensible questions demonstrates §9.2
better than one showing none.

**The check is advisory to agents too (proposal 0041).** The host's
write gate once treated a new unjustified link as a reason to refuse an
agent's write, which turned these questions into refusals: 94 silent
presences on one film could not be linked at all. Since 0041 the gate
returns it as a note for the plan's risks and applies the write; spec
§2.4.1 says a presence link is authored, not derived from the script.

An action-names-the-character rule was considered and NOT taken. It
would clear four of the six, but it is a heuristic — action names absent
characters too ("Ada's shawl" sits in a scene Ada is not in) — and the
existing report is doing its job. Recorded here so the next person to
notice sc 1 knows it was a decision.

## 7d. ✅ Two lists that read badly

### Staging beats sorted alphabetically

A staging beat is the only row in the schema that sits in a scene
without holding a reference to one: it hangs off a `scene_blocking` OR
an `action_sequence` — one or the other, never both — and the scene is
on the parent. `sceneRefFor` looks for a scene reference among the
entity's own fields, found none, and the list fell through to A-Z.

Alphabetical is unreadable here because the names repeat BY DESIGN.
Hollow Creek has "Positions established.", "The move that costs
something." and "New positions held to the end." three times each, once
per blocking, so A-Z printed three scenes shuffled together with nothing
to tell one row from another — and no scene shown beside them either,
since that label is also driven by holding a `scene_id`.

Fixed in `scf-core/src/listOrder.ts` (it was `state/listOrder.ts` in the editor) rather than in the view. `STORY_ORDERED`
gains an optional `from`: a subquery deriving the scene through
whichever parent the row has, so `storyOrder` still sees an ordinary
`scene_id` column and ONE ordering rule covers every list. `listTable`
is the table expression both list branches read from — the A-Z branch
needs the derived column too, to show the scene. Within a scene the
fallbacks put the parent before `beat_order`, because two blockings in
one scene both start at beat 1 and would otherwise interleave.

`listSort` already defaults to `story`, so the beats are in scene order
the moment they are story-orderable; nothing in the view changed.

### The start screen offered five things and meant three

Now three buttons: New Project, Open an SCF File, Open Hollow Creek
Demo. Resume and the folder-first open are gone, along with the
folder-choice panel that only `openProjectFolder` could raise.

*(Superseded: the OPFS working copy no longer exists. The window is a
client of the host, a refresh reopens the file by path, and Close lets go
of it. What follows describes the earlier design.)*

Worth knowing what that costs. A refresh still walks straight back into
the working database — `App`'s resume effect does that, and it is
untouched. What no longer has a route back is an explicit **Close
project**: `closeProject` disarms auto-resume and forgets the file
handle but does NOT wipe `working.scf`, so the OPFS database survives
with nothing in the UI able to reach it. Close now means close, which
is defensible, but the state it leaves behind is dead rather than gone —
holding storage and holding the multi-tab lock's exclusive handle.
Wiping on close would make the behaviour match what the screen now
says.

`openProjectFolder`, `openFromFolderChoice`, `pickScfInRoot` and
`dismissFolderChoice` are unreferenced from the UI as of this change.
They are left in the store: folder-first opening is a reasonable thing
to want back, and removing the flow is a bigger change than removing
the button. Folders still attach from the topbar, which is the path the
remaining button's tooltip describes.

## 7e. ✅ Media that looked authored and reached nobody

Found by the first `scf-mcp` session, which wrote a shot prompt for 3B
and missed the DOP's framing plate for that scene. Its findings split
four ways: what an author does, what the editor does, what the format
does, what the MCP does. This section is the first two. Nothing here
changes the format or the MCP.

### What the fixture said

Every problem was authoring, and none of it was visible in the editor:

- Both kitchen bindings pointed at the scene 3 bundle. The baseline
  bundle — the kitchen anchor, and the only record that the table is
  struck for the shoot — was bound to nothing, and the scene 3 binding
  had no range, so the scene 3 plate also answered for scene 19.
- Five bundles reached no subject. Ada's baseline bound her to the
  locket's bundle. The chime-in-the-mud image, a scene 24 state, was
  the chime's baseline. A `.wav` sat in a `visual_identity` bundle.
- Roles in twelve spellings (`reference` / `Reference`), sources with
  a typo and a case split, and 23 values in `json` columns that were
  comma lists, not JSON.
- §8.6's polymorphic case pointed at two assets deleted during
  re-authoring. Nothing noticed.

All fixed in `hollow_creek.data.json`. Published results moved by
value only (roles, JSON lists); no shape changed.

### What the editor now shows

- **On a bundle:** "Resolves for" — every binding and shot override
  that reaches it, with its scope read in story order, and an amber
  warning when nothing does. "Bind to…" binds any character, prop or
  location, optionally over a scene range; a ranged binding is never
  offered as a baseline. Only the range is offered here. When this was
  built it was the only binding filter the media cascade read; every
  filter has been read since schema 2.16 (proposal 0027, spec §12.8.1).
- **On a bundle's members:** a marker when the media kind contradicts
  the intent (audio in a picture bundle, a picture in a sound bundle —
  never video). Roles suggest the file's existing roles and adopt an
  existing spelling that differs only in case or spacing.
- **On an asset:** "bound to nothing" beside each such bundle, and a
  warning when every bundle holding the asset is unbound — referenced,
  so not a §8.6 orphan, and still unreachable.
- **Assets tab → media checks:** unbound bundles, bindings in force at
  every scene without being baselines, duplicate bindings, kind/intent
  contradictions, lookalike spellings in `role_in_bundle` and `source`
  (with a one-click "use X"), and `json` fields holding non-JSON (with
  "make it a list"). The same button sits in `JsonField`.

The checks live in `scf-core/src/ops/mediaChecks.ts`, headless and tested. The
reach derivation is `scf-core/src/bundling.ts` (`bundleReach`,
`unboundBundleIds`, `bindBundle`), reading binding tables from the
registry's `subject` field rather than a list. `bundling.ts` is a deep
import, not the public surface, so `api-surface.json` did not move.

### Deliberately left

- **Ada's Shawl stayed unbound** while costume had no asset binding
  entity. `costume_asset_binding` arrived in schema 2.16 (proposal
  0029), and the fixture now binds the shawl through it; an
  `asset_relationship` still records what the image shows.
- **Both locket rows keep the theme.** Removing the prop's connection
  would hide Q10's prop-carrier defect from the published artifact.
- **Nothing is enforced.** An unbound bundle can be assembled before
  anyone decides what it is for; these are findings, not errors.

## 7f. ✅ Narrative element workspaces

The Characters, Locations and Props workspaces — an activity bar, a
workspace per subject, reference boards that write bundles, bindings
and anchors by intent, exceptions, the "as of scene" control, and the
region and clip editors on identity tiles — have their own design
record: [`narrative-workspaces.md`](narrative-workspaces.md). It is a
separate document because it is one surface with its own decisions
(proposals 0033–0035, the no-copy file rule) and its own open list;
this document links to it so neither gets lost.

## 7g. ✅ Presentation — the film, made to leave the app

A fifth group in the activity bar, below Tools: read-only views of the
project made to be printed, exported or put on a screen. Four sections,
built one at a time; the unbuilt ones are shown disabled so the shape is
visible.

- **Shot list** ✅ (`ShotlistView.tsx`, logic in `scf-core/src/shotlist.ts`).
  The Shoot tab's shots as paper: storyboard frame (first storyboard
  panel, else start frame), shot code, size, angle, lens, move, seconds,
  action, a Done box; Title, Cast, Props and Notes as optional columns.
  Grouped under beat banners, scene facts above each table (location,
  scene-level `lighting_design`, cast, props), a size legend after.
  Landscape or portrait, Letter or A4, one scene or all, page per
  scene, cut shots in or out — remembered per browser, not in the
  `.scf`. Prints through the browser, which is also the PDF export, so
  the sheet on screen is the page.
- **Screenplay** ✅ (`ScreenplayView.tsx`, logic in
  `state/screenplayLayout.ts`). The last commit, paged as Final Draft
  pages it: Courier 12pt on a ten-to-the-inch, six-to-the-inch grid,
  so pagination is arithmetic and the view draws exactly the rows it
  computed. Title page laid out by key (centre, bottom left, bottom
  right); page numbers from page 2; scene numbers in one, both or no
  margins; headings, cues and parentheticals never end a page; action
  splits only two-and-two; speeches carry (MORE)/(CONT'D) across a
  break, and a returning speaker gets (CONT'D) (optional). Fountain
  emphasis is drawn. Outline material (sections, synopses, notes) is
  off by default. Exports: FDX (round-trips through our own importer,
  dual dialogue included), Fountain (the Script tab's writer, now
  shared), and PDF through the print dialog. Not done: dual dialogue
  side by side on the page (it prints in sequence), authored page
  breaks (dropped, as everywhere in v2), revision marks.
- **Storyboard** ✅ (`StoryboardView.tsx`, logic in
  `scf-core/src/storyboard.ts`, which builds on the shot list's `buildSheets`
  so the two never disagree on order). Frames in shot order at the
  project's `technical_specs.aspect_ratio` (or a chosen one). Board:
  scenes as rows or as columns, three frame sizes, shot number, name
  and description below the frame or over it, beats, unboarded and cut
  shots optional. Lightbox: a contact sheet, and a viewer that dims the
  app — ← → step, Home/End, F full screen, Esc closes; stops at the
  ends. The frame choice and its loader (`ShotFrame.tsx`) are shared
  with the shot list.
- **Gallery** ✅ (`GalleryView.tsx`, logic in `scf-core/src/gallery.ts`).
  Every current asset as a masonry wall: a grid with a 6px row unit,
  each tile spanning rows for its picture's own shape, so the sorted
  order still reads left to right. Sorts: by importance, alphabetical
  (natural order), newest, random (seeded, reshuffle on demand).
  Importance is derived, never stored: walk bundle → binding → subject,
  anchor → subject, and asset_relationship → shot / scene / project;
  one point per use, plus one and the subject's scene count for each
  subject reached (the poster counts as in every scene). Filters by
  what an asset serves, or "not used by anything". Pictures and video
  by default, other files optionally, older versions optionally.
  Tiles load only once on screen; a viewer dims the app, steps with
  the arrow keys and lists what the file is used for.

## 8. Suggested order

1. ✅ **§2 — Q04.** Done in spec 0.49.
2. ✅ **§5 — the stale documents.** Checklist at rev 13 (rev 14 since),
   app README at seven tabs, this file checked in.
3. ✅ **§4 — the deferrals recorded** as decisions rather than left
   implicit.
4. ◑ **§3 — the three unexercised features.** Beat anchoring and prop
   tags are in the fixture (spec 0.67); versions stay out with §0.4.
5. ✅ **§7a — the folder attach.** Done; two latent root-pairing
   defects fixed with it.
6. ✅ **§7b — thumbnails.** Done; `region_box` read for the first
   time, and the fixture exercises it.
7. ✅ **§7c — the two review surfaces.** Done; and it narrowed §3's
   fixture pass to two named divergences instead of twelve.
8. ✅ **§6** — both proposals resolved: 0002 implemented in its narrow
   form, 0003 deferred past 1.0.

## 9. What "MVP" is being taken to mean here

**Answered for the release, 2026-10-08** (`release-checklist.md` §A10):
**the editor is not part of SCF 1.0.** 1.0 is the format, its artifacts
and `scf-core`; the editor ships as the reference editor on its own
version line, and `scf-mcp` publishes at 0.x. So what follows is the
editor's own bar, and nothing below blocks the format's release.

Stated because the list above depends on it:

> **The editor is MVP-complete when every capability the format claims
> can be authored in it, and every capability the editor can author is
> visible in the published fixture.**

That definition is what puts §3 near the top and §4 out of scope. If
the intended bar is instead "a writer can take a screenplay from import
to a shootable package without touching SQL," then §3 becomes optional
polish and the list gets shorter — worth settling before any of it
starts.
