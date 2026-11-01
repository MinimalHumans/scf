// SPDX-License-Identifier: Apache-2.0
//! A manual check against whatever is actually installed on the
//! machine running it, not fixtures. `#[ignore]`d so CI (which has none
//! of these tools) never fails on it; run explicitly with
//! `cargo test -p media-core -- --ignored --nocapture` to see real
//! detection results.

use std::collections::HashMap;

#[test]
#[ignore = "depends on this machine's installed backends"]
fn detects_whatever_is_actually_on_this_machine() {
    let statuses = media_core::detect_all(&HashMap::new());
    for s in &statuses {
        println!("{:<9} ok={:<5} path={:<40} version={:?} error={:?} notable={:?}",
            s.id, s.ok, s.path.as_deref().unwrap_or("-"), s.version, s.error,
            s.notable);
    }
    assert_eq!(statuses.len(), 4);
}
