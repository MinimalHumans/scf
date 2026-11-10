<!-- SPDX-License-Identifier: CC-BY-4.0 -->
<p align="center">
  <a href="https://minimalhumans.github.io/SCF_studio/">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/SCF_CI_Collection/SVG/logoFull_white.svg">
      <img src="docs/SCF_CI_Collection/SVG/logoFull_black.svg" alt="SCF — Story Context Framework" width="440">
    </picture>
  </a>
</p>

<h1 align="center">SCF Studio</h1>

<p align="center">
  <strong>A film, described in a way a machine can answer questions about.</strong>
</p>

<p align="center">
  <a href="https://github.com/MinimalHumans/SCF_studio/actions/workflows/ci.yml"><img src="https://github.com/MinimalHumans/SCF_studio/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://minimalhumans.github.io/SCF_studio/"><img src="https://img.shields.io/badge/docs-minimalhumans.github.io-1b6393" alt="Documentation"></a>
  <a href="spec/stability.md"><img src="https://img.shields.io/badge/spec-1.0--rc.7-ef393b" alt="Specification: 1.0 release candidate"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/code-Apache--2.0-1b6393" alt="Code licence: Apache-2.0"></a>
  <a href="spec/LICENSE"><img src="https://img.shields.io/badge/prose-CC%20BY%204.0-f4af3f" alt="Prose licence: CC BY 4.0"></a>
</p>

<p align="center">
  <a href="https://minimalhumans.github.io/SCF_studio/">Documentation</a> ·
  <a href="https://minimalhumans.github.io/SCF_studio/what-is-scf.html">What is SCF?</a> ·
  <a href="https://minimalhumans.github.io/SCF_studio/spec.html">Specification</a> ·
  <a href="#getting-started">Getting started</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

<img src=".github/assets/brand-rule.svg" alt="" width="100%" height="6">

Tooling for the **Story Context Framework** — a description of a film's
intent, dense enough that a human or a machine can answer a specific
question about a specific moment: what a character sounds like in this
scene, what is in force here, what a shot is for.

An `.scf` file is a SQLite database. The schema is generated from one
declaration; every consumer reads the generated registry.

**Status: pre-1.0, release candidate.** The specification is at
`spec/scf-spec.md`, as candidate `1.0-rc.7`,
and `spec/stability.md` states what is safe to build against. Until 1.0
ships, existing `.scf` files are disposable — there is no migration path
and no backward compatibility owed to anything already written (spec
§11.0). The one exception is `fixtures/hollow_creek.scf`, which is a
normative artifact.

| Directory | What it holds |
|---|---|
| `schema/` | **The source of truth for the format.** Entity and field declarations, the version, the registry generator and linter. |
| `scf-core/` | The semantics, in TypeScript: resolution, structure, readiness, screenplay parsing, proposals. Environment-agnostic. |
| `scf-app/` | The editor — a desktop app (Tauri) over the same core, with a CodeMirror screenplay editor and canonical query pages. Its window owns the open files and serves the MCP. |
| `scf-host/` | The host core: the one owner of each open `.scf`, which the editor's window runs — read-only queries, named writes from `scf-core`, snapshots and a journal. See `docs/scf-write-ownership.md`. |
| `scf-mcp/` | The MCP tools for AI assistants, served by the editor (`scf-editor mcp`): one tool per canonical query, lookup, the shot-prompt composite, and write tools that plan first and change nothing until the plan is confirmed (`--read-only` removes them). See `docs/scf-mcp-design.md`. |
| `fixtures/` | `hollow_creek.scf`, the conformance fixture and demo project, with the scripts that build it. |
| `corpus/` | Screenplay parsing corpus. The public tier is checked in; `corpus/private` is not. |
| `spec/` | **The normative specification.** `scf-spec.md` (what the format is), `stability.md` (what is safe to build against), `conformance.md` (what claiming SCF support means), `CHANGELOG.md`. Published artifacts: `scf-schema.sql` (physical DDL), `registry.schema.json` (JSON Schema for the registry), `finding-catalog.json` (the normative finding codes), `junction-keys.json`, `readiness-rubrics.json`, `scf.magic` (a `file(1)` pattern), `ARTIFACTS.md` + `SHA256SUMS`. `screenplay-tables.json` (the screenplay infrastructure tables and the `line_type` vocabulary). `api-surface.json` (every name importable from `scf-core`), `entity-reference.md` and `query-reference.md` (generated reading aids, not normative). `ARTIFACTS.md` lists every file the manifest covers — these four documents, the generated artifacts, the canonical query results and the blessed negative reports under `fixtures/` — and says how many. |
| `docs/` | `what-is-scf.md`, `walkthrough.md`, `authoring-guide.md`, `glossary.md` and `faq.md` (start here if the format is new to you), `conventions.md` (the design record — why the format is the way it is), `schema-changelog.md`, `release-checklist.md` (what stands between here and 1.0), `developing.md` (setting up to work on the editor), and the design records for the editor and the MCP server: `editor-mvp.md`, `narrative-workspaces.md`, `story-structure-design-record.md`, `scf-mcp-design.md`, and `scf-write-ownership.md` (why one host owns every open file, and the rules its writes keep). |
| `site/` | The documentation site. Renders the Markdown above; authors nothing except its own landing page. `npm run build` in `site/`. |

## Getting started

Node 22.6 or newer, and Rust (stable) for the editor. Each package has
its own `package-lock.json`; the editor runs the others from source, so
install them all once:

```sh
(cd scf-core && npm ci) && (cd scf-host && npm ci) && (cd scf-mcp && npm ci)
cd scf-app && npm ci && npm run dev         # the editor, in its window
```

