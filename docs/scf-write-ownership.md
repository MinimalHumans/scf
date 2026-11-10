<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# One host for every `.scf` — design note

**Status: built** (on the `fileio` branch). First written 2026-10-12;
rewritten 2026-10-18 after the decisions in §2; §10 records what was
done and what was left. It supersedes the "`scf-mcp` has no write
tools" line in [`scf-mcp-design.md`](scf-mcp-design.md) §1, which that
document now says.

**Update 2026-10-19: the host is no longer a process.** Everything
below about who owns a file and how writes are made still holds; what
changed is where the owner runs. The desktop app's window runs the host
core itself, on SQLite and files its Tauri shell provides, and serves
each agent's MCP server beside it, reached through `scf-editor mcp`,
the app's executable run as a stdio pipe (the end of §10 has the detail). The Node host
process, its discovery file, the dev-server plugin and the MCP run from
Node are gone, so §3.1–3.3 describe a design that is no longer built.
Development is `npm run dev` in `scf-app`, the app in its own window.

Where to look: `scf-core/src/ops/` (the write rules and the two op
tables), `scf-host/src/core.ts` (the host), `scf-app/src/host/` and
`state/api.ts` (the window as a client), `scf-app/src/mcp/` and
`scf-mcp/src/writeTools.ts` (the MCP as a client).

---

## 1. The problem

The app and the MCP both reach SQLite through `SqlExec`, but treated the
file differently and shared no write logic.

| | App (before) | MCP (before) |
|---|---|---|
| Driver | sqlite-wasm in a worker, on OPFS | `node:sqlite`, read-only, per call |
| Live DB | an OPFS **working copy** | the `.scf` on disk |
| Persistence | `exportBytes()` → whole-file overwrite on Save | none |
| Write logic | in the views and `*Ops` modules | none |

Two consequences: no shared invariants (scene cascade, shot renumbering,
numbering policy…), and two writers clobbering each other (the app's Save
replaces the whole file).

## 2. Decisions

1. **One host process owns every open file.** It is the only process that
   opens a `.scf`. The window and the MCP are both clients of it.
2. **The host is required.** No browser-only mode, no OPFS working copy,
   no second code path. `npm run dev` starts the host together with Vite,
   so the development experience does not change.
3. **Write-through.** Every committed write is durable in the file
   immediately. There is no Save for a host-backed project; undo is the
   safety net.
4. **The host owns writes; clients send intent.** Reads are SQL on a
   read-only connection. Writes are **named ops** from a registry in
   `scf-core`, run by the host. No client sends write SQL.
5. **Tauri is out of scope.** It will later wrap the same host and add a
   native file dialog; nothing here should make that harder.

### Why writes are ops and not SQL

