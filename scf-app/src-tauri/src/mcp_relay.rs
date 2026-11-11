// SPDX-License-Identifier: Apache-2.0
//! The MCP's way into the app: each agent's stdio pipe (`scf-editor
//! mcp`, `pipe.rs`) connects here, and its lines are handed to the
//! window, which runs an MCP server for it beside the host
//! (`src/mcp/windowMcp.ts`).
//!
//! Lines, not parsed: an MCP message on stdio is one line of JSON, and
//! the window is what understands it. A pipe first says who it is,
//!
//!   → { "token": "…", "args": […], "cwd": "…", "readOnly": false, "elicit": true }
//!
//! and the window answers `{ "ok": true }` or `{ "error": "…" }` before
//! anything else. Where to connect, and the token, are in `mcp.json` in
//! the app's data folder, which only the user can read.
//!
//! A pipe that arrives before the window is listening waits for it. A
//! page that reloads (a developer's F5, or Vite's) loses the servers it
//! was running, but not the pipes: the new page is told of each again,
//! `resumed`, with what brings its new server to where the agent thinks
//! it is (`replay`): the MCP handshake, and the `open` and `set_root`
//! calls that chose its film and roots. A request in flight at the
//! reload goes unanswered.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot};

/// What `mcp.json` says.
#[derive(Serialize)]
pub struct Discovery {
    pub port: u16,
    pub token: String,
    pub pid: u32,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Hello {
    token: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    cwd: String,
    #[serde(default)]
    read_only: bool,
    #[serde(default = "yes")]
    elicit: bool,
    /// Not an agent at all: a second launch of the app asking this one
    /// to raise its window, and prove — by actually doing it — that its
    /// main thread is still alive. No session is added for this.
    #[serde(default)]
    raise: bool,
    /// A file this second launch was given to open (a `.scf`
    /// double-click), passed along with `raise`.
    #[serde(default)]
    open: Option<String>,
}

fn yes() -> bool {
    true
}

/// What the window hears.
#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum McpEvent {
    #[serde(rename_all = "camelCase")]
    Open {
        session: u32,
        args: Vec<String>,
        cwd: String,
        read_only: bool,
        elicit: bool,
        /// Told before, to a page that has since gone.
        resumed: bool,
        /// The agent's handshake and state, to replay to a resumed server.
        replay: Vec<String>,
    },
    Message {
        session: u32,
        line: String,
    },
    Closed {
        session: u32,
    },
}

enum Out {
    Line(String),
    End,
}

struct Session {
    out: mpsc::UnboundedSender<Out>,
    hello: Hello,
    /// The agent's `initialize` and `initialized`, as it sent them.
    handshake: Vec<String>,
    /// Its latest calls that set a server's state (`STATEFUL`).
    state: Vec<String>,
    /// Told to a listener; until then its events wait in `held`.
    announced: bool,
    held: Vec<McpEvent>,
}

impl Session {
    fn open(&self, session: u32, resumed: bool) -> McpEvent {
        McpEvent::Open {
            session,
            args: self.hello.args.clone(),
            cwd: self.hello.cwd.clone(),
            read_only: self.hello.read_only,
            elicit: self.hello.elicit,
            resumed,
            replay: if resumed {
                [&self.handshake[..], &self.state[..]].concat()
            } else {
                Vec::new()
            },
        }
    }
}

/// The tools whose calls are a server's state: which film, which roots.
const STATEFUL: [&str; 2] = ["open", "set_root"];
/// How many of those calls are kept; the latest win.
const STATE_KEPT: usize = 32;

enum Kept {
    Handshake,
    State,
    No,
}

/// Is this line one to replay to a resumed server?
fn kept(line: &str) -> Kept {
    let Ok(m) = serde_json::from_str::<serde_json::Value>(line) else {
        return Kept::No;
    };
    match m["method"].as_str() {
        Some("initialize" | "notifications/initialized") => Kept::Handshake,
        Some("tools/call")
            if m["params"]["name"]
                .as_str()
                .is_some_and(|n| STATEFUL.contains(&n)) =>
        {
            Kept::State
        }
        _ => Kept::No,
    }
}

#[derive(Default)]
struct Inner {
    next: u32,
    listener: Option<Channel<McpEvent>>,
    sessions: HashMap<u32, Session>,
}

