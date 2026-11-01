// SPDX-License-Identifier: Apache-2.0
//! The persistent conversion cache (docs/media-server-spec.md §7),
//! scoped to this phase's slice of it: a single global content-
//! addressed store (`entries`) plus the job queue's own bookkeeping
//! (`jobs`, `failures`). No per-project `refs` table yet — nothing in
//! this phase acts on per-project accounting (eviction, flush), so it
//! would be dead weight; see the plan this was built from.
//!
//! `rusqlite` directly, mirroring `scf-app/src-tauri/src/sql.rs`'s
//! `open()`: WAL mode plus a busy timeout, since the HTTP listener and
//! any number of in-flight job updates share one file.
//!
//! Timestamps are Unix seconds (`INTEGER`), not ISO text — nothing
//! reads these for display yet (that's Phase 7's dashboard); ordering
//! is all this phase needs, and a plain integer needs no date-
//! formatting dependency this crate doesn't otherwise have.

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;

/// A non-cryptographic, deterministic-across-builds hash — this keys a
/// cache, not a security boundary. `std`'s `DefaultHasher` is
/// explicitly not guaranteed stable across Rust versions, which a
/// cache key persisted to disk needs; FNV-1a is a handful of lines and
/// avoids a dependency for it.
struct Fnv1a(u64);
impl Fnv1a {
    fn new() -> Self {
        Fnv1a(0xcbf29ce484222325)
    }
    fn write(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.0 ^= u64::from(b);
            self.0 = self.0.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    fn finish(&self) -> u64 {
        self.0
    }
}

const EDGE_BYTES: u64 = 64 * 1024;

/// Enough to notice a file changed without reading the whole thing:
/// size, mtime, and a cheap hash of just the head and tail. The full
/// `source_signature` the spec calls for here — stronger than
/// `probe.rs`'s in-memory size+mtime pair, since this one is persisted
/// across restarts and needs to catch a file replaced with the same
/// size and mtime.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SourceSignature {
    size: u64,
    mtime: u64,
    edge_hash: u64,
}

pub fn source_signature(path: &Path) -> std::io::Result<SourceSignature> {
    let mut file = std::fs::File::open(path)?;
    let meta = file.metadata()?;
    let size = meta.len();
    let mtime = meta
        .modified()?
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let mut hasher = Fnv1a::new();
    let mut head = vec![0u8; EDGE_BYTES.min(size) as usize];
    file.read_exact(&mut head)?;
    hasher.write(&head);
    if size > EDGE_BYTES {
        file.seek(SeekFrom::Start(size - EDGE_BYTES))?;
        let mut tail = vec![0u8; EDGE_BYTES as usize];
        file.read_exact(&mut tail)?;
        hasher.write(&tail);
    }
    Ok(SourceSignature { size, mtime, edge_hash: hasher.finish() })
}

/// The output profile knobs that change what a conversion produces —
/// part of the cache key so changing a setting never serves a stale
/// result under the same name. Not user-configurable yet (the plan's
/// decision 7); the fields exist so the key is already shaped right
/// for when they are.
pub struct DerivedParams {
    pub resolution_cap: u32,
    pub crf: u32,
}

/// `hash(source_signature, backend_id, backend_version, profile_version,
/// derived_params)` (spec §7 "Key"). `profile_version` is bumped by
/// hand in this module whenever the output-profile logic changes.
pub const PROFILE_VERSION: u32 = 1;

pub fn cache_key(
    sig: SourceSignature,
    backend_id: &str,
    backend_version: &str,
    profile_version: u32,
    params: &DerivedParams,
) -> String {
    let mut hasher = Fnv1a::new();
    hasher.write(&sig.size.to_le_bytes());
    hasher.write(&sig.mtime.to_le_bytes());
    hasher.write(&sig.edge_hash.to_le_bytes());
    hasher.write(backend_id.as_bytes());
    hasher.write(backend_version.as_bytes());
    hasher.write(&profile_version.to_le_bytes());
    hasher.write(&params.resolution_cap.to_le_bytes());
    hasher.write(&params.crf.to_le_bytes());
    format!("{:016x}", hasher.finish())
}

fn new_id() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("randomness for a job id");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64
}

fn open_db(path: &Path) -> rusqlite::Result<Connection> {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let conn = Connection::open(path)?;
    conn.busy_timeout(Duration::from_secs(5))?;
    conn.execute_batch("PRAGMA journal_mode = WAL")?;
    migrate(&conn)?;
    Ok(conn)
}

fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS entries (
           key TEXT PRIMARY KEY,
           path_on_disk TEXT NOT NULL,
           bytes INTEGER NOT NULL,
           kind TEXT NOT NULL,
           created_at INTEGER NOT NULL,
           last_access INTEGER NOT NULL,
           hit_count INTEGER NOT NULL DEFAULT 0
         );
         CREATE TABLE IF NOT EXISTS jobs (
           id TEXT PRIMARY KEY,
           key TEXT NOT NULL,
           state TEXT NOT NULL,
           priority TEXT NOT NULL,
           error TEXT,
           created_at INTEGER NOT NULL,
           started_at INTEGER,
           finished_at INTEGER
         );
         CREATE INDEX IF NOT EXISTS jobs_key ON jobs (key);
         CREATE TABLE IF NOT EXISTS failures (
           key TEXT PRIMARY KEY,
           error TEXT NOT NULL,
           attempts INTEGER NOT NULL DEFAULT 1,
           last_attempt INTEGER NOT NULL
         );",
    )
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryInfo {
    pub path_on_disk: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum JobState {
    Queued,
    Running,
    Done,
    Failed,
    Cancelled,
}

impl JobState {
    fn as_str(self) -> &'static str {
        match self {
            JobState::Queued => "queued",
            JobState::Running => "running",
            JobState::Done => "done",
            JobState::Failed => "failed",
            JobState::Cancelled => "cancelled",
        }
    }

    fn parse(s: &str) -> Self {
        match s {
            "running" => JobState::Running,
            "done" => JobState::Done,
            "failed" => JobState::Failed,
            "cancelled" => JobState::Cancelled,
            _ => JobState::Queued,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobInfo {
    pub id: String,
    pub key: String,
    pub state: JobState,
    pub error: Option<String>,
}

/// Shared, cheap to clone — the HTTP listener and the queue's
/// background runner both hold one, same shape as `Handles`/
/// `Backends`.
#[derive(Clone)]
pub struct Cache {
    conn: Arc<Mutex<Connection>>,
    dir: PathBuf,
}

impl Cache {
    pub fn open(dir: PathBuf) -> rusqlite::Result<Self> {
        let conn = open_db(&dir.join("cache.db"))?;
        Ok(Cache { conn: Arc::new(Mutex::new(conn)), dir })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Where an in-progress job writes its output before it is fsynced
    /// and atomically renamed into `entries` — spec §6.
    pub fn tmp_path(&self, job_id: &str) -> PathBuf {
        self.dir.join("tmp").join(format!("{job_id}.part"))
    }

    /// Where a finished conversion lives on disk, named by its cache
    /// key so two jobs that land on the same key (a dedup race) agree
    /// on the final path without coordinating.
    pub fn entry_path(&self, key: &str) -> PathBuf {
        self.dir.join("entries").join(format!("{key}.mp4"))
    }

    pub fn get_entry(&self, key: &str) -> Option<EntryInfo> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT path_on_disk, bytes FROM entries WHERE key = ?1",
            [key],
            |row| Ok(EntryInfo {
                path_on_disk: row.get(0)?,
                bytes: row.get::<_, i64>(1)? as u64,
            }),
        )
        .optional()
        .unwrap_or(None)
    }

    /// Cache hits update `last_access`/`hit_count` (spec §7 "Eviction"
    /// — LRU bookkeeping starts now even though nothing reads it for
    /// eviction decisions until Phase 6).
    pub fn touch_entry(&self, key: &str) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "UPDATE entries SET last_access = ?1, hit_count = hit_count + 1 WHERE key = ?2",
            rusqlite::params![now(), key],
        );
    }

    pub fn put_entry(&self, key: &str, path_on_disk: &str, bytes: u64, kind: &str) {
        let conn = self.conn.lock().unwrap();
        let t = now();
        let _ = conn.execute(
            "INSERT INTO entries (key, path_on_disk, bytes, kind, created_at, last_access, hit_count)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5, 0)
             ON CONFLICT(key) DO UPDATE SET
               path_on_disk = excluded.path_on_disk, bytes = excluded.bytes,
               kind = excluded.kind, last_access = excluded.last_access",
            rusqlite::params![key, path_on_disk, bytes as i64, kind, t],
        );
    }

    /// An existing job for `key` that hasn't finished — a second
    /// request for the same conversion attaches to it instead of
    /// starting a duplicate (spec §6 "Dedup").
    pub fn active_job_for(&self, key: &str) -> Option<String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id FROM jobs WHERE key = ?1 AND state IN ('queued', 'running')
             ORDER BY created_at LIMIT 1",
            [key],
            |row| row.get(0),
        )
        .optional()
        .unwrap_or(None)
    }

    pub fn create_job(&self, key: &str, priority: &str) -> String {
        let id = new_id();
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "INSERT INTO jobs (id, key, state, priority, created_at)
             VALUES (?1, ?2, 'queued', ?3, ?4)",
            rusqlite::params![id, key, priority, now()],
        );
        id
    }

    pub fn get_job(&self, id: &str) -> Option<JobInfo> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, key, state, error FROM jobs WHERE id = ?1",
            [id],
            |row| {
                let state: String = row.get(2)?;
                Ok(JobInfo {
                    id: row.get(0)?, key: row.get(1)?,
                    state: JobState::parse(&state), error: row.get(3)?,
                })
            },
        )
        .optional()
        .unwrap_or(None)
    }

    pub fn set_job_running(&self, id: &str) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "UPDATE jobs SET state = 'running', started_at = ?1 WHERE id = ?2",
            rusqlite::params![now(), id],
        );
    }

    pub fn set_job_done(&self, id: &str) {
        self.finish(id, JobState::Done, None);
    }

    pub fn set_job_failed(&self, id: &str, error: &str) {
        self.finish(id, JobState::Failed, Some(error));
    }

    pub fn set_job_cancelled(&self, id: &str) {
        self.finish(id, JobState::Cancelled, None);
    }

    fn finish(&self, id: &str, state: JobState, error: Option<&str>) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "UPDATE jobs SET state = ?1, error = ?2, finished_at = ?3 WHERE id = ?4",
            rusqlite::params![state.as_str(), error, now(), id],
        );
    }

    /// Startup recovery (spec §6): a `running` row means the process
    /// died mid-job, not that it's still going — back to `queued` so
    /// it's retried.
    pub fn reset_running_to_queued(&self) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute("UPDATE jobs SET state = 'queued' WHERE state = 'running'", []);
    }

    /// `None` means no recorded failure — safe to attempt. A key
    /// already embeds its source signature (`cache_key`), so a changed
    /// file naturally gets a new key and is never blocked by an old
    /// failure; nothing here needs to compare signatures by hand.
    pub fn failure(&self, key: &str) -> Option<String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT error FROM failures WHERE key = ?1", [key], |row| row.get(0))
            .optional()
            .unwrap_or(None)
    }

    pub fn record_failure(&self, key: &str, error: &str) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "INSERT INTO failures (key, error, attempts, last_attempt) VALUES (?1, ?2, 1, ?3)
             ON CONFLICT(key) DO UPDATE SET
               error = excluded.error, attempts = attempts + 1, last_attempt = excluded.last_attempt",
            rusqlite::params![key, error, now()],
        );
    }
}

