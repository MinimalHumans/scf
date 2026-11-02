// SPDX-License-Identifier: Apache-2.0
//! The background conversion queue (docs/media-server-spec.md §6):
//! dedup, a concurrency cap, and cancel. `media-core`'s `Cache` and
//! `convert`/`still_convert` functions are plain synchronous code (no
//! tokio dependency there — see the plan); this is the async layer
//! that runs them concurrently, bounded, and cancellably, the same
//! way `scf-app/src-tauri/src/media.rs` already wraps `media_core::
//! detect_all` in a blocking task.
//!
//! Phase 7 adds [`Queue::worker_status`] (spec §9's "slots in use")
//! and `run_conversion`'s `Failure` type, which carries a failed
//! backend's own stderr tail alongside its short message — redacted of
//! the job's input/tmp paths (`media_core::redact_paths`) before it's
//! ever stored, since a backend's own error text routinely echoes
//! back the exact path it was given.

use std::collections::HashMap;
use std::path::Path;
use std::process::Child;
use std::sync::{Arc, Mutex};

use media_core::{Cache, DerivedParams, JobState, StillDerivedParams, StillSelection, Verdict};
use serde::Serialize;
use tokio::sync::Semaphore;

/// Not user-configurable yet (the plan's decision 7) — spec §6's
/// "default 1 video job".
const MAX_VIDEO_JOBS: usize = 1;

/// Spec §6: "default... 2 still jobs" — Phase 4 deferred this ("no
/// still pipeline yet to need a separate cap"); Phase 5 is that
/// pipeline, so this is the first phase that actually needs it.
const MAX_STILL_JOBS: usize = 2;

/// Not user-configurable yet (the plan's decision 7) — shared with
/// `serve.rs`, which needs the same values to compute a cache-key
/// lookup for the `/media` route that this module uses to actually run
/// the conversion.
pub(crate) const DERIVED_PARAMS: DerivedParams =
    DerivedParams { resolution_cap: 1080, crf: 23, layer: None, channel: None };

/// Phase 5's still output profile (spec §7) — shared with `serve.rs`
/// for the same reason `DERIVED_PARAMS` is.
pub(crate) const STILL_DERIVED_PARAMS: StillDerivedParams = StillDerivedParams { max_long_edge: 2048 };

#[derive(Clone)]
pub struct Queue {
    cache: Cache,
    /// Separate pools (spec §6: "1 video job + 2 still jobs") — a
    /// burst of still-render requests must not starve, or be starved
    /// by, a single running video conversion.
    video_semaphore: Arc<Semaphore>,
    still_semaphore: Arc<Semaphore>,
    /// Running jobs only — a cancel needs the actual OS process handle,
    /// which nothing in `Cache`'s SQLite rows can give it.
    running: Arc<Mutex<HashMap<String, Arc<Mutex<Child>>>>>,
    /// Live 0.0-1.0 progress, separate from `Cache`'s durable state —
    /// this changes many times a second while a job runs and has no
    /// business being a SQLite write each time. A still render never
    /// populates this (no progress to report — see `run_conversion`);
    /// its absence here is the honest "nothing yet" the frontend
    /// already treats a missing entry as.
    progress: Arc<Mutex<HashMap<String, f64>>>,
}

/// Spec §9 dashboard's "Worker status: slots in use". `_max` is each
/// pool's fixed cap (not yet user-configurable — same as
/// `MAX_VIDEO_JOBS`/`MAX_STILL_JOBS` themselves), included so the
/// frontend never hardcodes it a second time.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerStatus {
    pub video_in_use: usize,
    pub video_max: usize,
    pub still_in_use: usize,
    pub still_max: usize,
}

/// Only present for a [`Verdict::Render`] request — the selection
/// already resolved against a probe result (see `media_core::
/// resolve_still_selection`) and the source's own dimensions, needed
/// to decide whether `still_convert`'s resize cap applies.
pub struct StillRenderRequest {
    pub selection: StillSelection,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

pub struct EnqueueRequest<'a> {
    pub key: &'a str,
    pub priority: &'a str,
    pub input: &'a std::path::Path,
    pub verdict: Verdict,
    /// `"ffmpeg"` for Remux/Transcode; `"oiiotool"`/`"magick"` for
    /// Render — which arg-builder `run_conversion` dispatches to.
    pub backend_id: &'a str,
    pub backend: &'a std::path::Path,
    pub duration_secs: Option<f64>,
    /// `Some` only for `Verdict::Render`.
    pub still: Option<StillRenderRequest>,
}

fn output_ext(verdict: Verdict) -> &'static str {
    if verdict == Verdict::Render { "jpg" } else { "mp4" }
}

fn kind_str(verdict: Verdict) -> &'static str {
    match verdict {
        Verdict::Remux => "remux",
        Verdict::Render => "render",
        _ => "transcode",
    }
}

