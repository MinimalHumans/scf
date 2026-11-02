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
//!
//! Phase 8 adds real priority preemption (spec §6 "Priority... Preview
//! jobs preempt: pause or cancel lowest-priority running job when
//! slots are full" — [`Queue::preempt_if_needed`]/[`Queue::preempt`])
//! and an automatic hardware-encoder fallback: a transcode started
//! with `derived_params.hardware_encoder` set that fails is retried
//! once with the software encoder before being recorded as a real
//! failure (see `run_conversion`).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use media_core::{Cache, DerivedParams, JobState, StillDerivedParams, StillSelection, Verdict};
use serde::Serialize;
use tokio::sync::Semaphore;

/// Settings > Media's "Worker threads" defaults — the same figures this
/// module used to hardcode as fixed `MAX_VIDEO_JOBS`/`MAX_STILL_JOBS`
/// consts, now just what [`QueueConfig::default`] falls back to when
/// the caller (`scf-app/src-tauri`'s startup, reading app.db) has
/// nothing saved yet.
const DEFAULT_VIDEO_WORKERS: usize = 1;
const DEFAULT_STILL_WORKERS: usize = 2;

/// Worker-pool sizing (spec §6 "Concurrency... user-configurable cap").
/// Read once, at [`Queue::new`] — a tokio [`Semaphore`] has no clean way
/// to shrink its permit count at runtime, so a changed setting takes
/// effect at the next app launch, not live (Settings > Media says so).
#[derive(Clone, Copy)]
pub struct QueueConfig {
    pub video_workers: usize,
    pub still_workers: usize,
}

impl Default for QueueConfig {
    fn default() -> Self {
        QueueConfig { video_workers: DEFAULT_VIDEO_WORKERS, still_workers: DEFAULT_STILL_WORKERS }
    }
}

/// The subset of Settings > Media that *can* change live, without a
/// restart: the default proxy resolution and the two cache-kind caps
/// (split from the UI's single "global cache limit" GB figure by
/// `media_core::split_cache_cap`). Plain atomics, not a `Mutex`-guarded
/// struct — every reader just wants the current number, never a
/// consistent snapshot of more than one field at once, and this is read
/// on every `/media` request.
#[derive(Clone)]
pub struct RuntimeSettings {
    resolution_cap: Arc<AtomicU32>,
    video_cap_bytes: Arc<AtomicU64>,
    still_cap_bytes: Arc<AtomicU64>,
}

impl RuntimeSettings {
    pub fn new(resolution_cap: u32, cache_limit_bytes: u64) -> Self {
        let (video, still) = media_core::split_cache_cap(cache_limit_bytes);
        RuntimeSettings {
            resolution_cap: Arc::new(AtomicU32::new(resolution_cap)),
            video_cap_bytes: Arc::new(AtomicU64::new(video)),
            still_cap_bytes: Arc::new(AtomicU64::new(still)),
        }
    }

    pub fn resolution_cap(&self) -> u32 {
        self.resolution_cap.load(Ordering::Relaxed)
    }

    pub fn video_cap_bytes(&self) -> u64 {
        self.video_cap_bytes.load(Ordering::Relaxed)
    }

    pub fn still_cap_bytes(&self) -> u64 {
        self.still_cap_bytes.load(Ordering::Relaxed)
    }

    pub fn set_resolution_cap(&self, n: u32) {
        self.resolution_cap.store(n, Ordering::Relaxed);
    }

    /// Re-splits `total_bytes` the same way `new` did, so a later change
    /// to the one GB figure the UI shows keeps the two pools at the same
    /// ratio rather than drifting independently.
    pub fn set_cache_limit_bytes(&self, total_bytes: u64) {
        let (video, still) = media_core::split_cache_cap(total_bytes);
        self.video_cap_bytes.store(video, Ordering::Relaxed);
        self.still_cap_bytes.store(still, Ordering::Relaxed);
    }
}

impl Default for RuntimeSettings {
    fn default() -> Self {
        RuntimeSettings::new(
            1080, media_core::DEFAULT_VIDEO_CAP_BYTES + media_core::DEFAULT_STILL_CAP_BYTES)
    }
}