Nothing needs building first: the editor aliases `scf-core`, `scf-host`
and `scf-mcp` to their TypeScript source. **[`docs/developing.md`](docs/developing.md)
is the full setup for Windows, macOS and Linux** — the system packages
the desktop shell needs, running the editor and the tests, and pointing
an assistant at the dev app.

The editor is a desktop app (Tauri). Its window owns every open file
(`scf-host`'s core) and serves the MCP, so an assistant pointed at the
app (`scf-editor mcp`) works on the same film as the person at the editor;
connecting one is in [`scf-mcp/README.md`](scf-mcp/README.md). Files and
asset folders are opened via native OS dialogs across any drive or network
share; pairings and recent project history are stored in `app.db`. The
editor opens with a start screen; every change is written to the `.scf`
as it is made (there is no Save button — undo is the safety net), and the
demo asks where to put its copy first.

## Tests

```sh
cd scf-core && npm test    # semantics + conformance against the fixture
cd scf-host && npm test    # the host core, on Node's files and SQLite
cd scf-app  && npm test    # editor, import pipeline, the window on a host
cd scf-mcp  && npm test    # the MCP tools, on a host core in-process
```

Validate a file:

```sh
cd scf-core && npm run scf-check -- ../fixtures/hollow_creek.scf
```

Exit 0 means no errors; 1 means errors; 2 means the file could not be
read. `--json` emits the serialised report, `--quiet` the exit code
alone.

Both suites run green on a clean checkout.

Conformance artifacts, all checked on every test run:

| | |
|---|---|
| `fixtures/hollow_creek.scf` | The reference fixture. |
| `fixtures/negative/` | Nineteen deliberately-broken cases with blessed reports, plus `CASES.json` so anyone can rebuild them. |
| `fixtures/expectations/` | The sixteen canonical queries' normative results, a normative per-case result wherever one position cannot show a member, and the selectors that say what each was asked; plus rendered markdown for eight of them. The markdown is a convenience and is a contract for none. |

`corpus/private` is not checked in, and the blocks that need it
(`screenplay.test.ts` stage 3 payoff, `fountain.test.ts` private tier)
skip themselves when it is absent — a machine that has the private tier
picks up the extra coverage automatically.

## Continuous integration

`.github/workflows/ci.yml`, four jobs:

| Job | What fails it |
|---|---|
| `artifacts` | A generated file nobody regenerated: `registry.json`, `scf-schema.sql`, `screenplay-tables.json`, `finding-catalog.json`, the negative reports, the corpus expectations, `ARTIFACTS.md`, `SHA256SUMS` — and a schema or spec tag that is not on the remote, or that serves different bytes than `SHA256SUMS` claims. |
| `core` | Format semantics — typecheck, tests, `scf-check` against the fixture, the packaging test, the fixture rebuild, and the docs site build. |
| `app` | The editor — typecheck, tests (including the blessed query expectations), production build. |
| `mcp` | The MCP server — typecheck, the `file:` dependency rewrite, build, tests. |

Every artifact step runs in `--check` mode and never in write mode. CI
must fail on a stale artifact rather than quietly regenerate it and
pass: a pipeline that rewrites what it is verifying verifies nothing.

## Changing the format

`docs/conventions.md` §8. Short version: edit `schema/entity_registry.py`,
regenerate, lint, bump the version and record it in the changelog. If the
change touches anything normative, update `spec/scf-spec.md` and the
affected row in `spec/stability.md` in the same commit.

The two documents have distinct jobs and must not overlap: the spec
states rules and nothing else, the design record explains them and
states no rules. A rule found only in `docs/conventions.md` is a defect.

## Contributing and governance

| | |
|---|---|
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | How to contribute, and which of the three routes a change takes |
| [`proposals/`](proposals/) | Changes to the **format** get argued here before they get built |
| [`GOVERNANCE.md`](GOVERNANCE.md) | Who decides, what they weigh, and how a decision is recorded |
| [`SECURITY.md`](SECURITY.md) | What is in scope, and how to report privately |
| [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) | Contributor Covenant 2.1 |

A **defect** in the specification is an issue, not a proposal. Every
independent reader run has written its own implementation against this
format, and their authors found dozens of them; every one was worth having quickly
and without ceremony. Proposals are for changes where the answer is
arguable and the argument is the valuable part.

## Licensing

Code is Apache-2.0 ([`LICENSE`](LICENSE)). **Prose is CC BY 4.0** — the
specification is written to be implemented by other people, and a
document nobody may quote is a document nobody adopts.

The boundary runs between written documents and generated data, and is
stated once in [`spec/LICENSE`](spec/LICENSE). Generated artifacts carry
the licence of the code that produces them; so do the fixtures, because
an attribution burden on a conformance fixture is a burden on
conformance. Neither licence is copyleft: nothing here obliges you to
open your implementation.

Names are covered separately in [`NOTICE`](NOTICE). Short version: say
your software reads, writes or conforms to SCF as much as you like —
just do not imply this project endorses it.

## History

A first implementation (a Python/FastAPI editor) established the schema
and the resolution semantics, and was held to conformance parity with
this one while both existed. It is retired; nothing here depends on it.
The conformance suites and the Hollow Creek fixture carry the contract
forward.

<img src=".github/assets/brand-rule.svg" alt="" width="100%" height="6">

<p align="center">
  <a href="https://www.minimalhumans.com">
    <img src=".github/assets/minimal-humans-plate.svg" alt="Minimal Humans" width="240">
  </a>
  <br>
  <sub>SCF is developed by <a href="https://www.minimalhumans.com">Minimal Humans</a>.</sub>
</p>