type OnCount = Box<dyn Fn(usize) + Send>;
/// Puts a window-raise on the app's main thread, calling back once it
/// has actually run there — the only way to tell a frozen main thread
/// from one that is merely slow.
type Raiser = Arc<dyn Fn(Option<String>, Box<dyn FnOnce() + Send>) + Send + Sync>;

/// The pipes connected now. Cheap to clone; every clone is the same.
#[derive(Clone)]
pub struct Relay {
    inner: Arc<Mutex<Inner>>,
    /// Called with the number of pipes whenever one comes or goes.
    on_count: Arc<Mutex<Option<OnCount>>>,
    /// Since when there has been no pipe; none while there is one.
    idle_since: Arc<Mutex<Option<Instant>>>,
    /// Set once the window exists (lib.rs's `setup`); unset briefly
    /// before that, when a `raise` can only fail.
    raiser: Arc<Mutex<Option<Raiser>>>,
}

impl Relay {
    pub fn new() -> Self {
        Self {
            inner: Arc::default(),
            on_count: Arc::default(),
            idle_since: Arc::new(Mutex::new(Some(Instant::now()))),
            raiser: Arc::default(),
        }
    }

    pub fn count(&self) -> usize {
        self.inner.lock().unwrap().sessions.len()
    }

    /// How long there has been no pipe, if there is none now.
    pub fn idle_for(&self) -> Option<Duration> {
        self.idle_since.lock().unwrap().map(|t| t.elapsed())
    }

    pub fn on_count(&self, f: impl Fn(usize) + Send + 'static) {
        *self.on_count.lock().unwrap() = Some(Box::new(f));
    }

    pub fn set_raiser(
        &self, f: impl Fn(Option<String>, Box<dyn FnOnce() + Send>) + Send + Sync + 'static,
    ) {
        *self.raiser.lock().unwrap() = Some(Arc::new(f));
    }

    fn raiser(&self) -> Option<Raiser> {
        self.raiser.lock().unwrap().clone()
    }

    fn counted(&self) {
        let n = self.count();
        {
            let mut idle = self.idle_since.lock().unwrap();
            *idle = match (n, *idle) {
                (0, None) => Some(Instant::now()),
                (0, since) => since,
                _ => None,
            };
        }
        if let Some(f) = self.on_count.lock().unwrap().as_ref() {
            f(n);
        }
    }

    /// Tell the window, or hold it for when there is one.
    fn emit(&self, session: u32, event: McpEvent) {
        let mut inner = self.inner.lock().unwrap();
        let listener = inner.listener.clone();
        let Some(s) = inner.sessions.get_mut(&session) else {
            return;
        };
        match listener {
            Some(channel) if s.announced => {
                let _ = channel.send(event);
            }
            _ => s.held.push(event),
        }
    }

    fn add(&self, out: mpsc::UnboundedSender<Out>, hello: Hello) -> u32 {
        let id = {
            let mut inner = self.inner.lock().unwrap();
            inner.next += 1;
            let id = inner.next;
            let session = Session {
                out,
                hello,
                handshake: Vec::new(),
                state: Vec::new(),
                announced: false,
                held: Vec::new(),
            };
            let open = session.open(id, false);
            inner.sessions.insert(id, session);
            inner.sessions.get_mut(&id).unwrap().held.push(open);
            id
        };
        self.counted();
        id
    }

    fn announce_held(&self) {
        let mut inner = self.inner.lock().unwrap();
        let Some(channel) = inner.listener.clone() else {
            return;
        };
        for s in inner.sessions.values_mut().filter(|s| !s.announced) {
            s.announced = true;
            for event in s.held.drain(..) {
                let _ = channel.send(event);
            }
        }
    }

    fn remove(&self, session: u32) {
        let gone = self.inner.lock().unwrap().sessions.remove(&session);
        if let Some(s) = gone {
            let _ = s.out.send(Out::End);
            self.counted();
        }
    }

    /// A line from the agent, kept as well if it is one to replay.
    fn received(&self, session: u32, line: String) {
        if let Some(s) = self.inner.lock().unwrap().sessions.get_mut(&session) {
            match kept(&line) {
                Kept::Handshake if s.handshake.len() < 2 => s.handshake.push(line.clone()),
                Kept::State => {
                    s.state.push(line.clone());
                    if s.state.len() > STATE_KEPT {
                        s.state.remove(0);
                    }
                }
                _ => {}
            }
        }
        self.emit(session, McpEvent::Message { session, line });
    }

