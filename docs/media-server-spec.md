# Media Server Spec

## 1. Scope

The media server is a pillar alongside the frontend app and the host. It sits between raw project files and the webview. It resolves a media request to raw passthrough, a cache hit, or a queued conversion.

The webview addresses media by identifier (the existing `@root/path` scheme, scf-core's `AssetIdentifier`) plus a project id — never by absolute path. Resolving an identifier to real bytes is entirely the media server's concern; the webview neither constructs, holds, nor is ever shown a resolved filesystem path. See §2 and §5.

Non-goals: bundling or distributing ffmpeg/ImageMagick/OpenImageIO (BYO only), true HDR/float display, DCC-based rendering.

Rule: no backend available means raw passthrough only. No queue, no cache.

## 2. Architecture

- Separate Rust crate (`media-core`), no Tauri or webview dependency. Contains probe, backends, queue, cache, resolver.
- Thin HTTP layer (`media-server`) over `media-core`, hosted inside the Tauri process.
- Host owns policy: project roots, settings, token issuance. The MCP reaches media only through the host, never the media server directly.
- Frontend talks to the media server over HTTP for bytes, and to the host for settings, queue control, and dashboard data.
- Identifier resolution (`@root/path` → a real location) is, for now, a round trip through the host's existing resolution logic (`scf-core`'s `resolveIdentifier`, `scf-host`'s `assets` module) — the same code the editor and the standalone MCP already share. The media server does not reimplement that state machine.
- This round trip is the deliberate extension point for later, not a thing to design around now: a media server fronting a real networked/shared store could do its own, smarter path translation (multiple roots, remote mounts, per-user access) in place of the desktop app's simple `@root` keyword substitution. The request API (§4) is addressed by identifier specifically so that door stays open without a client-visible change.

## 3. Backends

Four external binaries, all user-supplied:

| Binary | Role |
|---|---|
| ffmpeg | video transcode/remux, stills, thumbnails |
| ffprobe | stream/container probing |
| magick | TIFF, PSD, HEIC, RAW (delegate-dependent), general stills |
| oiiotool | EXR layers/channels, DPX, OCIO transforms |

### Discovery
Order: user-configured path, then PATH, then known locations (`/opt/homebrew/bin`, `/usr/local/bin`, `C:\Program Files\...`, common Chocolatey/Scoop paths). GUI apps on macOS do not inherit shell PATH, so the known-locations probe is required.

### Validation
Run on every resolved path, cache result keyed by binary path + mtime + size:
- ffmpeg: `-version`, `-encoders`, `-decoders`. Record libx264 / hardware encoder availability and whether the build can decode HEVC.
- ffprobe: `-version`.
- magick: `-version`, `-list format`. Record readable/writable formats.
- oiiotool: `--help`, `--buildinfo`. Record format list and OCIO availability.

Capability record per backend: `{path, version, formats_in[], formats_out[], encoders[]}`.

### Spawn rules
- Args arrays only, never shell strings.
- Tauri capability scope restricts spawnable binaries to the validated set.
- Windows: Job Object per child. Unix: process group, kill group on cancel.

### Backend trait
```rust
trait Backend {
    fn id(&self) -> &'static str;
    fn capabilities(&self) -> &Capabilities;
    fn can_handle(&self, probe: &ProbeResult, req: &DerivedRequest) -> bool;
    fn estimate_output_bytes(&self, probe: &ProbeResult, req: &DerivedRequest) -> u64;
    async fn run(&self, job: &Job, out_tmp: &Path, progress: ProgressTx, cancel: CancelToken) -> Result<()>;
}
```
Dispatcher picks the first available backend whose `can_handle` returns true. Preference order is a setting.

## 3.1 Settings UI (backend section)
- Per-binary row: status, resolved path, version, manual path override, "Reveal folder", "Re-detect".
- Per-binary: official/recommended download links, short note on what file types it unlocks.
- Summary line: which file types are currently unlocked.

## 4. Request API (loopback HTTP)

All requests carry a per-session token (header `Authorization: Bearer`, or `?t=` for `<img>`/`<video>` src where headers are unavailable).

```
GET  /media?id=<identifier>&project=<id>[&layer=&channel=&exposure=&colorspace=&max=&frame=&mode=]
GET  /meta?id=<identifier>&project=<id>
GET  /jobs/<id>
POST /jobs/<id>/cancel
```

`id` is the asset's stored identifier (e.g. `@project/shots/sc01.mov`), URL-encoded, exactly as `scf-core`'s `parseIdentifier` accepts it — never an absolute path. Nothing the webview sends or receives names a real filesystem location.

`/media` responses:
- 200 / 206: bytes (passthrough or cache hit). Range requests supported on every path.
- 202: conversion queued or running. Body: `{job_id, state, progress}`. Frontend polls `/jobs/<id>` or subscribes via host events.
- 404: the identifier does not resolve under the project's current root — `missing`, `out-of-root`, or `unaddressed` in `scf-core`'s resolution states. Body names which.
- 409: the identifier resolves to a real file, but it is an un-materialised placeholder (a cloud file not yet downloaded) — `scf-core`'s `unmaterialised` state. Never probed or queued: generating a preview must not force a download as a side effect. Body says so; frontend shows the existing "placeholder, not missing" message rather than treating it as broken.
- 415: no available backend can produce a displayable form. Frontend shows a placeholder.
- 422: negative-cached failure. Body includes last error summary.

`/meta` returns probe data: container, codecs, dimensions, duration, for EXR the layer and channel list. Frontend builds the layer picker from this.

`mode`: `auto` (default), `raw` (force passthrough), `proxy` (force derived).

## 5. Resolution pipeline

1. Resolve `id` against the project's current root — today, the round trip described in §2 (`scf-core`'s `resolveIdentifier`), which already distinguishes `resolved`, `missing`, `unmaterialised`, `out-of-root`, `unaddressed`. Only `resolved` continues to step 2.
   - `missing` / `out-of-root` / `unaddressed` → 404 immediately.
   - `unmaterialised` → 409 immediately. Never probed, signed, or queued — see §4.
