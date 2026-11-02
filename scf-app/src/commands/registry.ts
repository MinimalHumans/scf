// SPDX-License-Identifier: Apache-2.0
/**
 * registry.ts — the app's commands, defined once.
 *
 * The title-strip menu reads this today; the command palette and the
 * keyboard shortcuts read it next (docs/ui-rework-tabs.md §5), so a
 * command has one label, one shortcut and one rule for when it is
 * available, wherever it is offered.
 *
 * Pure: a command acts through the `CommandContext` it is given, so the
 * registry and the menu model are tested without a window or a store.
 */

export type MenuName = "File" | "View" | "Help";

export interface CommandContext {
  /** A project is open in the active tab. */
  hasProject: boolean;
  /** The host is connected, so a file can be opened or made. */
  hostReady: boolean;
  newProject(): void;
  openProject(): void;
  /** Open Recent's own entry: focuses the tab if the path is already
   *  open (live or backgrounded), otherwise opens it as a new tab. */
  openRecentPath(path: string): void;
  saveProjectAs(): void;
  closeProject(): void;
  attachFolder(): void;
  /** The project's asset root: none chosen, found, or chosen but gone. */
  assetRoot: "unset" | "ok" | "missing";
  /** Developer tools are switched on (a setting; off by default). */
  developerMode: boolean;
  toggleIdentity(): void;
  identityOpen: boolean;
  showAbout(): void;
  showSettings(): void;
  showLicenses(): void;
  /** Quit the app, which closing the window no longer does. */
  exitApp(): void;
  /** Open the event log tab, or bring it forward. */
  openEventLog(): void;
  /** Open the media dashboard tab, or bring it forward. */
  openMediaDashboard(): void;
}

export interface Command {
  id: string;
  /** Said as the situation calls for: "Select…" before a folder is
   *  chosen, "Change…" after. */
  label: string | ((ctx: CommandContext) => string);
  menu: MenuName;
  /** As typed on this platform's keyboard: "Ctrl+O". */
  shortcut?: string;
  /** Not built yet: listed so the shape of the app shows, not clickable. */
  pending?: string;
  /** Not offered at all (default: offered). Unlike `disabled`, the
   *  command is absent from the menu. */
  hidden?(ctx: CommandContext): boolean;
  /** Unavailable right now (default: available). */
  disabled?(ctx: CommandContext): boolean;
  /** A checkmark in the menu, for a command that switches something. */
  checked?(ctx: CommandContext): boolean;
  /** Rendered after every group, heading-less, instead of inside `menu`
   *  — the true bottom of the one-popup menu, not just the bottom of
   *  its own group. */
  topLevel?: boolean;
  run(ctx: CommandContext): void;
}

const needsProject = (ctx: CommandContext): boolean => !ctx.hasProject;
const needsHost = (ctx: CommandContext): boolean => !ctx.hostReady;

export const COMMANDS: readonly Command[] = [
  { id: "file.new", label: "New project", menu: "File", shortcut: "Ctrl+N",
    disabled: needsHost, run: (c) => { c.newProject(); } },
  { id: "file.open", label: "Open…", menu: "File", shortcut: "Ctrl+O",
    disabled: needsHost, run: (c) => { c.openProject(); } },
  { id: "file.saveAs", label: "Save as…", menu: "File",
    shortcut: "Ctrl+Shift+S", disabled: needsProject,
    run: (c) => { c.saveProjectAs(); } },
  { id: "file.assetRoot", menu: "File",
    label: (c) => c.assetRoot === "ok" ? "Change asset root folder…"
      : c.assetRoot === "missing" ? "Locate asset root folder…"
      : "Select asset root folder…",
    disabled: needsProject, run: (c) => { c.attachFolder(); } },
  { id: "file.close", label: "Close project", menu: "File",
    disabled: needsProject, run: (c) => { c.closeProject(); } },
  // App-wide rather than the project's, so it is offered with no
  // project open too.
  { id: "file.settings", label: "Settings", menu: "File",
    shortcut: "Ctrl+,", run: (c) => { c.showSettings(); } },

  // Closing the window leaves the app in the tray, so quitting has to be
  // somewhere plain to find. It sits below every group, not inside one,
  // so it stays the last thing in the popup regardless of their order.
  { id: "file.exit", label: "Exit", menu: "File", shortcut: "Ctrl+Q",
    topLevel: true, run: (c) => { c.exitApp(); } },

  { id: "view.eventLog", label: "Event log", menu: "View",
    run: (c) => { c.openEventLog(); } },
  { id: "view.mediaDashboard", label: "Media dashboard", menu: "View",
    run: (c) => { c.openMediaDashboard(); } },
  { id: "view.identity", label: "Row identity", menu: "View",
    shortcut: "Ctrl+I",
    hidden: (c) => !c.developerMode, disabled: needsProject, checked: (c) => c.identityOpen,
    run: (c) => { c.toggleIdentity(); } },

  { id: "help.about", label: "About SCF Editor", menu: "Help",
    run: (c) => { c.showAbout(); } },
  { id: "help.licenses", label: "Open Source Licenses", menu: "Help",
    run: (c) => { c.showLicenses(); } },
];

