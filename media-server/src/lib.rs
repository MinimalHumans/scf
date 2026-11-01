// SPDX-License-Identifier: Apache-2.0
//! media-server — the loopback HTTP side of the media server
//! (docs/media-server-spec.md §2, §4). No Tauri or webview dependency:
//! `scf-app/src-tauri/src/media_server.rs` is what turns the future
//! [`start`] returns into a running task, mirroring `sql_socket.rs`'s
//! shape without this crate depending on Tauri's runtime.
//!
//! Phase 2 only: raw passthrough with Range support, token and Host
//! checks. No probing, no conversion, no queue — see the spec's phase
//! list and the plan this was built from.

mod handles;
mod serve;

use std::future::Future;

use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::Request;
use hyper_util::rt::TokioIo;
use serde::Serialize;
use tokio::net::TcpListener;

pub use handles::Handles;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub url: String,
    pub token: String,
}

fn new_token() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("randomness for a token");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Binds a free loopback port and returns the info the frontend needs,
/// the shared handle registry (so the caller can expose a "register"
/// command over it), and the accept loop as a bare future. The caller
/// decides how to drive that future — `tauri::async_runtime::spawn` in
/// the app, a plain `tokio::spawn` for any other host, per the spec's
/// own note that this crate is the seam a differently-hosted media
/// server reuses.
pub fn start() -> std::io::Result<(ServerInfo, Handles, impl Future<Output = ()>)> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    listener.set_nonblocking(true)?;
    let port = listener.local_addr()?.port();
    let token = new_token();
    let handles = Handles::default();

    let info = ServerInfo { url: format!("http://127.0.0.1:{port}"), token: token.clone() };
    let ctx = serve::Context { port, token, handles: handles.clone() };

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

    Ok((info, handles, accept))
}
