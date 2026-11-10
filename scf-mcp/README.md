<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# @minimalhumans/scf-mcp

An [MCP](https://modelcontextprotocol.io) server over a Story Context
Framework (`.scf`) file, so an AI assistant can answer questions about a
film — and assemble a shot prompt — without being handed a schema and
told to write SQL.

It runs inside the SCF Editor desktop app, beside the editor: an
assistant starts `scf-editor mcp`, the app's own executable run as a
stdio pipe, and the app serves it. Nothing is hosted, and the film never leaves your
machine except as the answers your assistant asks for.

**It shares the editor's host.** The app's window owns every open
`.scf` (`scf-host`'s core), and the editor and every assistant's server
are its clients, so a film open in both is one session: a change either
makes, the other sees. If the app is not running, the pipe starts it in
the background, window hidden; such an app exits a little after its last
assistant leaves, unless someone has opened its window. While it runs
it has a tray icon, so a background copy can be seen, opened or quit.

Point the assistant at the executable with the argument `mcp` and
nothing else. A config left over from the old Node server (the
executable followed by `…/server.js`) is not an MCP launch: it starts
the app as if you had opened it, window and all, every time the
assistant starts its servers. The executable now refuses a `.js`
argument and says so.

**It reads, and it can change a film — carefully.** Most tools read.
The write tools (`create_row`, `update_row`, `delete_row`, `add_shot`,
`set_shot_cut`, `move_shot`, `set_title_page_key`) are two steps: called
as they stand they only return a *plan* — the exact changes, the risks
and a `planId` — and change nothing. Show it to the person you are
working with; call the tool again with `confirm` set to that `planId`
and it applies the change only if the film still matches the plan. Where
the client supports it, the person is asked directly as well. The host
holds three more lines: it copies the file before an agent's change
(unless it did within the last ten minutes), it refuses any change that
would leave a reference pointing at nothing (a line that is gone, a row
that is not there) where the file did not already have that problem, and it
journals which client made every change (`recent_changes`; the editor
shows "edited by …"). `--read-only` (or `SCF_MCP_READ_ONLY=1`) offers no
write tool at all.

SCF stays the ground truth of the film, not the workflow for making it:
change a row when asked to, not as a place to keep working notes.

## Connecting an assistant

Point the assistant at the app's executable with the argument `mcp`.
On Windows the installer puts `scf-editor.exe` in
`%LOCALAPPDATA%\SCF Editor\` by default.

```sh
claude mcp add scf -- "%LOCALAPPDATA%\SCF Editor\scf-editor.exe" mcp
claude mcp list        # scf should show as connected
```

or, in `claude_desktop_config.json` (Settings → Developer → Edit Config,
then restart Claude Desktop):

```json
{
  "mcpServers": {
    "scf": {
      "command": "C:\\Users\\you\\AppData\\Local\\SCF Editor\\scf-editor.exe",
      "args": ["mcp"]
    }
  }
}
```

That is the whole setup. Ask your assistant to open a film and it will
use the `open` tool; nothing else needs configuring. `claude mcp remove
scf` undoes it.

**From a checkout**, run the editor with `npm run dev` in `scf-app`,
and point the assistant at
`scf-app/src-tauri/target/debug/scf-editor.exe mcp`.
A debug pipe connects only to the running dev app, never to an installed
one, and does not start it; a page reload keeps it connected.

## Optional settings

None of these are needed to get started. Add them after `mcp` only when
you want them.

| Setting | Use it when |
|---|---|
| `--scf <path>` | You work on one film and want it open at startup instead of asking the assistant to open it. |
| `--root name=path` | The film refers to media as `@name/…` and you want those files resolved to a folder on this machine. Repeat for several roots. |
| `--config <path>` | You have several roots and prefer a JSON file: `{ "scf": "…", "roots": { "name": "path" } }`. |
| `--read-only` | No write tool is offered (also `SCF_MCP_READ_ONLY=1`). |

Relative paths are the assistant's: they are resolved against the
directory it started the pipe in. Where a film's media lives is a
property of the machine, not of the file, which is why roots are set
here (spec §0.3, §8.2). Because these paths are specific to your
machine, do not commit a project-level `.mcp.json` that contains them.

## When it does not start

| Message or symptom | Cause |
|---|---|
| `the SCF editor (dev) is not running` | A debug pipe: start the editor with `npm run dev` in `scf-app`. |
| `unrecognised argument` | An option the server does not know; the usage follows the message. |

Claude Desktop logs are in `~/Library/Logs/Claude/` on macOS and
`%APPDATA%\Claude\logs\` on Windows (`mcp-server-scf.log`).

## Tools

| Tool | What it answers |
|---|---|
| `open` | Open, or switch to, a film, with optional root mappings. |
| `recent_files` | Films this or a past session opened — a hint for `open`. |
| `find` | A label (scene number, shot code, name) to its uuid. |
| `list` | Every row of an entity type, optionally filtered, in story order where rows have one. |
| `where_used` | Which rows point at this one. |
| `shot_context`, `shot_media`, `shot_readiness` | A shot prompt in three calls: the frame, what to attach, what is thin. |
| one tool per canonical query | The specification's §12 queries, each with its own typed parameters. |
| `readiness` | Q14, for pre-flight before writing a prompt. |

`scf-mcp/src/mcpServer.ts` lists them authoritatively.

## Status

`0.x`, and part of the editor rather than a package of its own: it is
not published to npm, and runs only in the desktop app. It depends on
`@minimalhumans/scf-core`, which carries the format's 1.0 promise; this
does not yet make one. The design record is
[`docs/scf-mcp-design.md`](https://github.com/MinimalHumans/SCF_studio/blob/main/docs/scf-mcp-design.md).

Apache-2.0. See `LICENSE` and `NOTICE`.