/** Where separators fall: before the first command of each of these. */
const SEPARATE_BEFORE = new Set([
  "file.assetRoot", "file.close", "file.settings",
]);

export interface MenuItem {
  id: string;
  label: string;
  shortcut: string | null;
  disabled: boolean;
  checked: boolean;
  /** Why it is disabled, when that is worth saying. */
  hint: string | null;
  separatorBefore: boolean;
}

export interface MenuGroup {
  name: MenuName;
  items: MenuItem[];
}

const MENU_ORDER: readonly MenuName[] = ["File", "View", "Help"];

const toMenuItem = (c: Command, ctx: CommandContext): MenuItem => ({
  id: c.id,
  label: typeof c.label === "function" ? c.label(ctx) : c.label,
  shortcut: c.shortcut ?? null,
  disabled: c.pending !== undefined || (c.disabled?.(ctx) ?? false),
  checked: c.checked?.(ctx) ?? false,
  hint: c.pending ?? null,
  separatorBefore: SEPARATE_BEFORE.has(c.id),
});

/** The menu as it stands for `ctx`: every grouped command placed,
 *  enabled or not. Top-level commands are left to `topLevelItems`. */
export function menuModel(
    ctx: CommandContext, commands: readonly Command[] = COMMANDS):
    MenuGroup[] {
  return MENU_ORDER.map((name) => ({
    name,
    items: commands.filter((c) => c.menu === name && !c.topLevel &&
                                  !(c.hidden?.(ctx) ?? false))
      .map((c) => toMenuItem(c, ctx)),
  }));
}

/** Commands shown below every group, heading-less, in registry order. */
export function topLevelItems(
    ctx: CommandContext, commands: readonly Command[] = COMMANDS):
    MenuItem[] {
  return commands.filter((c) => (c.topLevel ?? false) &&
                                 !(c.hidden?.(ctx) ?? false))
    .map((c) => toMenuItem(c, ctx));
}

/** Run a command by id, unless it is unavailable. True when it ran. */
export function runCommand(
    id: string, ctx: CommandContext,
    commands: readonly Command[] = COMMANDS): boolean {
  const command = commands.find((c) => c.id === id);
  if (command === undefined || command.pending !== undefined ||
      (command.hidden?.(ctx) ?? false) ||
      (command.disabled?.(ctx) ?? false)) return false;
  command.run(ctx);
  return true;
}

/** The command a key press is bound to, if any. */
export function commandForKey(
    e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" |
                           "altKey">,
    commands: readonly Command[] = COMMANDS): Command | undefined {
  if (e.altKey || !(e.ctrlKey || e.metaKey)) return undefined;
  const typed = [
    "CTRL", ...(e.shiftKey ? ["SHIFT"] : []), e.key.toUpperCase(),
  ].join("+");
  return commands.find((c) => c.shortcut?.toUpperCase() === typed);
}

/** What the tab's marker says about the project, most urgent first. */
export type TabStatus = "problem" | "external" | "dirty" | null;

export interface TabStatusInput {
  hostLost: boolean;
  assetRootStatus: "unmapped" | "ok" | "missing";
  externalChange: boolean;
  externalEdit: boolean;
  draftDirty: boolean;
}

export function tabStatus(s: TabStatusInput): TabStatus {
  if (s.hostLost || s.assetRootStatus === "missing") return "problem";
  if (s.externalChange || s.externalEdit) return "external";
  if (s.draftDirty) return "dirty";
  return null;
}

export function tabStatusText(
    status: TabStatus, s: TabStatusInput): string | null {
  if (status === null) return null;
  if (s.hostLost) return "Lost the connection to the SCF host";
  if (s.assetRootStatus === "missing") return "Project folder not found";
  if (s.externalChange) return "Changed outside SCF Editor; reload to edit";
  if (s.externalEdit) return "Edited by another program";
  return "A record has unsaved changes";
}
