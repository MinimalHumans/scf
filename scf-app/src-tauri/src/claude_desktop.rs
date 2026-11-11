// SPDX-License-Identifier: Apache-2.0
//! Registering this app with Claude Desktop, from Settings.
//!
//! Claude Desktop has no API to add an MCP server at runtime: it reads
//! `claude_desktop_config.json` once, at launch. So "install" here means
//! writing our entry into that file ourselves and telling the person to
//! restart Claude Desktop — the same thing a person would do by hand,
//! done for them. Nothing else in that file is ours to judge: we merge
//! our one entry into whatever `mcpServers` already has, and leave the
//! rest byte-for-byte.

use std::path::PathBuf;

use serde::Serialize;
use serde_json::{Map, Value};

/// Where Claude Desktop keeps its config, per OS. `None` on a platform
/// Claude Desktop does not ship for.
fn config_path() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        Some(dirs::config_dir()?.join("Claude").join("claude_desktop_config.json"))
    }
    #[cfg(target_os = "macos")]
    {
        Some(
            dirs::home_dir()?
                .join("Library")
                .join("Application Support")
                .join("Claude")
                .join("claude_desktop_config.json"),
        )
    }
    #[cfg(target_os = "linux")]
    {
        Some(dirs::config_dir()?.join("Claude").join("claude_desktop_config.json"))
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        None
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpInstallResult {
    /// The config file written.
    path: String,
    /// Whether a file was already there (so a `.bak` sits beside it now).
    existed: bool,
}

/// Add (or replace) this app's entry in Claude Desktop's config, so it
/// starts offering SCF the next time Claude Desktop launches. Returns
/// where it wrote, for the confirmation the caller shows; the caller
/// still has to tell the person to restart Claude Desktop — this does
/// not, and cannot, do that for them.
#[tauri::command]
pub fn mcp_install_claude_desktop() -> Result<McpInstallResult, String> {
    let path = config_path().ok_or_else(|| {
        "Claude Desktop's config location isn't known on this platform.".to_string()
    })?;
    let exe = std::env::current_exe()
        .map_err(|e| format!("couldn't find this app's own executable: {e}"))?;
    // Resolved so the path Claude Desktop launches is real even if we
    // were started through a symlink or a relative arg.
    let exe = dunce::canonicalize(&exe).unwrap_or(exe);

    let existed = path.exists();
    let mut root: Value = if existed {
        let text = std::fs::read_to_string(&path)
            .map_err(|e| format!("couldn't read {}: {e}", path.display()))?;
        if text.trim().is_empty() {
            Value::Object(Map::new())
        } else {
            serde_json::from_str(&text).map_err(|e| {
                format!(
                    "{} doesn't parse as JSON ({e}); fix or remove it, then try again",
                    path.display()
                )
            })?
        }
    } else {
        Value::Object(Map::new())
    };
    let root_obj = root
        .as_object_mut()
        .ok_or_else(|| format!("{} isn't a JSON object at the top level", path.display()))?;
    let servers = root_obj
        .entry("mcpServers")
        .or_insert_with(|| Value::Object(Map::new()));
    let servers_obj = servers
        .as_object_mut()
        .ok_or_else(|| "its \"mcpServers\" isn't an object".to_string())?;
    servers_obj.insert(
        "scf-editor".to_string(),
        serde_json::json!({
            "command": exe.to_string_lossy(),
            "args": ["mcp"],
        }),
    );

    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("couldn't create {}: {e}", dir.display()))?;
    }
    if existed {
        let backup = path.with_extension("json.bak");
        std::fs::copy(&path, &backup)
            .map_err(|e| format!("couldn't back up the existing config: {e}"))?;
    }
    let text = serde_json::to_string_pretty(&root)
        .map_err(|e| format!("couldn't serialize the config: {e}"))?;
    std::fs::write(&path, text).map_err(|e| format!("couldn't write {}: {e}", path.display()))?;

    Ok(McpInstallResult { path: path.to_string_lossy().into_owned(), existed })
}
