// SPDX-License-Identifier: Apache-2.0
import { useStore } from "../state/store.ts";
import { CategoryTree } from "./CategoryTree.tsx";
import { SubjectNav } from "./SubjectNav.tsx";
import { SubjectView } from "./SubjectView.tsx";
import { EntityList } from "./EntityList.tsx";
import { EntityForm } from "./EntityForm.tsx";
import { ReverseLinks } from "./ReverseLinks.tsx";
import { SearchBox } from "./SearchBox.tsx";
import { QueryIndex, QueryRunner } from "./queries/QueryRunner.tsx";
import { ScriptView } from "./ScriptView.tsx";
import { StructureView } from "./StructureView.tsx";
import { undoSummary } from "@scf-core/ops/undoDelete.ts";
import { ShootView } from "./ShootView.tsx";
import { ScriptReader } from "./ScriptReader.tsx";
import { useStore as useStoreRaw } from "../state/store.ts";
import logoFullWhite from "../assets/logoFull_white.svg";
import { Component, useEffect, useRef, useState, type ReactNode }
  from "react";

/**
 * A render crash anywhere in the main pane must never white-screen the
 * app: it renders here, with its message, and navigation stays alive.
 */
class MainPaneBoundary extends Component<
  { children: ReactNode; resetKey: string },
  { error: Error | null }
> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }
  override componentDidUpdate(prev: { resetKey: string }): void {
    if (prev.resetKey !== this.props.resetKey &&
        this.state.error !== null) {
      this.setState({ error: null });
    }
  }
  override render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <div className="pane-crash" role="alert">
          <h2>This view crashed</h2>
          <p className="mono">{this.state.error.message}</p>
          <pre className="crash-stack">{this.state.error.stack}</pre>
          <p className="muted">
            Pick another item or tab to continue — the rest of the app
            is fine. Please report the message above.
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}
import { SceneRail } from "./SceneRail.tsx";
import { IdentityPanel } from "./IdentityPanel.tsx";
import { AssetBrowser, AssetPathRail } from "./AssetBrowser.tsx";
import { ActivityBar } from "./workspace/ActivityBar.tsx";
import { TitleStrip } from "./chrome/TitleStrip.tsx";
import { useAppCommands } from "./chrome/useAppCommands.tsx";
import { ToolPane } from "./tools/ToolPane.tsx";
import { useTabs } from "../state/tabs.ts";
import { CharacterRail, SubjectRail } from "./workspace/CharacterRail.tsx";
import { LocationWorkspace } from "./workspace/LocationWorkspace.tsx";
import { PropWorkspace } from "./workspace/PropWorkspace.tsx";
import { CharacterWorkspace } from "./workspace/CharacterWorkspace.tsx";
import { ProjectWorkspace } from "./workspace/ProjectWorkspace.tsx";
import { ShotlistView } from "./ShotlistView.tsx";
import { StoryboardView } from "./StoryboardView.tsx";
import { ScreenplayView } from "./ScreenplayView.tsx";
import { GalleryView } from "./GalleryView.tsx";

const RAIL_KEY = "scf:rail-width";
const RAIL_MIN = 180;
/** Wide enough for a deep asset path or a long scene heading. */
const RAIL_MAX = 900;
/** The section switcher moved out of the rail into the activity bar, so
 *  the rail no longer has a tab bar to measure; it starts at a width a
 *  character list or scene list reads well at, and remembers a drag. */
const RAIL_DEFAULT = 260;

/** The read-only script beside Structure and Shoot: wide enough for a
 *  dialogue block to keep its indents, remembered once dragged. */
const READER_KEY = "scf:reader-width";
const READER_OPEN_KEY = "scf:reader-open";
const READER_MIN = 280;
const READER_MAX = 1100;
const READER_DEFAULT = 480;

function usePaneWidth(key: string, min: number, max: number,
                      fallback: number): [number, (w: number) => void] {
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem(key));
    return Number.isFinite(saved) && saved >= min ? saved : fallback;
  });
  const set = (w: number): void => {
    const clamped = Math.min(max, Math.max(min, w));
    setWidth(clamped);
    localStorage.setItem(key, String(clamped));
  };
  return [width, set];
}

function useRailWidth(): [number, (w: number) => void] {
  return usePaneWidth(RAIL_KEY, RAIL_MIN, RAIL_MAX, RAIL_DEFAULT);
}

function useReaderOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(
    () => localStorage.getItem(READER_OPEN_KEY) !== "0");
  const set = (v: boolean): void => {
    setOpen(v);
    localStorage.setItem(READER_OPEN_KEY, v ? "1" : "0");
  };
  return [open, set];
}

