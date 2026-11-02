// SPDX-License-Identifier: Apache-2.0
//! Reads Settings > Media's global knobs (`scf-app/src/state/settings.
//! ts`) straight out of `app.db`'s `pref` table at process startup —
//! before `media_server::start` is called in `lib.rs`'s `run()`, which
//! happens before any `AppHandle` exists (same reason `pipe.rs`'s own
//! discovery file uses `dirs::data_dir()` directly rather than `app.
//! path().app_data_dir()`). `app.db` itself is otherwise only ever
//! opened from the frontend (`scf-host`'s `appStore.ts`, over its own
//! loopback SQL socket) — this is a second, read-only, best-effort
//! connection to the same file, used only for this one startup read.
//!
//! A worker-thread count only ever takes effect at the next launch (a
//! tokio `Semaphore` can't shrink live — see `media-server`'s
//! `queue.rs`), which is exactly what reading it here, once, at process
//! start, gives for free. `resolution_cap`/`cache_limit_bytes` are read
//! here too, as the right starting point, but stay live-updatable after
//! that via `media_set_runtime_settings` (`media_server.rs`), which
//! `settings.ts`'s setters call right after writing the same pref.

use media_server::MediaServerConfig;
use rusqlite::{Connection, OpenFlags};

const VIDEO_WORKERS_PREF: &str = "mediaVideoWorkers";
const STILL_WORKERS_PREF: &str = "mediaStillWorkers";
const PROXY_RESOLUTION_PREF: &str = "mediaProxyResolution";
const CACHE_LIMIT_GB_PREF: &str = "mediaCacheLimitGb";

fn read_pref(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM pref WHERE key = ?1", [key], |row| row.get(0)).ok()
}

/// Never fails outright: a missing `app.db` (first run), a missing
/// `pref` table (older `app.db`, never touched by this feature yet), or
/// a value that doesn't parse all fall back to [`MediaServerConfig`]'s
/// own defaults field by field, same as `settings.ts`'s own `load()`
/// treats an absent pref as "use the default," not an error.
pub fn load_startup_config() -> MediaServerConfig {
    let defaults = MediaServerConfig::default();
    let Some(path) = dirs::data_dir().map(|d| d.join(crate::pipe::IDENTIFIER).join("app.db")) else {
        return defaults;
    };
    let Ok(conn) = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY) else {
        return defaults;
    };

    let video_workers = read_pref(&conn, VIDEO_WORKERS_PREF)
        .and_then(|v| v.parse().ok()).unwrap_or(defaults.video_workers);
    let still_workers = read_pref(&conn, STILL_WORKERS_PREF)
        .and_then(|v| v.parse().ok()).unwrap_or(defaults.still_workers);
    let resolution_cap = read_pref(&conn, PROXY_RESOLUTION_PREF)
        .and_then(|v| v.parse().ok()).unwrap_or(defaults.resolution_cap);
    let cache_limit_bytes = read_pref(&conn, CACHE_LIMIT_GB_PREF)
        .and_then(|v| v.parse::<f64>().ok())
        .map(|gb| (gb * 1024.0 * 1024.0 * 1024.0) as u64)
        .unwrap_or(defaults.cache_limit_bytes);

    MediaServerConfig { video_workers, still_workers, resolution_cap, cache_limit_bytes }
}