2. Canonicalize the resolved path (symlinks resolved, no traversal) as a defense-in-depth check on top of step 1, not the primary authority.
3. Compute signature: size + mtime + hash of first and last 64 KB.
4. Probe (cached by signature): ffprobe for video/audio, oiiotool/magick for images.
5. Verdict per file, cached:
   - `passthrough`: webview can decode as is. Decision uses a capability table seeded from a frontend report (`MediaCapabilities.decodingInfo` / `canPlayType`, sent once per session per codec/container combo), since support differs on WebView2, WKWebView, WebKitGTK.
   - `remux`: codec playable, container not. `ffmpeg -c copy` to MP4. Treated as cheap, may run without explicit user action.
   - `transcode`: codec unsupported (e.g. HEVC on WebView2 without extension). Explicit user action only (preview open or queue request). Never speculative.
   - `render`: derived still (EXR layer/channel, TIFF, PSD, RAW) to PNG/JPEG at max resolution.
   - `unsupported`: no backend. 415.
6. Cache lookup by key. Hit: serve. Miss: enqueue (if allowed by verdict rules) and return 202.

If no backend exists for a `remux`/`transcode`/`render` verdict, fall back to raw passthrough and let the browser fail, or 415 for formats known to be undecodable (EXR, PSD, etc.).

## 6. Queue

- Persistent in SQLite (`jobs` table). States: `queued`, `running`, `done`, `failed`, `cancelled`.
- Concurrency: default 1 video job + 2 still jobs, user-configurable cap.
- Priority: `preview` (user is viewing) > `requested` > `background`. Preview jobs preempt: pause or cancel lowest-priority running job when slots are full.
- Idempotent jobs. Output written to `<cache>/tmp/<job>.part`, fsynced, atomically renamed into place on success.
- Startup: mark `running` jobs as `queued`, delete orphaned `.part` files.
- Progress: ffmpeg `-progress pipe:1`; oiiotool/magick report start/finish only.
- Cancel: kill process group / Job Object, delete `.part`, state `cancelled`. Same path on app exit.
- Dedup: identical cache key already queued or running attaches to the existing job.
- Disk guard: before starting, check free space against `estimate_output_bytes`, evict if needed, fail with `insufficient_space` if still short.

### Video delivery before completion
Initial implementation: wait for completion, show progress. Later option: fragmented MP4 (`+frag_keyframe+empty_moov`) served progressively with range support. Design the `/media` handler so output files can grow during serving without a rewrite.

## 7. Cache

Location: app cache dir (`dirs::cache_dir()/<app>/media`), not inside project folders. Overridable in settings.

### Store
Single shared content-addressed store plus per-project reference table. Avoids duplicating identical media across projects and simplifies per-project accounting.

`project_id` is the project row's existing `uuid` (`app.db`'s `project` table, file-management-plan.md §2 decision 6) — already the identity a project is matched on across Save As and versioned copies. Not a new id.

SQLite schema (sketch):
```
entries(key PK, path_on_disk, bytes, kind, created_at, last_access, hit_count, pinned)
refs(project_id, key, PRIMARY KEY(project_id, key))
jobs(id PK, key, project_id, state, priority, error, created_at, started_at, finished_at)
failures(key PK, error, backend, attempts, last_attempt)
```