impl Queue {
    pub fn new(cache: Cache) -> Self {
        // Startup recovery — spec §6: a `running` row survived a crash,
        // not a job that's still going; an orphaned `.part` belongs to
        // no job once every `running` row above it is gone.
        cache.reset_running_to_queued();
        media_core::delete_orphaned_parts(cache.dir());
        Queue {
            cache,
            video_semaphore: Arc::new(Semaphore::new(MAX_VIDEO_JOBS)),
            still_semaphore: Arc::new(Semaphore::new(MAX_STILL_JOBS)),
            running: Arc::new(Mutex::new(HashMap::new())),
            progress: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn cache(&self) -> &Cache {
        &self.cache
    }

    pub fn progress_of(&self, job_id: &str) -> Option<f64> {
        self.progress.lock().unwrap().get(job_id).copied()
    }

    /// Slots in use vs. the (fixed, not yet user-configurable) cap in
    /// each pool — spec §9's dashboard "Worker status". Counting
    /// `MAX_* - available_permits()` rather than `self.running`'s own
    /// length: a permit is held for the whole spawned task, including
    /// the brief window after it's acquired but before `run_conversion`
    /// inserts into `running`, so `running.len()` would undercount a
    /// job that's just about to start.
    pub fn worker_status(&self) -> WorkerStatus {
        WorkerStatus {
            video_in_use: MAX_VIDEO_JOBS - self.video_semaphore.available_permits(),
            video_max: MAX_VIDEO_JOBS,
            still_in_use: MAX_STILL_JOBS - self.still_semaphore.available_permits(),
            still_max: MAX_STILL_JOBS,
        }
    }

    /// An existing queued/running job for `key` is reused (spec §6
    /// "Dedup"); otherwise a new one is created and its run spawned in
    /// the background. Either way returns the job id to poll.
    pub fn enqueue(&self, req: EnqueueRequest<'_>) -> String {
        if let Some(existing) = self.cache.active_job_for(req.key) {
            return existing;
        }
        let id = self.cache.create_job(
            req.key, req.priority, req.backend_id, &req.input.display().to_string());
        self.spawn_run(id.clone(), req);
        id
    }

    fn spawn_run(&self, id: String, req: EnqueueRequest<'_>) {
        let queue = self.clone();
        let key = req.key.to_string();
        let input = req.input.to_path_buf();
        let verdict = req.verdict;
        let backend_id = req.backend_id.to_string();
        let backend = req.backend.to_path_buf();
        let duration_secs = req.duration_secs;
        let still = req.still;
        let semaphore = if verdict == Verdict::Render {
            queue.still_semaphore.clone()
        } else {
            queue.video_semaphore.clone()
        };

        tokio::spawn(async move {
            let permit = semaphore.acquire_owned().await;
            let Ok(_permit) = permit else { return }; // semaphore closed: shutting down

            // Cancelled while queued, before its turn came up.
            if queue.cache.get_job(&id).map(|j| j.state) != Some(JobState::Queued) {
                return;
            }
            queue.cache.set_job_running(&id);

            let id_for_run = id.clone();
            let queue_for_run = queue.clone();
            let result = tokio::task::spawn_blocking(move || {
                run_conversion(&queue_for_run, &id_for_run, ConversionJob {
                    backend_id: &backend_id, backend: &backend, input: &input,
                    verdict, duration_secs, still,
                })
            })
            .await;

            queue.running.lock().unwrap().remove(&id);
            queue.progress.lock().unwrap().remove(&id);

            match result {
                Ok(Ok(())) => {
                    let path = queue.cache.entry_path(&key, output_ext(verdict));
                    let bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                    queue.cache.put_entry(&key, &path.display().to_string(), bytes, kind_str(verdict));
                    queue.cache.set_job_done(&id);
                }
                Ok(Err(f)) => {
                    queue.cache.record_failure(&key, &f.message);
                    queue.cache.set_job_failed(&id, &f.message, f.stderr_tail.as_deref());
                }
                Err(_join_error) => {
                    // The blocking task panicked — treat it the same as
                    // any other failure, never propagate a panic out of
                    // this background task.
                    let msg = "conversion task panicked".to_string();
                    queue.cache.record_failure(&key, &msg);
                    queue.cache.set_job_failed(&id, &msg, None);
                }
            }
        });
    }

    /// Kills the job's process if it's running, deletes its `.part`,
    /// and marks it `cancelled`. A no-op (not an error) for a job that
    /// has already finished or was never running — cancel is "make
    /// sure it's stopped," not "assert it was in flight."
    pub fn cancel(&self, job_id: &str) {
        if let Some(child) = self.running.lock().unwrap().remove(job_id) {
            let _ = child.lock().unwrap().kill();
        }
        let _ = std::fs::remove_file(self.cache.tmp_path(job_id));
        if let Some(job) = self.cache.get_job(job_id) {
            if job.state == JobState::Queued || job.state == JobState::Running {
                self.cache.set_job_cancelled(job_id);
            }
        }
        self.progress.lock().unwrap().remove(job_id);
    }
}

/// What [`run_conversion`] needs — bundled so the call doesn't carry
/// eight loose arguments (`queue`/`job_id` stay separate: they name
/// *where* this runs, not *what* to run).
struct ConversionJob<'a> {
    backend_id: &'a str,
    backend: &'a std::path::Path,
    input: &'a std::path::Path,
    verdict: Verdict,
    duration_secs: Option<f64>,
    still: Option<StillRenderRequest>,
}

/// A failed conversion's short message (shown everywhere a job's error
/// is shown) plus, when the backend actually ran and said something on
/// stderr before failing, that output's last few lines — spec §9's
/// dashboard "Failures list with per-job stderr tail". Already
/// redacted of any absolute path by the time it's built (see
/// `Failure::from_wait`): a backend's own error text routinely echoes
/// back the exact path we passed it, and that text is what eventually
/// reaches the HTTP API (spec §13: no absolute path anywhere in it).
struct Failure {
    message: String,
    stderr_tail: Option<String>,
}

impl Failure {
    /// Everything that can fail *before* a backend is even running
    /// (making the tmp dir, the spawn itself) has no stderr to show —
    /// there was no process to produce any.
    fn plain(message: String) -> Self {
        Failure { message, stderr_tail: None }
    }

