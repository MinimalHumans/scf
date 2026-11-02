// SPDX-License-Identifier: Apache-2.0
//! The persistent conversion cache (docs/media-server-spec.md §7): a
//! single global content-addressed store (`entries`), the job queue's
//! own bookkeeping (`jobs`, `failures`), and (Phase 6) a per-project
//! `refs` table — `project_id` is, for now, whatever string the caller
//! already uses as a project's identity (`media-server`'s `Handles`
//! passes through the asset root the frontend resolved against, per
//! `resolvedAbsolutePath`'s caller) rather than the `app.db` project
//! row's `uuid` the spec's §7 sketch names: that identity is scf-core's
//! to assign and isn't reachable from this crate or `media-server`,
//! neither of which touches `app.db`. Swapping in the real uuid later
//! is a caller-side change only — every method here just hashes
//! whatever string it's given.
//!
//! Eviction (`enforce_quota`) and the manual flush/retry actions (spec
//! §7 "Eviction"/"Negative cache"/"Manual actions") are this phase's
//! other addition. Per-project caps are per *kind group* ([`VIDEO_KINDS`]
//! / [`STILL_KINDS`]) rather than one cap across both — spec §7
//! "Separate quotas: thumbnails, stills, video proxies. One large proxy
//! cannot evict thumbnails" — and are fixed defaults, not yet
//! user-configurable (the plan's decision 7, same as the queue's
//! concurrency caps and the output profiles in `convert.rs`).
//!
//! `rusqlite` directly, mirroring `scf-app/src-tauri/src/sql.rs`'s
//! `open()`: WAL mode plus a busy timeout, since the HTTP listener and
//! any number of in-flight job updates share one file.
//!
//! Timestamps are Unix seconds (`INTEGER`), not ISO text — ordering is
//! all a plain integer needs, and the frontend already does its own
//! date formatting for everything else it shows, so there's no reason
//! for this crate to pick up a formatting dependency to match.
//!
//! Phase 7 (the dashboard) is `jobs`' other addition: `backend_id`,
//! `input_path` and `stderr_tail` columns (nothing here reads them —
//! they're pure passthrough storage for `list_recent_jobs`/`get_job`
//! to hand back), plus [`Cache::stats`] for the shared store's own
//! entry counts/bytes/hit-rate figures per kind group.

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
/// result under the same name. `resolution_cap`/`crf` are video's (not
/// user-configurable yet, the plan's decision 7); `layer`/`channel`
/// are Phase 5's still-image addition (§7 "Key": "derived_params...
/// layer, channel") — both `None` for video and for a still with no
/// layer structure, so existing cache keys for those cases are
/// unaffected in shape, only in the extra (empty) bytes hashed.
#[derive(Default)]
pub struct DerivedParams {
    pub resolution_cap: u32,
    pub crf: u32,
    pub layer: Option<String>,
    pub channel: Option<String>,
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
    hasher.write(params.layer.as_deref().unwrap_or("").as_bytes());
    hasher.write(params.channel.as_deref().unwrap_or("").as_bytes());
    format!("{:016x}", hasher.finish())
}

/// The still output profile's own knobs (spec §7) — separate from
/// [`DerivedParams`] because video's resolution cap/CRF and stills'
/// max long edge are unrelated settings; conflating them would make
/// the video path carry meaningless still fields and vice versa.
pub struct StillDerivedParams {
    pub max_long_edge: u32,
}

impl Default for StillDerivedParams {
    fn default() -> Self {
        StillDerivedParams { max_long_edge: 2048 }
    }
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
         );
         CREATE TABLE IF NOT EXISTS refs (
           project_id TEXT NOT NULL,
           key TEXT NOT NULL,
           PRIMARY KEY (project_id, key)
         );
         CREATE INDEX IF NOT EXISTS refs_key ON refs (key);",
    )?;
    // Phase 7's dashboard needs more than `jobs` already had: which
    // file and backend a job is for (so a queue/failures row can show
    // one without a second lookup), and the failed backend's own
    // stderr tail (`proc_tail.rs`). `ALTER TABLE` rather than another
    // `CREATE TABLE IF NOT EXISTS` — the table already exists on every
    // machine that ran an earlier phase, and SQLite has no `ADD COLUMN
    // IF NOT EXISTS` old enough to rely on here.
    add_column_if_missing(conn, "jobs", "backend_id", "TEXT")?;
    add_column_if_missing(conn, "jobs", "input_path", "TEXT")?;
    add_column_if_missing(conn, "jobs", "stderr_tail", "TEXT")?;
    Ok(())
}

