// SPDX-License-Identifier: Apache-2.0
//! The background conversion queue (docs/media-server-spec.md §6):
//! dedup, a concurrency cap, and cancel. `media-core`'s `Cache` and
//! `convert` functions are plain synchronous code (no tokio
//! dependency there — see the plan); this is the async layer that
//! runs them concurrently, bounded, and cancellably, the same way
//! `scf-app/src-tauri/src/media.rs` already wraps `media_core::
//! detect_all` in a blocking task.

use std::collections::HashMap;
use std::process::Child;
use std::sync::{Arc, Mutex};

use media_core::{Cache, DerivedParams, JobState, Verdict};
use tokio::sync::Semaphore;

/// Not user-configurable yet (the plan's decision 7) — "default 1
/// video job" from spec §6, and there is no still pipeline yet to
/// need a separate cap.
const MAX_CONCURRENT_JOBS: usize = 1;

/// Not user-configurable yet (the plan's decision 7) — shared with
/// `serve.rs`, which needs the same values to compute a cache-key
/// lookup for the `/media` route that this module uses to actually run
/// the conversion.
pub(crate) const DERIVED_PARAMS: DerivedParams = DerivedParams { resolution_cap: 1080, crf: 23 };

#[derive(Clone)]
pub struct Queue {
    cache: Cache,
    semaphore: Arc<Semaphore>,
    /// Running jobs only — a cancel needs the actual OS process handle,
    /// which nothing in `Cache`'s SQLite rows can give it.
    running: Arc<Mutex<HashMap<String, Arc<Mutex<Child>>>>>,
    /// Live 0.0-1.0 progress, separate from `Cache`'s durable state —
    /// this changes many times a second while a job runs and has no
    /// business being a SQLite write each time.
    progress: Arc<Mutex<HashMap<String, f64>>>,
}

pub struct EnqueueRequest<'a> {
    pub key: &'a str,
    pub priority: &'a str,
    pub input: &'a std::path::Path,
    pub verdict: Verdict,
    pub ffmpeg: &'a std::path::Path,
    pub duration_secs: Option<f64>,
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
            semaphore: Arc::new(Semaphore::new(MAX_CONCURRENT_JOBS)),
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

    /// An existing queued/running job for `key` is reused (spec §6
    /// "Dedup"); otherwise a new one is created and its run spawned in
    /// the background. Either way returns the job id to poll.
    pub fn enqueue(&self, req: EnqueueRequest<'_>) -> String {
        if let Some(existing) = self.cache.active_job_for(req.key) {
            return existing;
        }
        let id = self.cache.create_job(req.key, req.priority);
        self.spawn_run(id.clone(), req);
        id
    }

    fn spawn_run(&self, id: String, req: EnqueueRequest<'_>) {
        let queue = self.clone();
        let key = req.key.to_string();
        let input = req.input.to_path_buf();
        let verdict = req.verdict;
        let ffmpeg = req.ffmpeg.to_path_buf();
        let duration_secs = req.duration_secs;

        tokio::spawn(async move {
            let permit = queue.semaphore.clone().acquire_owned().await;
            let Ok(_permit) = permit else { return }; // semaphore closed: shutting down

            // Cancelled while queued, before its turn came up.
            if queue.cache.get_job(&id).map(|j| j.state) != Some(JobState::Queued) {
                return;
            }
            queue.cache.set_job_running(&id);

            let id_for_run = id.clone();
            let queue_for_run = queue.clone();
            let result = tokio::task::spawn_blocking(move || {
                run_conversion(&queue_for_run, &id_for_run, &ffmpeg, &input, verdict, duration_secs)
            })
            .await;

            queue.running.lock().unwrap().remove(&id);
            queue.progress.lock().unwrap().remove(&id);

            match result {
                Ok(Ok(())) => {
                    let path = queue.cache.entry_path(&key);
                    let bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                    let kind = if verdict == Verdict::Remux { "remux" } else { "transcode" };
                    queue.cache.put_entry(&key, &path.display().to_string(), bytes, kind);
                    queue.cache.set_job_done(&id);
                }
                Ok(Err(e)) => {
                    queue.cache.record_failure(&key, &e);
                    queue.cache.set_job_failed(&id, &e);
                }
                Err(_join_error) => {
                    // The blocking task panicked — treat it the same as
                    // any other failure, never propagate a panic out of
                    // this background task.
                    let msg = "conversion task panicked".to_string();
                    queue.cache.record_failure(&key, &msg);
                    queue.cache.set_job_failed(&id, &msg);
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

/// The actual blocking work: spawn ffmpeg, track it for cancel, read
/// its progress, fsync and rename on success. Runs inside
/// `spawn_blocking` — ordinary synchronous code, same style as
/// `media_core::probe`.
fn run_conversion(
    queue: &Queue, job_id: &str, ffmpeg: &std::path::Path, input: &std::path::Path,
    verdict: Verdict, duration_secs: Option<f64>,
) -> Result<(), String> {
    let tmp = queue.cache.tmp_path(job_id);
    if let Some(dir) = tmp.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }

    let spawned = if verdict == Verdict::Remux {
        media_core::spawn_remux(ffmpeg, input, &tmp)
    } else {
        media_core::spawn_transcode(ffmpeg, input, &tmp, &DERIVED_PARAMS)
    }
    .map_err(|e| e.to_string())?;

    queue.running.lock().unwrap().insert(job_id.to_string(), spawned.child.clone());

    let job_id_for_progress = job_id.to_string();
    let progress = queue.progress.clone();
    media_core::wait_with_progress(spawned, duration_secs, move |p| {
        progress.lock().unwrap().insert(job_id_for_progress.clone(), p);
    })?;

    // A cancel may have killed the process and deleted `.part` just as
    // it was finishing successfully — check the output is still there
    // rather than fsync-ing and renaming nothing.
    if !tmp.exists() {
        return Err("cancelled".to_string());
    }

    // Opened read-write, not just `File::open` (read-only): Windows'
    // `FlushFileBuffers` (what `sync_all` calls there) needs write
    // access on the handle or it fails with "Access is denied" —
    // confirmed against a real run during this phase's verification.
    let file = std::fs::OpenOptions::new().write(true).open(&tmp).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);

    let key = queue.cache.get_job(job_id).map(|j| j.key).unwrap_or_default();
    let final_path = queue.cache.entry_path(&key);
    if let Some(dir) = final_path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, &final_path).map_err(|e| e.to_string())?;
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
            ffmpeg: Path::new("Z:/does/not/exist/ffmpeg.exe"),
            duration_secs: None,
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

    #[test]
    fn new_queue_requeues_running_jobs_and_clears_orphaned_parts() {
        let dir = TempDir::new("startup-recovery");
        let cache = Cache::open(dir.0.clone()).unwrap();
        let job = cache.create_job("k1", "requested");
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
        let id = queue.cache().create_job("k1", "requested");
        queue.cancel(&id);
        assert_eq!(queue.cache().get_job(&id).unwrap().state, JobState::Cancelled);
    }
}