    /// A backend ran and then `wait_with_progress`/`wait_still`
    /// reported it failed. `tail` is that spawn's own `stderr_tail`
    /// handle, cloned by the caller before the spawn was consumed;
    /// `redact` is every path given to it on the command line, so the
    /// backend's own error text (often just that path plus "No such
    /// file or directory" or similar) never carries one through.
    fn from_wait(message: String, tail: &Arc<Mutex<String>>, redact: &[&Path]) -> Self {
        let raw = tail.lock().unwrap().clone();
        let stderr_tail = (!raw.trim().is_empty()).then(|| media_core::redact_paths(&raw, redact));
        Failure { message, stderr_tail }
    }
}

/// The actual blocking work: spawn the right backend, track it for
/// cancel, read progress (video only — spec §6: "oiiotool/magick
/// report start/finish only"), fsync and rename on success. Runs
/// inside `spawn_blocking` — ordinary synchronous code, same style as
/// `media_core::probe`.
fn run_conversion(queue: &Queue, job_id: &str, job: ConversionJob<'_>) -> Result<(), Failure> {
    let tmp = queue.cache.tmp_path(job_id);
    if let Some(dir) = tmp.parent() {
        std::fs::create_dir_all(dir).map_err(|e| Failure::plain(e.to_string()))?;
    }

    if job.verdict == Verdict::Render {
        let still = job.still
            .ok_or_else(|| Failure::plain("a render job with no still request".to_string()))?;
        let spawned = media_core::spawn_still_render(media_core::StillRenderArgs {
            backend_id: job.backend_id, backend_path: job.backend, input: job.input, out_tmp: &tmp,
            selection: &still.selection, width: still.width, height: still.height,
            max_long_edge: STILL_DERIVED_PARAMS.max_long_edge,
        }).map_err(|e| Failure::plain(e.to_string()))?;
        queue.running.lock().unwrap().insert(job_id.to_string(), spawned.child.clone());
        let tail = spawned.stderr_tail.clone();
        media_core::wait_still(spawned.child)
            .map_err(|e| Failure::from_wait(e, &tail, &[job.input, &tmp]))?;
    } else {
        let spawned = if job.verdict == Verdict::Remux {
            media_core::spawn_remux(job.backend, job.input, &tmp)
        } else {
            media_core::spawn_transcode(job.backend, job.input, &tmp, &DERIVED_PARAMS)
        }
        .map_err(|e| Failure::plain(e.to_string()))?;

        queue.running.lock().unwrap().insert(job_id.to_string(), spawned.child.clone());
        let tail = spawned.stderr_tail.clone();

        let job_id_for_progress = job_id.to_string();
        let progress = queue.progress.clone();
        media_core::wait_with_progress(spawned, job.duration_secs, move |p| {
            progress.lock().unwrap().insert(job_id_for_progress.clone(), p);
        })
        .map_err(|e| Failure::from_wait(e, &tail, &[job.input, &tmp]))?;
    }

    // A cancel may have killed the process and deleted `.part` just as
    // it was finishing successfully — check the output is still there
    // rather than fsync-ing and renaming nothing.
    if !tmp.exists() {
        return Err(Failure::plain("cancelled".to_string()));
    }

    // Opened read-write, not just `File::open` (read-only): Windows'
    // `FlushFileBuffers` (what `sync_all` calls there) needs write
    // access on the handle or it fails with "Access is denied" —
    // confirmed against a real run during this phase's verification.
    let file = std::fs::OpenOptions::new().write(true).open(&tmp)
        .map_err(|e| Failure::plain(e.to_string()))?;
    file.sync_all().map_err(|e| Failure::plain(e.to_string()))?;
    drop(file);

    let key = queue.cache.get_job(job_id).map(|j| j.key).unwrap_or_default();
    let final_path = queue.cache.entry_path(&key, output_ext(job.verdict));
    if let Some(dir) = final_path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| Failure::plain(e.to_string()))?;
    }
    std::fs::rename(&tmp, &final_path).map_err(|e| Failure::plain(e.to_string()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir()
                .join(format!("media-server-queue-test-{}-{name}", std::process::id()));
            std::fs::create_dir_all(&path).unwrap();
            TempDir(path)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn temp_queue(name: &str) -> (Queue, TempDir) {
        let dir = TempDir::new(name);
        let cache = Cache::open(dir.0.clone()).unwrap();
        (Queue::new(cache), dir)
    }

    fn fake_request(key: &'static str) -> EnqueueRequest<'static> {
        EnqueueRequest {
            key, priority: "requested",
            input: Path::new("Z:/does/not/exist.mp4"),
            verdict: Verdict::Remux,
            backend_id: "ffmpeg",
            backend: Path::new("Z:/does/not/exist/ffmpeg.exe"),
            duration_secs: None,
            still: None,
        }
    }

    #[tokio::test]
    async fn a_second_enqueue_for_the_same_key_attaches_to_the_first() {
        let (queue, _dir) = temp_queue("dedup");
        let a = queue.enqueue(fake_request("k1"));
        let b = queue.enqueue(fake_request("k1"));
        assert_eq!(a, b);
    }

    #[tokio::test]
    async fn different_keys_get_different_jobs() {
        let (queue, _dir) = temp_queue("dedup-different");
        let a = queue.enqueue(fake_request("k1"));
        let b = queue.enqueue(fake_request("k2"));
        assert_ne!(a, b);
    }

    /// Video and still jobs draw from separate semaphore pools (spec
    /// §6: "1 video job + 2 still jobs") — a saturated video queue
    /// must never block a still render, or vice versa. Checked
    /// directly on the (private, same-module) fields rather than
    /// through a dedup side effect, which can't actually distinguish
    /// the two pools (a real cache key already differs by backend id
    /// between a video and a still job, so two jobs ever sharing one
    /// key never happens in practice either way).
    #[tokio::test]
    async fn video_and_still_jobs_use_separate_semaphore_pools() {
        let (queue, _dir) = temp_queue("semaphore-pools");
        assert_eq!(queue.video_semaphore.available_permits(), MAX_VIDEO_JOBS);
        assert_eq!(queue.still_semaphore.available_permits(), MAX_STILL_JOBS);
        assert_ne!(MAX_VIDEO_JOBS, MAX_STILL_JOBS, "sanity: the two pools are actually configured differently");
    }

    #[tokio::test]
    async fn worker_status_reports_each_pools_fixed_cap_when_idle() {
        let (queue, _dir) = temp_queue("worker-status-idle");
        let status = queue.worker_status();
        assert_eq!(status.video_in_use, 0);
        assert_eq!(status.video_max, MAX_VIDEO_JOBS);
        assert_eq!(status.still_in_use, 0);
        assert_eq!(status.still_max, MAX_STILL_JOBS);
    }

    #[test]
    fn new_queue_requeues_running_jobs_and_clears_orphaned_parts() {
        let dir = TempDir::new("startup-recovery");
        let cache = Cache::open(dir.0.clone()).unwrap();
        let job = cache.create_job("k1", "requested", "ffmpeg", "in.mp4");
        cache.set_job_running(&job);
        let tmp = cache.tmp_path(&job);
        std::fs::create_dir_all(tmp.parent().unwrap()).unwrap();
        std::fs::write(&tmp, b"partial").unwrap();

        let _queue = Queue::new(cache.clone());

        assert_eq!(cache.get_job(&job).unwrap().state, JobState::Queued);
        assert!(!tmp.exists());
    }

    #[test]
    fn cancelling_an_unknown_job_is_a_quiet_no_op() {
        let (queue, _dir) = temp_queue("cancel-unknown");
        queue.cancel("not-a-real-job-id"); // must not panic
    }

    #[test]
    fn cancelling_a_queued_job_marks_it_cancelled() {
        let (queue, _dir) = temp_queue("cancel-queued");
        let id = queue.cache().create_job("k1", "requested", "ffmpeg", "in.mp4");
        queue.cancel(&id);
        assert_eq!(queue.cache().get_job(&id).unwrap().state, JobState::Cancelled);
    }
}
