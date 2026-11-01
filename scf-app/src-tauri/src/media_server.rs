// SPDX-License-Identifier: Apache-2.0
//! The bridge to `media-server`'s loopback HTTP listener (Phase 2 of
//! docs/media-server-spec.md) and its probe capability report (Phase
//! 3). Mirrors `sql_socket.rs`'s shape: a `start()` that binds a free
//! port and spawns the accept loop on Tauri's own async runtime (which
//! neither `media-server` nor `media-core` ever touch, so both stay
//! usable outside Tauri), plus commands over the resulting shared
//! state.

use media_core::{Backends, Capabilities};
use media_server::{Handles, ServerInfo};

/// Bind the server and spawn its accept loop. Call once, at startup,
/// same as `sql_socket::start`. `backends` is shared with `media.rs`'s
/// detection command — `/meta` reads the same "currently known good
/// paths" the Settings dialog shows, never its own copy. `cache_dir`
/// is `host_setup`'s own `app.path().app_cache_dir()` — the first real
/// use of a cache dir distinct from `data_dir` in this app (Phase 4).
pub fn start(
    backends: Backends, cache_dir: std::path::PathBuf,
) -> std::io::Result<(ServerInfo, Handles, Capabilities)> {
    let (info, handles, capabilities, accept) = media_server::start(backends, cache_dir)?;
    tauri::async_runtime::spawn(accept);
    Ok((info, handles, capabilities))
}

#[tauri::command]
pub fn media_server_info(info: tauri::State<'_, ServerInfo>) -> ServerInfo {
    info.inner().clone()
}

/// `path` is already a resolved, absolute path — the window computed it
/// the same way it always has (`scf-host`'s `assets` module), and it
/// never crosses back out: the caller gets a handle, not the path.
#[tauri::command]
pub fn media_register_asset(handles: tauri::State<'_, Handles>, path: String) -> String {
    handles.register(path)
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
