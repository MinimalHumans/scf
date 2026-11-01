// SPDX-License-Identifier: Apache-2.0
//! The bridge to `media-server`'s loopback HTTP listener (Phase 2 of
//! docs/media-server-spec.md). Mirrors `sql_socket.rs`'s shape: a
//! `start()` that binds a free port and spawns the accept loop on
//! Tauri's own async runtime (which `media-server` itself never
//! touches, so it stays usable outside Tauri), plus commands over the
//! resulting shared state.

use media_server::{Handles, ServerInfo};

/// Bind the server and spawn its accept loop. Call once, at startup,
/// same as `sql_socket::start`.
pub fn start() -> std::io::Result<(ServerInfo, Handles)> {
    let (info, handles, accept) = media_server::start()?;
    tauri::async_runtime::spawn(accept);
    Ok((info, handles))
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
