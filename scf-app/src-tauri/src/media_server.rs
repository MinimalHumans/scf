// SPDX-License-Identifier: Apache-2.0
//! The bridge to `media-server`'s loopback HTTP listener (Phase 2 of
//! docs/media-server-spec.md) and its probe capability report (Phase
//! 3). Mirrors `sql_socket.rs`'s shape: a `start()` that binds a free
//! port and spawns the accept loop on Tauri's own async runtime (which
//! neither `media-server` nor `media-core` ever touch, so both stay
//! usable outside Tauri), plus commands over the resulting shared
//! state.

use media_core::{Backends, Capabilities};
use media_server::{Handles, Queue, ServerInfo};

/// Bind the server and spawn its accept loop. Call once, at startup,
/// same as `sql_socket::start`. `backends` is shared with `media.rs`'s
/// detection command — `/meta` reads the same "currently known good
/// paths" the Settings dialog shows, never its own copy. `cache_dir`
/// is `host_setup`'s own `app.path().app_cache_dir()` — the first real
/// use of a cache dir distinct from `data_dir` in this app (Phase 4).
/// `Queue` (Phase 6) rides along so `media_cache_flush` below can reach
/// the same cache the HTTP listener itself writes to.
pub fn start(
    backends: Backends, cache_dir: std::path::PathBuf,
) -> std::io::Result<(ServerInfo, Handles, Capabilities, Queue)> {
    let (info, handles, capabilities, queue, accept) = media_server::start(backends, cache_dir)?;
    tauri::async_runtime::spawn(accept);
    Ok((info, handles, capabilities, queue))
}

#[tauri::command]
pub fn media_server_info(info: tauri::State<'_, ServerInfo>) -> ServerInfo {
    info.inner().clone()
}

/// `path` is already a resolved, absolute path — the window computed it
/// the same way it always has (`scf-host`'s `assets` module), and it
/// never crosses back out: the caller gets a handle, not the path.
/// `project_id` (Phase 6) is whatever string the window already treats
/// as that asset's project identity — `objectUrlCache.ts` passes its
/// `assetRoot` — so the cache's per-project quota and flush (spec §7)
/// have something to key on; `None` when there's no project context.
#[tauri::command]
pub fn media_register_asset(
    handles: tauri::State<'_, Handles>, path: String, project_id: Option<String>,
) -> String {
    handles.register(path, project_id)
}

/// The explicit "Flush project"/"Flush all" actions (spec §7 "Manual
/// actions"): `Some(project_id)` drops just that project's refs and
/// the entries that leaves unreferenced; `None` clears the whole cache.
/// Not yet wired to a Settings/Dashboard button — Phase 7's dashboard
/// is where that button lives — but reachable now the same way
/// `media_register_asset` was ahead of the preview flow that first
/// called it.
#[tauri::command]
pub fn media_cache_flush(queue: tauri::State<'_, Queue>, project_id: Option<String>) {
    match project_id {
        Some(project_id) => queue.cache().flush_project(&project_id),
        None => queue.cache().flush_all(),
    }
}

/// The frontend's once-per-session `canPlayType` report — see the plan
/// this was built from for why `canPlayType` over `MediaCapabilities.
/// decodingInfo` for now.
#[tauri::command]
pub fn media_report_capabilities(
    capabilities: tauri::State<'_, Capabilities>,
    report: std::collections::HashMap<String, bool>,
) {
    capabilities.report(report);
}
