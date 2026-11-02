// SPDX-License-Identifier: Apache-2.0
//! Handle → absolute path registry (docs/media-server-spec.md §10's
//! "output file paths never derived from user input" applied to input
//! too: the webview never sees or sends a path, only this opaque
//! handle).
//!
//! Mirrors `scf-app/src-tauri/src/sql.rs`'s `Databases`: a cheap-to-
//! clone, `tauri::State`-friendly registry shared between the register
//! command (write side) and the HTTP listener (read side).
//!
//! Phase 6 adds a project id alongside the path: `media-core`'s cache
//! needs one to attribute usage and run per-project eviction/flush (spec
//! §7's `refs`), and this registry is the only place in `media-server`
//! that ever learns one — the caller passes whatever string it already
//! uses as a project's identity (see `cache.rs`'s module doc for why
//! that's not literally the spec's `app.db` `uuid`). A handle can end
//! up registered under more than one project id: two project roots
//! happening to resolve the same absolute file (shared stock footage,
//! say) is rare but not impossible, and the cache's per-project
//! accounting should credit every project that asked for it, not just
//! whichever registered the handle first.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
pub struct Handles {
    inner: Arc<Mutex<Registry>>,
}

#[derive(Default)]
struct Registry {
    by_handle: HashMap<String, Entry>,
    by_path: HashMap<String, String>,
}

#[derive(Clone, Default)]
struct Entry {
    path: String,
    project_ids: HashSet<String>,
}

/// What [`Handles::resolve`] gives back: the real path, plus every
/// project id this handle has ever been registered under — `media-
/// server`'s `serve.rs` adds a cache ref for each one on every `/media`
/// request.
pub struct Resolved {
    pub path: String,
    pub project_ids: Vec<String>,
}

fn new_handle() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("randomness for a handle");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

impl Handles {
    /// The handle for `path`, reusing one already issued for the same
    /// path rather than growing one entry per repeat view. Never
    /// expires in this phase — see the plan's decision 3. `project_id`
    /// is `None` when the caller has no project context (nothing in
    /// this phase needs one to just serve bytes); it's folded into the
    /// handle's existing set either way.
    pub fn register(&self, path: String, project_id: Option<String>) -> String {
        let mut reg = self.inner.lock().unwrap();
        if let Some(existing) = reg.by_path.get(&path).cloned() {
            if let Some(pid) = project_id {
                reg.by_handle.get_mut(&existing).expect("by_path and by_handle agree").project_ids.insert(pid);
            }
            return existing;
        }
        let handle = new_handle();
        let mut project_ids = HashSet::new();
        if let Some(pid) = project_id {
            project_ids.insert(pid);
        }
        reg.by_path.insert(path.clone(), handle.clone());
        reg.by_handle.insert(handle.clone(), Entry { path, project_ids });
        handle
    }

    /// The path (and known project ids) a handle was registered for,
    /// or `None` for an unknown or stale one.
    pub fn resolve(&self, handle: &str) -> Option<Resolved> {
        let reg = self.inner.lock().unwrap();
        reg.by_handle.get(handle).map(|e| Resolved {
            path: e.path.clone(),
            project_ids: e.project_ids.iter().cloned().collect(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_path_gets_the_same_handle() {
        let handles = Handles::default();
        let a = handles.register("C:\\plates\\a.png".to_string(), None);
        let b = handles.register("C:\\plates\\a.png".to_string(), None);
        assert_eq!(a, b);
    }

    #[test]
    fn different_paths_get_different_handles() {
        let handles = Handles::default();
        let a = handles.register("C:\\plates\\a.png".to_string(), None);
        let b = handles.register("C:\\plates\\b.png".to_string(), None);
        assert_ne!(a, b);
    }

    #[test]
    fn resolves_back_to_the_registered_path() {
        let handles = Handles::default();
        let handle = handles.register("C:\\plates\\a.png".to_string(), None);
        assert_eq!(handles.resolve(&handle).unwrap().path, "C:\\plates\\a.png");
    }

    #[test]
    fn unknown_handle_resolves_to_nothing() {
        let handles = Handles::default();
        assert!(handles.resolve("not-a-real-handle").is_none());
    }

    #[test]
    fn a_registered_project_id_comes_back_in_resolve() {
        let handles = Handles::default();
        let handle = handles.register("C:\\plates\\a.png".to_string(), Some("proj-a".to_string()));
        assert_eq!(handles.resolve(&handle).unwrap().project_ids, vec!["proj-a".to_string()]);
    }

    /// The same absolute path registered under two different projects
    /// — a file shared between project roots — credits both, not just
    /// the one that registered first.
    #[test]
    fn the_same_path_registered_under_two_projects_carries_both() {
        let handles = Handles::default();
        let a = handles.register("C:\\shared\\stock.mov".to_string(), Some("proj-a".to_string()));
        let b = handles.register("C:\\shared\\stock.mov".to_string(), Some("proj-b".to_string()));
        assert_eq!(a, b);
        let mut ids = handles.resolve(&a).unwrap().project_ids;
        ids.sort();
        assert_eq!(ids, vec!["proj-a".to_string(), "proj-b".to_string()]);
    }

    #[test]
    fn registering_with_no_project_id_resolves_with_an_empty_list() {
        let handles = Handles::default();
        let handle = handles.register("C:\\plates\\a.png".to_string(), None);
        assert_eq!(handles.resolve(&handle).unwrap().project_ids, Vec::<String>::new());
    }
}
