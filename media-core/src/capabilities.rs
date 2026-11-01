// SPDX-License-Identifier: Apache-2.0
//! What the webview has reported it can actually decode
//! (docs/media-server-spec.md §5's verdict step: "a capability table
//! seeded from a frontend report... since support differs on WebView2,
//! WKWebView, WebKitGTK").
//!
//! Keyed by `"<codec>/<container>"` (e.g. `"hevc/mp4"`), reported once
//! per session by the frontend via `canPlayType` — see the plan this
//! was built from for why `canPlayType` over `MediaCapabilities.
//! decodingInfo` for now.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
pub struct Capabilities {
    inner: Arc<Mutex<HashMap<String, bool>>>,
}

impl Capabilities {
    /// Replace the whole table in one go — the frontend sends its full
    /// report as a single round trip, not one call per codec.
    pub fn report(&self, decodable: HashMap<String, bool>) {
        *self.inner.lock().unwrap() = decodable;
    }

    /// `Some(true/false)` when the frontend has actually reported on
    /// this exact `codec/container` key; `None` when it hasn't (yet, or
    /// this session never checked that combination) — the caller falls
    /// back to a static guess rather than treating "unknown" as "no".
    pub fn can_decode(&self, key: &str) -> Option<bool> {
        self.inner.lock().unwrap().get(key).copied()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_reported_yet_is_unknown() {
        let caps = Capabilities::default();
        assert_eq!(caps.can_decode("h264/mp4"), None);
    }

    #[test]
    fn a_reported_combo_is_known() {
        let caps = Capabilities::default();
        caps.report(HashMap::from([
            ("h264/mp4".to_string(), true),
            ("hevc/mp4".to_string(), false),
        ]));
        assert_eq!(caps.can_decode("h264/mp4"), Some(true));
        assert_eq!(caps.can_decode("hevc/mp4"), Some(false));
        assert_eq!(caps.can_decode("av1/mp4"), None);
    }

    #[test]
    fn a_later_report_replaces_the_whole_table() {
        let caps = Capabilities::default();
        caps.report(HashMap::from([("h264/mp4".to_string(), true)]));
        caps.report(HashMap::from([("hevc/mp4".to_string(), false)]));
        assert_eq!(caps.can_decode("h264/mp4"), None);
        assert_eq!(caps.can_decode("hevc/mp4"), Some(false));
    }
}
