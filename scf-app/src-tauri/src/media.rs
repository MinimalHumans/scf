// SPDX-License-Identifier: Apache-2.0
//! The bridge to `media-core`'s backend detection (Phase 1 of
//! docs/media-server-spec.md). No settings live here: `overrides` is
//! whatever the window already read from `scf-host`'s `pref` table —
//! this module never opens `app.db` itself (see the plan's note on
//! keeping that contract in one place).
//!
//! `media_core::Backends` (Phase 3) is the longer-lived "currently
//! known good paths" registry `media-server`'s `/meta` route reads
//! from — this module is the only writer, updating it after every
//! detection run so the HTTP side never has to re-run discovery itself.

use std::collections::HashMap;

use media_core::{Backends, BackendStatus};

/// Detect and validate ffmpeg/ffprobe/magick/oiiotool. Spawns four to
/// eight short-lived processes, so it runs off the async runtime that
/// also drives `sql_socket`/`mcp_relay` — otherwise a slow probe (or,
/// worst case, a hung one at a user-configured override path) would
/// stall them too.
#[tauri::command]
pub async fn media_detect_backends(
    backends: tauri::State<'_, Backends>,
    overrides: HashMap<String, String>,
) -> Result<Vec<BackendStatus>, String> {
    let shared = backends.inner().clone();
    let statuses = tauri::async_runtime::spawn_blocking(move || media_core::detect_all(&overrides))
        .await
        .map_err(|e| e.to_string())?;
    shared.update_from(&statuses);
    Ok(statuses)
}

/// Detect once at startup, off the main thread, without making the
/// window wait on it — `/meta` calls before this finishes just see "no
/// ffprobe configured" for a moment, which is an honest, non-breaking
/// transient state, not worth delaying the window over.
pub fn detect_at_startup(backends: Backends) {
    tauri::async_runtime::spawn(async move {
        let statuses = tauri::async_runtime::spawn_blocking(|| {
            media_core::detect_all(&HashMap::new())
        }).await;
        if let Ok(statuses) = statuses {
            backends.update_from(&statuses);
        }
    });
}
