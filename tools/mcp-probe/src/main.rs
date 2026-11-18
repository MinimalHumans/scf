// SPDX-License-Identifier: Apache-2.0
//! `mcp-probe`: a throwaway MCP server on stdio, for finding out what an
//! agent (Claude Desktop, say) actually shows an executable it launches.
//!
//! Point the agent at it where it would point at `scf-editor mcp`:
//!
//!   "mcp-probe": { "command": "C:\\path\\to\\mcp-probe.exe", "args": ["mcp"] }
//!
//! and it writes one JSON line per event to a log (see `log_path`):
//!
//!   launch   once, when started: argv, cwd, the whole environment, the
//!            kind of handle each of stdin/stdout/stderr is, and the
//!            chain of parent processes
//!   in       every line the agent sends, verbatim, with its method, id
//!            and `params._meta` pulled out, plus the process's
//!            environment and cwd if they differ from the last message
//!   out      every line it answers with
//!   exit     when stdin closes, with how long it lived
//!
//! Every record carries `pid` and `launch` (an id for this process), so
//! two conversations are the same process if and only if those match —
//! which is the question this exists to answer. The log is shared by all
//! processes; each record is one `write`, so they interleave by line.
//!
//! The log holds the full environment, API keys included. It is for the
//! person running the test; do not commit or share it.
//!
//! stdout carries the protocol and nothing else; notes go to stderr, which
//! Claude Desktop keeps in `%APPDATA%\Claude\logs\mcp-server-<name>.log`.

use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Map, Value};

const VERSION: &str = env!("CARGO_PKG_VERSION");
/// Used when the agent's `initialize` names no version.
const FALLBACK_PROTOCOL: &str = "2025-06-18";

// ---------------------------------------------------------------------------
// Time

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis())
}

/// `2026-11-15T09:30:00.123Z`, without a date library.
fn iso(ms: u128) -> String {
    let secs = (ms / 1000) as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Days since 1970-01-01 to a civil date (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60,
        ms % 1000
    )
}

// ---------------------------------------------------------------------------
// The process's surroundings

type Env = BTreeMap<String, String>;

fn env_snapshot() -> Env {
    std::env::vars_os()
        .map(|(k, v)| (k.to_string_lossy().into_owned(), v.to_string_lossy().into_owned()))
        .collect()
}

/// FNV-1a over the sorted environment: enough to see that it changed.
fn env_hash(env: &Env) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for (k, v) in env {
        for b in k.bytes().chain([b'=']).chain(v.bytes()).chain([0]) {
            h ^= u64::from(b);
            h = h.wrapping_mul(0x0100_0000_01b3);
        }
    }
    format!("{h:016x}")
}

fn env_diff(old: &Env, new: &Env) -> Value {
    let added: Map<String, Value> =
        new.iter().filter(|(k, _)| !old.contains_key(*k)).map(|(k, v)| (k.clone(), json!(v))).collect();
    let removed: Vec<&String> = old.keys().filter(|k| !new.contains_key(*k)).collect();
    let changed: Map<String, Value> = new
        .iter()
        .filter(|(k, v)| old.get(*k).is_some_and(|o| o != *v))
        .map(|(k, v)| (k.clone(), json!({ "from": old[k], "to": v })))
        .collect();
    json!({ "added": added, "removed": removed, "changed": changed })
}

fn cwd() -> String {
    std::env::current_dir().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default()
}

#[cfg(windows)]
mod os {
    use serde_json::{json, Value};
    use std::collections::HashMap;
    use std::ffi::c_void;

    #[repr(C)]
    struct ProcessEntry32W {
        size: u32,
        usage: u32,
        process_id: u32,
        default_heap_id: usize,
        module_id: u32,
        threads: u32,
        parent_process_id: u32,
        pri_class_base: i32,
        flags: u32,
        exe_file: [u16; 260],
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetStdHandle(which: u32) -> *mut c_void;
        fn GetFileType(handle: *mut c_void) -> u32;
        fn GetConsoleMode(handle: *mut c_void, mode: *mut u32) -> i32;
        fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> *mut c_void;
        fn Process32FirstW(snapshot: *mut c_void, entry: *mut ProcessEntry32W) -> i32;
        fn Process32NextW(snapshot: *mut c_void, entry: *mut ProcessEntry32W) -> i32;
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
        fn QueryFullProcessImageNameW(
            process: *mut c_void, flags: u32, name: *mut u16, size: *mut u32,
        ) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }

