// SPDX-License-Identifier: Apache-2.0
//! What tells this machine from another, for the MCP server's session
//! ids (scf-mcp `sessionId.ts`), which are salted with it.
//!
//! It is the operating system's own identifier of the installation: the
//! same on every run, and not a secret. Where there is none to read the
//! answer is empty, and the caller makes do.

/// The machine's identifier, or "" when it has none this can read.
#[tauri::command]
pub async fn machine_id() -> String {
    read().unwrap_or_default().trim().to_string()
}

/// `MachineGuid`, which Windows sets when it is installed.
#[cfg(windows)]
fn read() -> Option<String> {
    use std::os::windows::process::CommandExt;
    use std::path::PathBuf;
    use std::process::Command;

    // Without this a console window flashes up over the app.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    // By its full path, so that no other `reg` on the search path is run.
    let reg = std::env::var_os("SystemRoot")
        .map(|root| PathBuf::from(root).join("System32").join("reg.exe"))
        .unwrap_or_else(|| PathBuf::from("reg"));
    let out = Command::new(reg)
        .args([
            "query",
            r"HKLM\SOFTWARE\Microsoft\Cryptography",
            "/v",
            "MachineGuid",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    // "    MachineGuid    REG_SZ    <guid>"
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .find(|line| line.contains("MachineGuid"))?
        .split_whitespace()
        .last()
        .map(str::to_string)
}

/// `IOPlatformUUID`, the hardware's.
#[cfg(target_os = "macos")]
fn read() -> Option<String> {
    let out = std::process::Command::new("/usr/sbin/ioreg")
        .args(["-rd1", "-c", "IOPlatformExpertDevice"])
        .output()
        .ok()?;
    // `    "IOPlatformUUID" = "<uuid>"`
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .find(|line| line.contains("IOPlatformUUID"))?
        .split('"')
        .nth(3)
        .map(str::to_string)
}

/// `machine-id(5)`, which systemd or D-Bus writes at first boot.
#[cfg(not(any(windows, target_os = "macos")))]
fn read() -> Option<String> {
    ["/etc/machine-id", "/var/lib/dbus/machine-id"]
        .iter()
        .find_map(|path| std::fs::read_to_string(path).ok())
}

#[cfg(test)]
mod tests {
    #[test]
    fn says_the_same_thing_every_time_and_nothing_like_a_line_of_output() {
        let id = super::read().unwrap_or_default();
        assert_eq!(id, super::read().unwrap_or_default());
        assert!(!id.trim().contains(char::is_whitespace), "{id:?}");
        // Windows always has one, and it is a GUID.
        #[cfg(windows)]
        assert_eq!(id.trim().len(), 36, "{id:?}");
    }
}