/// The software-encoder defaults (spec §7's output profile) — CRF isn't
/// user-configurable yet, same as before Phase 8; `resolution_cap` now
/// comes from [`RuntimeSettings`] (Settings > Media's "Default proxy
/// resolution"). `serve.rs` starts from this and fills in
/// `hardware_encoder` itself (from `Backends::best_hw_encoder`, which
/// this function deliberately takes no dependency on) before computing
/// its cache-key lookup for the `/media` route, so the two agree on
/// everything else without this module needing a `Backends` of its own.
pub(crate) fn default_derived_params(resolution_cap: u32) -> DerivedParams {
    DerivedParams { resolution_cap, crf: 23, layer: None, channel: None, hardware_encoder: None }
}

/// Phase 5's still output profile (spec §7) — shared with `serve.rs`
/// for the same reason `default_derived_params` is.
pub(crate) const STILL_DERIVED_PARAMS: StillDerivedParams = StillDerivedParams { max_long_edge: 2048 };

/// Spec §6's three priority tiers. `Ord`'s derived order follows
/// declaration order, deliberately low to high, so a plain `<`/`min_by`
/// reads the same way the spec lists them: "preview... > requested...
/// > background".
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Priority {
    Background,
    Requested,
    Preview,
}

impl Priority {
    fn parse(s: &str) -> Self {
        match s {
            "preview" => Priority::Preview,
            "background" => Priority::Background,
            _ => Priority::Requested,
        }
    }
}

/// Which semaphore pool a job draws from — spec §6's "1 video job + 2
/// still jobs" split, named here so preemption can compare like with
/// like (a saturated still pool never preempts a video job, or vice
/// versa — see `Queue::preempt_if_needed`).
#[derive(Clone, Copy, PartialEq, Eq)]
enum Pool {
    Video,
    Still,
}

fn pool_of(verdict: Verdict) -> Pool {
    if verdict == Verdict::Render { Pool::Still } else { Pool::Video }
}

#[derive(Clone)]
pub struct Queue {
    cache: Cache,
    /// Separate pools (spec §6: "1 video job + 2 still jobs") — a
    /// burst of still-render requests must not starve, or be starved
    /// by, a single running video conversion.
    video_semaphore: Arc<Semaphore>,
    still_semaphore: Arc<Semaphore>,
    /// Each pool's configured size (`QueueConfig`, read once at `new`) —
    /// `worker_status` needs these directly now that they're no longer
    /// fixed consts a reader could just name.
    video_max: usize,
    still_max: usize,
    /// Settings > Media's live-updatable knobs (resolution cap, cache
    /// caps) — shared via `Arc`, so every clone of this `Queue` (one per
    /// in-flight HTTP connection — see `lib.rs`'s `ctx.clone()`) sees a
    /// setting change the instant `RuntimeSettings::set_*` is called.
    runtime: RuntimeSettings,
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
    /// Phase 8: every not-yet-terminal job's full request, owned and
    /// keyed by job id — enough to call `spawn_run` again when
    /// `preempt` kills it, from a context (the background task's own
    /// result handling) that has nothing left of the original caller's
    /// borrowed `EnqueueRequest` to reuse.
    pending: Arc<Mutex<HashMap<String, PendingSpec>>>,
    /// Job ids currently being killed *for preemption*, not a real
    /// cancel or failure — `spawn_run`'s result handling checks this
    /// (and removes the entry) to decide whether a killed job's exit
    /// means "requeue it" or "it really failed."
    preempted: Arc<Mutex<HashSet<String>>>,
    /// A running job's priority and pool, kept alongside `running`
    /// rather than folded into it — this is purely additive, so
    /// `running`'s existing shape and every call site that reads it
    /// stays untouched. What `preempt_if_needed` scans to find the
    /// lowest-priority running job to displace.
    running_priority: Arc<Mutex<HashMap<String, (Priority, Pool)>>>,
}

