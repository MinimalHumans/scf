// SPDX-License-Identifier: Apache-2.0
//! The bridge to `media-core`'s backend detection (Phase 1 of
//! docs/media-server-spec.md). No settings live here: `overrides` is
//! whatever the window already read from `scf-host`'s `pref` table —
//! this module never opens `app.db` itself (see the plan's note on
//! keeping that contract in one place).

use std::collections::HashMap;

use media_core::BackendStatus;

/// Detect and validate ffmpeg/ffprobe/magick/oiiotool. Spawns four to
/// eight short-lived processes, so it runs off the async runtime that
/// also drives `sql_socket`/`mcp_relay` — otherwise a slow probe (or,
/// worst case, a hung one at a user-configured override path) would
/// stall them too.
#[tauri::command]
pub async fn media_detect_backends(
    overrides: HashMap<String, String>,
) -> Result<Vec<BackendStatus>, String> {
    tauri::async_runtime::spawn_blocking(move || media_core::detect_all(&overrides))
        .await
        .map_err(|e| e.to_string())
}
