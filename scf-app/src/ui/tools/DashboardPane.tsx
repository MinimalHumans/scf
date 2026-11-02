// SPDX-License-Identifier: Apache-2.0
/**
 * DashboardPane — the Media tab's live view onto the media server
 * (docs/media-server-spec.md §9): the job queue and worker slots, the
 * failures list with each job's stderr tail, and cache usage against
 * this project's quota, with a per-project limit override and flush
 * actions. Binary detection/overrides ("Media helpers") and every other
 * global knob (worker threads, default proxy resolution, the global
 * cache limit) live only in Settings > Media now (`SettingsPane.tsx`) —
 * this tab is project-scoped operational state, not configuration.
 *
 * A tool tab, like Settings and the event log (state/tabs.ts). It
 * needs no project open to be useful — worker/cache/backend state is
 * app-wide — but reads the active project's asset root, when there is
 * one, to scope the cache-usage figures the same way `objectUrlCache.
 * ts` already scopes a handle registration.
 *
 * Polls every two seconds while open and stops the moment the tab
 * unmounts. There is no push channel for job state yet — the spec's
 * own "subscribes via host events" (§4) is still just `/jobs/<id>`
 * polling today — so this is the same mechanism, aimed at the list
 * instead of one id.
 */

import { useEffect, useRef, useState } from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { useStore } from "../../state/store.ts";
import { windowAppStore } from "../../host/windowAppStore.ts";
import {
  cancelJob, flushCache, pushProjectCacheLimitOverride, retryJob, setJobPriority,
} from "../../files/objectUrlCache.ts";
import {
  getCacheStats, listJobs, PRIORITY_TIERS,
  type CacheStats, type DashboardJob, type JobsResponse, type PriorityTier,
} from "../../files/mediaDashboard.ts";

const describe = (e: unknown): string => e instanceof Error ? e.message : String(e);

const POLL_MS = 2000;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

function formatElapsed(startSecs: number): string {
  const secs = Math.max(0, Math.floor(Date.now() / 1000) - startSecs);
  if (secs < 60) return `${String(secs)}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${String(mins)}m ${String(secs % 60)}s`;
  return `${String(Math.floor(mins / 60))}h ${String(mins % 60)}m`;
}

const STATE_LABEL: Record<DashboardJob["state"], string> = {
  queued: "Queued", running: "Running", done: "Done",
  failed: "Failed", cancelled: "Cancelled",
};

const PRIORITY_LABEL: Record<PriorityTier, string> = {
  background: "Background", requested: "Requested", preview: "Preview",
};

/** A horizontal meter, shared by a job's own conversion progress (always
 *  the neutral tone — there is no "too much progress") and a cache
 *  usage bar (blue under 80%, amber 80–95%, red past it — the
 *  blueprint's own thresholds). */
function Meter({ fraction, tone }: {
  fraction: number; tone: "progress" | "cache";
}): JSX.Element {
  const pct = Math.max(0, Math.min(1, fraction)) * 100;
  const level = tone === "progress" ? "normal"
    : pct > 95 ? "danger" : pct > 80 ? "warn" : "normal";
  return (
    <div className="dashboard-meter" role="progressbar" aria-valuenow={Math.round(pct)}
         aria-valuemin={0} aria-valuemax={100}>
      <div className={`dashboard-meter-fill dashboard-meter-${level}`}
           style={{ width: `${String(pct)}%` }} />
    </div>
  );
}

/** The file extension, upper-cased, as the closest thing to a format
 *  badge the dashboard can show — `fileName` is a bare basename (spec
 *  §13: no absolute, or even relative, path crosses this boundary), so
 *  there is no path to resolve a real thumbnail from here. */
function FormatBadge({ fileName }: { fileName: string | null }): JSX.Element {
  const dot = fileName?.lastIndexOf(".") ?? -1;
  const ext = dot === -1 || fileName === null ? "" : fileName.slice(dot + 1).toUpperCase();
  return <span className="dashboard-format-badge" aria-hidden="true">{ext === "" ? "—" : ext}</span>;
}

