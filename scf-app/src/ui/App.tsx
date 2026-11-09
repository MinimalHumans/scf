// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../state/store.ts";
import { RecentProjects } from "./RecentProjects.tsx";
import { SuggestionDialog } from "./SuggestionDialog.tsx";
import { Workbench } from "./Workbench.tsx";
import { TitleStrip } from "./chrome/TitleStrip.tsx";
import { useAppCommands } from "./chrome/useAppCommands.tsx";
import { ToolPane } from "./tools/ToolPane.tsx";
import { useTabs } from "../state/tabs.ts";
import { useProjectTabs } from "../state/projectTabs.ts";
import { useSettings } from "../state/settings.ts";
import logoBigCloud from "../assets/logoBig_cloud.svg";
import logoMinimalHumans from "../assets/minimalHumans_logoShort.svg";

function StartScreen(): JSX.Element {
  const { openDemo, openFromPicker, newProject, hostStatus, hostError,
          connect, phase, errorMessage } = useStore();
  const ready = hostStatus === "ready";
  return (
    <div className="start">
      <div className="start-card">
        <h1 className="start-mark">
          <img src={logoBigCloud} alt="SCF" />
        </h1>
        <p className="start-sub">Story Context Framework — editor</p>
        {hostStatus === "connecting" && (
          <p className="start-status" role="status">
            {hostError ?? "Connecting to the SCF host…"}
          </p>
        )}
        {hostStatus === "unavailable" && (
          <>
            <p className="start-error">
              The SCF host is not reachable: {hostError}
            </p>
            <button onClick={() => void connect()}>Try again</button>
          </>
        )}
        <div className="start-actions">
          <button className="primary" disabled={!ready}
                  onClick={() => void newProject()}>
            New Project
          </button>
          <button disabled={!ready}
                  onClick={() => void openFromPicker()}
                  title="If app.db already knows this file's asset folder
it is attached automatically; otherwise choose it from the File menu.">
            Open an SCF File
          </button>
          <button disabled={!ready} onClick={() => void openDemo()}>
            Open Hollow Creek Demo
          </button>
        </div>
        {phase === "loading" && <p className="start-status">Opening…</p>}
        {phase === "error" && (
          <>
            <p className="start-error">{errorMessage}</p>
            <button onClick={() => window.location.reload()}>
              Reload app
            </button>
          </>
        )}
        {phase === "start" && errorMessage !== null && (
          <p className="start-error">{errorMessage}</p>
        )}
        {ready && <RecentProjects />}
      </div>
      <a className="start-maker" href="https://www.minimalhumans.com"
         target="_blank" rel="noopener noreferrer">
        <img src={logoMinimalHumans} alt="Minimal Humans" />
      </a>
    </div>
  );
}

function MultiTabScreen(): JSX.Element {
  return (
    <div className="start">
      <div className="start-card">
        <h1 className="start-mark">
          <img src={logoBigCloud} alt="SCF" />
        </h1>
        <p className="start-sub">Story Context Framework — editor</p>
        <p className="start-warn">
          SCF is already open in another tab. Two windows editing one
          film would each save their own copy of the script over the
          other's, so only one tab is allowed at a time. Close the other
          tab, then
        </p>
        <button className="primary"
                onClick={() => window.location.reload()}>
          Try again here
        </button>
      </div>
    </div>
  );
}

/**
 * The title strip above the screens that have no project: the window has
 * no frame of its own on Windows, so without this the start screen would
 * have nothing to drag, no window buttons, and no way to quit.
 */
function StartShell({ children }: { children: JSX.Element }): JSX.Element {
  const { ctx, about, settings, licenses } = useAppCommands({
    hasProject: false, identityOpen: false, toggleIdentity: () => undefined,
  });
  const front = useTabs((t) => t.active);
  // No tab is live here (the start screen only shows when nothing is),
  // but a tab a resume could not reopen, or one left backgrounded while
  // this tab failed, is still worth showing — closable, and clickable
  // to try again.
  const hasTabs = useProjectTabs((s) => s.tabs.length > 0);
  return (
    <div className="start-shell">
      <TitleStrip ctx={ctx} showProject={hasTabs} />
      {about}
      {settings}
      {licenses}
      {front === "project" ? children : <ToolPane id={front} />}
    </div>
  );
}

export function App(): JSX.Element {
  const phase = useStore((s) => s.phase);
  const hostStatus = useStore((s) => s.hostStatus);
  const connect = useStore((s) => s.connect);
  const resumeTabs = useStore((s) => s.resumeTabs);
  const openOrFocus = useStore((s) => s.openOrFocus);
  const settingsLoaded = useSettings((s) => s.loaded);
  const tried = useRef(false);
  const connecting = useRef(false);

  // The host starts with the dev server, possibly a moment after the
  // page: connect (retrying) as soon as the app is up.
  useEffect(() => {
    if (connecting.current) return;
    connecting.current = true;
    void connect();
    void useSettings.getState().load();
  }, [connect]);

  // Launching (or a dev reload) reopens whatever was open before, tab
  // for tab — unless the setting is off, which `resumeTabs` itself
  // checks once it has an answer from `load` above to check. A file
  // this launch was given to open (a `.scf` double-click, lib.rs's
  // `launch_path`) comes after and takes the front tab, so it is not
  // lost under whatever tab resuming happened to land on.
  useEffect(() => {
    if (tried.current || phase !== "start") return;
    if (hostStatus !== "ready" || !settingsLoaded) return;
    tried.current = true;
    void (async () => {
      await resumeTabs();
      const path = await invoke<string | null>("launch_path");
      if (path !== null) await openOrFocus(path);
    })();
  }, [phase, hostStatus, settingsLoaded, resumeTabs, openOrFocus]);

  if (phase === "multitab") return <StartShell><MultiTabScreen /></StartShell>;
  if (phase !== "open") return <StartShell><StartScreen /></StartShell>;
  return <><Workbench /><SuggestionDialog /></>;
}