### Key
`hash(source_signature, backend_id, backend_version_major, profile_version, derived_params)`
- `source_signature`: size + mtime + first/last 64 KB hash. No creation time.
- `profile_version`: integer bumped when output profile logic changes.
- `derived_params`: normalized resolution cap, CRF/quality, layer, channel, exposure, colorspace, frame.

### Output profiles
- Video: MP4, H.264, yuv420p, `+faststart`, resolution cap (default 1080p), CRF setting. Optional hardware encoder via setting.
- Stills: JPEG (default) or PNG, max long-edge setting (default 2048), 8-bit sRGB display transform.
- Thumbnails: separate profile, max 256 px.

### Eviction
- LRU on `last_access`. Cache hits update `last_access` and `hit_count`.
- Separate quotas: thumbnails, stills, video proxies. One large proxy cannot evict thumbnails.
- Per-project cap in MB. Entries referenced by multiple projects count once toward the store total, and toward each project's usage proportionally or fully (pick fully, simpler to explain in UI).
- Pinned entries (currently playing, queued) are never evicted.
- Enforcement at write time (before job start) and by a periodic sweep.

### Negative cache
Failed key recorded in `failures` with error text. Retries blocked until: source signature changes, backend path/version changes, or user clicks Retry. Cleared by cache flush.

### Manual actions
Flush project (drops refs, deletes entries with no remaining refs), flush all, retry failed.

## 8. Settings (user-editable)

- Backend paths and preference order.
- Concurrency limits.
- Per-project max cache MB, per-kind quotas.
- Eligible file types and source size bounds. Semantics: `min_source_bytes` and `max_source_bytes`; sources outside the range are never auto-processed, but an explicit preview request may override `max_source_bytes` with a confirmation.
- Output profile: video resolution cap, CRF, still format, still max edge, hardware encoder on/off.
- Cache location.

## 9. Dashboard

- Queue list: job, file, state, progress, priority, backend, elapsed. Cancel and retry per job.
- Worker status: slots in use, current command (redacted paths optional).
- Cache: usage vs project cap per kind, entry counts, hit rate, flush buttons.
- Failures list with per-job stderr tail.
- Backend status panel (shared with settings).

## 10. Security

- Bind `127.0.0.1` only, random port, per-session random token issued by host.
- Reject requests whose `Host` header is not loopback (DNS rebinding).
- Strict CORS: only the app's webview origin.
- Identifier-only addressing: the client supplies an `@root/path` identifier and a project id, never an absolute path, and no response reveals one. Path allow-list: the resolved path must canonicalize under the registered project root. Reject otherwise, including via symlink.
- No endpoint accepts a binary path or ffmpeg arguments from the client. All args built server-side from validated params.
- Output file paths never derived from user input; always cache-key-based.

## 11. Host and MCP integration

- Host exposes commands: `media.meta`, `media.request`, `media.job_status`, `media.cancel`, `media.cache_stats`, `media.flush`.
- MCP tools (e.g. `shot_media`, `media_resolution`) call these host commands. They receive a derived file path or a status, never the loopback URL or token.
- Host is the single authority for project roots and permissions.

## 12. Implementation phases

1. `media-core` skeleton: backend discovery, validation, capability records, settings plumbing, backend settings UI.
2. Passthrough server with range support, token auth, identifier resolution (the §2 round trip), path allow-list. Same observable behavior as today for the user, but retires the base64-over-IPC/blob-URL path entirely: `scf-app/src/files/objectUrlCache.ts`, the blob-building parts of `assetLocator.ts`, and every `acquire`/`release` call site (`AssetThumb.tsx`, `AssetPreview.tsx`, `GalleryView.tsx`, `MediaStrip.tsx`).
3. Probe + verdict engine, `/meta`, frontend capability report.
4. SQLite store, cache key, ffmpeg remux and transcode, queue with cancel and cleanup, 202 flow.
5. Still pipeline: magick and oiiotool backends, EXR layer/channel params, layer picker in the UI.
6. Eviction, quotas, negative cache, flush actions.
7. Dashboard.
8. Progressive fMP4, hardware encoders, preemption refinements.

## 13. Test plan

- `media-core` unit tests with fixture files: H.264 MP4, HEVC MKV, HEVC MP4, ProRes MOV, multilayer EXR, TIFF, PSD, HEIC, truncated file, zero-byte file, unmaterialised placeholder (cloud stub).
- Fake backends (shell stubs) for queue, cancel, crash, and disk-full behavior.
- Kill-during-transcode test on Windows and macOS: no orphaned ffmpeg processes, no leftover `.part` after restart.
- Range request conformance for passthrough, cache hit, and growing file.
- Resolution tests: `missing` / `out-of-root` / `unaddressed` → 404, `unmaterialised` → 409 with no probe, no job, no cache entry ever created.
- Security tests: traversal, symlink escape, wrong Host header, missing token, no absolute path accepted or returned anywhere in the API.
