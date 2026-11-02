// SPDX-License-Identifier: Apache-2.0
//! Capturing a failed backend's stderr for the dashboard (Phase 7,
//! spec §9: "Failures list with per-job stderr tail"). `convert.rs`
//! and `still_convert.rs` both pipe stderr now (it was `Stdio::null()`
//! before this phase — nothing read it, so there was nothing to keep),
//! and both read it the same way: a background thread drains the pipe
//! into a bounded ring of lines as the process runs, so a chatty
//! backend's own stdout/stderr buffering can never make it block on a
//! full pipe, and the caller reads whatever's accumulated whenever it
//! wants (usually: after `wait` returns non-zero).

use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::ChildStderr;
use std::sync::{Arc, Mutex};

/// Enough to see the actual error (ffmpeg/magick/oiiotool put the
/// reason near the end of their output) without holding a runaway
/// process's entire stderr in memory.
const MAX_TAIL_LINES: usize = 20;

/// Spawns the reader thread and returns the handle both the caller and
/// the thread share. The thread exits on its own once stderr closes
/// (the process exited) — nothing needs to join it; a caller that
/// never reads the handle has just spent one thread and a few hundred
/// bytes for nothing, not leaked anything.
pub(crate) fn spawn_tail_reader(stderr: ChildStderr) -> Arc<Mutex<String>> {
    let tail = Arc::new(Mutex::new(String::new()));
    let tail_for_thread = tail.clone();
    std::thread::spawn(move || {
        let mut lines: VecDeque<String> = VecDeque::with_capacity(MAX_TAIL_LINES);
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if lines.len() == MAX_TAIL_LINES {
                lines.pop_front();
            }
            lines.push_back(line);
            // Updated as it goes, not just at the end — a cancel kills
            // the process before it exits, which would otherwise lose
            // everything read so far.
            *tail_for_thread.lock().unwrap() = lines.iter().cloned().collect::<Vec<_>>().join("\n");
        }
    });
    tail
}

/// Replaces every literal occurrence of each path's full, displayed
/// form with just its file name, before a stderr tail is ever stored
/// or sent anywhere a client can read it (spec §10/§13: no absolute
/// path is ever returned by the API, and a backend's own error text
/// routinely echoes back the exact argument we gave it, e.g. "in.mov:
/// No such file or directory"). Not a general path scrubber — it only
/// catches the exact strings this job passed on the command line,
/// which covers the actual leak vector (our own argv), not every way
/// a determined backend could print a path. `pub`, not `pub(crate)`:
/// `media-server`'s queue (a different crate) is the only caller that
/// actually has both a stderr tail and the paths that produced it.
pub fn redact_paths(text: &str, paths: &[&Path]) -> String {
    let mut out = text.to_string();
    for path in paths {
        let full = path.display().to_string();
        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            out = out.replace(&full, name);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redact_paths_replaces_the_full_path_with_just_the_file_name() {
        let text = "ffmpeg: C:\\plates\\shot01.mov: No such file or directory";
        let redacted = redact_paths(text, &[Path::new("C:\\plates\\shot01.mov")]);
        assert_eq!(redacted, "ffmpeg: shot01.mov: No such file or directory");
    }

    #[test]
    fn redact_paths_leaves_unrelated_text_alone() {
        let text = "unsupported pixel format";
        assert_eq!(redact_paths(text, &[Path::new("C:\\plates\\shot01.mov")]), text);
    }

    #[test]
    fn redact_paths_handles_more_than_one_path() {
        let text = "reading C:\\in\\a.mov writing C:\\out\\b.part";
        let redacted = redact_paths(
            text, &[Path::new("C:\\in\\a.mov"), Path::new("C:\\out\\b.part")]);
        assert_eq!(redacted, "reading a.mov writing b.part");
    }
}