    const INVALID_HANDLE_VALUE: isize = -1;
    const TH32CS_SNAPPROCESS: u32 = 2;
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;

    fn kind(which: i32) -> &'static str {
        // SAFETY: these only read the process's handle table or the handle's type.
        unsafe {
            let h = GetStdHandle(which as u32);
            if h.is_null() {
                return "none";
            }
            if h as isize == INVALID_HANDLE_VALUE {
                return "invalid";
            }
            match GetFileType(h) {
                1 => "file",
                2 => {
                    let mut mode = 0u32;
                    if GetConsoleMode(h, &mut mode) != 0 { "console" } else { "char device (nul?)" }
                }
                3 => "pipe",
                _ => "unknown",
            }
        }
    }

    /// What each of the standard handles is: a pipe is what an agent hands over.
    pub fn stdio() -> Value {
        json!({ "stdin": kind(-10), "stdout": kind(-11), "stderr": kind(-12) })
    }

    fn image_path(pid: u32) -> Option<String> {
        // SAFETY: the buffer outlives the call; the handle is closed after.
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if h.is_null() {
                return None;
            }
            let mut buf = vec![0u16; 4096];
            let mut size = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut size) != 0;
            CloseHandle(h);
            ok.then(|| String::from_utf16_lossy(&buf[..size as usize]))
        }
    }

    /// This process's parent, its parent, and so on, nearest first.
    pub fn ancestry() -> Value {
        let mut procs: HashMap<u32, (u32, String)> = HashMap::new();
        // SAFETY: the entry is sized as the API requires; the snapshot is closed after.
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snap.is_null() || snap as isize == INVALID_HANDLE_VALUE {
                return json!([]);
            }
            let mut e: ProcessEntry32W = std::mem::zeroed();
            e.size = std::mem::size_of::<ProcessEntry32W>() as u32;
            let mut more = Process32FirstW(snap, &mut e) != 0;
            while more {
                let end = e.exe_file.iter().position(|&c| c == 0).unwrap_or(e.exe_file.len());
                procs.insert(
                    e.process_id,
                    (e.parent_process_id, String::from_utf16_lossy(&e.exe_file[..end])),
                );
                more = Process32NextW(snap, &mut e) != 0;
            }
            CloseHandle(snap);
        }
        let mut chain = Vec::new();
        let mut at = std::process::id();
        while chain.len() < 8 {
            let Some((parent, _)) = procs.get(&at) else { break };
            let parent = *parent;
            // A parent that has exited can leave its pid to be reused: stop on a loop.
            if parent == 0 || parent == at || chain.iter().any(|c: &Value| c["pid"] == parent) {
                break;
            }
            let Some((_, name)) = procs.get(&parent) else {
                chain.push(json!({ "pid": parent, "name": null, "note": "no longer running" }));
                break;
            };
            chain.push(json!({ "pid": parent, "name": name, "path": image_path(parent) }));
            at = parent;
        }
        Value::Array(chain)
    }
}

#[cfg(not(windows))]
mod os {
    use serde_json::{json, Value};

    pub fn stdio() -> Value {
        json!({ "stdin": "unknown", "stdout": "unknown", "stderr": "unknown" })
    }

    pub fn ancestry() -> Value {
        #[cfg(unix)]
        return json!([{ "pid": std::os::unix::process::parent_id() }]);
        #[cfg(not(unix))]
        json!([])
    }
}

// ---------------------------------------------------------------------------
// The log

fn log_path() -> PathBuf {
    if let Some(p) = std::env::var_os("MCP_PROBE_LOG") {
        return PathBuf::from(p);
    }
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local").join("share")))
        .unwrap_or_else(std::env::temp_dir);
    base.join("mcp-probe").join("probe.jsonl")
}

struct Probe {
    log: Option<File>,
    path: PathBuf,
    pid: u32,
    launch: String,
    started: Instant,
    env: Env,
    cwd: String,
    /// Lines received; every `in`/`out` record is numbered by it.
    messages: u64,
    /// `tools/call` requests among them.
    calls: u64,
}

impl Probe {
    fn new() -> Self {
        let pid = std::process::id();
        let path = log_path();
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let log = OpenOptions::new().create(true).append(true).open(&path).ok();
        Self {
            log,
            path,
            pid,
            launch: format!("{pid}-{:x}", now_ms()),
            started: Instant::now(),
            env: env_snapshot(),
            cwd: cwd(),
            messages: 0,
            calls: 0,
        }
    }

