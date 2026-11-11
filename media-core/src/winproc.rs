// SPDX-License-Identifier: Apache-2.0
//! A `Command::new` that doesn't flash a console window on Windows.
//!
//! Every backend here (ffmpeg, ffprobe, magick, oiiotool) is a console
//! .exe; spawned from this GUI app with a plain `std::process::Command`,
//! Windows still allocates it a console, which briefly flashes on
//! screen. `CREATE_NO_WINDOW` suppresses that; it's a no-op on other
//! platforms.

use std::path::Path;
use std::process::Command;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub fn command(path: &Path) -> Command {
    let mut cmd = Command::new(path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}