/// A one-time schema migration that tolerates having already run:
/// `ALTER TABLE ... ADD COLUMN` has no portable "if not exists" short
/// of a SQLite version this crate doesn't pin, so this just runs it
/// and swallows exactly the "already there" error rather than
/// tracking a migration version anywhere.
fn add_column_if_missing(
    conn: &Connection, table: &str, column: &str, sql_type: &str,
) -> rusqlite::Result<()> {
    match conn.execute(&format!("ALTER TABLE {table} ADD COLUMN {column} {sql_type}"), []) {
        Ok(_) => Ok(()),
        Err(rusqlite::Error::SqliteFailure(_, Some(msg)))
            if msg.contains("duplicate column name") => Ok(()),
        Err(e) => Err(e),
    }
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
    /// Phase 7's dashboard additions — all present from `create_job`
    /// onward except `stderr_tail`, which only a failed job ever has.
    pub priority: String,
    pub backend_id: Option<String>,
    pub input_path: Option<String>,
    pub stderr_tail: Option<String>,
    pub created_at: i64,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
}

/// Shared between `get_job` and `list_recent_jobs` so the two queries
/// can never drift into reading `jobs` in a different column order
/// than [`job_from_row`] expects.
const JOB_COLUMNS: &str =
    "id, key, state, error, priority, backend_id, input_path, stderr_tail, \
     created_at, started_at, finished_at";