    /// One line, in one `write`, so processes sharing the file interleave by line.
    fn record(&mut self, event: &str, fields: Value) {
        let mut line = Map::new();
        line.insert("ts".into(), json!(iso(now_ms())));
        line.insert("pid".into(), json!(self.pid));
        line.insert("launch".into(), json!(self.launch));
        line.insert("event".into(), json!(event));
        if let Value::Object(fields) = fields {
            line.extend(fields);
        }
        let mut text = Value::Object(line).to_string();
        text.push('\n');
        if let Some(log) = self.log.as_mut() {
            if log.write_all(text.as_bytes()).is_err() {
                self.log = None;
                eprintln!("mcp-probe: the log {} can no longer be written", self.path.display());
            }
        }
    }

    fn launch_record(&mut self) {
        let record = json!({
            "probeVersion": VERSION,
            "argv": std::env::args_os().map(|a| a.to_string_lossy().into_owned()).collect::<Vec<_>>(),
            "exe": std::env::current_exe().ok().map(|p| p.to_string_lossy().into_owned()),
            "cwd": self.cwd,
            "stdio": os::stdio(),
            "ancestry": os::ancestry(),
            "envHash": env_hash(&self.env),
            "env": self.env,
        });
        self.record("launch", record);
    }

    /// What the process's surroundings are now, if they are not what they
    /// were at the last message.
    fn surroundings_changed(&mut self) -> Value {
        let env = env_snapshot();
        let now_cwd = cwd();
        let mut changed = Map::new();
        if env != self.env {
            changed.insert("env".into(), env_diff(&self.env, &env));
            self.env = env;
        }
        if now_cwd != self.cwd {
            changed.insert("cwd".into(), json!({ "from": self.cwd, "to": now_cwd }));
            self.cwd = now_cwd;
        }
        Value::Object(changed)
    }
}

// ---------------------------------------------------------------------------
// The server

fn tool_list() -> Value {
    json!([
        {
            "name": "probe_whoami",
            "description": "Report which probe process answered this call, how it was \
                launched, and everything this request carried besides its arguments (`_meta`).",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "probe_echo",
            "description": "Echo the arguments and `_meta` of this call back, with the \
                process that answered. Pass anything.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "message": { "type": "string" },
                    "session_id": { "type": "string",
                                    "description": "The `session_id` that `open` returned for the film." },
                    "film_id": { "type": "string" }
                },
                "additionalProperties": true
            }
        },
        {
            "name": "probe_env",
            "description": "The names of the environment variables this process has, and \
                a hash of them. Values are in the log, not here, unless asked for by name.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "names": { "type": "array", "items": { "type": "string" },
                               "description": "Variables whose values to return." }
                }
            }
        }
    ])
}

/// The text of a successful tool result.
fn text_result(value: &Value) -> Value {
    let text = serde_json::to_string_pretty(value).unwrap_or_default();
    json!({ "content": [{ "type": "text", "text": text }], "isError": false })
}

fn error_response(id: &Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

impl Probe {
    fn who(&self, meta: &Value) -> Value {
        json!({
            "pid": self.pid,
            "launch": self.launch,
            "uptimeMs": self.started.elapsed().as_millis() as u64,
            "messagesSoFar": self.messages,
            "toolCallsSoFar": self.calls,
            "argv": std::env::args_os().map(|a| a.to_string_lossy().into_owned()).collect::<Vec<_>>(),
            "cwd": self.cwd,
            "ancestry": os::ancestry(),
            "requestMeta": meta,
            "log": self.path.to_string_lossy(),
        })
    }

    fn call_tool(&self, params: &Value) -> Value {
        let meta = params.get("_meta").cloned().unwrap_or(Value::Null);
        let args = params.get("arguments").cloned().unwrap_or(Value::Null);
        match params["name"].as_str().unwrap_or_default() {
            "probe_whoami" => text_result(&self.who(&meta)),
            "probe_echo" => {
                text_result(&json!({ "arguments": args, "requestMeta": meta, "answeredBy": self.who(&Value::Null) }))
            }
            "probe_env" => {
                let wanted: Vec<&str> = args["names"]
                    .as_array()
                    .map(|a| a.iter().filter_map(Value::as_str).collect())
                    .unwrap_or_default();
                let values: Map<String, Value> = wanted
                    .iter()
                    .map(|n| (n.to_string(), self.env.get(*n).map_or(Value::Null, |v| json!(v))))
                    .collect();
                text_result(&json!({
                    "count": self.env.len(),
                    "hash": env_hash(&self.env),
                    "names": self.env.keys().collect::<Vec<_>>(),
                    "values": values,
                }))
            }
            other => json!({
                "content": [{ "type": "text", "text": format!("no such tool: {other}") }],
                "isError": true
            }),
        }
    }

    /// The answer to one message, if it wants one.
    fn handle(&mut self, message: &Value) -> Option<Value> {
        let method = message["method"].as_str()?;
        let id = message.get("id").filter(|id| !id.is_null())?;
        let params = &message["params"];
        let result = match method {
            "initialize" => json!({
                "protocolVersion": params["protocolVersion"].as_str().unwrap_or(FALLBACK_PROTOCOL),
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "mcp-probe", "version": VERSION },
            }),
            "ping" => json!({}),
            "tools/list" => json!({ "tools": tool_list() }),
            "tools/call" => {
                self.calls += 1;
                self.call_tool(params)
            }
            _ => return Some(error_response(id, -32601, &format!("method not found: {method}"))),
        };
        Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
    }
}

