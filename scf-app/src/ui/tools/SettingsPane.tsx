// SPDX-License-Identifier: Apache-2.0
/**
 * SettingsPane — app settings, as a tool tab (state/tabs.ts) alongside
 * the event log: reaches across every project tab and the start screen
 * alike (ToolPane.tsx renders it from both App.tsx's StartShell and
 * Workbench.tsx), so it doesn't need to be a dialog to do that — the
 * event log already proves a tool tab can.
 *
 * Three sections: General (tab-remembering, developer mode — both
 * one-line toggles with nothing else to say), Local data (project
 * pairings and the event log, grouped under one heading because both
 * are app.db/audit.db cache, not project content — and because that
 * framing is also the reason Settings, not the start screen's
 * recent-projects list, is the one place that forgets a project), and
 * Backends (the external tools the media server looks for). Each inner
 * piece still owns its own fetch and error state, so one failing
 * cannot blank the rest.
 */

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { ProjectRow } from "@scf-host/appStore.ts";
import { windowAppStore } from "../../host/windowAppStore.ts";
import { windowAuditStore } from "../../host/windowAuditStore.ts";
import { chooseAssetFolder } from "../../files/assetFolderChooser.ts";
import {
  PROXY_RESOLUTIONS, useSettings, type ProxyResolution,
} from "../../state/settings.ts";
import { useStore } from "../../state/store.ts";
import { useTabs } from "../../state/tabs.ts";
import {
  BACKEND_IDS, detectBackends, getOverrides, setOverride,
  type BackendId, type BackendStatus,
} from "../../state/mediaBackends.ts";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug",
  "Sep", "Oct", "Nov", "Dec"];

/** "Today, 14:32" / "Yesterday, 09:05" / "Mar 4, 10:17" / "Mar 4 2024" —
 *  a browser history's sense of a last-visited time, not a log's. */
