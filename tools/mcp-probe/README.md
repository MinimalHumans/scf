<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# mcp-probe

A throwaway MCP server on stdio that records what an agent shows an
executable it launches: its arguments, working directory, environment,
what its stdio handles are, which processes launched it, and every
message it is sent. For finding out whether two conversations can be told
apart from the executable's side.

It speaks the same stdio contract as `scf-editor mcp`, so it goes where
that does.

## Build

```sh
cd tools/mcp-probe
cargo build --release     # target/release/mcp-probe.exe
```

## Use with Claude Desktop

In `%APPDATA%\Claude\claude_desktop_config.json`, beside (or instead of)
`scf-editor`, then restart Claude Desktop:

```json
"mcpServers": {
  "mcp-probe": {
    "command": "F:\\code\\minimal-humans\\scf\\tools\\mcp-probe\\target\\release\\mcp-probe.exe",
    "args": ["mcp"],
    "env": { "MCP_PROBE_LOG": "C:\\temp\\probe.jsonl" }
  }
}
```

`env` is optional. The log defaults to
`%LOCALAPPDATA%\mcp-probe\probe.jsonl`. Claude Desktop also keeps the
probe's stderr in `%APPDATA%\Claude\logs\mcp-server-mcp-probe.log`.

## What is logged

One JSON line per event, each with `pid` and `launch` (an id for that
process). Two conversations were served by one process if those match.

| event    | when                    | holds                                                                 |
| -------- | ----------------------- | --------------------------------------------------------------------- |
| `launch` | the process starts      | `argv`, `exe`, `cwd`, `env`, `envHash`, `stdio`, `ancestry`            |
| `in`     | each line from the agent | `raw`, and a `summary` with `method`, `id`, `meta` (`params._meta`), `paramsKeys`, `tool` |
| `out`    | each line it answers    | `raw`                                                                 |
| `exit`   | stdin closes            | `reason`, `uptimeMs`, `messages`, `toolCalls`                         |

An `in` record also has `surroundingsChanged` if the environment or
working directory differs from the previous message. Expect it never to:
a process's environment is fixed at launch, so anything per-call has to
be in the message (`meta`, `params`), not the environment.

## Tools

Ask Claude to call them, in more than one conversation, and compare.

- `probe_whoami` — the answering process, its launch, and the `_meta`
  its request carried.
- `probe_echo` — echoes its arguments and `_meta`.
- `probe_env` — environment variable names and a hash; values only for
  names asked for. (The log has them all.)

## Care

The log contains the whole environment, API keys included. Do not commit
or share it.
