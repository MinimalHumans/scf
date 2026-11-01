// SPDX-License-Identifier: Apache-2.0
//! The desktop shell: a window, and what its host runs on.
//!
//! The window runs the host core itself (`src/host/windowHost.ts`); the
//! shell gives it SQLite (`sql`, `sql_socket`), files (`files`) and its
//! settings (`host_setup`). Agents reach it through `scf-editor mcp`,
//! this same executable as a stdio pipe (`pipe`), whose lines the shell
//! relays to the window (`mcp_relay`).
//!
//! An agent can start the app: the pipe runs it with `--background`, and
//! the window stays hidden. The app then lives as long as some agent is
//! connected, and exits a little after the last one goes, unless a person
//! has opened the window, which keeps it until they quit.
//!
//! The app has a tray icon, so a hidden app can be seen and reached: it
//! says how many assistants are connected, opens the window on a click,
//! and quits from its menu (and from File > Exit). Closing the window
//! leaves the app in the tray rather than ending it.

mod files;
mod mcp_relay;
mod media;
mod media_server;
mod pipe;
mod sql;
mod sql_socket;
mod token;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Serialize;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

/// What the window's own host is given (`src/host/windowHost.ts`).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostSetup {
    /// Folders `create`/`saveAs` are confined to, from `SCF_HOST_ROOTS`.
    /// Empty (the default) means unconfined — the normal case, since
    /// paths come from the shell's own dialogs now.
    roots: Vec<String>,
    /// Where snapshots and the journal are kept.
    data_dir: String,
    version: String,
}

#[tauri::command]
fn host_setup(app: AppHandle) -> Result<HostSetup, String> {
    // The desktop app has full machine access (file-management-plan.md
    // decision 1): no folder confinement by default, now that native
    // dialogs (not the host's own `list`) are how a path is picked.
    // `SCF_HOST_ROOTS` remains an opt-in restriction, for a sandboxed
    // manual run or a future automated UI test.
    let roots: Vec<PathBuf> = match std::env::var_os("SCF_HOST_ROOTS") {
        Some(v) if !v.is_empty() => std::env::split_paths(&v)
            .filter(|p| !p.as_os_str().is_empty())
            .collect(),
        _ => Vec::new(),
    };
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let text = |p: PathBuf| p.to_string_lossy().into_owned();
    Ok(HostSetup {
        roots: roots.into_iter().map(text).collect(),
        data_dir: text(data_dir),
        version: app.package_info().version.to_string(),
    })
}

/// What the pipe passes when it starts the app.
const BACKGROUND: &str = "--background";

/// How long a pipe-started app waits for its pipe, and a hidden app
/// whose last pipe has gone waits for another (an agent restarting its
/// servers), before it exits.
const LINGER: Duration = Duration::from_secs(20);

fn main_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    app.get_webview_window("main")
}

/// Whether a person has had the window up. An app an agent started and
/// nobody has opened leaves when it is unused; one that has been seen
/// stays, in the tray, until it is quit.
#[derive(Default)]
struct Seen(AtomicBool);

/// Whether the tray icon exists. Without one, closing the window cannot
/// leave the app anywhere to be found, so it ends the app as usual.
#[derive(Default)]
struct TrayUp(AtomicBool);

/// The tray menu's Quit, whose label says what quitting costs.
struct QuitItem(MenuItem<tauri::Wry>);

fn assistants(n: usize) -> String {
    if n == 1 {
        "1 assistant".into()
    } else {
        format!("{n} assistants")
    }
}

fn tooltip(n: usize) -> String {
    let name = if cfg!(debug_assertions) { "SCF Editor (dev)" } else { "SCF Editor" };
    if n == 0 {
        name.into()
    } else {
        format!("{name} \u{2014} {} connected", assistants(n))
    }
}

fn quit_text(n: usize) -> String {
    if n == 0 {
        "Quit SCF Editor".into()
    } else {
        format!("Quit SCF Editor ({} connected)…", assistants(n))
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open SCF Editor", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", quit_text(0), true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &PredefinedMenuItem::separator(app)?, &quit])?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip(tooltip(0))
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show(app),
            "quit" => request_quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    app.manage(QuitItem(quit));
    Ok(())
}

/// Whether the quit question is already on screen, so a second click on
/// Exit does not stack another.
#[derive(Default)]
struct Asking(AtomicBool);