/// Spec §9 dashboard's "Worker status: slots in use". `_max` is each
/// pool's configured cap (`QueueConfig`, fixed for the life of this
/// process), included so the frontend never hardcodes it a second time.
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
/// to decide whether `still_convert`'s resize cap applies. `Clone`
/// (Phase 8) so a [`PendingSpec`] can own a copy for a preempted job's
/// retry.
#[derive(Clone)]
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
    /// Phase 8: the resolved output profile, including which hardware
    /// encoder (if any) to use — `serve.rs` builds this once per
    /// request (it already needs it for the cache key) and hands it
    /// straight through rather than this module re-deriving it.
    pub derived_params: DerivedParams,
}

/// Phase 8: everything [`Queue::spawn_run`] needs, owned rather than
/// borrowed. An [`EnqueueRequest`] borrows from its caller's stack and
/// can't outlive that one call; a preempted job's retry happens later,
/// from inside the preempted job's *own* background task, long after
/// the HTTP request that originally created it has returned.
#[derive(Clone)]
struct PendingSpec {
    key: String,
    priority: String,
    input: PathBuf,
    verdict: Verdict,
    backend_id: String,
    backend: PathBuf,
    duration_secs: Option<f64>,
    still: Option<StillRenderRequest>,
    derived_params: DerivedParams,
}

impl PendingSpec {
    fn from_request(req: &EnqueueRequest<'_>) -> Self {
        PendingSpec {
            key: req.key.to_string(), priority: req.priority.to_string(),
            input: req.input.to_path_buf(), verdict: req.verdict,
            backend_id: req.backend_id.to_string(), backend: req.backend.to_path_buf(),
            duration_secs: req.duration_secs, still: req.still.clone(),
            derived_params: req.derived_params.clone(),
        }
    }

