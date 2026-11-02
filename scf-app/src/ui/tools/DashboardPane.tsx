// SPDX-License-Identifier: Apache-2.0
/**
 * DashboardPane — Phase 7's live view onto the media server (docs/
 * media-server-spec.md §9): the job queue and worker slots, the
 * failures list with each job's stderr tail, and cache usage against
 * this project's quota with flush actions. Binary detection/overrides
 * ("Media helpers") live only in Settings > Media now
 * (`SettingsPane.tsx`'s `BackendsSection`) — this tab is project-scoped
 * operational state, not global configuration.
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
import { cancelJob, flushCache, retryJob } from "../../files/objectUrlCache.ts";
import {
  getCacheStats, listJobs,
  type CacheStats, type DashboardJob, type JobsResponse,
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

function QueueSection({ jobs, workers, onChanged }: {
  jobs: DashboardJob[]; workers: JobsResponse["workers"]; onChanged: () => void;
}): JSX.Element {
  const active = jobs.filter((j) => j.state === "queued" || j.state === "running");

  const cancel = (id: string): void => {
    void cancelJob(id).then(onChanged);
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
          {active.map((j) => (
            <li key={j.id} className="settings-pairing-row">
              <div className="settings-pairing-main">
                <div className="settings-pairing-title">
                  <strong>{j.fileName ?? j.id}</strong>
                  <span className="muted small">{STATE_LABEL[j.state]}</span>
                </div>
                <span className="muted small mono">
                  {j.backendId ?? "—"} · {j.priority} ·{" "}
                  {formatElapsed(j.startedAt ?? j.createdAt)}
                  {j.progress !== null &&
                    ` · ${String(Math.round(j.progress * 100))}%`}
                </span>
              </div>
              <div className="settings-pairing-actions">
                <button className="ghost tiny" onClick={() => cancel(j.id)}>
                  Cancel
                </button>
              </div>
            </li>
          ))}
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

function CacheSection({ stats, projectId, onChanged }: {
  stats: CacheStats | null; projectId: string | null; onChanged: () => void;
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

  return (
    <section>
      <h3>Cache</h3>
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
          Flush all…
        </button>
      </div>
      {error !== null && <p className="settings-error">{error}</p>}
    </section>
  );
}

export function DashboardPane(): JSX.Element {
  const projectId = useStore((s) => s.assetRoot);
  const [jobsResponse, setJobsResponse] = useState<JobsResponse | null>(null);
  const [stats, setStats] = useState<CacheStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const liveRef = useRef(true);

  const refresh = (): void => {
    void listJobs()
      .then((r) => { if (liveRef.current) setJobsResponse(r); })
      .catch((e: unknown) => { if (liveRef.current) setError(describe(e)); });
    void getCacheStats(projectId)
      .then((s) => { if (liveRef.current) setStats(s); })
      .catch((e: unknown) => { if (liveRef.current) setError(describe(e)); });
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
        <CacheSection stats={stats} projectId={projectId} onChanged={refresh} />
      </div>
    </div>
  );
}