/// What is worth seeing of a message at a glance; `raw` has the rest.
fn summary(message: &Value) -> Value {
    let params = &message["params"];
    let mut s = Map::new();
    for key in ["method", "id"] {
        if let Some(v) = message.get(key) {
            s.insert(key.into(), v.clone());
        }
    }
    if let Some(meta) = params.get("_meta") {
        s.insert("meta".into(), meta.clone());
    }
    if let Some(keys) = params.as_object().map(|p| p.keys().collect::<Vec<_>>()) {
        s.insert("paramsKeys".into(), json!(keys));
    }
    if let Some(name) = params.get("name") {
        s.insert("tool".into(), name.clone());
    }
    if message["method"] == "initialize" {
        for key in ["protocolVersion", "clientInfo", "capabilities"] {
            if let Some(v) = params.get(key) {
                s.insert(key.into(), v.clone());
            }
        }
    }
    Value::Object(s)
}

fn main() -> ExitCode {
    let mut probe = Probe::new();
    probe.launch_record();
    eprintln!(
        "mcp-probe: pid {}, launch {}, logging to {}",
        probe.pid,
        probe.launch,
        probe.path.display()
    );

    let stdin = std::io::stdin();
    let mut stdin = stdin.lock();
    let mut stdout = std::io::stdout().lock();
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match stdin.read_until(b'\n', &mut buf) {
            Ok(0) => {
                probe.record("exit", json!({ "reason": "stdin closed", "uptimeMs": probe.started.elapsed().as_millis() as u64, "messages": probe.messages, "toolCalls": probe.calls }));
                return ExitCode::SUCCESS;
            }
            Err(e) => {
                probe.record("exit", json!({ "reason": format!("stdin error: {e}"), "messages": probe.messages }));
                return ExitCode::FAILURE;
            }
            Ok(_) => {}
        }
        let raw = String::from_utf8_lossy(&buf).trim_end_matches(['\r', '\n']).to_string();
        if raw.trim().is_empty() {
            continue;
        }
        probe.messages += 1;
        let seq = probe.messages;
        let parsed: Result<Value, _> = serde_json::from_str(&raw);

        let mut record = json!({ "seq": seq, "bytes": buf.len(), "raw": raw });
        let changed = probe.surroundings_changed();
        if changed.as_object().is_some_and(|c| !c.is_empty()) {
            record["surroundingsChanged"] = changed;
        }
        let mut replies = Vec::new();
        match &parsed {
            Ok(Value::Array(batch)) => {
                record["summary"] = batch.iter().map(summary).collect();
                replies.extend(batch.iter().filter_map(|m| probe.handle(m)));
            }
            Ok(message) => {
                record["summary"] = summary(message);
                replies.extend(probe.handle(message));
            }
            Err(e) => {
                record["parseError"] = json!(e.to_string());
                replies.push(error_response(&Value::Null, -32700, "parse error"));
            }
        }
        probe.record("in", record);

        for reply in replies {
            let text = reply.to_string();
            probe.record("out", json!({ "seq": seq, "raw": text }));
            if writeln!(stdout, "{text}").and_then(|()| stdout.flush()).is_err() {
                probe.record("exit", json!({ "reason": "stdout closed", "messages": probe.messages }));
                return ExitCode::FAILURE;
            }
        }
    }
}