    fn as_request(&self) -> EnqueueRequest<'_> {
        EnqueueRequest {
            key: &self.key, priority: &self.priority, input: &self.input, verdict: self.verdict,
            backend_id: &self.backend_id, backend: &self.backend, duration_secs: self.duration_secs,
            still: self.still.clone(), derived_params: self.derived_params.clone(),
        }
    }
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
    pub fn new(cache: Cache, config: QueueConfig, runtime: RuntimeSettings) -> Self {
        // Startup recovery — spec §6: a `running` row survived a crash,
        // not a job that's still going; an orphaned `.part` belongs to
        // no job once every `running` row above it is gone.
        cache.reset_running_to_queued();
        media_core::delete_orphaned_parts(cache.dir());
        Queue {
            cache,
            video_semaphore: Arc::new(Semaphore::new(config.video_workers)),
            still_semaphore: Arc::new(Semaphore::new(config.still_workers)),
            video_max: config.video_workers,
            still_max: config.still_workers,
            runtime,
            running: Arc::new(Mutex::new(HashMap::new())),
            progress: Arc::new(Mutex::new(HashMap::new())),
            pending: Arc::new(Mutex::new(HashMap::new())),
            preempted: Arc::new(Mutex::new(HashSet::new())),
            running_priority: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn cache(&self) -> &Cache {
        &self.cache
    }

    /// Settings > Media's live knobs — see [`RuntimeSettings`].
    pub fn runtime(&self) -> &RuntimeSettings {
        &self.runtime
    }

    pub fn progress_of(&self, job_id: &str) -> Option<f64> {
        self.progress.lock().unwrap().get(job_id).copied()
    }

    /// Slots in use vs. each pool's configured cap (`QueueConfig`) —
    /// spec §9's dashboard "Worker status". Counting `_max -
    /// available_permits()` rather than `self.running`'s own length: a
    /// permit is held for the whole spawned task, including the brief
    /// window after it's acquired but before `run_conversion` inserts
    /// into `running`, so `running.len()` would undercount a job that's
    /// just about to start.
    pub fn worker_status(&self) -> WorkerStatus {
        WorkerStatus {
            video_in_use: self.video_max - self.video_semaphore.available_permits(),
            video_max: self.video_max,
            still_in_use: self.still_max - self.still_semaphore.available_permits(),
            still_max: self.still_max,
        }
    }

    /// An existing queued/running job for `key` is reused (spec §6
    /// "Dedup"); otherwise a new one is created and its run spawned in
    /// the background. Either way returns the job id to poll.
    ///
    /// Phase 8: a genuinely new job starts waiting for a slot first,
    /// then — only for this new job, dedup already returned above for
    /// anything already in flight — `preempt_if_needed` may kill a
    /// lower-priority running job in the same pool to free one sooner
    /// (spec §6 "Priority... Preview jobs preempt").
    pub fn enqueue(&self, req: EnqueueRequest<'_>) -> String {
        if let Some(existing) = self.cache.active_job_for(req.key) {
            return existing;
        }
        let id = self.cache.create_job(
            req.key, req.priority, req.backend_id, &req.input.display().to_string());
        self.pending.lock().unwrap().insert(id.clone(), PendingSpec::from_request(&req));
        let priority = Priority::parse(req.priority);
        let pool = pool_of(req.verdict);
        self.spawn_run(id.clone(), req);
        self.preempt_if_needed(priority, pool);
        id
    }

    /// Spec §6: "preview jobs preempt: pause or cancel lowest-priority
    /// running job when slots are full." Only ever fires for a
    /// genuinely new job — a no-op when its pool has an idle slot (the
    /// new job's own semaphore wait will resolve on its own), or when
    /// every running job in that pool is already at or above its
    /// priority (there's nothing lower to displace).
    fn preempt_if_needed(&self, priority: Priority, pool: Pool) {
        let full = match pool {
            Pool::Video => self.video_semaphore.available_permits() == 0,
            Pool::Still => self.still_semaphore.available_permits() == 0,
        };
        if !full {
            return;
        }
        let victim = self.running_priority.lock().unwrap().iter()
            .filter(|(_, (p, pl))| *pl == pool && *p < priority)
            .min_by_key(|(_, (p, _))| *p)
            .map(|(id, _)| id.clone());
        if let Some(id) = victim {
            self.preempt(&id);
        }
    }

    /// Kills a running job to free its slot for something higher-
    /// priority, and marks it so `spawn_run`'s result handling retries
    /// it (from its saved [`PendingSpec`]) instead of recording a
    /// failure — this crate's queue picks "cancel" over "pause" from
    /// spec §6's either/or. The job keeps its id and tries again once
    /// a slot is next free, same as any other queued job.
    fn preempt(&self, job_id: &str) {
        self.preempted.lock().unwrap().insert(job_id.to_string());
        if let Some(child) = self.running.lock().unwrap().get(job_id).cloned() {
            let _ = child.lock().unwrap().kill();
        }
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
        let derived_params = req.derived_params;
        let priority = Priority::parse(req.priority);
        let pool = pool_of(verdict);
        let semaphore = match pool {
            Pool::Still => queue.still_semaphore.clone(),
            Pool::Video => queue.video_semaphore.clone(),
        };

        tokio::spawn(async move {
            let permit = semaphore.acquire_owned().await;
            let Ok(_permit) = permit else { return }; // semaphore closed: shutting down

            // Cancelled while queued, before its turn came up.
            if queue.cache.get_job(&id).map(|j| j.state) != Some(JobState::Queued) {
                queue.pending.lock().unwrap().remove(&id);
                queue.preempted.lock().unwrap().remove(&id);
                return;
            }
            queue.cache.set_job_running(&id);
            queue.running_priority.lock().unwrap().insert(id.clone(), (priority, pool));

            let id_for_run = id.clone();
            let queue_for_run = queue.clone();
            let result = tokio::task::spawn_blocking(move || {
                run_conversion(&queue_for_run, &id_for_run, ConversionJob {
                    backend_id: &backend_id, backend: &backend, input: &input,
                    verdict, duration_secs, still, derived_params: &derived_params,
                })
            })
            .await;

            queue.running.lock().unwrap().remove(&id);
            queue.running_priority.lock().unwrap().remove(&id);
            queue.progress.lock().unwrap().remove(&id);

            // Killed on purpose by `preempt`, not a real failure — back
            // to `queued` and try again from the top, from the same
            // `PendingSpec` this job was created with.
            if queue.preempted.lock().unwrap().remove(&id) {
                queue.cache.set_job_queued(&id);
                if let Some(spec) = queue.pending.lock().unwrap().get(&id).cloned() {
                    queue.spawn_run(id.clone(), spec.as_request());
                }
                return;
            }

            match result {
                Ok(Ok(())) => {
                    let path = queue.cache.entry_path(&key, output_ext(verdict));
                    let bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                    queue.cache.put_entry(&key, &path.display().to_string(), bytes, kind_str(verdict));
                    queue.cache.set_job_done(&id);
                    queue.pending.lock().unwrap().remove(&id);
                }
                Ok(Err(f)) => {
                    // A real user cancel (`Queue::cancel`, not
                    // `preempt`) already set this job's final state
                    // synchronously, before this task's kill even
                    // resolved — never downgrade that back to `failed`
                    // just because the killed process's own exit looks
                    // like any other failure from here.
                    if queue.cache.get_job(&id).map(|j| j.state) != Some(JobState::Cancelled) {
                        queue.cache.record_failure(&key, &f.message);
                        queue.cache.set_job_failed(&id, &f.message, f.stderr_tail.as_deref());
                    }
                    queue.pending.lock().unwrap().remove(&id);
                }
                Err(_join_error) => {
                    // The blocking task panicked — treat it the same as
                    // any other failure, never propagate a panic out of
                    // this background task.
                    let msg = "conversion task panicked".to_string();
                    queue.cache.record_failure(&key, &msg);
                    queue.cache.set_job_failed(&id, &msg, None);
                    queue.pending.lock().unwrap().remove(&id);
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
        self.running_priority.lock().unwrap().remove(job_id);
        // A real cancel always wins over an in-flight preemption retry
        // for the same job — never let `spawn_run`'s result handling
        // requeue something the user just asked to stop.
        self.preempted.lock().unwrap().remove(job_id);
        self.pending.lock().unwrap().remove(job_id);
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
    derived_params: &'a DerivedParams,
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
            media_core::spawn_transcode(job.backend, job.input, &tmp, job.derived_params)
        }
        .map_err(|e| Failure::plain(e.to_string()))?;

        queue.running.lock().unwrap().insert(job_id.to_string(), spawned.child.clone());
        let tail = spawned.stderr_tail.clone();

        let job_id_for_progress = job_id.to_string();
        let progress = queue.progress.clone();
        let result = media_core::wait_with_progress(spawned, job.duration_secs, {
            let progress = progress.clone();
            let job_id_for_progress = job_id_for_progress.clone();
            move |p| { progress.lock().unwrap().insert(job_id_for_progress.clone(), p); }
        });

        if let Err(e) = result {
            // Phase 8: a hardware encoder failing (missing driver,
            // VRAM, a codec this GPU's encoder doesn't actually
            // support despite being listed in `ffmpeg -encoders`)
            // falls back to the software encoder once, transparently
            // — never a job failure the user has to notice and retry
            // by hand. Only for a transcode: remux never chose an
            // encoder to begin with, so there's nothing to fall back
            // from.
            let can_fall_back =
                job.verdict == Verdict::Transcode && job.derived_params.hardware_encoder.is_some();
            if !can_fall_back {
                return Err(Failure::from_wait(e, &tail, &[job.input, &tmp]));
            }
            let software = DerivedParams { hardware_encoder: None, ..job.derived_params.clone() };
            let retry = media_core::spawn_transcode(job.backend, job.input, &tmp, &software)
                .map_err(|e| Failure::plain(e.to_string()))?;
            queue.running.lock().unwrap().insert(job_id.to_string(), retry.child.clone());
            let retry_tail = retry.stderr_tail.clone();
            media_core::wait_with_progress(retry, job.duration_secs, move |p| {
                progress.lock().unwrap().insert(job_id_for_progress.clone(), p);
            })
            .map_err(|e| Failure::from_wait(e, &retry_tail, &[job.input, &tmp]))?;
        }
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
        (Queue::new(cache, QueueConfig::default(), RuntimeSettings::default()), dir)
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
            derived_params: DerivedParams::default(),
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
        assert_eq!(queue.video_semaphore.available_permits(), DEFAULT_VIDEO_WORKERS);
        assert_eq!(queue.still_semaphore.available_permits(), DEFAULT_STILL_WORKERS);
        assert_ne!(DEFAULT_VIDEO_WORKERS, DEFAULT_STILL_WORKERS, "sanity: the two pools are actually configured differently");
    }

    #[tokio::test]
    async fn worker_status_reports_each_pools_fixed_cap_when_idle() {
        let (queue, _dir) = temp_queue("worker-status-idle");
        let status = queue.worker_status();
        assert_eq!(status.video_in_use, 0);
        assert_eq!(status.video_max, DEFAULT_VIDEO_WORKERS);
        assert_eq!(status.still_in_use, 0);
        assert_eq!(status.still_max, DEFAULT_STILL_WORKERS);
    }

    #[tokio::test]
    async fn a_custom_queue_config_sizes_both_pools() {
        let dir = TempDir::new("custom-config");
        let cache = Cache::open(dir.0.clone()).unwrap();
        let queue = Queue::new(
            cache, QueueConfig { video_workers: 3, still_workers: 5 }, RuntimeSettings::default());
        let status = queue.worker_status();
        assert_eq!(status.video_max, 3);
        assert_eq!(status.still_max, 5);
    }

    #[test]
    fn runtime_settings_can_be_updated_live() {
        let runtime = RuntimeSettings::new(1080, 2 * 1024 * 1024 * 1024 + 512 * 1024 * 1024);
        assert_eq!(runtime.resolution_cap(), 1080);
        runtime.set_resolution_cap(720);
        assert_eq!(runtime.resolution_cap(), 720);

        let before_video = runtime.video_cap_bytes();
        runtime.set_cache_limit_bytes(10 * 1024 * 1024 * 1024);
        assert!(runtime.video_cap_bytes() > before_video);
        assert_eq!(runtime.video_cap_bytes() + runtime.still_cap_bytes(), 10 * 1024 * 1024 * 1024);
    }

    /// Phase 8's preemption policy, exercised directly (same module, so
    /// private fields and `Priority`/`Pool` are reachable) rather than
    /// through a real running backend — a real `ffmpeg` would exit
    /// almost instantly against the nonexistent paths these other
    /// tests use, long before any preemption decision could matter.
    #[tokio::test]
    async fn preempt_if_needed_picks_the_lowest_priority_running_job_in_the_same_pool() {
        let (queue, _dir) = temp_queue("preempt-pick");
        queue.running_priority.lock().unwrap()
            .insert("bg".to_string(), (Priority::Background, Pool::Video));
        queue.running_priority.lock().unwrap()
            .insert("req".to_string(), (Priority::Requested, Pool::Video));
        let _permit = queue.video_semaphore.try_acquire().unwrap(); // pool now full
        queue.preempt_if_needed(Priority::Preview, Pool::Video);
        let preempted = queue.preempted.lock().unwrap();
        assert!(preempted.contains("bg"), "should have preempted the lower-priority job");
        assert!(!preempted.contains("req"));
    }

    #[tokio::test]
    async fn preempt_if_needed_does_nothing_when_the_pool_has_room() {
        let (queue, _dir) = temp_queue("preempt-room");
        queue.running_priority.lock().unwrap()
            .insert("bg".to_string(), (Priority::Background, Pool::Video));
        // No permit taken — the pool still has an idle slot.
        queue.preempt_if_needed(Priority::Preview, Pool::Video);
        assert!(queue.preempted.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn preempt_if_needed_does_nothing_when_nothing_running_outranks_it() {
        let (queue, _dir) = temp_queue("preempt-none-lower");
        queue.running_priority.lock().unwrap()
            .insert("already-preview".to_string(), (Priority::Preview, Pool::Video));
        let _permit = queue.video_semaphore.try_acquire().unwrap();
        queue.preempt_if_needed(Priority::Preview, Pool::Video);
        assert!(queue.preempted.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn preempt_if_needed_never_reaches_into_a_different_pool() {
        let (queue, _dir) = temp_queue("preempt-pool-isolation");
        queue.running_priority.lock().unwrap()
            .insert("bg-still".to_string(), (Priority::Background, Pool::Still));
        let _permit = queue.video_semaphore.try_acquire().unwrap(); // video pool full, still pool untouched
        queue.preempt_if_needed(Priority::Preview, Pool::Video);
        assert!(queue.preempted.lock().unwrap().is_empty());
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

        let _queue = Queue::new(cache.clone(), QueueConfig::default(), RuntimeSettings::default());

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
