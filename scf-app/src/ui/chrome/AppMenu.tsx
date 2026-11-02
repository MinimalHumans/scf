// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from "react";
import type { ProjectRow } from "@scf-host/appStore.ts";
import { windowAppStore } from "../../host/windowAppStore.ts";
import { nameOf, useStore } from "../../state/store.ts";
import {
  menuModel, runCommand, topLevelItems, type CommandContext,
  type MenuItem,
} from "../../commands/registry.ts";
import { GearIcon } from "./TitleStrip.tsx";

/** The directory a path sits in, no trailing separator ("" for a bare
 *  file name with no directory at all). */
function dirOf(path: string): string {
  const idx = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return idx <= 0 ? "" : path.slice(0, idx);
}

/**
 * A directory path elided in the MIDDLE rather than at an end, so the
 * two parts likeliest to tell two same-named files apart — where the
 * path starts, and the immediate parent folder — both stay visible:
 * ".../Downloads" and ".../fixtures" read very differently even with
 * everything between them cut, where trimming only the end would show
 * the same drive and nothing else. `max` counts characters, not pixels.
 */
function middleEllipsisDir(dir: string, max: number): string {
  if (dir.length <= max) return dir;
  const sep = dir.includes("\\") ? "\\" : "/";
  const lastSep = dir.lastIndexOf(sep);
  const tail = lastSep === -1 ? "" : dir.slice(lastSep);
  const headBudget = max - tail.length - 1;
  return headBudget <= 0
    ? "…" + tail.slice(Math.max(0, tail.length - (max - 1)))
    : dir.slice(0, headBudget) + "…" + tail;
}

const RECENT_PATH_MAX = 30;

/**
 * File > Open Recent: the one dynamic, data-driven item in the menu, so
 * it is hand-built here rather than forced into the static `COMMANDS`
 * table. Opens on hover (and on click, for touch/keyboard); each entry
 * either focuses that path's tab or opens it, same rule as clicking it
 * in Recent Projects on the start screen (store.ts `openOrFocus`).
 * Labelled the same way a tab is — the file name, not the film's own
 * title — with the folder beneath it to tell apart two files that
 * happen to share a name.
 */