fn job_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<JobInfo> {
    let state: String = row.get(2)?;
    Ok(JobInfo {
        id: row.get(0)?, key: row.get(1)?, state: JobState::parse(&state), error: row.get(3)?,
        priority: row.get(4)?, backend_id: row.get(5)?, input_path: row.get(6)?,
        stderr_tail: row.get(7)?, created_at: row.get(8)?, started_at: row.get(9)?,
        finished_at: row.get(10)?,
    })
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
    /// on the final path without coordinating. `ext` is the caller's
    /// (not derived here) — `"mp4"` for Remux/Transcode, `"jpg"` for
    /// Phase 5's Render.
    pub fn entry_path(&self, key: &str, ext: &str) -> PathBuf {
        self.dir.join("entries").join(format!("{key}.{ext}"))
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

    /// Cache hits update `last_access`/`hit_count` (spec §7 "Eviction" —
    /// what [`Cache::enforce_quota`] orders its LRU candidates by).
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

    /// `backend_id`/`input_path` (Phase 7) are stored purely for the
    /// dashboard's "job, file, backend" columns — nothing in the queue
    /// or cache itself reads them back. `input_path` is the real
    /// absolute path; see `JobInfo`'s own doc and `media-server`'s
    /// `serve.rs`, the one place that ever turns it into the file-name-
    /// only form the HTTP API is allowed to return (spec §13: no
    /// absolute path anywhere in the API).
    pub fn create_job(&self, key: &str, priority: &str, backend_id: &str, input_path: &str) -> String {
        let id = new_id();
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "INSERT INTO jobs (id, key, state, priority, backend_id, input_path, created_at)
             VALUES (?1, ?2, 'queued', ?3, ?4, ?5, ?6)",
            rusqlite::params![id, key, priority, backend_id, input_path, now()],
        );
        id
    }

    pub fn get_job(&self, id: &str) -> Option<JobInfo> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            &format!("SELECT {JOB_COLUMNS} FROM jobs WHERE id = ?1"),
            [id],
            job_from_row,
        )
        .optional()
        .unwrap_or(None)
    }

    /// Every job, most recently active first (spec §9's queue list and
    /// failures list are both just filtered views of this — the
    /// dashboard buckets by `state` client-side rather than this
    /// needing two separate queries). `limit` bounds a long-lived
    /// cache's history from growing the response without bound; there
    /// is no pagination yet because nothing shows more than one page.
    pub fn list_recent_jobs(&self, limit: u32) -> Vec<JobInfo> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = match conn.prepare(
            &format!(
                "SELECT {JOB_COLUMNS} FROM jobs \
                 ORDER BY COALESCE(finished_at, started_at, created_at) DESC LIMIT ?1"
            ),
        ) {
            Ok(stmt) => stmt,
            Err(_) => return Vec::new(),
        };
        stmt.query_map([limit], job_from_row)
            .map(|rows| rows.filter_map(Result::ok).collect())
            .unwrap_or_default()
    }

    pub fn set_job_running(&self, id: &str) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "UPDATE jobs SET state = 'running', started_at = ?1 WHERE id = ?2",
            rusqlite::params![now(), id],
        );
    }

    pub fn set_job_done(&self, id: &str) {
        self.finish(id, JobState::Done, None, None);
    }

    /// `stderr_tail` (Phase 7) is the failed backend's own output,
    /// already redacted of any absolute path by the caller
    /// (`media-server`'s queue, which is the only place that has both
    /// the tail and the paths that produced it) — this just stores
    /// whatever it's given.
    pub fn set_job_failed(&self, id: &str, error: &str, stderr_tail: Option<&str>) {
        self.finish(id, JobState::Failed, Some(error), stderr_tail);
    }

    pub fn set_job_cancelled(&self, id: &str) {
        self.finish(id, JobState::Cancelled, None, None);
    }

    fn finish(&self, id: &str, state: JobState, error: Option<&str>, stderr_tail: Option<&str>) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "UPDATE jobs SET state = ?1, error = ?2, stderr_tail = ?3, finished_at = ?4 WHERE id = ?5",
            rusqlite::params![state.as_str(), error, stderr_tail, now(), id],
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

    /// Explicit "Retry" (spec §7 "Manual actions") — drops the negative-
    /// cache row so the next request for `key` attempts again even
    /// though the source hasn't changed (the automatic unblock
    /// `failure()`'s doc comment describes). A no-op for a key with no
    /// recorded failure.
    pub fn retry_failure(&self, key: &str) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute("DELETE FROM failures WHERE key = ?1", [key]);
    }

    /// Records that `project_id` has used `key` — spec §7's `refs`
    /// table. Called on every `/media` request that reaches a cache
    /// key, hit or miss, so a project's usage reflects everything it's
    /// asked for, not just what it happened to be first to produce.
    /// Idempotent: a repeat request for the same (project, key) pair is
    /// a no-op, not a second row.
    pub fn add_ref(&self, project_id: &str, key: &str) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "INSERT INTO refs (project_id, key) VALUES (?1, ?2) ON CONFLICT DO NOTHING",
            rusqlite::params![project_id, key],
        );
    }

    /// Bytes of `kinds`-matching entries `project_id` currently
    /// references. Spec §7: "Entries referenced by multiple projects
    /// count once toward the store total, and toward each project's
    /// usage proportionally or fully (pick fully...)" — this is that
    /// "fully": a shared entry counts its whole size toward every
    /// project that references it, not a fraction.
    pub fn project_usage_bytes(&self, project_id: &str, kinds: &[&str]) -> u64 {
        let conn = self.conn.lock().unwrap();
        project_usage_bytes_locked(&conn, project_id, kinds)
    }

    /// LRU-evicts `kinds`-matching entries `project_id` references
    /// until its usage for that kind group is at or under `cap_bytes`
    /// (spec §7 "Eviction", enforced "at write time" — the caller's job
    /// is to call this right after a request that may have just grown
    /// the project's usage, hit or miss alike).
    ///
    /// An entry with an active ([`JobState::Queued`]/[`JobState::
    /// Running`]) job for its key is never a candidate (spec: "Pinned
    /// entries (currently playing, queued) are never evicted" — the
    /// only form of pinning this phase has a producer for; nothing yet
    /// tracks "currently playing" as distinct session state). If every
    /// remaining entry is pinned this way, usage simply stays over cap
    /// until one of them finishes — there is nothing else to evict.
    ///
    /// Dropping `project_id`'s own ref to a candidate, rather than the
    /// entry outright, matches `flush_project`'s own semantics: the
    /// entry itself is only ever deleted once no project still
    /// references it (see `delete_entry_if_unreferenced_locked`), so a
    /// file shared with another project survives this project's
    /// eviction.
    pub fn enforce_quota(&self, project_id: &str, kinds: &[&str], cap_bytes: u64) {
        let conn = self.conn.lock().unwrap();
        loop {
            if project_usage_bytes_locked(&conn, project_id, kinds) <= cap_bytes {
                break;
            }
            let mut params: Vec<&str> = vec![project_id];
            params.extend(kinds.iter().copied());
            let sql = format!(
                "SELECT e.key FROM entries e JOIN refs r ON r.key = e.key
                 WHERE r.project_id = ?1 AND e.kind IN ({})
                   AND e.key NOT IN (SELECT key FROM jobs WHERE state IN ('queued', 'running'))
                 ORDER BY e.last_access ASC LIMIT 1",
                kinds_placeholders(kinds, 2),
            );
            let candidate: Option<String> = conn
                .query_row(&sql, rusqlite::params_from_iter(params), |row| row.get(0))
                .optional()
                .unwrap_or(None);
            match candidate {
                Some(key) => remove_ref_locked(&conn, project_id, &key),
                None => break, // nothing left to evict — the rest is pinned
            }
        }
    }

    /// Drops every ref `project_id` holds, deleting the entries that
    /// leaves unreferenced (spec §7 "Manual actions": "Flush project
    /// (drops refs, deletes entries with no remaining refs)").
    pub fn flush_project(&self, project_id: &str) {
        let conn = self.conn.lock().unwrap();
        let keys: Vec<String> = conn
            .prepare("SELECT key FROM refs WHERE project_id = ?1")
            .and_then(|mut stmt| {
                stmt.query_map([project_id], |row| row.get(0))?.collect()
            })
            .unwrap_or_default();
        for key in keys {
            remove_ref_locked(&conn, project_id, &key);
        }
    }

    /// Drops every entry and ref, deletes every cached file, and clears
    /// the negative cache (spec §7: "Flush all" plus "[Negative cache
    /// is] cleared by cache flush").
    pub fn flush_all(&self) {
        let conn = self.conn.lock().unwrap();
        let paths: Vec<String> = conn
            .prepare("SELECT path_on_disk FROM entries")
            .and_then(|mut stmt| stmt.query_map([], |row| row.get(0))?.collect())
            .unwrap_or_default();
        for path in &paths {
            let _ = std::fs::remove_file(path);
        }
        let _ = conn.execute("DELETE FROM entries", []);
        let _ = conn.execute("DELETE FROM refs", []);
        let _ = conn.execute("DELETE FROM failures", []);
    }

    /// Global, not per-project — spec §9 "Cache: ... entry counts, hit
    /// rate" is the shared store's own figures; a project's usage
    /// against its cap is [`Cache::project_usage_bytes`] instead, which
    /// the dashboard calls separately once it knows which project it's
    /// showing. "Hit rate" isn't tracked as its own counter: every
    /// [`Cache::put_entry`] is exactly one miss (the conversion that
    /// produced the entry) and every [`Cache::touch_entry`] after it is
    /// exactly one hit, so `hits / (hits + count)` over the entries that
    /// still exist is that same rate, derived rather than separately
    /// bookkept.
    pub fn stats(&self) -> CacheStats {
        let conn = self.conn.lock().unwrap();
        CacheStats {
            video: kind_stats_locked(&conn, &VIDEO_KINDS),
            stills: kind_stats_locked(&conn, &STILL_KINDS),
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KindStats {
    pub count: u64,
    pub bytes: u64,
    pub hits: u64,
}

#[derive(Debug, Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheStats {
    pub video: KindStats,
    pub stills: KindStats,
}

fn kind_stats_locked(conn: &Connection, kinds: &[&str]) -> KindStats {
    let sql = format!(
        "SELECT COUNT(*), COALESCE(SUM(bytes), 0), COALESCE(SUM(hit_count), 0) \
         FROM entries WHERE kind IN ({})",
        kinds_placeholders(kinds, 1),
    );
    conn.query_row(&sql, rusqlite::params_from_iter(kinds.iter()), |row| {
        Ok(KindStats {
            count: row.get::<_, i64>(0)? as u64,
            bytes: row.get::<_, i64>(1)? as u64,
            hits: row.get::<_, i64>(2)? as u64,
        })
    })
    .unwrap_or_default()
}

/// `project_id`'s own usage-accounting primitive, taking an already-
/// locked connection so callers that need to read-then-write (
/// `enforce_quota`'s loop) never lock `Cache`'s mutex twice from the
/// same thread — `std::sync::Mutex` isn't reentrant.
fn project_usage_bytes_locked(conn: &Connection, project_id: &str, kinds: &[&str]) -> u64 {
    let sql = format!(
        "SELECT COALESCE(SUM(e.bytes), 0) FROM refs r JOIN entries e ON e.key = r.key
         WHERE r.project_id = ?1 AND e.kind IN ({})",
        kinds_placeholders(kinds, 2),
    );
    let mut params: Vec<&str> = vec![project_id];
    params.extend(kinds.iter().copied());
    conn.query_row(&sql, rusqlite::params_from_iter(params), |row| row.get::<_, i64>(0))
        .unwrap_or(0) as u64
}

/// `?2, ?3, ...` for as many `kinds` as given, starting after
/// `first_unused` positional params already spoken for by the caller's
/// own SQL (`?1` for `project_id`, in every caller above).
fn kinds_placeholders(kinds: &[&str], first_unused: usize) -> String {
    (0..kinds.len())
        .map(|i| format!("?{}", first_unused + i))
        .collect::<Vec<_>>()
        .join(",")
}

/// Drops `project_id`'s ref to `key`, then deletes the entry (and its
/// file) if that was the last one. Takes a locked connection for the
/// same reason `project_usage_bytes_locked` does.
fn remove_ref_locked(conn: &Connection, project_id: &str, key: &str) {
    let _ = conn.execute(
        "DELETE FROM refs WHERE project_id = ?1 AND key = ?2",
        rusqlite::params![project_id, key],
    );
    delete_entry_if_unreferenced_locked(conn, key);
}

/// If no project still refs `key`, deletes its cache file and `entries`
/// row. A query error is treated as "still referenced" — the safe
/// direction when in doubt is to leave the file alone, not delete it.
fn delete_entry_if_unreferenced_locked(conn: &Connection, key: &str) {
    let still_referenced: bool = conn
        .query_row("SELECT EXISTS(SELECT 1 FROM refs WHERE key = ?1)", [key], |row| row.get(0))
        .unwrap_or(true);
    if still_referenced {
        return;
    }
    let path: Option<String> = conn
        .query_row("SELECT path_on_disk FROM entries WHERE key = ?1", [key], |row| row.get(0))
        .optional()
        .unwrap_or(None);
    if let Some(path) = path {
        let _ = std::fs::remove_file(path);
    }
    let _ = conn.execute("DELETE FROM entries WHERE key = ?1", [key]);
}

/// Spec §7 "Separate quotas: thumbnails, stills, video proxies" — the
/// two kind groups this codebase actually has entries for today (no
/// thumbnail profile exists yet; see `convert.rs`/`still_convert.rs`).
pub const VIDEO_KINDS: [&str; 2] = ["remux", "transcode"];
pub const STILL_KINDS: [&str; 1] = ["render"];

/// Spec §8 "Per-project max cache MB, per-kind quotas" — fixed for now
/// (the plan's decision 7), one default per kind group rather than one
/// overall project cap: the two group caps already bound a project's
/// total footprint, and a third cross-kind cap would only add a layer
/// with no settings surface yet to make it mean anything.
pub const DEFAULT_VIDEO_CAP_BYTES: u64 = 2 * 1024 * 1024 * 1024;
pub const DEFAULT_STILL_CAP_BYTES: u64 = 512 * 1024 * 1024;

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
        let params = DerivedParams { resolution_cap: 1080, crf: 23, ..Default::default() };
        let a = cache_key(sig, "ffmpeg", "6.1", PROFILE_VERSION, &params);
        let b = cache_key(sig, "ffmpeg", "6.1", PROFILE_VERSION, &params);
        assert_eq!(a, b);
    }

    #[test]
    fn cache_key_changes_with_profile_version_or_params() {
        let sig = SourceSignature { size: 100, mtime: 1000, edge_hash: 42 };
        let params = DerivedParams { resolution_cap: 1080, crf: 23, ..Default::default() };
        let base = cache_key(sig, "ffmpeg", "6.1", 1, &params);
        assert_ne!(base, cache_key(sig, "ffmpeg", "6.1", 2, &params));
        let other_params = DerivedParams { resolution_cap: 720, crf: 23, ..Default::default() };
        assert_ne!(base, cache_key(sig, "ffmpeg", "6.1", 1, &other_params));
    }

    #[test]
    fn cache_key_changes_when_the_source_signature_changes() {
        let params = DerivedParams { resolution_cap: 1080, crf: 23, ..Default::default() };
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
        let id = cache.create_job("k1", "requested", "ffmpeg", "in.mp4");
        assert_eq!(cache.get_job(&id).unwrap().state, JobState::Queued);
        cache.set_job_running(&id);
        assert_eq!(cache.get_job(&id).unwrap().state, JobState::Running);
        cache.set_job_done(&id);
        let job = cache.get_job(&id).unwrap();
        assert_eq!(job.state, JobState::Done);
        assert!(job.error.is_none());
    }

    #[test]
    fn create_job_records_its_priority_backend_and_input_path() {
        let (cache, _dir) = temp_cache("jobs-metadata");
        let id = cache.create_job("k1", "background", "oiiotool", "C:/plates/shot.exr");
        let job = cache.get_job(&id).unwrap();
        assert_eq!(job.priority, "background");
        assert_eq!(job.backend_id.as_deref(), Some("oiiotool"));
        assert_eq!(job.input_path.as_deref(), Some("C:/plates/shot.exr"));
    }

    #[test]
    fn list_recent_jobs_orders_most_recently_active_first() {
        let (cache, _dir) = temp_cache("jobs-recent");
        let first = cache.create_job("k1", "requested", "ffmpeg", "a.mp4");
        let second = cache.create_job("k2", "requested", "ffmpeg", "b.mp4");
        // `now()`'s 1-second resolution can't be trusted to separate
        // two rows created microseconds apart within the same test —
        // set `created_at` by hand so the ordering under test isn't
        // racing the clock.
        let conn = cache.conn.lock().unwrap();
        conn.execute("UPDATE jobs SET created_at = 1000 WHERE id = ?1", [&first]).unwrap();
        conn.execute("UPDATE jobs SET created_at = 2000 WHERE id = ?1", [&second]).unwrap();
        drop(conn);

        let recent = cache.list_recent_jobs(10);
        assert_eq!(recent.first().unwrap().id, second);
        assert_eq!(recent.get(1).unwrap().id, first);
    }

    #[test]
    fn a_failed_job_carries_its_error() {
        let (cache, _dir) = temp_cache("jobs-failed");
        let id = cache.create_job("k1", "requested", "ffmpeg", "in.mp4");
        cache.set_job_failed(&id, "ffmpeg exited with code 1", Some("frame=1 error: broken pipe"));
        let job = cache.get_job(&id).unwrap();
        assert_eq!(job.state, JobState::Failed);
        assert_eq!(job.error.as_deref(), Some("ffmpeg exited with code 1"));
        assert_eq!(job.stderr_tail.as_deref(), Some("frame=1 error: broken pipe"));
    }

    #[test]
    fn a_second_request_for_the_same_key_attaches_to_the_active_job() {
        let (cache, _dir) = temp_cache("dedup");
        assert!(cache.active_job_for("k1").is_none());
        let id = cache.create_job("k1", "requested", "ffmpeg", "in.mp4");
        assert_eq!(cache.active_job_for("k1"), Some(id));
    }

    #[test]
    fn a_finished_job_is_no_longer_active_for_dedup() {
        let (cache, _dir) = temp_cache("dedup-finished");
        let id = cache.create_job("k1", "requested", "ffmpeg", "in.mp4");
        cache.set_job_done(&id);
        assert!(cache.active_job_for("k1").is_none());
    }

    #[test]
    fn startup_recovery_requeues_running_jobs_but_leaves_others_alone() {
        let (cache, _dir) = temp_cache("recovery");
        let running = cache.create_job("k1", "requested", "ffmpeg", "in.mp4");
        cache.set_job_running(&running);
        let done = cache.create_job("k2", "requested", "ffmpeg", "in2.mp4");
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

    /// A real file under `dir`'s `entries/` folder, registered as `key`
    /// — eviction/flush tests need a real path to assert the file is
    /// actually gone, not just the row.
    fn put_real_entry(cache: &Cache, dir: &Path, key: &str, kind: &str, bytes: u64) -> PathBuf {
        let path = dir.join("entries").join(format!("{key}.bin"));
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, vec![0u8; bytes as usize]).unwrap();
        cache.put_entry(key, &path.display().to_string(), bytes, kind);
        path
    }

    /// Bypasses `now()`'s 1-second resolution so LRU-ordering tests
    /// don't race against how fast the test itself runs.
    fn set_last_access(cache: &Cache, key: &str, when: i64) {
        let conn = cache.conn.lock().unwrap();
        conn.execute(
            "UPDATE entries SET last_access = ?1 WHERE key = ?2",
            rusqlite::params![when, key],
        )
        .unwrap();
    }

    #[test]
    fn project_usage_sums_only_the_matching_kind_group_for_referenced_entries() {
        let (cache, dir) = temp_cache("refs-usage");
        put_real_entry(&cache, &dir.path, "v1", "transcode", 100);
        put_real_entry(&cache, &dir.path, "s1", "render", 50);
        cache.add_ref("proj-a", "v1");
        cache.add_ref("proj-a", "s1");

        assert_eq!(cache.project_usage_bytes("proj-a", &VIDEO_KINDS), 100);
        assert_eq!(cache.project_usage_bytes("proj-a", &STILL_KINDS), 50);
        assert_eq!(cache.project_usage_bytes("proj-b", &VIDEO_KINDS), 0);
    }

    #[test]
    fn adding_the_same_ref_twice_does_not_double_count_usage() {
        let (cache, dir) = temp_cache("refs-dedup");
        put_real_entry(&cache, &dir.path, "v1", "remux", 10);
        cache.add_ref("proj-a", "v1");
        cache.add_ref("proj-a", "v1");
        assert_eq!(cache.project_usage_bytes("proj-a", &VIDEO_KINDS), 10);
    }

    #[test]
    fn enforce_quota_evicts_the_least_recently_used_entry_first() {
        let (cache, dir) = temp_cache("quota-lru");
        let p1 = put_real_entry(&cache, &dir.path, "v1", "remux", 100);
        let p2 = put_real_entry(&cache, &dir.path, "v2", "remux", 100);
        set_last_access(&cache, "v1", 1000);
        set_last_access(&cache, "v2", 2000);
        cache.add_ref("proj", "v1");
        cache.add_ref("proj", "v2");

        cache.enforce_quota("proj", &VIDEO_KINDS, 100);

        assert!(cache.get_entry("v1").is_none(), "the older entry should have been evicted");
        assert!(!p1.exists());
        assert!(cache.get_entry("v2").is_some());
        assert!(p2.exists());
    }

    #[test]
    fn enforce_quota_never_evicts_an_entry_with_an_active_job() {
        let (cache, dir) = temp_cache("quota-pinned");
        let p1 = put_real_entry(&cache, &dir.path, "v1", "remux", 100);
        cache.add_ref("proj", "v1");
        let job = cache.create_job("v1", "requested", "ffmpeg", "in.mp4");
        cache.set_job_running(&job);

        cache.enforce_quota("proj", &VIDEO_KINDS, 0); // an impossibly tight cap

        assert!(cache.get_entry("v1").is_some(), "an entry with a running job must survive eviction");
        assert!(p1.exists());
    }

    #[test]
    fn enforce_quota_only_evicts_the_matching_kind_group() {
        let (cache, dir) = temp_cache("quota-kinds");
        let video = put_real_entry(&cache, &dir.path, "v1", "remux", 100);
        put_real_entry(&cache, &dir.path, "s1", "render", 100);
        cache.add_ref("proj", "v1");
        cache.add_ref("proj", "s1");

        cache.enforce_quota("proj", &STILL_KINDS, 0);

        assert!(cache.get_entry("v1").is_some(), "a video entry must survive a still-only eviction");
        assert!(video.exists());
        assert!(cache.get_entry("s1").is_none(), "the over-quota still entry is evicted");
    }

    #[test]
    fn evicting_a_shared_entry_for_one_project_drops_only_that_projects_ref() {
        let (cache, dir) = temp_cache("quota-shared");
        let path = put_real_entry(&cache, &dir.path, "v1", "remux", 100);
        cache.add_ref("proj-a", "v1");
        cache.add_ref("proj-b", "v1");

        cache.enforce_quota("proj-a", &VIDEO_KINDS, 0);

        assert_eq!(cache.project_usage_bytes("proj-a", &VIDEO_KINDS), 0, "proj-a's own ref is gone");
        assert_eq!(cache.project_usage_bytes("proj-b", &VIDEO_KINDS), 100, "proj-b's ref, and the file, survive");
        assert!(path.exists());
        assert!(cache.get_entry("v1").is_some());
    }

    #[test]
    fn flush_project_drops_only_that_projects_refs_and_entries() {
        let (cache, dir) = temp_cache("flush-project");
        let only_a = put_real_entry(&cache, &dir.path, "only-a", "remux", 10);
        let shared = put_real_entry(&cache, &dir.path, "shared", "remux", 10);
        cache.add_ref("proj-a", "only-a");
        cache.add_ref("proj-a", "shared");
        cache.add_ref("proj-b", "shared");

        cache.flush_project("proj-a");

        assert!(cache.get_entry("only-a").is_none());
        assert!(!only_a.exists());
        assert!(cache.get_entry("shared").is_some(), "still referenced by proj-b");
        assert!(shared.exists());
    }

    #[test]
    fn flush_all_clears_entries_refs_and_failures_and_deletes_the_files() {
        let (cache, dir) = temp_cache("flush-all");
        let path = put_real_entry(&cache, &dir.path, "v1", "remux", 10);
        cache.add_ref("proj-a", "v1");
        cache.record_failure("v2", "not a media file");

        cache.flush_all();

        assert!(cache.get_entry("v1").is_none());
        assert!(!path.exists());
        assert_eq!(cache.project_usage_bytes("proj-a", &VIDEO_KINDS), 0);
        assert!(cache.failure("v2").is_none());
    }

    #[test]
    fn retry_failure_clears_a_recorded_failure_without_touching_others() {
        let (cache, _dir) = temp_cache("retry");
        cache.record_failure("k1", "broken");
        cache.record_failure("k2", "also broken");

        cache.retry_failure("k1");

        assert!(cache.failure("k1").is_none());
        assert_eq!(cache.failure("k2").as_deref(), Some("also broken"));
    }

    #[test]
    fn retrying_a_key_with_no_failure_is_a_quiet_no_op() {
        let (cache, _dir) = temp_cache("retry-noop");
        cache.retry_failure("not-a-real-key"); // must not panic
    }

    #[test]
    fn stats_counts_and_sums_bytes_and_hits_per_kind_group() {
        let (cache, dir) = temp_cache("stats");
        put_real_entry(&cache, &dir.path, "v1", "remux", 100);
        put_real_entry(&cache, &dir.path, "s1", "render", 50);
        cache.touch_entry("v1");
        cache.touch_entry("v1");

        let stats = cache.stats();
        assert_eq!(stats.video.count, 1);
        assert_eq!(stats.video.bytes, 100);
        assert_eq!(stats.video.hits, 2);
        assert_eq!(stats.stills.count, 1);
        assert_eq!(stats.stills.bytes, 50);
        assert_eq!(stats.stills.hits, 0);
    }
}
