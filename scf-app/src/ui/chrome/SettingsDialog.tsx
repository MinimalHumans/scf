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
        const projects = await store.recentProjects(50);
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

  return (
    <section>
      <h4>Project history</h4>
      <p className="muted small">
        Every project this app has opened, and the asset folder it is
        paired with. Kept in app.db regardless of which project is open
        right now.
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
                <strong>{r.title ?? r.baseName ?? "Untitled"}</strong>
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

const RETENTION_DAYS = [30, 90, 365];

function EventLogSection(): JSX.Element {
  const [days, setDays] = useState(90);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pruneNow = (): void => {
    void confirm(
      `Delete every event older than ${String(days)} days? This cannot ` +
      "be undone — export from the Event log tab first if you want a copy.",
      { title: "Delete old events", kind: "warning" },
    ).then((ok) => {
      if (!ok) return;
      void (async () => {
        setBusy(true);
        setError(null);
        setNotice(null);
        const before =
          new Date(Date.now() - days * 86_400_000).toISOString();
        const store = await windowAuditStore();
        const removed = await store.prune(before);
        await store.append({
          actorKind: "user", actorName: "window", scope: "app",
          action: "settings.eventLog.prune",
          summary: `removed ${String(removed)} events older than ` +
            `${String(days)} days`,
        }).catch((e: unknown) => {
          console.error("audit trail write failed:", e);
        });
        setNotice(`Removed ${String(removed)} event${
          removed === 1 ? "" : "s"} older than ${String(days)} days.`);
      })().catch((e: unknown) => setError(describe(e)))
        .finally(() => setBusy(false));
    });
  };

  return (
    <section>
      <h4>Event log</h4>
      <p className="muted small">
        A manual cleanup for the local event log (audit.db). This deletes
        from the front of the chain; events kept past this point stay
        verifiable.
      </p>
      <label className="settings-row">
        Delete events older than
        <select value={days}
                onChange={(e) => setDays(Number(e.target.value))}>
          {RETENTION_DAYS.map((d) => (
            <option key={d} value={d}>
              {d < 365 ? `${String(d)} days` : "1 year"}
            </option>
          ))}
        </select>
        <button className="danger" disabled={busy} onClick={pruneNow}>
          Delete now
        </button>
      </label>
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
        machine — in app.db and audit.db — not stored in any project
        file. This is the only place that edits either cache; the start
        screen's recent-projects list just reads it.
      </p>
      <ProjectsSection />
      <EventLogSection />
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
            {section === "data" && <DataSection />}
          </div>
        </div>
      </div>
    </div>
  );
}