function OpenRecentItem({ ctx, onRun }: {
  ctx: CommandContext; onRun: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<ProjectRow[] | null>(null);
  const disabled = !ctx.hostReady;

  useEffect(() => {
    if (!open || disabled) return;
    let cancelled = false;
    void (async () => {
      const rows = await (await windowAppStore()).recentProjects(10);
      if (!cancelled) setEntries(rows);
    })();
    return () => { cancelled = true; };
  }, [open, disabled]);

  return (
    <div className="app-menu-submenu-wrap"
         onMouseEnter={() => { if (!disabled) setOpen(true); }}
         onMouseLeave={() => setOpen(false)}>
      <button role="menuitem" className="app-menu-item" disabled={disabled}
              aria-haspopup="menu" aria-expanded={open}
              onClick={() => { if (!disabled) setOpen((v) => !v); }}>
        <span className="app-menu-check" aria-hidden="true" />
        <span className="app-menu-label">Open Recent</span>
        <span className="app-menu-shortcut">▸</span>
      </button>
      {open && !disabled && (
        <div className="app-menu-popup app-menu-submenu" role="menu">
          {entries === null ? (
            <div className="app-menu-item muted">Loading…</div>
          ) : entries.length === 0 ? (
            <div className="app-menu-item muted">No recent files</div>
          ) : entries.map((e) => (
            <button key={e.pathKey}
                    role="menuitem" className="app-menu-item recent"
                    title={e.scfPath}
                    onClick={() => {
                      setOpen(false);
                      onRun();
                      ctx.openRecentPath(e.scfPath);
                    }}>
              <span className="app-menu-check" aria-hidden="true" />
              <span className="app-menu-recent-text">
                <span className="app-menu-label">{nameOf(e.scfPath)}</span>
                <span className="app-menu-recent-dir muted small">
                  {middleEllipsisDir(dirOf(e.scfPath), RECENT_PATH_MAX)}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The hamburger. A full menu bar will not fit beside the tabs in the
 * title row, so File, View and Help are headed groups in one popup,
 * one click to open it, one to run a command — with top-level commands
 * such as Exit below all of them, so they stay the true bottom of the
 * popup rather than the bottom of whichever group they'd sit in.
 */
function MenuItemButton({ item, ctx, onRun }: {
  item: MenuItem; ctx: CommandContext; onRun: () => void;
}): JSX.Element {
  return (
    <div>
      {item.separatorBefore && (
        <div className="app-menu-sep" role="separator" />
      )}
      <button role={item.checked ? "menuitemcheckbox" : "menuitem"}
              aria-checked={item.checked ? true : undefined}
              className="app-menu-item" disabled={item.disabled}
              title={item.hint ?? undefined}
              onClick={() => { onRun(); runCommand(item.id, ctx); }}>
        <span className="app-menu-check" aria-hidden="true">
          {item.checked ? "✓" : ""}
        </span>
        {item.id === "file.settings" && <GearIcon />}
        <span className="app-menu-label">{item.label}</span>
        {item.hint !== null
          ? <span className="app-menu-shortcut">{item.hint}</span>
          : item.shortcut !== null && (
            <span className="app-menu-shortcut">{item.shortcut}</span>
          )}
      </button>
    </div>
  );
}

export function AppMenu({ ctx }: { ctx: CommandContext }): JSX.Element {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const groups = menuModel(ctx);
  const bottom = topLevelItems(ctx);

  // The one thing worth interrupting for from here: the project has no
  // usable folder AND there is something that actually needs it. A film
  // with no assets, or one whose root is fine, never shows this.
  //
  // Severity splits by cause, not just by "root isn't ok": a folder
  // that was simply never set is a setup gap (`unaddressed` assets,
  // amber); one that WAS set and now can't be found is a live
  // regression — every asset under it resolves as `missing`, same as
  // a deleted file would — so it reads as a blocker, red, like the
  // Assets-nav badge's own "broken media" case.
  const assetRootStatus = useStore((s) => s.assetRootStatus);
  const counts = useStore((s) => s.assetResolution?.counts ?? null);
  const needsFolder = counts !== null && (
    (assetRootStatus === "unmapped" && counts.unaddressed > 0) ||
    (assetRootStatus === "missing" && counts.missing > 0));
  const folderSeverity = assetRootStatus === "missing" ? "blocker" : "warn";

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent): void => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", away);
    return () => window.removeEventListener("pointerdown", away);
  }, [open]);

  // Focus the first enabled item when the popup opens, so the keyboard
  // can drive it straight away.
  useEffect(() => {
    if (open) {
      root.current?.querySelector<HTMLButtonElement>(
        "[role=menuitem]:not(:disabled)")?.focus();
    }
  }, [open]);

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === "Escape") {
      setOpen(false);
      root.current?.querySelector<HTMLButtonElement>(".app-menu-button")
        ?.focus();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const items = [...root.current?.querySelectorAll<HTMLButtonElement>(
      "[role=menuitem]:not(:disabled)") ?? []];
    if (items.length === 0) return;
    e.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "ArrowDown"
      ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  return (
    <div className="app-menu" ref={root} onKeyDown={onKeyDown}>
      <button className="app-menu-button ghost" aria-haspopup="menu"
              aria-expanded={open} aria-label="Menu"
              title={!needsFolder ? "Menu" : assetRootStatus === "missing"
                ? "Menu — the project folder can't be found, so some " +
                  "assets can't resolve"
                : "Menu — no project folder is set, so some assets can't " +
                  "resolve"}
              onClick={() => setOpen((v) => !v)}>
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor"
                strokeWidth="1.5" strokeLinecap="round" fill="none" />
        </svg>
        {needsFolder && (
          <span className={`app-menu-badge app-menu-badge-${folderSeverity}`}
                aria-hidden="true" />
        )}
      </button>
      {open && (
        <div className="app-menu-popup" role="menu">
          {groups.map((g) => (
            <div key={g.name} role="group" aria-label={g.name}>
              <div className="app-menu-heading">{g.name}</div>
              {g.items.map((item) => (
                <div key={item.id}>
                  <MenuItemButton item={item} ctx={ctx}
                                  onRun={() => setOpen(false)} />
                  {item.id === "file.open" && (
                    <OpenRecentItem ctx={ctx}
                                    onRun={() => setOpen(false)} />
                  )}
                </div>
              ))}
            </div>
          ))}
          {bottom.length > 0 && (
            <div role="group">
              <div className="app-menu-sep" role="separator" />
              {bottom.map((item) => (
                <MenuItemButton key={item.id} item={item} ctx={ctx}
                                onRun={() => setOpen(false)} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