function bumpedTier(current: string, dir: 1 | -1): PriorityTier {
  const at = PRIORITY_TIERS.indexOf(current as PriorityTier);
  const from = at === -1 ? PRIORITY_TIERS.indexOf("requested") : at;
  const next = Math.min(PRIORITY_TIERS.length - 1, Math.max(0, from + dir));
  return PRIORITY_TIERS[next] ?? "requested";
}

function QueueSection({ jobs, workers, onChanged }: {
  jobs: DashboardJob[]; workers: JobsResponse["workers"]; onChanged: () => void;
}): JSX.Element {
  const active = jobs.filter((j) => j.state === "queued" || j.state === "running");

  const cancel = (id: string): void => {
    void cancelJob(id).then(onChanged);
  };

  const bump = (job: DashboardJob, dir: 1 | -1): void => {
    const next = bumpedTier(job.priority, dir);
    if (next === job.priority) return;
    void setJobPriority(job.id, next).then(onChanged);
  };

  return (
    <section>
      <h3>Queue</h3>
      <p className="muted small">
        Video: {String(workers.videoInUse)}/{String(workers.videoMax)} slots in
        use · Stills: {String(workers.stillInUse)}/{String(workers.stillMax)} slots
        in use.
      </p>
      {active.length === 0 && <p className="muted">Nothing queued or running.</p>}
      {active.length > 0 && (
        <ul className="settings-pairing-list">
          {active.map((j) => {
            const tierIndex = PRIORITY_TIERS.indexOf(j.priority as PriorityTier);
            return (
              <li key={j.id} className="settings-pairing-row dashboard-job-row">
                <FormatBadge fileName={j.fileName} />
                <div className="settings-pairing-main">
                  <div className="settings-pairing-title">
                    <strong>{j.fileName ?? j.id}</strong>
                    <span className="muted small">{STATE_LABEL[j.state]}</span>
                  </div>
                  <span className="muted small mono">
                    {j.backendId ?? "—"} ·{" "}
                    {PRIORITY_LABEL[j.priority as PriorityTier] ?? j.priority} ·{" "}
                    {formatElapsed(j.startedAt ?? j.createdAt)}
                    {j.sourceBytes !== null && ` · ${formatBytes(j.sourceBytes)} source`}
                    {j.partialBytes !== null && ` · ${formatBytes(j.partialBytes)} written so far`}
                  </span>
                  {j.progress !== null && (
                    <div className="dashboard-job-progress">
                      <Meter fraction={j.progress} tone="progress" />
                      <span className="muted small mono">
                        {String(Math.round(j.progress * 100))}%
                      </span>
                    </div>
                  )}
                </div>
                <div className="settings-pairing-actions dashboard-job-actions">
                  <div className="dashboard-priority-controls">
                    <button className="ghost tiny" title="Raise priority"
                            aria-label={`Raise priority for ${j.fileName ?? j.id}`}
                            disabled={tierIndex >= PRIORITY_TIERS.length - 1}
                            onClick={() => bump(j, 1)}>
                      ▲
                    </button>
                    <button className="ghost tiny" title="Lower priority"
                            aria-label={`Lower priority for ${j.fileName ?? j.id}`}
                            disabled={tierIndex <= 0}
                            onClick={() => bump(j, -1)}>
                      ▼
                    </button>
                  </div>
                  <button className="ghost tiny" onClick={() => cancel(j.id)}>
                    Cancel
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function FailuresSection({ jobs, onChanged }: {
  jobs: DashboardJob[]; onChanged: () => void;
}): JSX.Element {
  const failed = jobs.filter((j) => j.state === "failed");
  const [expanded, setExpanded] = useState<string | null>(null);

  const retry = (id: string): void => {
    void retryJob(id).then(onChanged);
  };

  return (
    <section>
      <h4>Failures</h4>
      {failed.length === 0 && <p className="muted">No recent failures.</p>}
      {failed.length > 0 && (
        <ul className="settings-pairing-list">
          {failed.map((j) => (
            <li key={j.id} className="settings-pairing-row">
              <div className="settings-pairing-main">
                <div className="settings-pairing-title">
                  <strong>{j.fileName ?? j.id}</strong>
                  <span className="settings-error small">{j.error ?? "failed"}</span>
                </div>
                {j.stderrTail !== null && j.stderrTail.trim() !== "" && (
                  <>
                    <button className="ghost tiny"
                            onClick={() => setExpanded((e) => e === j.id ? null : j.id)}>
                      {expanded === j.id ? "Hide details" : "Show details"}
                    </button>
                    {expanded === j.id && (
                      <pre className="mono small dashboard-stderr">{j.stderrTail}</pre>
                    )}
                  </>
                )}
              </div>
              <div className="settings-pairing-actions">
                <button className="ghost tiny" onClick={() => retry(j.id)}>Retry</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Reads and writes app.db's `project.cache_limit_mb` (the "Project
 *  limit override" field) and pushes a change straight to the running
 *  media server — `onChanged` then re-fetches cache stats so the usage
 *  bar reflects the new cap immediately, not after the next poll. */
function CacheLimitOverride({ projectPath, projectId, onChanged }: {
  projectPath: string | null; projectId: string | null; onChanged: () => void;
}): JSX.Element {
  const [value, setValue] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setLoaded(false);
    if (projectPath === null) { setValue(""); setLoaded(true); return; }
    void (async () => {
      const store = await windowAppStore();
      const row = await store.getProject(projectPath);
      if (!live) return;
      setValue(row?.cacheLimitMb != null ? String(row.cacheLimitMb) : "");
      setLoaded(true);
    })();
    return () => { live = false; };
  }, [projectPath]);

  const save = (): void => {
    if (projectPath === null || projectId === null) return;
    const trimmed = value.trim();
    const mb = trimmed === "" ? null : Number(trimmed);
    if (mb !== null && (!Number.isFinite(mb) || mb <= 0)) {
      setError("Enter a positive number, or leave it blank to use the global limit.");
      return;
    }
    void (async () => {
      setBusy(true);
      setError(null);
      const store = await windowAppStore();
      await store.setCacheLimitMb(projectPath, mb);
      await pushProjectCacheLimitOverride(projectPath, projectId);
      onChanged();
    })().catch((e: unknown) => setError(describe(e))).finally(() => setBusy(false));
  };

  return (
    <div className="dashboard-cache-override">
      <label className="settings-field">
        Project limit override (MB)
        <input type="number" min={1} placeholder="uses the global limit"
               disabled={!loaded || projectId === null} value={value}
               onChange={(e) => setValue(e.target.value)} />
      </label>
      <button className="ghost tiny" disabled={busy || !loaded || projectId === null}
              onClick={save}>
        Save
      </button>
      {error !== null && <p className="settings-error small">{error}</p>}
    </div>
  );
}

function CacheSection({ stats, globalStats, projectId, projectPath, onChanged }: {
  stats: CacheStats | null; globalStats: CacheStats | null;
  projectId: string | null; projectPath: string | null; onChanged: () => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const flush = (scope: "project" | "all"): void => {
    const whose = scope === "project" ? "this project's" : "the entire";
    void confirm(
      `Flush ${whose} media cache? Converted previews are deleted and will ` +
      "be regenerated the next time they're needed.",
      { title: "Flush media cache", kind: "warning" },
    ).then((ok) => {
      if (!ok) return;
      void (async () => {
        setBusy(true);
        setError(null);
        await flushCache(scope === "project" ? projectId : null);
        onChanged();
      })().catch((e: unknown) => setError(describe(e)))
        .finally(() => setBusy(false));
    });
  };

  const globalBytes = globalStats === null ? null
    : globalStats.video.bytes + globalStats.stills.bytes;
  const globalCap = globalStats === null ? null
    : globalStats.video.capBytes + globalStats.stills.capBytes;

  return (
    <section>
      <h3>Cache</h3>

      <CacheLimitOverride projectPath={projectPath} projectId={projectId} onChanged={onChanged} />

      {stats === null && <p className="muted">Loading…</p>}
      {stats !== null && (
        <ul className="settings-pairing-list">
          {([["Video", stats.video], ["Stills", stats.stills]] as const).map(([label, k]) => (
            <li key={label} className="settings-pairing-row">
              <div className="settings-pairing-main">
                <div className="settings-pairing-title">
                  <strong>{label}</strong>
                  <span className="muted small">
                    {String(k.count)} entr{k.count === 1 ? "y" : "ies"} ·{" "}
                    {k.count + k.hits > 0
                      ? `${String(Math.round((k.hits / (k.count + k.hits)) * 100))}% hit rate`
                      : "no activity yet"}
                  </span>
                </div>
                <span className="muted small mono">
                  {formatBytes(k.bytes)} in the shared store
                  {k.projectUsageBytes !== null &&
                    ` · ${formatBytes(k.projectUsageBytes)} / ${formatBytes(k.capBytes)} this project`}
                </span>
                {k.projectUsageBytes !== null && k.capBytes > 0 && (
                  <Meter fraction={k.projectUsageBytes / k.capBytes} tone="cache" />
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="settings-row">
        <button className="ghost tiny" disabled={busy || projectId === null}
                onClick={() => flush("project")}>
          Flush this project…
        </button>
        <button className="danger tiny" disabled={busy} onClick={() => flush("all")}>
          Flush System Cache…
        </button>
      </div>
      {globalBytes !== null && globalCap !== null && globalCap > 0 && (
        <div className="dashboard-global-footprint">
          <span className="muted small mono">
            {formatBytes(globalBytes)} / {formatBytes(globalCap)} across every project
          </span>
          <Meter fraction={globalBytes / globalCap} tone="cache" />
        </div>
      )}
      {error !== null && <p className="settings-error">{error}</p>}
    </section>
  );
}

export function DashboardPane(): JSX.Element {
  const projectId = useStore((s) => s.assetRoot);
  const projectPath = useStore((s) => s.projectPath);
  const [jobsResponse, setJobsResponse] = useState<JobsResponse | null>(null);
  const [stats, setStats] = useState<CacheStats | null>(null);
  const [globalStats, setGlobalStats] = useState<CacheStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const liveRef = useRef(true);

  const refresh = (): void => {
    void listJobs()
      .then((r) => { if (liveRef.current) setJobsResponse(r); })
      .catch((e: unknown) => { if (liveRef.current) setError(describe(e)); });
    void getCacheStats(projectId)
      .then((s) => { if (liveRef.current) setStats(s); })
      .catch((e: unknown) => { if (liveRef.current) setError(describe(e)); });
    // A second, unscoped call just for the global-footprint figures —
    // `capBytes` in the project-scoped response above is this
    // project's effective cap (its own override, if any), not the
    // global one the footprint bar needs as its denominator.
    void getCacheStats(null)
      .then((s) => { if (liveRef.current) setGlobalStats(s); })
      .catch(() => { /* the project-scoped error above already covers this */ });
  };

  useEffect(() => {
    liveRef.current = true;
    refresh();
    const interval = window.setInterval(refresh, POLL_MS);
    return () => {
      liveRef.current = false;
      window.clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const jobs = jobsResponse?.jobs ?? [];

  return (
    <div className="settings-body">
      <div className="settings-content">
        {error !== null && <p className="settings-error">{error}</p>}
        {jobsResponse !== null && (
          <QueueSection jobs={jobs} workers={jobsResponse.workers} onChanged={refresh} />
        )}
        {jobsResponse !== null && <FailuresSection jobs={jobs} onChanged={refresh} />}
        <CacheSection stats={stats} globalStats={globalStats} projectId={projectId}
                      projectPath={projectPath} onChanged={refresh} />
      </div>
    </div>
  );
}
