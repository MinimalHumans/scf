// SPDX-License-Identifier: Apache-2.0
//! media-server — the loopback HTTP side of the media server
//! (docs/media-server-spec.md §2, §4). No Tauri or webview dependency:
//! `scf-app/src-tauri/src/media_server.rs` is what turns the future
//! [`start`] returns into a running task, mirroring `sql_socket.rs`'s
//! shape without this crate depending on Tauri's runtime.
//!
//! `/media` is raw passthrough with Range support (Phase 2), now
//! branching on a probe+verdict for anything ffprobe can read: a
//! cache hit is served, a miss is queued and answered `202` (Phase 4).
//! `/meta` adds ffprobe-based technical facts and the same verdict,
//! informationally, for `AssetFileFacts` (Phase 3). Still images
//! (EXR/TIFF/PSD/HEIC/DPX) get the same cache/queue treatment via
//! oiiotool/magick instead of ffmpeg (Phase 5). Every `/media` request
//! now also records which project(s) asked for it and enforces that
//! project's quota (Phase 6), and `/jobs/<id>/retry` clears a failed
//! job's negative-cache entry. `/jobs` (no id, Phase 7) is the
//! dashboard's own route: the recent job list, redacted of any
//! absolute path, plus worker slot usage.

mod handles;
mod queue;
mod serve;

use std::future::Future;
use std::path::PathBuf;

use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::Request;
use hyper_util::rt::TokioIo;
use serde::Serialize;
use tokio::net::TcpListener;

pub use handles::Handles;
pub use queue::{QueueConfig, Queue, RuntimeSettings, WorkerStatus};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub url: String,
    pub token: String,
}

/// Everything about the media pipeline Settings > Media lets a user
/// change, gathered into one value the caller (`scf-app/src-tauri`'s
/// startup) builds once, from whatever it finds persisted in app.db, and
/// hands to [`start`]. `video_workers`/`still_workers` are read once,
/// into `Queue`'s semaphores, and only take effect at the next launch
/// (a tokio `Semaphore` has no clean way to shrink at runtime);
/// `resolution_cap`/`cache_limit_bytes` seed a [`RuntimeSettings`] the
/// caller can keep updating live after `start` returns.
#[derive(Clone, Copy)]
pub struct MediaServerConfig {
    pub video_workers: usize,
    pub still_workers: usize,
    pub resolution_cap: u32,
    pub cache_limit_bytes: u64,
}

impl Default for MediaServerConfig {
    fn default() -> Self {
        let q = QueueConfig::default();
        MediaServerConfig {
            video_workers: q.video_workers,
            still_workers: q.still_workers,
            resolution_cap: 1080,
            cache_limit_bytes: media_core::DEFAULT_VIDEO_CAP_BYTES + media_core::DEFAULT_STILL_CAP_BYTES,
        }
    }
}

fn new_token() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("randomness for a token");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Binds a free loopback port and returns the info the frontend needs,
/// the shared handle registry (so the caller can expose a "register"
/// command over it), the shared capability-report registry (so the
/// caller can expose a "report" command over it — `backends` is passed
/// in rather than returned, since the Phase 1 detection command already
/// owns that one), the shared [`Queue`] (Phase 6: so the caller can
/// expose flush/stats commands over its [`media_core::Cache`] — cheap
/// to clone, same as the other three), and the accept loop as a bare
/// future. The caller decides how to drive that future — `tauri::
/// async_runtime::spawn` in the app, a plain `tokio::spawn` for any
/// other host, per the spec's own note that this crate is the seam a
/// differently-hosted media server reuses.
pub fn start(
    backends: media_core::Backends,
    cache_dir: PathBuf,
    config: MediaServerConfig,
) -> std::io::Result<(ServerInfo, Handles, media_core::Capabilities, Queue, impl Future<Output = ()>)> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    listener.set_nonblocking(true)?;
    let port = listener.local_addr()?.port();
    let token = new_token();
    let handles = Handles::default();
    let capabilities = media_core::Capabilities::default();
    let probe_cache = media_core::ProbeCache::default();
    let still_probe_cache = media_core::StillProbeCache::default();
    let cache = media_core::Cache::open(cache_dir.join("media"))
        .map_err(|e| std::io::Error::other(e.to_string()))?;
    let queue_config = QueueConfig { video_workers: config.video_workers, still_workers: config.still_workers };
    let runtime = RuntimeSettings::new(config.resolution_cap, config.cache_limit_bytes);
    let queue = Queue::new(cache, queue_config, runtime);

    let info = ServerInfo { url: format!("http://127.0.0.1:{port}"), token: token.clone() };
    let ctx = serve::Context {
        port, token, handles: handles.clone(), backends,
        capabilities: capabilities.clone(), probe_cache, still_probe_cache, queue: queue.clone(),
    };

    let accept = async move {
        let listener = TcpListener::from_std(listener).expect("loopback listener");
        loop {
            let Ok((stream, _)) = listener.accept().await else { continue };
            let _ = stream.set_nodelay(true);
            let ctx = ctx.clone();
            tokio::spawn(async move {
                let io = TokioIo::new(stream);
                let service = service_fn(move |req: Request<Incoming>| {
                    let ctx = ctx.clone();
                    async move { serve::handle(req, ctx).await }
                });
                let _ = http1::Builder::new().serve_connection(io, service).await;
            });
        }
    };

    Ok((info, handles, capabilities, queue, accept))
}
