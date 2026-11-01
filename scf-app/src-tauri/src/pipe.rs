// SPDX-License-Identifier: Apache-2.0
//! `scf-editor mcp [options]`: the SCF editor's MCP server, on stdio, for
//! an agent to start.
//!
//! The server itself runs in the editor's window (`mcp_relay.rs`); this
//! is a pipe to it, run by the same executable before any of the app
//! starts (`main.rs`), so one file is both the app and what an agent is
//! pointed at. It finds the running app through `mcp.json` in the app's
//! data folder, or starts it in the background (itself, with
//! `--background`) and waits for it, says who it is, and from then on
//! copies stdin to the app and the app's answers to stdout. Its options
//! are scf-mcp's own, and are the app's to judge; so are
//! SCF_MCP_READ_ONLY and SCF_MCP_ELICIT.
//!
//! A debug build is the developer's: it looks for the app `npm run dev`
//! runs (the `.dev` identifier, src-tauri/tauri.dev.json), and does not
//! start one, which would have no page without the dev server.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpStream};
use std::path::PathBuf;
use std::process::{Command, ExitCode, Stdio};
use std::time::{Duration, Instant};

/// The app's identifier (tauri.conf.json, tauri.dev.json), which names
/// its data folder.
const IDENTIFIER: &str = if cfg!(debug_assertions) {
    "com.minimalhumans.scf-editor.dev"
} else {
    "com.minimalhumans.scf-editor"
};

/// How long a started app has to be ready.
const START_TIMEOUT: Duration = Duration::from_secs(60);

/// How long a second launch waits for the running app to confirm it
/// raised its window, before concluding it is frozen. Longer than the
/// window's own `RAISE_TIMEOUT` (mcp_relay.rs), so its answer — even a
/// negative one — has time to arrive.
const RAISE_TIMEOUT: Duration = Duration::from_secs(5);

fn fail(message: impl std::fmt::Display) -> ExitCode {
    eprintln!("scf-editor: {message}");
    ExitCode::FAILURE
}

fn discovery_path() -> Option<PathBuf> {
    Some(dirs::data_dir()?.join(IDENTIFIER).join("mcp.json"))
}

/// Connected to the running app, and the token it wants.
fn connect() -> Option<(TcpStream, String)> {
    let text = std::fs::read(discovery_path()?).ok()?;
    let found: serde_json::Value = serde_json::from_slice(&text).ok()?;
    let port = u16::try_from(found["port"].as_u64()?).ok()?;
    let token = found["token"].as_str()?.to_string();
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let stream = TcpStream::connect_timeout(&addr, Duration::from_secs(2)).ok()?;
    Some((stream, token))
}

/// Ask an already-running app, if any, to raise its window. `None`
/// means none was found — safe to start one. `Some(true)` means it
/// confirmed. `Some(false)` means it is there (the socket accepted the
/// connection) but never confirmed — frozen, most likely — and this
/// process must not start a second engine on top of it regardless.
pub fn raise_existing() -> Option<bool> {
    let (stream, token) = connect()?;
    let _ = stream.set_read_timeout(Some(RAISE_TIMEOUT));
    let mut to_app = stream.try_clone().ok()?;
    let hello = serde_json::json!({ "token": token, "raise": true });
    if writeln!(to_app, "{hello}").is_err() {
        return Some(false);
    }
    let mut line = String::new();
    let ok = BufReader::new(stream).read_line(&mut line).is_ok_and(|n| n > 0)
        && serde_json::from_str::<serde_json::Value>(&line)
            .ok()
            .is_some_and(|v| v["ok"] == true);
    Some(ok)
}

/// Tell the person the running copy did not answer, since there is no
/// window of our own (nor, at this point, even an app) to put it on.
#[cfg(windows)]
pub fn alert_unresponsive() {
    windows::alert(
        "SCF Editor",
        "SCF Editor appears to be running already, but it did not \
         respond. Close it from Task Manager and try again.",
    );
}

#[cfg(not(windows))]
pub fn alert_unresponsive() {
    eprintln!("scf-editor: already running but not responding; close it and try again");
}

/// Start the app in the background, detached from this process: its
/// output must not land in the agent's protocol stream, and it outlives
/// this pipe.
fn start_app() -> std::io::Result<()> {
    let mut command = Command::new(std::env::current_exe()?);
    command
        .arg(crate::BACKGROUND)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
        windows::keep_stdio_to_ourselves();
    }
    #[cfg(unix)]
    {
        // Not in the agent's process group, whose signals are for us.
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    command.spawn().map(|_| ())
}

#[cfg(windows)]
mod windows {
    use std::ffi::c_void;

    #[link(name = "kernel32")]
    extern "system" {
        fn GetStdHandle(which: u32) -> *mut c_void;
        fn SetHandleInformation(handle: *mut c_void, mask: u32, flags: u32) -> i32;
        fn AttachConsole(process: u32) -> i32;
    }

    #[link(name = "user32")]
    extern "system" {
        fn MessageBoxW(
            hwnd: *mut c_void, text: *const u16, caption: *const u16, utype: u32,
        ) -> i32;
    }

    // STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE.
    const STDIO: [i32; 3] = [-10, -11, -12];
    const STD_OUTPUT_HANDLE: i32 = -11;
    const ATTACH_PARENT_PROCESS: u32 = u32::MAX;
    const HANDLE_FLAG_INHERIT: u32 = 1;
    const INVALID_HANDLE_VALUE: isize = -1;
    const MB_OK: u32 = 0x0000_0000;
    const MB_ICONERROR: u32 = 0x0000_0010;

    fn to_wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// A plain modal alert, for when there is no window of our own —
    /// nor, at this point, even an app — to put one on.
    pub fn alert(title: &str, message: &str) {
        let title = to_wide(title);
        let message = to_wide(message);
        // SAFETY: both buffers outlive the call, which is synchronous
        // and does not retain either pointer past it.
        unsafe {
            MessageBoxW(
                std::ptr::null_mut(), message.as_ptr(), title.as_ptr(), MB_OK | MB_ICONERROR,
            );
        }
    }

    /// Windows gives a child every inheritable handle its parent has, and
    /// this pipe's stdio is inheritable. Were the app to keep a copy of
    /// our stdout, the agent would not see it close until the app exits.
    pub fn keep_stdio_to_ourselves() {
        for which in STDIO {
            // SAFETY: both take any handle value, and fail harmlessly on
            // one that is not open.
            unsafe {
                SetHandleInformation(GetStdHandle(which as u32), HANDLE_FLAG_INHERIT, 0);
            }
        }
    }

    /// A release build is a windowed program, which Windows starts with
    /// no stdio unless its parent hands it some. An agent always does
    /// (pipes); a person typing `scf-editor mcp` in a terminal does not,
    /// so there the terminal's console is borrowed, and what this says
    /// (a usage error, say) is seen.
    pub fn use_a_console_if_not_piped() {
        // SAFETY: GetStdHandle only reads the process's handle table;
        // AttachConsole fails harmlessly when there is no parent console.
        unsafe {
            let out = GetStdHandle(STD_OUTPUT_HANDLE as u32);
            if out.is_null() || out as isize == INVALID_HANDLE_VALUE {
                AttachConsole(ATTACH_PARENT_PROCESS);
            }
        }
    }
}

fn connect_or_start() -> Result<(TcpStream, String), String> {
    if let Some(found) = connect() {
        return Ok(found);
    }
    if cfg!(debug_assertions) {
        return Err(
            "the SCF editor (dev) is not running; start it with `npm run dev` in scf-app".into(),
        );
    }
    start_app().map_err(|e| format!("could not start the SCF editor: {e}"))?;
    let deadline = Instant::now() + START_TIMEOUT;
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(200));
        if let Some(found) = connect() {
            return Ok(found);
        }
    }
    Err("the SCF editor did not start in time".into())
}

/// Be the pipe, with the arguments after `mcp`.
pub fn run(args: Vec<String>) -> ExitCode {
    #[cfg(windows)]
    windows::use_a_console_if_not_piped();

    let (stream, token) = match connect_or_start() {
        Ok(found) => found,
        Err(e) => return fail(e),
    };
    let _ = stream.set_nodelay(true);
    let cwd = std::env::current_dir()
        .map(|d| d.to_string_lossy().into_owned())
        .unwrap_or_default();
    let env = |name: &str| std::env::var(name).ok();
    let hello = serde_json::json!({
        "token": token,
        "args": args,
        "cwd": cwd,
        "readOnly": env("SCF_MCP_READ_ONLY").as_deref() == Some("1"),
        "elicit": env("SCF_MCP_ELICIT").as_deref() != Some("0"),
    });
    let mut to_app = match stream.try_clone() {
        Ok(s) => s,
        Err(e) => return fail(e),
    };
    if let Err(e) = writeln!(to_app, "{hello}") {
        return fail(format!("the SCF editor went away: {e}"));
    }

    // Its first line is whether it will serve us.
    let mut from_app = BufReader::new(stream);
    let mut answer = String::new();
    if from_app.read_line(&mut answer).unwrap_or(0) == 0 {
        return fail("the SCF editor closed the connection");
    }
    let answer: serde_json::Value = serde_json::from_str(&answer).unwrap_or_default();
    if answer["ok"] != true {
        let said = answer["error"].as_str().unwrap_or("the SCF editor refused");
        eprint!("{said}");
        if !said.ends_with('\n') {
            eprintln!();
        }
        return ExitCode::FAILURE;
    }

    // The agent's messages to the app, until the agent is done.
    std::thread::spawn(move || {
        let _ = std::io::copy(&mut std::io::stdin().lock(), &mut to_app);
        let _ = to_app.shutdown(Shutdown::Write);
    });

    // And the app's to the agent, each as soon as it comes.
    let mut out = std::io::stdout().lock();
    let mut buf = [0u8; 64 * 1024];
    loop {
        match from_app.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if out.write_all(&buf[..n]).and_then(|()| out.flush()).is_err() {
                    break;
                }
            }
        }
    }
    ExitCode::SUCCESS
}
