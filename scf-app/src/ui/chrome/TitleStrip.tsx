// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState, type ReactNode } from "react";
import { isDirty, useStore } from "../../state/store.ts";
import { TOOL_TITLES, useTabs } from "../../state/tabs.ts";
import { useProjectTabs } from "../../state/projectTabs.ts";
import {
  tabStatus, tabStatusText, type CommandContext, type TabStatusInput,
} from "../../commands/registry.ts";
import logoSmallCloud from "../../assets/logoSmall_cloud.svg";
import { AppMenu } from "./AppMenu.tsx";
import { useFrameless, WindowControls } from "./WindowControls.tsx";

const TAB_GLYPH = { problem: "⚠", external: "●", dirty: "●" } as const;

/** Precedes the "Settings" label — on its tab here and on its menu
 *  item in AppMenu — so it reads as a settings screen at a glance,
 *  not just another tool tab or command. */
export function GearIcon(): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true"
         className="tab-tool-icon" fill="none" stroke="currentColor"
         strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2
                2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0
                .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15
                .09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2
                2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2
                2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2
                0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l
                -.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2
                2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2
                2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

/** Precedes the "Event log" label, to match {@link GearIcon}. */
export function EventLogIcon(): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true"
         className="tab-tool-icon" fill="none" stroke="currentColor"
         strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" />
      <line x1="3" y1="12" x2="3.01" y2="12" />
      <line x1="3" y1="18" x2="3.01" y2="18" />
    </svg>
  );
}

/** Precedes the "Media" label, to match {@link GearIcon}. */
export function MediaIcon(): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true"
         className="tab-tool-icon" fill="none" stroke="currentColor"
         strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <line x1="7" y1="4" x2="7" y2="20" />
      <line x1="17" y1="4" x2="17" y2="20" />
      <line x1="2" y1="9" x2="7" y2="9" />
      <line x1="2" y1="15" x2="7" y2="15" />
      <line x1="17" y1="9" x2="22" y2="9" />
      <line x1="17" y1="15" x2="22" y2="15" />
    </svg>
  );
}

const TOOL_ICONS: Record<string, () => JSX.Element> = {
  events: EventLogIcon,
  media: MediaIcon,
  settings: GearIcon,
};

/** Unsaved edits in an open record: what differs from what was loaded. */
function draftDirty(draft: { values: unknown; original: unknown } | null):
    boolean {
  return draft !== null &&
    JSON.stringify(draft.values) !== JSON.stringify(draft.original);
}

/**
 * The project tabs, scrollable once there are more than fit, with an
 * arrow at whichever side has tabs hidden past it — pointing the way
 * to them rather than sitting on both sides unconditionally.
 */
function TabScroller({ children, dependency }: {
  children: ReactNode;
  /** Re-measure whenever this changes (the tab count, titles, …). */
  dependency: unknown;
}): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  const measure = (): void => {
    const el = scrollRef.current;
    if (el === null) return;
    setCanLeft(el.scrollLeft > 1);
    setCanRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 1);
  };

  useEffect(() => {
    measure();
    const el = scrollRef.current;
    if (el === null) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => { ro.disconnect(); };
  }, [dependency]);

  const scrollByTab = (dx: number): void => {
    scrollRef.current?.scrollBy({ left: dx, behavior: "smooth" });
  };

  return (
    <div className="tab-scroll-area">
      {canLeft && (
        <button className="tab-scroll-arrow tab-scroll-arrow-left ghost"
                aria-label="Scroll to earlier tabs"
                onClick={() => scrollByTab(-160)}>
          ‹
        </button>
      )}
      <div className="tab-scroll" ref={scrollRef} onScroll={measure}>
        {children}
      </div>
      {canRight && (
        <button className="tab-scroll-arrow tab-scroll-arrow-right ghost"
                aria-label="Scroll to later tabs"
                onClick={() => scrollByTab(160)}>
          ›
        </button>
      )}
    </div>
  );
}

/**
 * The top of the window, in one row:
 * `[menu] [logo] [project tabs…] [+] ...drag... [search] [status]
 * [controls]`.
 *
 * Replaces the old top bar (docs/ui-rework-tabs.md §5). Each project tab
 * is the one place that project's problems are shown — live or
 * backgrounded alike.
 */