    /// A pipe has gone: forget it, and tell the window if it knew.
    fn closed(&self, session: u32) {
        let gone = self.inner.lock().unwrap().sessions.remove(&session);
        let Some(s) = gone else { return };
        if s.announced {
            if let Some(channel) = self.inner.lock().unwrap().listener.clone() {
                let _ = channel.send(McpEvent::Closed { session });
            }
        }
        self.counted();
    }
}

async fn serve(relay: Relay, stream: TcpStream, token: Arc<String>) {
    let (read, mut write) = stream.into_split();
    let mut lines = BufReader::new(read).lines();
    let hello = tokio::time::timeout(Duration::from_secs(10), lines.next_line()).await;
    let Ok(Ok(Some(hello))) = hello else { return };
    let Ok(hello) = serde_json::from_str::<Hello>(&hello) else {
        return;
    };
    if hello.token != *token {
        return;
    }

    if hello.raise {
        let ok = raise_window(&relay, hello.open.clone()).await;
        let reply = serde_json::json!({ "ok": ok }).to_string();
        let _ = write.write_all(reply.as_bytes()).await;
        let _ = write.write_all(b"\n").await;
        let _ = write.shutdown().await;
        return;
    }

    let (out, mut outgoing) = mpsc::unbounded_channel();
    let session = relay.add(out, hello);
    tauri::async_runtime::spawn(async move {
        while let Some(Out::Line(line)) = outgoing.recv().await {
            if write.write_all(line.as_bytes()).await.is_err()
                || write.write_all(b"\n").await.is_err()
            {
                break;
            }
        }
        let _ = write.shutdown().await;
    });

    relay.announce_held();
    while let Ok(Some(line)) = lines.next_line().await {
        relay.received(session, line);
    }
    relay.closed(session);
}

/// How long the window has to prove, on its own main thread, that it
/// raised itself — not just that the request reached it.
const RAISE_TIMEOUT: Duration = Duration::from_secs(3);

/// Ask the window to raise itself, and wait for it to actually have
/// done so. `false` means either no window exists yet or its main
/// thread never got back to us in time — frozen, most likely.
async fn raise_window(relay: &Relay, open: Option<String>) -> bool {
    let Some(raiser) = relay.raiser() else { return false };
    let (tx, rx) = oneshot::channel();
    raiser(open, Box::new(move || {
        let _ = tx.send(());
    }));
    tokio::time::timeout(RAISE_TIMEOUT, rx).await.is_ok()
}

/// Listen on a free loopback port. What `mcp.json` should say comes back.
pub fn start(relay: Relay) -> std::io::Result<Discovery> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    listener.set_nonblocking(true)?;
    let discovery = Discovery {
        port: listener.local_addr()?.port(),
        token: crate::token::new()?,
        pid: std::process::id(),
    };
    let token = Arc::new(discovery.token.clone());
    tauri::async_runtime::spawn(async move {
        let listener = TcpListener::from_std(listener).expect("loopback listener");
        while let Ok((stream, _)) = listener.accept().await {
            let _ = stream.set_nodelay(true);
            tauri::async_runtime::spawn(serve(relay.clone(), stream, token.clone()));
        }
    });
    Ok(discovery)
}

/// The window is ready for pipes: those waiting are announced, and those
/// a page before it was serving (a reload) are announced again.
#[tauri::command]
pub fn mcp_listen(relay: tauri::State<'_, Relay>, events: Channel<McpEvent>) {
    {
        let mut inner = relay.inner.lock().unwrap();
        inner.listener = Some(events);
        for (id, s) in inner.sessions.iter_mut().filter(|(_, s)| s.announced) {
            s.announced = false;
            s.held = vec![s.open(*id, true)];
        }
    }
    relay.announce_held();
}

#[tauri::command]
pub fn mcp_send(relay: tauri::State<'_, Relay>, session: u32, line: String) {
    if let Some(s) = relay.inner.lock().unwrap().sessions.get(&session) {
        let _ = s.out.send(Out::Line(line));
    }
}

/// End a pipe, after whatever was sent to it.
#[tauri::command]
pub fn mcp_close(relay: tauri::State<'_, Relay>, session: u32) {
    relay.remove(session);
}