/// Quit, from the tray or File > Exit. Immediately when nobody is
/// connected; otherwise only once the person has said they mean it, since
/// quitting ends each assistant's connection and whatever it was doing.
fn request_quit(app: &AppHandle) {
    let n = app.state::<mcp_relay::Relay>().count();
    if n == 0 {
        app.exit(0);
        return;
    }
    if app.state::<Asking>().0.swap(true, Ordering::Relaxed) {
        return;
    }
    let handle = app.clone();
    app.dialog()
        .message(format!(
            "{} connected to SCF Editor. Quitting disconnects {} and ends \
             anything {} is doing.",
            if n == 1 { "1 assistant is".to_string() } else { format!("{n} assistants are") },
            if n == 1 { "it" } else { "them" },
            if n == 1 { "it" } else { "they" },
        ))
        .title("Quit SCF Editor?")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom("Quit".into(), "Cancel".into()))
        .show(move |quit| {
            handle.state::<Asking>().0.store(false, Ordering::Relaxed);
            if quit {
                handle.exit(0);
            }
        });
}

/// Quit the app, from the window's File > Exit.
#[tauri::command]
fn quit_app(app: AppHandle) {
    request_quit(&app);
}

fn show(app: &AppHandle) {
    app.state::<Seen>().0.store(true, Ordering::Relaxed);
    if let Some(w) = main_window(app) {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn hidden(app: &AppHandle) -> bool {
    main_window(app).is_none_or(|w| !w.is_visible().unwrap_or(false))
}

/// Exit in a while, if nobody has opened the window and by then there has
/// been no pipe for that long.
fn exit_if_unused(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(LINGER).await;
        let idle = app.state::<mcp_relay::Relay>().idle_for();
        let seen = app.state::<Seen>().0.load(Ordering::Relaxed);
        if hidden(&app) && !seen && idle.is_some_and(|d| d >= LINGER) {
            app.exit(0);
        }
    });
}

/// Where the pipe looks for the app.
fn discovery_path(app: &AppHandle) -> tauri::Result<PathBuf> {
    Ok(app.path().app_data_dir()?.join("mcp.json"))
}

fn publish(app: &AppHandle, discovery: &mcp_relay::Discovery) -> tauri::Result<()> {
    let path = discovery_path(app)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    // Whole or not at all: a pipe may be reading it as it is written.
    let partial = path.with_extension("json.partial");
    std::fs::write(&partial, serde_json::to_vec(discovery)?)?;
    std::fs::rename(&partial, &path)?;
    Ok(())
}

/// Take `mcp.json` down, if it is still this app's.
fn unpublish(app: &AppHandle) {
    let Ok(path) = discovery_path(app) else {
        return;
    };
    let ours = std::fs::read(&path)
        .ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .is_some_and(|v| v["pid"] == std::process::id());
    if ours {
        let _ = std::fs::remove_file(path);
    }
}

/// `scf-editor mcp …`: an agent's stdio pipe to the app (`pipe.rs`).
pub fn mcp_pipe(args: Vec<String>) -> std::process::ExitCode {
    pipe::run(args)
}