function RailResizeHandle({ onDrag }: {
  onDrag: (clientX: number) => void;
}): JSX.Element {
  return (
    <div className="rail-resize-handle"
         onPointerDown={(e) => {
           e.preventDefault();
           const move = (ev: PointerEvent): void => onDrag(ev.clientX);
           const up = (): void => {
             window.removeEventListener("pointermove", move);
             window.removeEventListener("pointerup", up);
           };
           window.addEventListener("pointermove", move);
           window.addEventListener("pointerup", up);
         }} />
  );
}

export function Workbench(): JSX.Element {
  const [railWidth, setRailWidth] = useRailWidth();
  const [readerWidth, setReaderWidth] = usePaneWidth(
    READER_KEY, READER_MIN, READER_MAX, READER_DEFAULT);
  const [readerOpen, setReaderOpen] = useReaderOpen();
  // A diagnostic, not a workspace: an overlay reachable from anywhere
  // rather than a seventh nav tab, because it reads whatever row is
  // already open.
  const [identityOpen, setIdentityOpen] = useState(false);
  const { navMode, openRow, selectedEntityType, selectedSubject } =
    useStore();
  const front = useTabs((t) => t.active);
  const openTools = useTabs((t) => t.tools);

  // Keeps `assetResolution` current for the menu and Assets-nav badges,
  // which only read it — this is the one place that re-scans, on the
  // same signal IdentityPanel's own tally already re-runs on (a folder
  // attached, a project opened or switched).
  const resolveAssets = useStoreRaw((s) => s.resolveAssets);
  const environmentRevision = useStoreRaw((s) => s.environmentRevision);
  useEffect(() => { void resolveAssets(); }, [environmentRevision, resolveAssets]);

  const { ctx: commandCtx, about, licenses } = useAppCommands({
    hasProject: true, identityOpen,
    toggleIdentity: () => { setIdentityOpen((v) => !v); },
  });

  const main = openRow !== null
    ? <EntityForm key={`${openRow.entity}:${String(openRow.id)}`} />
    : navMode === "intro"
      ? <IntroMain />
    : navMode === "project"
      ? <ProjectWorkspace />
    : navMode === "script"
      ? <ScriptView />
    : navMode === "structure"
      ? <StructureView />
    : navMode === "shoot"
      ? <ShootView />
    : navMode === "queries"
      ? <QueryRunner />
    : navMode === "assets"
      ? <AssetBrowser />
    : navMode === "characters"
      ? <CharacterWorkspace />
    : navMode === "locations"
      ? <LocationWorkspace />
    : navMode === "props"
      ? <PropWorkspace />
    : navMode === "shotlist"
      ? <ShotlistView />
    : navMode === "storyboard"
      ? <StoryboardView />
    : navMode === "screenplay"
      ? <ScreenplayView />
    : navMode === "gallery"
      ? <GalleryView />
      // Subjects mode never falls through to the schema list: with no
      // subject picked it showed whichever entity the Schema tab was
      // last on, so switching subject type landed on Story Beats.
      : navMode === "subject"
      ? (selectedSubject !== null
          ? <SubjectView
              key={`${selectedSubject.entity}:${selectedSubject.id}`} />
          : <EmptyMain />)
      : selectedEntityType !== null
        ? <EntityList entity={selectedEntityType} />
        : <EmptyMain />;

  // What the rail lists for the current section. Structure and Shoot
  // have no list of their own, so they get the width back rather than
  // an empty column.
  const railContent: JSX.Element | null =
    navMode === "subject" ? <SubjectNav />
    : navMode === "schema" ? <CategoryTree />
    : navMode === "script" ? <SceneRail />
    : navMode === "assets" ? <AssetPathRail />
    : navMode === "characters" ? <CharacterRail />
    : navMode === "locations" ? <SubjectRail key="location" kind="location" />
    : navMode === "props" ? <SubjectRail key="prop" kind="prop" />
    : navMode === "queries" ? <QueryIndex />
    : null;

  // Structure and Shoot are planned against the script, so they read it
  // alongside rather than across a tab switch. Not while a record is
  // open: that is the form's turn for the width.
  const showReader = openRow === null &&
    (navMode === "structure" || navMode === "shoot");

  const errorMessage = useStoreRaw((st) => st.errorMessage);
  // Set while the live tab is switching to another already-open one
  // (store.ts `openPath`). Nothing here unmounts for it: the content
  // below is still the OUTGOING project's — untouched, so nothing in
  // it re-queries — until the new one lands in one atomic update, and
  // stays fully interactive-looking the whole time except for a dim
  // that only appears if the switch is slow enough to need it. Popping
  // the whole pane out and back in for every switch, even a fast one,
  // read as a glitch; holding it steady and only admitting a wait once
  // there truly is one reads as stable.
  const switchingTab = useStoreRaw((st) => st.switchingTab);
  const [switchTakingAWhile, setSwitchTakingAWhile] = useState(false);
  useEffect(() => {
    if (!switchingTab) { setSwitchTakingAWhile(false); return; }
    const t = setTimeout(() => setSwitchTakingAWhile(true), 150);
    return () => clearTimeout(t);
  }, [switchingTab]);
  return (
    <div className="workbench">
      {errorMessage !== null && (
        <div className="error-toast" role="alert">
          <span>{errorMessage}</span>
          <button onClick={() =>
            useStoreRaw.setState({ errorMessage: null })}>×</button>
        </div>
      )}
      <HostBanner />
      <TitleStrip ctx={commandCtx} search={<SearchBox />}
                  status={<SaveControls />} />
      {about}
      {licenses}
      <ToolPane tools={openTools} active={front} />
      {front === "project" && (
      <div className={"panels" +
                       (switchingTab ? " panels-locked" : "") +
                       (switchTakingAWhile ? " panels-switching" : "")}>
        <ActivityBar />
        {railContent !== null && (
          <nav className="rail rail-nav" style={{ width: railWidth }}
               aria-label="Section contents">
            <RailResizeHandle onDrag={(x) =>
              setRailWidth(x - (document.querySelector(".rail-nav")
                ?.getBoundingClientRect().left ?? 0))} />
            {railContent}
          </nav>
        )}
        {showReader && (readerOpen
          ? <aside className="script-reader-pane"
                   style={{ width: readerWidth }}
                   aria-label="Screenplay (read-only)">
              <RailResizeHandle onDrag={(x) =>
                setReaderWidth(x - (document
                  .querySelector(".script-reader-pane")
                  ?.getBoundingClientRect().left ?? 0))} />
              <ScriptReader onHide={() => setReaderOpen(false)} />
            </aside>
          : <button className="script-reader-collapsed"
                    title="Show the script beside this view"
                    onClick={() => setReaderOpen(true)}>
              <span>Script ▸</span>
            </button>)}
        <main className="main-panel">{main}<UndoToast /></main>
        {openRow !== null && openRow.id !== null && (
          <aside className="rail rail-context">
            <ReverseLinks entity={openRow.entity} id={openRow.id} />
          </aside>
        )}
        {identityOpen && (
          <IdentityPanel onClose={() => setIdentityOpen(false)} />
        )}
      </div>
      )}
    </div>
  );
}

