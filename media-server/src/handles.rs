// SPDX-License-Identifier: Apache-2.0
//! Handle → absolute path registry (docs/media-server-spec.md §10's
//! "output file paths never derived from user input" applied to input
//! too: the webview never sees or sends a path, only this opaque
//! handle).
//!
//! Mirrors `scf-app/src-tauri/src/sql.rs`'s `Databases`: a cheap-to-
//! clone, `tauri::State`-friendly registry shared between the register
//! command (write side) and the HTTP listener (read side).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
pub struct Handles {
    inner: Arc<Mutex<Registry>>,
}

#[derive(Default)]
struct Registry {
    by_handle: HashMap<String, String>,
    by_path: HashMap<String, String>,
}

fn new_handle() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("randomness for a handle");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

impl Handles {
    /// The handle for `path`, reusing one already issued for the same
    /// path rather than growing one entry per repeat view. Never
    /// expires in this phase — see the plan's decision 3.
    pub fn register(&self, path: String) -> String {
        let mut reg = self.inner.lock().unwrap();
        if let Some(existing) = reg.by_path.get(&path) {
            return existing.clone();
        }
        let handle = new_handle();
        reg.by_path.insert(path.clone(), handle.clone());
        reg.by_handle.insert(handle.clone(), path);
        handle
    }

    /// The path a handle was registered for, or `None` for an unknown
    /// or stale one.
    pub fn resolve(&self, handle: &str) -> Option<String> {
        self.inner.lock().unwrap().by_handle.get(handle).cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_path_gets_the_same_handle() {
        let handles = Handles::default();
        let a = handles.register("C:\\plates\\a.png".to_string());
        let b = handles.register("C:\\plates\\a.png".to_string());
        assert_eq!(a, b);
    }

    #[test]
    fn different_paths_get_different_handles() {
        let handles = Handles::default();
        let a = handles.register("C:\\plates\\a.png".to_string());
        let b = handles.register("C:\\plates\\b.png".to_string());
        assert_ne!(a, b);
    }

    #[test]
    fn resolves_back_to_the_registered_path() {
        let handles = Handles::default();
        let handle = handles.register("C:\\plates\\a.png".to_string());
        assert_eq!(handles.resolve(&handle), Some("C:\\plates\\a.png".to_string()));
    }

    #[test]
    fn unknown_handle_resolves_to_nothing() {
        let handles = Handles::default();
        assert_eq!(handles.resolve("not-a-real-handle"), None);
    }
}