If the host only proxied `exec`, each client would run its own
`BEGIN … COMMIT` over a shared connection, and interleaved transactions
would let one client's rollback undo another's work. With the host
running ops, a transaction never spans a network round trip, and the
revision token, the integrity gate and provenance live in one place. It
is also the existing rule ("nothing outside `scf-core/src/ops` issues
write SQL", pinned by `scf-app/test/noInlineWrites.test.ts`) enforced at
runtime.

## 3. Shape

```
 window (Vite page) ─┐                    ┌─ Session(film A)  openNodeSession
 MCP shim (stdio)   ─┼─ loopback + token ─┤  Session(film B)  one write queue each
 scripts / CLI      ─┘      host          └─ op registry (scf-core)
```

- **Protocol.** Request/response over a loopback WebSocket (events need a
  push channel): `open(path)`, `query(sql, params)`, `op(name, args,
  expectedRevision?)`, `close`, plus `revision` events to every client of
  a file. `query` rejects anything that is not a single read statement
  and runs on a read-only connection.
- **Op registry** (`scf-core`). A name → handler map with argument
  validation, so the MCP's tools and the window's calls are the same
  table. `Session.write` already serialises and counts.
- **Client library.** One `HostClient` for browser and Node, exposing
  `SqlExec` for reads and `call(op, args)` for writes, so views and tools
  keep their shape.
- **Current film is per client connection.** An MCP `open` never changes
  what the window shows. Two clients on the same file share one session
  and one write queue.

### 3.1 Development (superseded 2026-10-19)

`npm run dev` in `scf-app` starts the host and Vite as one command. A
Vite plugin (`scf-app/tools/scfHostPlugin.ts`) starts the host
**inside the dev server's process**, loading `scf-host` and `scf-core`
from TypeScript source, so there is no build step and an edit takes
effect on restart like any other. The host's lifetime is the dev
server's, including on Ctrl-C. Direct use of a bare host is the
`scf-host` command.

The plugin allow-lists the dev server's own origin and serves the
connection details (`{url, token}`) at `/__scf-host`. Vite's dev server
sends permissive CORS headers, so that endpoint answers only a request
the browser marks same-origin, with a matching `Host`, and sets no CORS
header; another site cannot read the token. The host also writes the
discovery file, so an MCP started during development shares this host.
If a host is already running the plugin refuses to start a second.

### 3.2 Startup from an MCP call (superseded 2026-10-19: the MCP pipe starts the app)

If no host is running, the MCP shim starts one: read the registry
directory for `{pid, port, token, version}`; a dead pid is stale and is
deleted; take a start lock so concurrent shims do not both spawn; spawn
the same binary in serve mode, detached; wait for the registry entry and
a ping; on timeout, fail naming the host's log file. A host with no
clients for N minutes flushes and exits; one started by the window stays
while the window is open.

### 3.3 Version skew (superseded 2026-10-19: the pipe and the app ship together)

The shim compares versions on connect. An old idle host is asked to exit
and is respawned; a busy one produces a clear error rather than a
mismatched protocol.

## 4. Choosing a file

The desktop app uses native OS dialogs (`tauri-plugin-dialog`) for
opening films, Save As, creating projects, and picking asset folders:

- **Full machine access.** The desktop app has no folder confinement
  and can open files across any drive letter, UNC path, or mapped
  network drive. `SCF_HOST_ROOTS` remains available as an opt-in
  restriction for sandboxed test environments.
- **The MCP works in paths directly.**
- The host canonicalises paths at the boundary (see §8, WSL) and the
  canonical path is the session key.
- **Asset folder pairing.** Handled via `app.db` (SQLite in the app data
  directory), shared between the editor and MCP. Asset reads are
  consolidated in the host's `assets` module.

## 5. Safety

File-level contention disappears with one connection per file. Logical
conflicts do not: an agent reads shot 10A, the user renumbers, the agent
writes against stale assumptions.

- **Expected-revision token** on every write; reject if the session has
  moved. `Session.revision` is the source.
- **One transaction per op.** Ops are already `withTransaction`; none may
  nest.
- **Plan → confirm → apply** for destructive ops, reusing
  `planSceneRemoval`, `planCommitStructure`.
- **Integrity gate.** Run `scanIntegrity` inside the transaction and roll
  back if the write adds a *blocking* finding the file did not already
  have: a line anchor whose line is gone, or a reference naming no row
  (spec §9.4.1, `reference.dangling`). A scene link for someone with no
  cue there is not one. The format says such a link is legitimate (spec
  §2.4.1), so it is returned as a question for the plan and the write
  goes through (proposals 0040 and 0041).
- **Snapshot** the file before the first write of a host session.
- **Provenance.** Undo entries and the change journal record the client
  (window, MCP agent id): "Added shot 10B (via MCP)".
- **Out-of-band edits.** `Session.hasExternalChange()` (mtime and size)
  is checked before each write; on a change the host refuses and tells
  the client, never overwrites.

## 6. Keeping the window unsurprising

- **Data only, never navigation.** An agent's write arrives as a
  `revision` event and refreshes lists exactly as a local edit does.
  Selection, tab and scroll are window-local and unreachable.
- **Presence.** A small indicator shows an agent is connected.
- **Drafts.** If the user has an unsaved form draft on a row an agent
  just changed, warn at commit rather than overwrite silently.

## 7. Security

The host exposes a local write endpoint and a filesystem listing, so it
is not "just localhost":

- Bind `127.0.0.1` only. A random per-session token, held in a
  user-only registry file, is required on every connection.
- Check the `Origin` header on the WebSocket upgrade against the Vite
  dev origin; a web page the user happens to visit must not be able to
  reach the host.
- Path access is unrestricted for native OS dialogs by default;
  opt-in confinement remains configurable via `SCF_HOST_ROOTS`.
- Every write is attributable to a client (§5).

## 8. Platform notes

- **WSL.** The repo lives on `/mnt/f`. A shim in WSL and a host on
  Windows (or the reverse) share neither unix sockets, pids nor the
  registry directory, and the same file is `F:\…` on one side and
  `/mnt/f/…` on the other. Require shim and host to be the same OS, or
  use loopback TCP with a canonical-path rule at the boundary. Settle
  this before routing is built; session keys are paths.
- **Process startup is slow on `/mnt/f`.** The MCP smoke suite already
  needs ~8 s for two sequential server starts here, so host start-up
  timeouts must be generous and configurable.

## 9. Edge cases to settle

1. A cloud-sync client replaces the `.scf` under a running host (§5,
   external change).
2. A second host on the same path (two users, a network share): the
   start lock covers one machine only; take a per-file advisory lock in
   the session.
3. Host crash with queued writes: acknowledge only after COMMIT.
4. Stale registration after a hard kill: pid liveness check, then
   respawn; the file is safe because SQLite transactions are atomic.
5. Existing OPFS "Resume" copies from earlier sessions are abandoned;
   say so once on first run.

## 10. Order of work

Done on branch `fileio`:

- ✅ Write logic in `scf-core/src/ops/` (scenes, shoot, elements, media,
  structure, record create/update/delete, title page, script features,
  import, integrity); the app issues no write SQL.
- ✅ `Session` (`scf-core/src/session.ts`): revision, dirty, persist
  watermark, external-change token, serialised writes; `openNodeSession`
  is the file-backed driver.

- ✅ **Op tables** in core. `ops/opTable.ts` is the small curated set
  for tools: named, schema-checked arguments, `callOp` with an
  expected-revision check. `ops/calls.ts` is the window's broader write
  surface: every function the editor used to run itself, by name, with
  its own positional arguments, typed from the functions. Wrappers
  exist where a function took something that cannot cross a process
  (`script.commit` for the link-then-store pair the editor ran in one
  transaction, `import.apply` which re-parses the text host-side,
  `undo.change`).
- ✅ **`scf-host`**: transport-free core, WebSocket server with token,
  `Host` and `Origin` checks, discovery file. Tested with a real socket.
- ✅ **`HostClient`** (`@minimalhumans/scf-host/client`) over a
  `HostTransport`; WebSocket adapter, plus a Node `connectToHost`. A
  Tauri `invoke()` adapter implements the same four-method interface.
- ✅ **Dev integration**: the Vite plugin above.
- ✅ **Window migration**: the window opens, creates, copies and
  reads/writes through the host; every write is a named call from
  `ops/calls.ts` (`state/api.ts`); the file chooser is a
  `ProjectChooser` backed by the host's `list`; the SQLite worker, OPFS
  copy, Save and Resume-from-OPFS are deleted. Done in three steps:
  host methods + connection retry + chooser, every write moved to
  `call()`, then the cutover and deletions.

- ✅ **MCP** (`scf-mcp`): a client of the host. It finds a running host
  or starts one (a lock directory so two servers do not both spawn; the
  host exits by itself after `--idle-exit`); every tool call has its own
  connection, so no film outlives a call. Read tools are unchanged for
  the caller. Seven write tools, each plan → confirm → apply (§5):
  - a *plan* is deterministic (exact field diffs, risks, a `planId`
    hashed from the film, revision and changes), made with a host **dry
    run** that runs the write, measures the integrity findings it would
    add, and rolls back without moving the revision;
  - *apply* re-plans, applies only an identical plan, and sends the
    revision it was planned at as `expectedRevision`; where the client
    can elicit, the person is asked directly as well;
  - the host adds the **integrity gate** (the write runs in one outer
    transaction whose inner transactions are savepoints; any new
    blocking finding, by identity, rolls it all back), a **snapshot**
    before an
    agent's write (once per ten minutes per film, last ten kept) and a
    **journal** of who made every write (`journal`, `recent_changes`; the
    editor shows "edited by …");
  - revisions carry on across a film being closed and reopened, so a
    plan's revision still means something at apply;
  - `--read-only` registers no write tool and opens films read-only; a
    film on an older schema is refused with "open it once in the
    editor".

- ✅ **Reads in one place.** The modules that read the film and had
  lived in the editor moved into `scf-core` with their tests, and the
  editor imports them back: `gallery`, `characterPresence` (who speaks
  where, link vs script), `subjectStats`, `listOrder`, `assetStanding`,
  `shotlist` and `storyboard` (with `readShotlistRows` and
  `readBoardRows`, which replaced thirteen inline queries in two
  views), and `queryMarkdown` — the prompt-ready rendering of all
  sixteen canonical queries, split out of the editor's `runners.ts`,
  which keeps only the picker wiring. The renderings are pinned
  character for character (`scf-core/test/golden/queryMarkdown.json`,
  captured before the move). The MCP offers the same reads: `shot_list`,
  `gallery`, `character_presence`, and `format: "markdown"` on the
  query tools. A read whose answer is *shaped* (joins, ordering rules, a
  derivation) belongs in core; a view may still do a plain lookup of its
  own rows.
- ✅ **Docs**: this note, the READMEs of `scf-core`, `scf-host`,
  `scf-app` and `scf-mcp`, `scf-mcp-design.md` §1 and §5, `conventions.md`
  §9, and the editor notes.

Known limits of the window migration: the import dialog no longer shows
per-step progress (a call returns once); a change the MCP makes to the
script text updates lists and records but not an editor that is already
open on that script, which re-reads when it is next opened; a second
browser tab is refused rather than shared.

Known limits of the MCP migration: the write tools cover records, shots,
cuts, shot order and the title page — the curated op table — not media,
structure or script text, which stay in the editor until a case for them
is made; there is no tool to restore a snapshot (it is a file to open in
the editor); the host compares protocol versions on connect but does not
yet restart an idle host that is an older build; and session keys are
paths, so under WSL a host and a client that spell one file `F:\…` and
`/mnt/f/…` do not share a session.

On branch `tauri`, the desktop app (decision 5, now in scope): a Tauri
shell around the same window, and no host process. The window runs the
host core (`scf-host/src/core.ts`, which takes its files, SQLite and
paths from a `HostPlatform`) on the shell's: SQLite through rusqlite,
set to behave as `node:sqlite` does (foreign keys on, no double-quoted
strings), over a loopback WebSocket because a Tauri `invoke` costs a
millisecond and scf-core awaits every statement. The window is a client
of its own core in-process (`connectInProcess`). The MCP runs in the
window too, one server per agent (`scf-mcp/src/mcpServer.ts` on a
platform of the window's), reached by `scf-editor mcp`, a pipe the shell
relays to the window, which starts the app hidden if it is not running.
So an agent and the editor share one owner of each film again, the
window's core. The Node host, and the MCP run from Node, were then
removed: development is the app in its own window (`npm run dev`), and
the tests run the same core on Node's files and SQLite, in-process.
The file chooser uses native OS dialogs with full machine access and
`app.db`-backed asset root pairing.