export function TitleStrip({ ctx, search, status, showProject = true }: {
  ctx: CommandContext;
  /** The search box, until the palette replaces it. */
  search?: ReactNode;
  /** Folder and outside-edit state of the active project. */
  status?: ReactNode;
  /** False on the start screen, where there is no project to tab. */
  showProject?: boolean;
}): JSX.Element {
  const { projectPath, hostLost, assetRootStatus, externalChange,
          externalEdit, draft, switchProjectTab, closeProjectTab } =
    useStore();
  const frameless = useFrameless();
  const { tools, active, closeTool, showProject: showProjectTab } = useTabs();
  const projectTabs = useProjectTabs((s) => s.tabs);
  const projectFront = active === "project";

  const liveInput: TabStatusInput = {
    hostLost, assetRootStatus, externalChange,
    externalEdit: externalEdit !== null, draftDirty: draftDirty(draft),
  };

  const dragFrom = useRef<number | null>(null);
  const [draggingPath, setDraggingPath] = useState<string | null>(null);

  /**
   * Reordering by pointer, not native HTML5 drag-and-drop: Tauri's
   * window-level drag-drop handling (needed for dropping files from the
   * OS onto the asset browser, files/nativeDrop.ts) takes over the
   * webview's drag gesture and leaves an in-page `draggable` stuck
   * showing the "no drop" cursor. Pointer events never go near that —
   * the same approach the rail and reader panes already use to resize
   * (`RailResizeHandle` in Workbench.tsx).
   */
  const startTabDrag = (index: number, path: string): void => {
    dragFrom.current = index;
    setDraggingPath(path);
    const move = (e: PointerEvent): void => {
      const from = dragFrom.current;
      if (from === null) return;
      const over = [...document.querySelectorAll<HTMLElement>(".tab-project")]
        .findIndex((el) => {
          const r = el.getBoundingClientRect();
          return e.clientX >= r.left && e.clientX < r.right;
        });
      if (over === -1 || over === from) return;
      useProjectTabs.getState().move(from, over);
      dragFrom.current = over;
    };
    const up = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      dragFrom.current = null;
      setDraggingPath(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <header className={"title-strip" + (frameless ? " frameless" : "")}>
      <AppMenu ctx={ctx} />
      <img className="title-mark" src={logoSmallCloud} alt="SCF" />
      <div className="tab-list" role="tablist" aria-label="Open tabs">
        {showProject && (
          <TabScroller dependency={projectTabs.map((t) => t.path).join()}>
            {projectTabs.map((tab, index) => {
              const isLive = tab.path === projectPath;
              const input: TabStatusInput = isLive ? liveInput : {
                hostLost: false,
                assetRootStatus: tab.problem !== null ? "missing" : "ok",
                externalChange: false,
                externalEdit: tab.externalDot !== null,
                draftDirty: isDirty(tab.memory.draft),
              };
              const state = tabStatus(input);
              const why = tab.problem ?? (!isLive && tab.externalDot !== null
                ? `Changed in the background by ${tab.externalDot.by}`
                : tabStatusText(state, input));
              const tooltip = why !== null ? `${why}\n${tab.path}` : tab.path;
              return (
                <div key={tab.path}
                     className={"tab tab-project" +
                                (projectFront && isLive ? " active" : "") +
                                (state === null ? "" : ` tab-${state}`) +
                                (draggingPath === tab.path ? " dragging" : "")}
                     role="tab" aria-selected={projectFront && isLive}
                     title={tooltip}
                     onPointerDown={(e) => {
                       if (e.button === 0) startTabDrag(index, tab.path);
                     }}
                     onClick={() => {
                       showProjectTab();
                       if (!isLive) void switchProjectTab(tab.path);
                     }}
                     onAuxClick={(e) => {
                       if (e.button === 1) {
                         e.preventDefault();
                         void closeProjectTab(tab.path);
                       }
                     }}>
                  <span className="tab-title">{tab.title}</span>
                  {state !== null && (
                    <span className="tab-state" role="img"
                          aria-label={why ?? ""}>
                      {TAB_GLYPH[state]}
                    </span>
                  )}
                  <button className="tab-close ghost"
                          aria-label={`Close ${tab.title}`}
                          onPointerDown={(e) => { e.stopPropagation(); }}
                          onClick={(e) => {
                            e.stopPropagation();
                            void closeProjectTab(tab.path);
                          }}>
                    ×
                  </button>
                </div>
              );
            })}
          </TabScroller>
        )}
      </div>
      {showProject && (
        <div className="tab-add-slot">
          <button className="tab-add ghost" aria-label="Open another file"
                  title="Open another SCF file"
                  onClick={() => { ctx.openProject(); }}>
            +
          </button>
        </div>
      )}
      <div className="tab-list" role="tablist" aria-label="Open tools">
        {tools.map((id) => {
          const Icon = TOOL_ICONS[id];
          return (
            <div key={id} className={"tab tab-tool" +
                                     (active === id ? " active" : "")}
                 role="tab" aria-selected={active === id}
                 onClick={() => useTabs.getState().openTool(id)}
                 onAuxClick={(e) => {
                   if (e.button === 1) { e.preventDefault(); closeTool(id); }
                 }}>
              {Icon !== undefined && <Icon />}
              <span className="tab-title">{TOOL_TITLES[id]}</span>
              <button className="tab-close ghost" aria-label={`Close ${
                        TOOL_TITLES[id]}`}
                      onClick={(e) => { e.stopPropagation(); closeTool(id); }}>
                ×
              </button>
            </div>
          );
        })}
      </div>
      <div className="title-drag" data-tauri-drag-region />
      <div className="title-trailing">
        {search}
        {status !== undefined && <div className="title-status">{status}</div>}
        {frameless && <WindowControls />}
      </div>
    </header>
  );
}