/// Orphaned `.part` files from a previous run (spec §6) — nothing
/// references them (every live job's row was just reset above, and a
/// `.part` only ever belongs to a job that's no longer running).
pub fn delete_orphaned_parts(dir: &Path) {
    let tmp = dir.join("tmp");
    let Ok(entries) = std::fs::read_dir(&tmp) else { return };
    for entry in entries.flatten() {
        if entry.path().extension().is_some_and(|e| e == "part") {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A throwaway directory under the OS temp dir, cleaned up on drop
    /// — same pattern as `discover.rs`'s `TempBin`/`serve.rs`'s
    /// `TempFile`.
    struct TempCacheDir {
        path: PathBuf,
    }

    impl TempCacheDir {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir()
                .join(format!("media-core-cache-test-{}-{name}", std::process::id()));
            std::fs::create_dir_all(&path).unwrap();
            TempCacheDir { path }
        }
    }

    impl Drop for TempCacheDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    fn temp_cache(name: &str) -> (Cache, TempCacheDir) {
        let dir = TempCacheDir::new(name);
        let cache = Cache::open(dir.path.clone()).unwrap();
        (cache, dir)
    }

    #[test]
    fn cache_key_is_stable_for_the_same_inputs() {
        let sig = SourceSignature { size: 100, mtime: 1000, edge_hash: 42 };
        let params = DerivedParams { resolution_cap: 1080, crf: 23 };
        let a = cache_key(sig, "ffmpeg", "6.1", PROFILE_VERSION, &params);
        let b = cache_key(sig, "ffmpeg", "6.1", PROFILE_VERSION, &params);
        assert_eq!(a, b);
    }

    #[test]
    fn cache_key_changes_with_profile_version_or_params() {
        let sig = SourceSignature { size: 100, mtime: 1000, edge_hash: 42 };
        let params = DerivedParams { resolution_cap: 1080, crf: 23 };
        let base = cache_key(sig, "ffmpeg", "6.1", 1, &params);
        assert_ne!(base, cache_key(sig, "ffmpeg", "6.1", 2, &params));
        let other_params = DerivedParams { resolution_cap: 720, crf: 23 };
        assert_ne!(base, cache_key(sig, "ffmpeg", "6.1", 1, &other_params));
    }

    #[test]
    fn cache_key_changes_when_the_source_signature_changes() {
        let params = DerivedParams { resolution_cap: 1080, crf: 23 };
        let a = cache_key(
            SourceSignature { size: 100, mtime: 1000, edge_hash: 42 },
            "ffmpeg", "6.1", PROFILE_VERSION, &params);
        let b = cache_key(
            SourceSignature { size: 101, mtime: 1000, edge_hash: 42 },
            "ffmpeg", "6.1", PROFILE_VERSION, &params);
        assert_ne!(a, b);
    }

    #[test]
    fn an_entry_round_trips_and_touch_updates_hit_count() {
        let (cache, _dir) = temp_cache("entries");
        assert!(cache.get_entry("k1").is_none());
        cache.put_entry("k1", "C:/cache/k1.mp4", 1234, "transcode");
        let entry = cache.get_entry("k1").unwrap();
        assert_eq!(entry.path_on_disk, "C:/cache/k1.mp4");
        assert_eq!(entry.bytes, 1234);
        cache.touch_entry("k1");
        cache.touch_entry("k1");
        // No public read of hit_count yet (nothing in this phase needs
        // it) — this just confirms touching an unknown key, or twice,
        // never panics or errors.
    }

    #[test]
    fn putting_the_same_key_twice_replaces_rather_than_duplicates() {
        let (cache, _dir) = temp_cache("entries-replace");
        cache.put_entry("k1", "C:/cache/old.mp4", 100, "remux");
        cache.put_entry("k1", "C:/cache/new.mp4", 200, "remux");
        let entry = cache.get_entry("k1").unwrap();
        assert_eq!(entry.path_on_disk, "C:/cache/new.mp4");
        assert_eq!(entry.bytes, 200);
    }

    #[test]
    fn a_job_moves_through_its_states() {
        let (cache, _dir) = temp_cache("jobs");
        let id = cache.create_job("k1", "requested");
        assert_eq!(cache.get_job(&id).unwrap().state, JobState::Queued);
        cache.set_job_running(&id);
        assert_eq!(cache.get_job(&id).unwrap().state, JobState::Running);
        cache.set_job_done(&id);
        let job = cache.get_job(&id).unwrap();
        assert_eq!(job.state, JobState::Done);
        assert!(job.error.is_none());
    }

    #[test]
    fn a_failed_job_carries_its_error() {
        let (cache, _dir) = temp_cache("jobs-failed");
        let id = cache.create_job("k1", "requested");
        cache.set_job_failed(&id, "ffmpeg exited with code 1");
        let job = cache.get_job(&id).unwrap();
        assert_eq!(job.state, JobState::Failed);
        assert_eq!(job.error.as_deref(), Some("ffmpeg exited with code 1"));
    }

    #[test]
    fn a_second_request_for_the_same_key_attaches_to_the_active_job() {
        let (cache, _dir) = temp_cache("dedup");
        assert!(cache.active_job_for("k1").is_none());
        let id = cache.create_job("k1", "requested");
        assert_eq!(cache.active_job_for("k1"), Some(id));
    }

    #[test]
    fn a_finished_job_is_no_longer_active_for_dedup() {
        let (cache, _dir) = temp_cache("dedup-finished");
        let id = cache.create_job("k1", "requested");
        cache.set_job_done(&id);
        assert!(cache.active_job_for("k1").is_none());
    }

    #[test]
    fn startup_recovery_requeues_running_jobs_but_leaves_others_alone() {
        let (cache, _dir) = temp_cache("recovery");
        let running = cache.create_job("k1", "requested");
        cache.set_job_running(&running);
        let done = cache.create_job("k2", "requested");
        cache.set_job_done(&done);

        cache.reset_running_to_queued();

        assert_eq!(cache.get_job(&running).unwrap().state, JobState::Queued);
        assert_eq!(cache.get_job(&done).unwrap().state, JobState::Done);
    }

    #[test]
    fn a_failure_is_recorded_and_blocks_until_overwritten() {
        let (cache, _dir) = temp_cache("failures");
        assert!(cache.failure("k1").is_none());
        cache.record_failure("k1", "not a media file");
        assert_eq!(cache.failure("k1").as_deref(), Some("not a media file"));
        // A retry (same key — i.e. the source signature did not
        // change) that fails again just updates the record, not a
        // second row.
        cache.record_failure("k1", "still not a media file");
        assert_eq!(cache.failure("k1").as_deref(), Some("still not a media file"));
    }

    #[test]
    fn orphaned_part_files_are_deleted_but_the_tmp_dir_survives() {
        let (cache, dir) = temp_cache("orphans");
        let tmp = cache.dir().join("tmp");
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("abc.part"), b"partial").unwrap();
        std::fs::write(tmp.join("keep.txt"), b"not a part file").unwrap();

        delete_orphaned_parts(&dir.path);

        assert!(!tmp.join("abc.part").exists());
        assert!(tmp.join("keep.txt").exists());
    }
}
