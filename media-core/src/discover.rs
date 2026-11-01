// SPDX-License-Identifier: Apache-2.0
//! Finding a backend's executable: override, then PATH, then known
//! install locations (docs/media-server-spec.md §3 "Discovery").
//!
//! Always resolves to a real, existing file path or nothing at all —
//! never a bare command name. The settings UI shows this path, so
//! "found" has to mean "this exact file is sitting right there."

use crate::Binary;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

#[derive(Debug, PartialEq, Eq)]
pub enum Discovered {
    Found(PathBuf),
    /// An override was configured but nothing exists there. Deliberately
    /// NOT the same as `NotFound`: silently falling back to a different
    /// copy found on PATH would ignore the one thing the user explicitly
    /// asked to pin.
    OverrideInvalid(PathBuf),
    NotFound,
}

pub fn discover(binary: Binary, override_path: Option<&Path>) -> Discovered {
    if let Some(p) = override_path {
        return if p.is_file() {
            Discovered::Found(p.to_path_buf())
        } else {
            Discovered::OverrideInvalid(p.to_path_buf())
        };
    }
    if let Some(p) = scan_path(binary) {
        return Discovered::Found(p);
    }
    if let Some(p) = scan_known_locations(binary) {
        return Discovered::Found(p);
    }
    Discovered::NotFound
}

fn exe_filename(binary: Binary) -> String {
    if cfg!(windows) {
        format!("{}.exe", binary.id())
    } else {
        binary.id().to_string()
    }
}

fn first_existing(dirs: impl IntoIterator<Item = PathBuf>, filename: &str) -> Option<PathBuf> {
    dirs.into_iter().map(|d| d.join(filename)).find(|p| p.is_file())
}

fn scan_path(binary: Binary) -> Option<PathBuf> {
    scan_path_var(binary, std::env::var_os("PATH"))
}

/// Takes the `PATH` value explicitly so tests never have to mutate a
/// process-wide environment variable (unsafe to do from parallel tests).
fn scan_path_var(binary: Binary, path_var: Option<OsString>) -> Option<PathBuf> {
    let filename = exe_filename(binary);
    first_existing(std::env::split_paths(&path_var?), &filename)
}

/// Not exhaustive. This app currently ships Windows-only
/// (`tauri.conf.json`'s `bundle.targets`), so the Windows list is the one
/// that matters; macOS/Linux cover the Docker/CI dev path only and are a
/// short, expandable stub.
#[cfg(windows)]
fn known_locations(binary: Binary) -> Vec<PathBuf> {
    fn program_files_matching(prefix: &str) -> Vec<PathBuf> {
        ["ProgramFiles", "ProgramFiles(x86)"]
            .iter()
            .filter_map(|v| std::env::var(v).ok())
            .filter_map(|base| std::fs::read_dir(base).ok())
            .flatten()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with(prefix))
            .map(|e| e.path())
            .collect()
    }

    let mut dirs = Vec::new();
    match binary {
        Binary::Ffmpeg | Binary::Ffprobe => {
            for d in program_files_matching("ffmpeg") {
                dirs.push(d.join("bin"));
                dirs.push(d);
            }
        }
        Binary::Magick => dirs.extend(program_files_matching("ImageMagick")),
        Binary::Oiiotool => {
            for d in program_files_matching("OpenImageIO") {
                dirs.push(d.join("bin"));
                dirs.push(d);
            }
        }
    }
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        dirs.push(PathBuf::from(local).join("Microsoft").join("WinGet").join("Links"));
    }
    if let Ok(profile) = std::env::var("USERPROFILE") {
        dirs.push(PathBuf::from(profile).join("scoop").join("shims"));
    }
    dirs.push(PathBuf::from(r"C:\ProgramData\chocolatey\bin"));
    dirs
}

#[cfg(not(windows))]
fn known_locations(_binary: Binary) -> Vec<PathBuf> {
    // GUI apps on macOS do not inherit the shell's PATH, hence this probe
    // existing at all (spec §3 "Discovery").
    vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
    ]
}

fn scan_known_locations(binary: Binary) -> Option<PathBuf> {
    first_existing(known_locations(binary), &exe_filename(binary))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    struct TempBin {
        dir: PathBuf,
    }

    impl TempBin {
        /// A throwaway directory under the OS temp dir holding one fake
        /// executable, cleaned up on drop.
        fn new(filename: &str) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("media-core-test-{}-{}", std::process::id(), filename));
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join(filename), b"not a real binary").unwrap();
            TempBin { dir }
        }
    }

    impl Drop for TempBin {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn override_wins_when_it_exists() {
        let bin = TempBin::new(&exe_filename(Binary::Ffmpeg));
        let path = bin.dir.join(exe_filename(Binary::Ffmpeg));
        match discover(Binary::Ffmpeg, Some(&path)) {
            Discovered::Found(p) => assert_eq!(p, path),
            other => panic!("expected Found, got {other:?}"),
        }
    }

    #[test]
    fn override_set_but_missing_does_not_fall_back() {
        let missing = std::env::temp_dir().join("media-core-test-missing-ffmpeg.exe");
        assert!(!missing.exists());
        match discover(Binary::Ffmpeg, Some(&missing)) {
            Discovered::OverrideInvalid(p) => assert_eq!(p, missing),
            other => panic!("expected OverrideInvalid, got {other:?}"),
        }
    }

    #[test]
    fn path_scan_finds_the_right_binary_in_a_fixture_dir() {
        let filename = exe_filename(Binary::Oiiotool);
        let bin = TempBin::new(&filename);
        let path_var = std::env::join_paths([bin.dir.clone()]).unwrap();
        let found = scan_path_var(Binary::Oiiotool, Some(path_var));
        assert_eq!(found, Some(bin.dir.join(&filename)));
    }

    #[test]
    fn path_scan_ignores_a_directory_with_the_wrong_binary() {
        let bin = TempBin::new(&exe_filename(Binary::Magick));
        let path_var = std::env::join_paths([bin.dir.clone()]).unwrap();
        // Looking for ffmpeg in a directory that only has magick.
        assert_eq!(scan_path_var(Binary::Ffmpeg, Some(path_var)), None);
    }
}