/**
 * A delete is the one action with no other way back — there is no file
 * history to go back to, and no row-level version. So it gets a toast
 * rather than a confirmation dialog: confirmations interrupt every
 * delete to prevent the rare wrong one, an undo interrupts none.
 */
function UndoToast(): JSX.Element | null {
  const { undo, undoDelete, dismissUndo, lastChange, undoLastChange } =
    useStore();
  if (undo === null && lastChange === null) return null;
  return (
    <div className="undo-toast" role="status">
      <span>{lastChange !== null ? lastChange.label
        : undo === null ? "" : undoSummary(undo)}</span>
      <button className="ghost tiny"
              onClick={() => void (lastChange !== null
                ? undoLastChange() : undoDelete())}>Undo</button>
      <button className="ghost tiny" aria-label="dismiss"
              onClick={dismissUndo}>×</button>
    </div>
  );
}

/**
 * There is no Save: the host writes every change to the file as it is
 * made. What is left is a quiet statement of the fact so nobody goes
 * looking for the button; Save As (version up, or rename) is in the
 * File menu.
 */
function SaveControls(): JSX.Element {
  const { projectPath, externalEdit, dismissExternalEdit } = useStore();
  return (
    <>
      {externalEdit !== null && (
        <button className="ghost tiny topbar-agent" role="status"
                onClick={dismissExternalEdit}
                title="Another program changed this film while it was open here. Lists and records are up to date; click to dismiss.">
          edited by {externalEdit.by}
        </button>
      )}
    </>
  );
}

/**
 * The two ways the window can stop being in step with the file, said
 * out loud. Neither is resolved silently: reconnecting after a dropped
 * host and re-reading after an outside edit both throw away what the
 * window believes, and that should be the user's click.
 */
function HostBanner(): JSX.Element | null {
  const { hostLost, externalChange, reconnect, reloadFromDisk } = useStore();
  if (hostLost) {
    return (
      <div className="error-toast" role="alert">
        <span>Lost the connection to the SCF host. Nothing more will be
          saved until it is back.</span>
        <button onClick={() => void reconnect()}>Reconnect</button>
      </div>
    );
  }
  if (externalChange) {
    return (
      <div className="error-toast" role="alert">
        <span>This file was changed outside SCF Studio. Your edits are
          refused until you reload it, so nothing is overwritten.</span>
        <button onClick={() => void reloadFromDisk()}>Reload</button>
      </div>
    );
  }
  return null;
}

function IntroMain(): JSX.Element {
  return (
    <div className="intro-main">
      <img src={logoFullWhite} alt="SCF" />
    </div>
  );
}

function EmptyMain(): JSX.Element {
  return (
    <div className="empty-main">
      <p>Pick a subject to see everything addressed to it, or switch to
         Schema to browse by entity type.</p>
    </div>
  );
}