/// WebKitGTK draws through DMA-BUF by default, and under NVIDIA's
/// proprietary driver that can leave the window blank. With that driver
/// loaded the renderer is turned off, unless the variable is already set
/// either way (`=0` keeps it on). Before anything else, as WebKitGTK reads
/// it once, and while there is only this thread to see the change.
#[cfg(target_os = "linux")]
fn avoid_blank_window() {
    const FLAG: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";
    if std::env::var_os(FLAG).is_some() {
        return;
    }
    let nvidia = ["/proc/driver/nvidia/version", "/sys/module/nvidia"]
        .iter()
        .any(|p| std::path::Path::new(p).exists());
    if nvidia {
        eprintln!(
            "scf-editor: NVIDIA's driver is loaded, so {FLAG}=1 \
             (set {FLAG}=0 to keep WebKitGTK's default)"
        );
        std::env::set_var(FLAG, "1");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    avoid_blank_window();
    let background = std::env::args().any(|a| a == BACKGROUND);
    // A person starting the app again while one is already running:
    // hand off to it ourselves, with a confirmed answer, rather than
    // let `tauri_plugin_single_instance` end this process silently with
    // no way to tell them why nothing opened — or, worse, start a
    // second engine beside a first that is merely slow to answer. A
    // pipe's own `--background` start keeps the plugin's existing,
    // quieter handling instead (pipe.rs's `connect_or_start` already
    // found nothing running, or it would not be starting one at all).
    if !background {
        match pipe::raise_existing() {
            Some(true) => return,
            Some(false) => return pipe::alert_unresponsive(),
            None => {}
        }
    }
    let databases = sql::Databases::default();
    let socket = sql_socket::start(databases.clone()).expect("a loopback port for SQL");
    let media_backends = media_core::Backends::default();
    media::detect_at_startup(media_backends.clone());
    // `dirs::cache_dir()` directly, not `app.path().app_cache_dir()`:
    // no `AppHandle` exists yet at this point (same reason `pipe.rs`'s
    // own discovery file uses `dirs::data_dir()` rather than waiting
    // for one). The first real use of a cache dir distinct from the
    // app's data dir in this app.
    let media_cache_dir = dirs::cache_dir()
        .expect("a cache directory for this OS")
        .join(pipe::IDENTIFIER);
    let (media_server_info, media_handles, media_capabilities) =
        media_server::start(media_backends.clone(), media_cache_dir)
            .expect("a loopback port for media");
    let relay = mcp_relay::Relay::new();
    let discovery = mcp_relay::start(relay.clone()).expect("a loopback port for the MCP");
    let builder = tauri::Builder::default()
        // First: a second start hands over here and goes no further.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // The person opening the app again wants to see it; a pipe
            // starting it needs only that it runs, which it does.
            if !argv.iter().any(|a| a == BACKGROUND) {
                show(app);
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Seen::default())
        .manage(Asking::default())
        .manage(TrayUp::default())
        .manage(databases)
        .manage(socket)
        .manage(media_backends)
        .manage(media_server_info)
        .manage(media_handles)
        .manage(media_capabilities)
        .manage(relay.clone())
        .setup(move |app| {
            let handle = app.handle().clone();
            publish(&handle, &discovery)?;
            // Made here rather than from the config (`create: false`), so
            // it starts as it will stay: hidden for an agent, otherwise
            // shown. Hiding a window and showing it later can leave
            // WebKitGTK's blank on some Linux desktops.
            let config = app
                .config()
                .app
                .windows
                .iter()
                .find(|w| w.label == "main")
                .cloned()
                .expect("tauri.conf.json has the main window");
            let mut window =
                tauri::WebviewWindowBuilder::from_config(&handle, &config)?.visible(!background);
            // Windows draws no frame of its own: the title strip is the
            // title bar, with its own window controls. Elsewhere the
            // native frame stays until that has been tried there.
            if cfg!(windows) {
                window = window.decorations(false);
            }
            if cfg!(debug_assertions) {
                // Beside an installed copy, which has its own data and pipe.
                window = window.title("SCF Editor (dev)");
            }
            window.build()?;
            match build_tray(&handle) {
                Ok(()) => handle.state::<TrayUp>().0.store(true, Ordering::Relaxed),
                // A desktop with no tray (some Linux ones) still works;
                // closing the window then ends the app, as it always did.
                Err(e) => eprintln!("scf-editor: no tray icon: {e}"),
            }
            let on_count = handle.clone();
            relay.on_count(move |n| {
                if let Some(tray) = on_count.tray_by_id("main") {
                    let _ = tray.set_tooltip(Some(tooltip(n)));
                }
                if let Some(quit) = on_count.try_state::<QuitItem>() {
                    let _ = quit.0.set_text(quit_text(n));
                }
                if n == 0 && hidden(&on_count) {
                    exit_if_unused(&on_count);
                }
            });
            let raise_handle = handle.clone();
            relay.set_raiser(move |after| {
                let app = raise_handle.clone();
                let app_for_show = app.clone();
                // Run on the main thread, same as a person clicking the
                // tray icon: `after` only fires once that has actually
                // happened, which is what lets a second launch tell a
                // frozen app from one that merely has not opened yet.
                let _ = app.run_on_main_thread(move || {
                    show(&app_for_show);
                    after();
                });
            });
            if background {
                exit_if_unused(&handle);
            } else {
                show(&handle);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Closing leaves the app in the tray; without a tray, only
                // an app an agent is using is kept (hidden) rather than ended.
                let tray = window.state::<TrayUp>().0.load(Ordering::Relaxed);
                if tray || window.state::<mcp_relay::Relay>().count() > 0 {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        });
    let builder = builder.invoke_handler(tauri::generate_handler![
        host_setup,
        quit_app,
        sql::sql_open,
        sql::sql_close,
        sql::sql_reset,
        mcp_relay::mcp_listen,
        mcp_relay::mcp_send,
        mcp_relay::mcp_close,
        media::media_detect_backends,
        media_server::media_server_info,
        media_server::media_register_asset,
        media_server::media_report_capabilities,
        sql::file_fingerprint,
        sql_socket::sql_socket,
        files::fs_windows,
        files::fs_real,
        files::fs_exists,
        files::fs_read_dir,
        files::fs_stat,
        files::fs_read_text,
        files::fs_read_range,
        files::fs_write_text,
        files::fs_append_text,
        files::fs_create_file,
        files::fs_mkdir,
        files::fs_remove,
        files::fs_rename,
    ]);
    builder
        .build(tauri::generate_context!())
        .expect("error while starting the SCF editor")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                unpublish(app);
            }
        });
}
