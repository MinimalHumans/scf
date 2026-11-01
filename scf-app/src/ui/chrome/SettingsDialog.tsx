// SPDX-License-Identifier: Apache-2.0
/**
 * SettingsDialog — app settings, on their own rather than folded into
 * the tab strip: Settings reaches across every project tab and the
 * start screen alike, so it is a dialog over whichever screen is
 * showing, not a tool tab competing with project and event-log tabs
 * for the same row.
 *
 * Two sections, not four: General (tab-remembering, developer mode —
 * both one-line toggles with nothing else to say) and Local data
 * (project pairings and the event log, grouped under one heading
 * because both are app.db/audit.db cache, not project content — and
 * because that framing is also the reason Settings, not the start
 * screen's recent-projects list, is the one place that forgets a
 * project). Each inner piece still owns its own fetch and error state,
 * so one failing cannot blank the rest.
 */

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirm } from "@tauri-apps/plugin-dialog";
import type { ProjectRow } from "@scf-host/appStore.ts";
import { windowAppStore } from "../../host/windowAppStore.ts";
import { windowAuditStore } from "../../host/windowAuditStore.ts";
import { chooseAssetFolder } from "../../files/assetFolderChooser.ts";
import { useSettings } from "../../state/settings.ts";
import { useStore } from "../../state/store.ts";
import { useTabs } from "../../state/tabs.ts";

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

type Section = "general" | "data";

const SECTIONS: { id: Section; label: string }[] = [
  { id: "general", label: "General" },
  { id: "data", label: "Local data" },
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

function EventLogSection({ onClose }: { onClose: () => void }): JSX.Element {
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
    onClose();
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

function DataSection({ onClose }: { onClose: () => void }): JSX.Element {
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
      <EventLogSection onClose={onClose} />
    </section>
  );
}

export function SettingsDialog({ onClose }: { onClose: () => void }):
    JSX.Element {
  const [section, setSection] = useState<Section>("general");
  return (
    <div className="modal-scrim" role="dialog" aria-modal="true"
         aria-labelledby="settings-dialog-title"
         onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
         onClick={onClose}>
      <div className="modal settings-dialog"
           onClick={(e) => { e.stopPropagation(); }}>
        <div className="modal-head">
          <h2 id="settings-dialog-title">Settings</h2>
          <button className="ghost tiny" aria-label="Close" autoFocus
                  onClick={onClose}>
            ×
          </button>
        </div>
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
            {section === "data" && <DataSection onClose={onClose} />}
          </div>
        </div>
      </div>
    </div>
  );
}
