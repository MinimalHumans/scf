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
import { confirm } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { ProjectRow } from "@scf-host/appStore.ts";
import { windowAppStore } from "../../host/windowAppStore.ts";
import { windowAuditStore } from "../../host/windowAuditStore.ts";
import { chooseAssetFolder } from "../../files/assetFolderChooser.ts";
import { useSettings } from "../../state/settings.ts";
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

type Section = "general" | "data" | "backends";

const SECTIONS: { id: Section; label: string }[] = [
  { id: "general", label: "General" },
  { id: "data", label: "Local data" },
  { id: "backends", label: "Backends" },
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

  const okCount = statuses === null ? 0 :
    BACKEND_IDS.filter((id) => statuses[id]?.ok === true).length;
  const unlocked = statuses === null ? [] : BACKEND_IDS
    .filter((id) => statuses[id]?.ok === true)
    .map((id) => BACKEND_INFO[id].unlocks);

  return (
    <section>
      <h3>Backends</h3>
      <p className="muted small">
        External tools the media server uses to preview formats the
        browser can't decode on its own — EXR, ProRes, PSD and the like.
        None are bundled; point at your own copy if it isn't on PATH.
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
      <ul className="settings-pairing-list">
        {BACKEND_IDS.map((id) => {
          const info = BACKEND_INFO[id];
          const status = statuses?.[id] ?? null;
          const override = overrides?.[id] ?? "";
          return (
            <li key={id} className="settings-pairing-row">
              <div className="settings-pairing-main">
                <div className="settings-pairing-title">
                  <strong>{info.label}</strong>
                  <span className={status?.ok === false ? "settings-error small" : "muted small"}>
                    {status === null ? "—"
                      : status.ok
                        ? `✓ ${status.version ?? "found"}`
                        : status.error ?? "not found"}
                  </span>
                </div>
                <span className="muted small mono">
                  {status?.path ?? "not resolved"}
                </span>
                <label className="settings-row">
                  <span className="muted small">Path override</span>
                  <input type="text" className="mono" defaultValue={override}
                         placeholder="auto-detect"
                         onBlur={(e) => commitOverride(id, e.target.value)} />
                </label>
              </div>
              <div className="settings-pairing-actions">
                <button className="ghost tiny" disabled={status?.path == null}
                        onClick={() => {
                          if (status?.path != null) void revealItemInDir(status.path);
                        }}>
                  Reveal folder
                </button>
                <a className="ghost tiny" href={info.href}
                   target="_blank" rel="noopener noreferrer">
                  Get it
                </a>
              </div>
            </li>
          );
        })}
      </ul>
      )}
      <p className="muted small">
        {statuses === null ? "Checking…"
          : okCount === 0
            ? "No backends found — previews fall back to whatever the " +
              "browser can decode natively."
            : `${String(okCount)} of ${String(BACKEND_IDS.length)} found. ` +
              `Unlocks: ${unlocked.join("; ")}.`}
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
        {section === "backends" && <BackendsSection />}
      </div>
    </div>
  );
}
