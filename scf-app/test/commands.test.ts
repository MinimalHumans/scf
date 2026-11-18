// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test, vi } from "vitest";
import {
  COMMANDS, commandForKey, menuModel, runCommand, tabStatus, tabStatusText,
  topLevelItems, type CommandContext, type TabStatusInput,
} from "../src/commands/registry.ts";

const ctx = (over: Partial<CommandContext> = {}): CommandContext => ({
  hasProject: true, hostReady: true, identityOpen: false,
  assetRoot: "ok", developerMode: true,
  newProject: vi.fn(), openProject: vi.fn(), openRecentPath: vi.fn(),
  saveProjectAs: vi.fn(),
  closeProject: vi.fn(), attachFolder: vi.fn(), toggleIdentity: vi.fn(),
  showAbout: vi.fn(), showSettings: vi.fn(), showLicenses: vi.fn(),
  exitApp: vi.fn(), openEventLog: vi.fn(), openHelp: vi.fn(), ...over,
});

const key = (k: string, mods: { shift?: boolean; alt?: boolean } = {}) => ({
  key: k, ctrlKey: true, metaKey: false,
  shiftKey: mods.shift ?? false, altKey: mods.alt ?? false,
});

describe("menu model", () => {
  test("File, View and Help hold the commands, in order", () => {
    const m = menuModel(ctx());
    expect(m.map((g) => g.name)).toEqual(["File", "View", "Help"]);
    expect(m[0]!.items.map((i) => i.id)).toEqual([
      "file.new", "file.open", "file.saveAs", "file.assetRoot",
      "file.close", "file.settings"]);
  });

  test("Exit sits below every group, not inside one", () => {
    const m = menuModel(ctx());
    for (const g of m) {
      expect(g.items.some((i) => i.id === "file.exit")).toBe(false);
    }
    expect(topLevelItems(ctx()).map((i) => i.id)).toEqual(["file.exit"]);
  });

  test("project commands are off without a project", () => {
    const file = menuModel(ctx({ hasProject: false }))[0]!;
    const off = file.items.filter((i) => i.disabled).map((i) => i.id);
    // Settings is app-wide, so it stays enabled with no project open.
    expect(off).toEqual(["file.saveAs", "file.assetRoot", "file.close"]);
  });

  test("nothing opens or makes a file until the host is ready", () => {
    const file = menuModel(ctx({ hostReady: false, hasProject: false }))[0]!;
    expect(file.items.find((i) => i.id === "file.open")!.disabled).toBe(true);
    expect(file.items.find((i) => i.id === "file.new")!.disabled).toBe(true);
  });

  test("Settings opens with or without a project", () => {
    const c = ctx({ hasProject: false });
    const settings = menuModel(c)[0]!.items
      .find((i) => i.id === "file.settings")!;
    expect(settings.disabled).toBe(false);
    expect(runCommand("file.settings", c)).toBe(true);
    expect(c.showSettings).toHaveBeenCalledOnce();
  });

  test("the event log opens with or without a project", () => {
    const c = ctx({ hasProject: false });
    const item = menuModel(c)[1]!.items.find((i) => i.id === "view.eventLog")!;
    expect(item.disabled).toBe(false);
    expect(runCommand("view.eventLog", c)).toBe(true);
    expect(c.openEventLog).toHaveBeenCalledOnce();
  });

  test("Help opens the manual first, then About and the licenses", () => {
    const c = ctx({ hasProject: false });
    expect(menuModel(c)[2]!.items.map((i) => i.id))
      .toEqual(["help.manual", "help.about", "help.licenses"]);
    expect(runCommand("help.manual", c)).toBe(true);
    expect(c.openHelp).toHaveBeenCalledOnce();
    expect(runCommand("help.licenses", c)).toBe(true);
    expect(c.showLicenses).toHaveBeenCalledOnce();
  });

  test("the asset root command says what it will do", () => {
    const label = (assetRoot: CommandContext["assetRoot"]) =>
      menuModel(ctx({ assetRoot }))[0]!.items
        .find((i) => i.id === "file.assetRoot")!.label;
    expect(label("unset")).toBe("Select asset root folder…");
    expect(label("ok")).toBe("Change asset root folder…");
    expect(label("missing")).toBe("Locate asset root folder…");
  });

  test("row identity is not in the menu unless developer mode is on", () => {
    const has = (developerMode: boolean) =>
      menuModel(ctx({ developerMode }))[1]!.items
        .some((i) => i.id === "view.identity");
    expect(has(false)).toBe(false);
    expect(has(true)).toBe(true);
    // Hidden means unavailable to the palette and shortcuts too.
    expect(runCommand("view.identity", ctx({ developerMode: false })))
      .toBe(false);
  });

  test("the identity toggle shows whether it is on", () => {
    const item = (open: boolean) => menuModel(ctx({ identityOpen: open }))[1]!
      .items.find((i) => i.id === "view.identity")!;
    expect(item(false).checked).toBe(false);
    expect(item(true).checked).toBe(true);
  });

  test("every command id is unique", () => {
    const ids = COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("running commands", () => {
  test("a command runs through the context", () => {
    const c = ctx();
    expect(runCommand("file.saveAs", c)).toBe(true);
    expect(c.saveProjectAs).toHaveBeenCalledOnce();
  });

  test("Exit is always there, with or without a project", () => {
    const c = ctx({ hasProject: false, hostReady: false });
    const exit = topLevelItems(c).find((i) => i.id === "file.exit")!;
    expect(exit.disabled).toBe(false);
    expect(runCommand("file.exit", c)).toBe(true);
    expect(c.exitApp).toHaveBeenCalledOnce();
  });

  test("an unavailable or unknown command does nothing", () => {
    const c = ctx({ hasProject: false });
    expect(runCommand("file.close", c)).toBe(false);
    expect(runCommand("no.such", c)).toBe(false);
    expect(c.closeProject).not.toHaveBeenCalled();
  });
});

describe("shortcuts", () => {
  test("a bound key finds its command", () => {
    expect(commandForKey(key("o"))?.id).toBe("file.open");
    expect(commandForKey(key("q"))?.id).toBe("file.exit");
    expect(commandForKey(key("S", { shift: true }))?.id).toBe("file.saveAs");
    expect(commandForKey({ ...key("o"), ctrlKey: false, metaKey: true })?.id)
      .toBe("file.open");
  });

  test("a plain key, an Alt chord and an unbound chord find nothing", () => {
    expect(commandForKey({ ...key("o"), ctrlKey: false })).toBeUndefined();
    // Alt+digit belongs to the section switcher.
    expect(commandForKey(key("1", { alt: true }))).toBeUndefined();
    expect(commandForKey(key("z"))).toBeUndefined();
  });

  test("Shift distinguishes Save as from a bare S", () => {
    expect(commandForKey(key("s"))).toBeUndefined();
  });

  test("F1 alone opens the manual; other function keys and F1 chords don't", () => {
    const plain = { key: "F1", ctrlKey: false, metaKey: false,
                    shiftKey: false, altKey: false };
    expect(commandForKey(plain)?.id).toBe("help.manual");
    expect(commandForKey({ ...plain, key: "F2" })).toBeUndefined();
    expect(commandForKey({ ...plain, ctrlKey: true })).toBeUndefined();
    expect(commandForKey({ ...plain, altKey: true })).toBeUndefined();
  });

  test("Ctrl+I is bound to row identity, Ctrl+, to Settings", () => {
    expect(commandForKey(key("i"))?.id).toBe("view.identity");
    expect(commandForKey(key(","))?.id).toBe("file.settings");
  });
});

describe("tab status", () => {
  const base: TabStatusInput = {
    hostLost: false, assetRootStatus: "ok", externalChange: false,
    externalEdit: false, draftDirty: false,
  };

  test("a healthy tab says nothing", () => {
    expect(tabStatus(base)).toBeNull();
    expect(tabStatusText(null, base)).toBeNull();
    // No folder attached is not a fault; the folder control says so.
    expect(tabStatus({ ...base, assetRootStatus: "unmapped" })).toBeNull();
  });

  test("a problem outranks an outside edit, which outranks unsaved", () => {
    const all = { ...base, assetRootStatus: "missing" as const,
                  externalEdit: true, draftDirty: true };
    expect(tabStatus(all)).toBe("problem");
    expect(tabStatus({ ...all, assetRootStatus: "ok" })).toBe("external");
    expect(tabStatus({ ...all, assetRootStatus: "ok", externalEdit: false }))
      .toBe("dirty");
  });

  test("the text names the folder when it is the folder", () => {
    const s = { ...base, assetRootStatus: "missing" as const };
    expect(tabStatusText(tabStatus(s), s)).toMatch(/folder not found/i);
  });
});
