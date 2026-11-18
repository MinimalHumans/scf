<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# Developing SCF Studio

From a fresh machine to the editor running in its window, with the tests
passing, on Windows, macOS or Linux.

> **Status.** The desktop app has been built and run, and the tests
> pass, on Windows, macOS (Apple Silicon) and Debian. If a step here is
> wrong or something breaks, note what you saw (the exact command and
> its output) so it can be fixed in the code or in this document.

## What you are setting up

- **`scf-core`** — the format: schema, queries, validation. TypeScript.
- **`scf-host`** — the one owner of each open `.scf` (a core, not a
  process).
- **`scf-mcp`** — the MCP tools agents use.
- **`scf-app`** — the editor: a React page in a [Tauri](https://tauri.app)
  desktop shell (`scf-app/src-tauri/`, Rust). The window runs the host
  and serves the MCP; the shell provides SQLite, files and the agents'
  pipe. There is no server to run and nothing to build first: the editor
  uses the other three packages as TypeScript source.

So you need **Node** (the page, its tooling, all the tests), **Rust** (the
shell), and what Rust needs on your OS to compile and to show a web view.

## 1. Prerequisites

### All platforms

- **Node 22.6 or newer** (22 LTS or 24; 26 also works). The tests use
  Node's built-in SQLite, and scf-core's scripts run its TypeScript
  source directly. With a version manager: `nvm install 24`
  ([nvm](https://github.com/nvm-sh/nvm), macOS/Linux) or
  [fnm](https://github.com/Schniz/fnm) (any OS); or the installer from
  [nodejs.org](https://nodejs.org).
- **Rust, stable**, through [rustup](https://rustup.rs). The shell needs
  1.90 or newer; `rustup update` brings an older one up to date.
- **Git.**
- **Python 3** — only for the repository's schema and spec checks (and
  `tools/verify.py`, which runs everything CI runs). Not needed to work
  on the editor.

### macOS

```sh
xcode-select --install          # the compiler and SDK; full Xcode also works
curl --proto '=https' --tlsv1.2 https://sh.rustup.rs -sSf | sh
```

The web view is the system's (WKWebView); nothing else to install.

### Linux

Rust:

```sh
curl --proto '=https' --tlsv1.2 https://sh.rustup.rs -sSf | sh
```

Then the system libraries the shell links against: WebKitGTK 4.1 for the
web view, and a C toolchain (SQLite is compiled in).

Debian, Ubuntu (22.04 or newer) and derivatives:

```sh
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

Fedora:

```sh
sudo dnf check-update
sudo dnf install webkit2gtk4.1-devel openssl-devel curl wget file \
  libappindicator-gtk3-devel librsvg2-devel libxdo-devel
sudo dnf group install "c-development"
```

Arch:

```sh
sudo pacman -Syu
sudo pacman -S --needed webkit2gtk-4.1 base-devel curl wget file openssl \
  appmenu-gtk-module libappindicator-gtk3 librsvg xdotool
```

Ubuntu 20.04 and older do not have WebKitGTK 4.1, which Tauri 2 needs.

### Windows

- **Visual Studio Build Tools** (or Visual Studio) with the **Desktop
  development with C++** workload: the MSVC compiler and a Windows SDK.
- **Rust** with [rustup-init.exe](https://rustup.rs), keeping its default
  MSVC toolchain.
- **WebView2** is part of Windows 10 and 11; nothing to install.

### Check

```sh
node --version     # v22.6 or newer
rustc --version    # 1.90 or newer
cargo --version
```

## 2. Install

Each package has its own `package-lock.json`. The editor runs the other
three from source, so install all four, once:

```sh
git clone git@github.com:MinimalHumans/scf.git
cd scf
(cd scf-core && npm ci) && (cd scf-host && npm ci) && (cd scf-mcp && npm ci)
cd scf-app && npm ci
```

Use `npm ci`, not `npm install`: it installs exactly what the lockfiles
say, which is what CI does. Run it again after a pull that changes a
lockfile.

## 3. Run the editor

```sh
cd scf-app
npm run dev
```

This is `tauri dev`: Vite serves the page, and the Rust shell is
compiled and opened around it. **The first run compiles the shell and
its dependencies — several minutes, with a progress bar that seems to
stop near the end while it links.** Later runs take seconds.

The window's title says **SCF Editor (dev)**. Click **Open Hollow Creek
Demo**, choose where to put the copy, and the editor opens on it.

While it runs:

- A change under `scf-app/src/` (or in `scf-core`, `scf-host`,
  `scf-mcp`) reloads the page in place.
- A change under `scf-app/src-tauri/` rebuilds and restarts the shell.
- **DevTools**: right-click › Inspect in the window (debug builds only).
- The page needs the shell: opening `http://localhost:5173` in a browser
  shows a message saying so, not the editor.

The dev app has its own identity, so it runs beside an installed SCF
Editor without sharing anything with it. Its data (snapshots, the write
journal, MCP settings, and `app.db` history and pairings) is in:

| | |
|---|---|
| macOS | `~/Library/Application Support/com.minimalhumans.scf-editor.dev/` |
| Linux | `~/.local/share/com.minimalhumans.scf-editor.dev/` (or `$XDG_DATA_HOME`) |
| Windows | `%APPDATA%\com.minimalhumans.scf-editor.dev\` |

Files and asset folders are opened through native OS dialogs with full
machine access across drives and network shares; `SCF_HOST_ROOTS` (a list
of folders, separated as `PATH` is) remains available to confine
`create`/`saveAs` to them instead.

## 4. Run the tests

None of them need the app running or anything built.

```sh
cd scf-core && npm test     # the format: semantics, conformance against the fixture
cd scf-host && npm test     # the host core, on Node's files and SQLite
cd scf-mcp  && npm test     # the MCP tools, on a host core in-process
cd scf-app  && npm test     # the editor, the import pipeline, the window on a host
```

Each package also has `npm run typecheck`. The shell's Rust:

```sh
cd scf-app/src-tauri
cargo test
cargo clippy --all-targets      # CI-clean is no warnings
cargo fmt --check
```

Everything CI runs, in one go (Python 3; `--fast` skips the slow
packaging steps):

```sh
python3 tools/verify.py --fast
```

The editor's tests take tens of seconds the first time, while Vite
transforms the sources. If one times out on a slow machine, run it again
before suspecting it.

### Docker (CI parity)

To run the full check suite in an isolated Linux container matching CI
without local toolchain dependencies:

```sh
docker/ci.sh
```

Builds the image (`docker/dev.Dockerfile`) and runs the same
install/typecheck/test/build steps as `ci.yml`, plus a `cargo check` of
the Tauri shell (`docker/run-checks.sh`), in one command.

## 5. Point an assistant at the dev app

Agents reach the editor through its own executable: `scf-editor mcp` is
an MCP server on stdio, piped to the running app. With `npm run dev`
running, point the assistant at the debug build:

```sh
# macOS / Linux, from the repository root
claude mcp add scf-dev -- "$(pwd)/scf-app/src-tauri/target/debug/scf-editor" mcp
```

```powershell
# Windows
claude mcp add scf-dev -- "$PWD\scf-app\src-tauri\target\debug\scf-editor.exe" mcp
```

Then ask it to open a film, e.g. *"Open `<repo>/fixtures/hollow_creek.scf`
and list its scenes."* Changes it makes show up in the editor as they
land, marked with the assistant's name.

A debug pipe only ever connects to the running `npm run dev`, never to an
installed app, and does not start one: if the dev app is not running it
says so and exits. A page reload keeps the assistant connected, with its
film still open; a shell rebuild restarts the app, which ends the
assistant's server: restart it from the client (`/mcp` in Claude Code). `scf-mcp/README.md` has the
options (`--scf`, `--root`, `--read-only`).

## 6. Build the installable app

On Windows:

```sh
cd scf-app
npm run tauri build
```

gives an NSIS installer in `scf-app/src-tauri/target/release/bundle/nsis/`.

On macOS and Linux the only bundle configured so far is that Windows
installer (`bundle.targets` in `src-tauri/tauri.conf.json`), so build
the app without one:

```sh
npm run tauri build -- --no-bundle
```

which gives the release executable, `src-tauri/target/release/scf-editor`.
Adding `app`/`dmg` and `deb`/`appimage` to `bundle.targets` is still to
do. Builds are unsigned.

## When something goes wrong

| Symptom | Likely cause |
|---|---|
| `npm ci` says the lockfile is out of sync | A `package.json` changed without its lock, or an npm older than the one that wrote the lock disagrees about optional packages. Report it; do not commit an `npm install` run on a different npm without checking `npm ci` with Node 22's npm. |
| Cargo says a dependency needs a newer `rustc` | Rust older than 1.90: `rustup update`. |
| `linker 'cc' not found`, `link.exe not found` | No C toolchain: `build-essential` / Xcode Command Line Tools / Visual Studio Build Tools (above). |
| `pkg-config` errors about `webkit2gtk-4.1`, `javascriptcoregtk`, `libsoup-3.0` | The Linux packages above are missing, or the distribution is too old for WebKitGTK 4.1. |
| The window opens but stays blank (Linux) | WebKitGTK's DMA-BUF renderer, which some GPU setups cannot show. With NVIDIA's proprietary driver loaded the app turns it off itself and says so in the terminal; elsewhere, `WEBKIT_DISABLE_DMABUF_RENDERER=1 npm run dev`. If it helps on a machine the app did not detect, report the GPU and driver so the detection can learn it. |
| The window says the editor runs in its desktop app | You opened the page in a browser; use the window `npm run dev` opened. |
| "Still waiting for the SCF host to start…" that never ends | Open DevTools in the window and look at the console; the shell's own output is in the terminal running `npm run dev`. |
| `the SCF editor (dev) is not running` from an assistant | Start `npm run dev`; a debug `scf-editor mcp` never starts the app itself. |
| Port 5173 in use | Another Vite server is running; stop it. |