function formatLastOpened(iso: string, now: Date): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, "0");
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay = (a: Date, b: Date): boolean =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (sameDay(d, now)) return `Today, ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) return `Yesterday, ${time}`;
  const month = MONTHS[d.getMonth()] ?? "";
  return d.getFullYear() === now.getFullYear()
    ? `${month} ${String(d.getDate())}, ${time}`
    : `${month} ${String(d.getDate())} ${String(d.getFullYear())}`;
}

const describe = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

type Section = "general" | "data" | "media";

const SECTIONS: { id: Section; label: string }[] = [
  { id: "general", label: "General" },
  { id: "data", label: "Local data" },
  { id: "media", label: "Media" },
];

function GeneralSection(): JSX.Element {
  const { rememberTabs, setRememberTabs, developerMode, setDeveloperMode } =
    useSettings();
  return (
    <section>
      <h3>General</h3>
      <label className="settings-check">
        <input type="checkbox" checked={rememberTabs}
               onChange={(e) => void setRememberTabs(e.target.checked)} />
        Remember open tabs
      </label>
      <p className="muted small">
        Reopens every file that was open last time, tab for tab, the next
        time the editor starts. Turning it off also forgets the tabs
        that were remembered.
      </p>

      <label className="settings-check">
        <input type="checkbox" checked={developerMode}
               onChange={(e) => void setDeveloperMode(e.target.checked)} />
        Developer mode
      </label>
      <p className="muted small">
        Exposes the row identity inspector — View &gt; Row identity, or
        Ctrl+I — which shows a row's uuid, lineage and asset bindings.
        Off by default: it is a diagnostic for working on SCF itself,
        not something a shoot needs open.
      </p>
    </section>
  );
}

interface PairingRow extends ProjectRow {
  /** Null when there is no asset root to check. */
  rootMissing: boolean | null;
}

function ProjectsSection(): JSX.Element {
  const bumpRecentProjectsRevision = useStore(
    (s) => s.bumpRecentProjectsRevision);
  const [rows, setRows] = useState<PairingRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const store = await windowAppStore();
        const projects = await store.recentProjects(500);
        const withChecks = await Promise.all(projects.map(async (p) => ({
          ...p,
          rootMissing: p.assetRoot === null ? null
            : !(await invoke<boolean>("fs_exists", { path: p.assetRoot })),
        })));
        if (live) setRows(withChecks);
      } catch (e) {
        if (live) setError(describe(e));
      }
    })();
    return () => { live = false; };
  }, [epoch]);

  const changeFolder = (scfPath: string): void => {
    void (async () => {
      const path = await chooseAssetFolder();
      if (path === null) return;
      const store = await windowAppStore();
      await store.setAssetRoot(scfPath, path);
      setEpoch((e) => e + 1);
      bumpRecentProjectsRevision();
    })().catch((e: unknown) => setError(describe(e)));
  };

  const forget = (scfPath: string, label: string): void => {
    void confirm(
      `Forget "${label}"? Its folder pairing and history drop from ` +
      "app.db; the project file itself is untouched.",
      { title: "Forget project", kind: "warning" },
    ).then((ok) => {
      if (!ok) return;
      void (async () => {
        const store = await windowAppStore();
        await store.forgetProject(scfPath);
        setEpoch((e) => e + 1);
        bumpRecentProjectsRevision();
      })().catch((e: unknown) => setError(describe(e)));
    });
  };

  const now = new Date();

  return (
    <section>
      <h4>Project history</h4>
      <p className="muted small">
        Every project this app has opened, newest first, and the asset
        folder each is paired with. Kept in app.db regardless of which
        project is open right now.
      </p>
      {error !== null && <p className="settings-error">{error}</p>}
      {rows === null && error === null && <p className="muted">Loading…</p>}
      {rows !== null && rows.length === 0 && (
        <p className="muted">No projects opened yet.</p>
      )}
      {rows !== null && rows.length > 0 && (
        <ul className="settings-pairing-list">
          {rows.map((r) => (
            <li key={r.pathKey} className="settings-pairing-row">
              <div className="settings-pairing-main">
                <div className="settings-pairing-title">
                  <strong>{r.title ?? r.baseName ?? "Untitled"}</strong>
                  <span className="muted small">
                    {formatLastOpened(r.lastOpened, now)}
                  </span>
                </div>
                <span className="muted small mono">{r.scfPath}</span>
                <span className="muted small mono">
                  {r.assetRoot ?? "no folder paired"}
                  {r.rootMissing === true && (
                    <span className="recent-project-flag">
                      {" "}folder not found
                    </span>
                  )}
                </span>
              </div>
              <div className="settings-pairing-actions">
                <button className="ghost tiny"
                        onClick={() => changeFolder(r.scfPath)}>
                  {r.assetRoot === null ? "Set folder…" : "Change…"}
                </button>
                <button className="ghost tiny"
                        onClick={() => forget(
                          r.scfPath, r.title ?? r.baseName ?? r.scfPath)}>
                  Forget
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function EventLogSection(): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const clearNow = (): void => {
    void confirm(
      "Clear the event log? This can't be undone — open the event log " +
      "first if you want to export a copy.",
      { title: "Clear event log", kind: "warning" },
    ).then((ok) => {
      if (!ok) return;
      void (async () => {
        setBusy(true);
        setError(null);
        setNotice(null);
        // A cutoff a moment ahead of now catches every row written so far.
        const before = new Date(Date.now() + 1000).toISOString();
        const store = await windowAuditStore();
        const removed = await store.prune(before);
        await store.append({
          actorKind: "user", actorName: "window", scope: "app",
          action: "settings.eventLog.clear",
          summary: `cleared ${String(removed)} events`,
        }).catch((e: unknown) => {
          console.error("event log write failed:", e);
        });
        setNotice(`Cleared ${String(removed)} event${
          removed === 1 ? "" : "s"}.`);
      })().catch((e: unknown) => setError(describe(e)))
        .finally(() => setBusy(false));
    });
  };

  const openEventLog = (): void => {
    useTabs.getState().openTool("events");
  };

  return (
    <section>
      <h4>Event log</h4>
      <p className="muted small">
        A local work history of what happened in your projects and in
        this app, kept on this machine. It isn't shared or synced
        anywhere, so it's yours to clear whenever you like.
      </p>
      <div className="settings-row">
        <button className="ghost tiny" onClick={openEventLog}>
          Open the event log
        </button>
        <button className="danger tiny" disabled={busy} onClick={clearNow}>
          Clear event log…
        </button>
      </div>
      {notice !== null && <p className="muted small">{notice}</p>}
      {error !== null && <p className="settings-error">{error}</p>}
    </section>
  );
}

function DataSection(): JSX.Element {
  return (
    <section>
      <h3>Local data</h3>
      <p className="muted small">
        Project pairings and the event log are both cached on this
        machine, not stored in any project file. This is the only place
        that edits either one; the start screen's recent-projects list
        just reads it.
      </p>
      <ProjectsSection />
      <EventLogSection />
    </section>
  );
}

function CheckIcon(): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 8.5l3.3 3.3L13 4.5" stroke="currentColor" strokeWidth="1.8"
            strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

/** Absence, not alarm: an optional add-on that simply isn't installed
 *  yet is not an error, so this reads as neutral rather than a warning
 *  triangle or a red "x". */
function MissingIcon(): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="5.6" stroke="currentColor" strokeWidth="1.3"
              fill="none" />
      <path d="M5.2 8h5.6" stroke="currentColor" strokeWidth="1.3"
            strokeLinecap="round" />
    </svg>
  );
}

function FolderIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M1.8 4.2c0-.55.45-1 1-1h3.2l1.3 1.5h5.9c.55 0 1 .45 1 1v6.1
                c0 .55-.45 1-1 1H2.8c-.55 0-1-.45-1-1V4.2Z"
            stroke="currentColor" strokeWidth="1.2" fill="none"
            strokeLinejoin="round" />
    </svg>
  );
}

/** The "Web" column head — a globe rather than the word, to stay
 *  narrow next to the icon-only buttons it heads. */
function GlobeIcon(): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.2"
              fill="none" />
      <path d="M1.8 8h12.4M8 1.8c2 2 2 10.4 0 12.4M8 1.8c-2 2-2 10.4 0 12.4"
            stroke="currentColor" strokeWidth="1.2" fill="none" />
    </svg>
  );
}

/** External-link glyph, so an address that leaves the app reads as one
 *  before it's clicked rather than after. */
function ExternalLinkIcon(): JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M6.6 3H3.4a1 1 0 0 0-1 1v8.6a1 1 0 0 0 1 1H12a1 1 0 0 0 1-1V9.4"
            stroke="currentColor" strokeWidth="1.3" fill="none"
            strokeLinecap="round" />
      <path d="M9 2.4h4.6V7M13.5 2.5 7.4 8.6" stroke="currentColor"
            strokeWidth="1.3" fill="none" strokeLinecap="round"
            strokeLinejoin="round" />
    </svg>
  );
}

/** Display name, download link and what it unlocks, per binary — not a
 *  capability check, just enough for a human reading the summary line.
 *  Deeper capability records are media-core's job, Phase 5 onward. */
const BACKEND_INFO: Record<BackendId, {
  label: string; href: string; unlocks: string;
}> = {
  ffmpeg: {
    label: "ffmpeg", href: "https://ffmpeg.org/download.html",
    unlocks: "video/audio transcoding, remuxing and stills",
  },
  ffprobe: {
    label: "ffprobe", href: "https://ffmpeg.org/download.html",
    unlocks: "video/audio probing (ships with ffmpeg)",
  },
  magick: {
    label: "magick (ImageMagick)",
    href: "https://imagemagick.org/script/download.php",
    unlocks: "TIFF, PSD and HEIC stills",
  },
  oiiotool: {
    label: "oiiotool (OpenImageIO)",
    href: "https://github.com/AcademySoftwareFoundation/OpenImageIO",
    unlocks: "EXR and DPX stills, OCIO colour transforms",
  },
};

/** Global media-pipeline configuration (worker counts, default proxy
 *  resolution, combined cache ceiling) — everything project-scoped
 *  (per-project cache override, the live queue) stays in the Media tab's
 *  `DashboardPane.tsx`; this is the only place that edits the rest. */
function MediaSettingsSection(): JSX.Element {
  const {
    videoWorkers, stillWorkers, proxyResolution, cacheLimitGb,
    setVideoWorkers, setStillWorkers, setProxyResolution, setCacheLimitGb,
  } = useSettings();

  return (
    <section>
      <h3>Media</h3>
      <h4>Worker threads</h4>
      <p className="muted small">
        How many ffmpeg/ImageMagick/oiiotool conversions can run at once,
        per kind. Raising this speeds up a backlog but competes harder for
        CPU on large ProRes/RAW files. Takes effect next time the app
        starts.
      </p>
      <div className="settings-row">
        <label className="settings-field">
          Video
          <input type="number" min={1} max={8} value={videoWorkers}
                 onChange={(e) => void setVideoWorkers(
                   Math.max(1, Number(e.target.value) || 1))} />
        </label>
        <label className="settings-field">
          Stills
          <input type="number" min={1} max={16} value={stillWorkers}
                 onChange={(e) => void setStillWorkers(
                   Math.max(1, Number(e.target.value) || 1))} />
        </label>
      </div>

      <h4>Default proxy resolution</h4>
      <p className="muted small">
        The target size for a video proxy when nothing more specific asks
        for one.
      </p>
      <select value={proxyResolution}
              onChange={(e) => void setProxyResolution(
                Number(e.target.value) as ProxyResolution)}>
        {PROXY_RESOLUTIONS.map((r) => (
          <option key={r} value={r}>
            {r === 720 ? "720p (half-res)" : `${String(r)}p`}
          </option>
        ))}
      </select>

      <h4>Global cache limit</h4>
      <p className="muted small">
        The combined ceiling for converted previews across every project,
        in GB, before the oldest entries are evicted. Per-project limits in
        the Media tab can only tighten this, never raise it.
      </p>
      <label className="settings-field">
        GB
        <input type="number" min={0.5} step={0.5} value={cacheLimitGb}
               onChange={(e) => void setCacheLimitGb(
                 Math.max(0.5, Number(e.target.value) || 0.5))} />
      </label>
    </section>
  );
}

/** Exported so Phase 7's `DashboardPane.tsx` can show the same panel
 *  (spec §9: "Backend status panel (shared with settings)") rather
 *  than keeping a second copy of this list in sync by hand. */
export function BackendsSection(): JSX.Element {
  const [overrides, setOverrides] =
    useState<Record<BackendId, string> | null>(null);
  const [statuses, setStatuses] = useState<Record<BackendId, BackendStatus> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async (
    current?: Record<BackendId, string>,
  ): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const o = current ?? overrides ?? await getOverrides();
      setOverrides(o);
      const results = await detectBackends(o);
      const byId = {} as Record<BackendId, BackendStatus>;
      for (const r of results) byId[r.id] = r;
      setStatuses(byId);
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => { void refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const commitOverride = (id: BackendId, path: string): void => {
    void (async () => {
      await setOverride(id, path);
      const next = { ...(overrides ?? await getOverrides()), [id]: path.trim() };
      await refresh(next);
    })().catch((e: unknown) => setError(describe(e)));
  };

  const pickOverride = (id: BackendId, current: string): void => {
    void (async () => {
      const path = await open({
        multiple: false, directory: false,
        filters: [{ name: "Executable", extensions: ["exe"] }],
        defaultPath: current.trim() === "" ? undefined : current,
      });
      if (path === null) return;
      commitOverride(id, path);
    })().catch((e: unknown) => setError(describe(e)));
  };

  const okCount = statuses === null ? 0 :
    BACKEND_IDS.filter((id) => statuses[id]?.ok === true).length;
  const unlocked = statuses === null ? [] : BACKEND_IDS
    .filter((id) => statuses[id]?.ok === true)
    .map((id) => BACKEND_INFO[id].unlocks);

  return (
    <section>
      <h3>Media helpers</h3>
      <p className="muted small">
        Optional tools that let previews show more of your footage and
        stills — ProRes, EXR, raw PSD/TIFF, HEIC and the like. Nothing
        here is required: without them, those files just preview with
        less detail.
      </p>
      <div className="settings-row">
        <button className="ghost tiny settings-redetect" disabled={busy}
                onClick={() => void refresh()}>
          <span className="settings-redetect-icon" aria-hidden="true">↻</span>
          {busy ? "Checking…" : "Re-detect"}
        </button>
      </div>
      {error !== null && <p className="settings-error">{error}</p>}
      {overrides === null && error === null && <p className="muted">Loading…</p>}
      {overrides !== null && (
      <div className="settings-backend-table">
        <div className="settings-backend-row settings-backend-head">
          <span>Tool</span>
          <span className="settings-backend-head-web" title="Web">
            <GlobeIcon />
          </span>
          <span>Status</span>
          <span>Location</span>
        </div>
        {BACKEND_IDS.map((id) => {
          const info = BACKEND_INFO[id];
          const status = statuses?.[id] ?? null;
          const override = overrides?.[id] ?? "";
          const found = status?.ok === true;
          const host = info.href.replace(/^https?:\/\//, "").split("/")[0];
          const statusText = status === null ? "Checking…"
            : found ? (status.version ?? "Found")
              : "Not installed (optional)";
          return (
            <div key={id} className="settings-backend-row">
              <strong className="settings-backend-name">{info.label}</strong>
              <a className="ghost tiny settings-icon-btn" href={info.href}
                 target="_blank" rel="noopener noreferrer"
                 title={`Download ${info.label} — opens ${host}`}
                 aria-label={`Download ${info.label} (opens ${host} in your browser)`}>
                <ExternalLinkIcon />
              </a>
              <div className={"settings-backend-status" +
                               (status === null ? "" : found ? " found" : " missing")}>
                <span className="settings-backend-status-icon" aria-hidden="true">
                  {status !== null && (found ? <CheckIcon /> : <MissingIcon />)}
                </span>
                <span className="small" title={statusText}>{statusText}</span>
              </div>
              <div className="settings-backend-override">
                <button type="button" className="ghost tiny settings-icon-btn"
                        title={`Choose ${info.label}'s executable…`}
                        aria-label={`Choose ${info.label}'s executable file`}
                        onClick={() => pickOverride(id, override)}>
                  <FolderIcon />
                </button>
                {status?.path != null ? (
                  <button type="button" className="settings-backend-path"
                          title="Open the containing folder"
                          aria-label={`Open the folder containing ${info.label}`}
                          onClick={() => void revealItemInDir(status.path ?? "")}>
                    {status.path}
                  </button>
                ) : (
                  <span className="muted small mono">
                    {override === "" ? "auto-detect" : override}
                  </span>
                )}
                {override !== "" && (
                  <button type="button"
                          className="ghost tiny settings-backend-clear"
                          title="Reset to auto-detect"
                          aria-label={`Reset ${info.label} to auto-detect`}
                          onClick={() => commitOverride(id, "")}>
                    ×
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      )}
      <p className="muted small">
        {statuses === null ? "Checking…"
          : okCount === 0
            ? "None installed yet — previews fall back to what your " +
              "browser can show natively."
            : `${String(okCount)} of ${String(BACKEND_IDS.length)} ` +
              `installed. Unlocks: ${unlocked.join("; ")}.`}
      </p>
    </section>
  );
}

export function SettingsPane(): JSX.Element {
  const [section, setSection] = useState<Section>("general");
  return (
    <div className="settings-body">
      <nav className="settings-nav" aria-label="Settings sections">
        {SECTIONS.map((s) => (
          <button key={s.id} role="tab" aria-selected={section === s.id}
                  className={"settings-nav-item" +
                             (section === s.id ? " active" : "")}
                  onClick={() => setSection(s.id)}>
            {s.label}
          </button>
        ))}
      </nav>
      <div className="settings-content">
        {section === "general" && <GeneralSection />}
        {section === "data" && <DataSection />}
        {section === "media" && (
          <>
            <MediaSettingsSection />
            <BackendsSection />
          </>
        )}
      </div>
    </div>
  );
}
