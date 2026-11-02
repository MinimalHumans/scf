// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../../state/store.ts";
import { useTabs } from "../../state/tabs.ts";
import {
  commandForKey, runCommand, type CommandContext,
} from "../../commands/registry.ts";
import { useSettings } from "../../state/settings.ts";
import { AboutDialog } from "./AboutDialog.tsx";
import { LicensesDialog } from "./LicensesDialog.tsx";

/**
 * What the menu and the shortcuts act through, for whichever screen has
 * the title strip: the open project's workbench or the start screen.
 * Also owns the About dialog, the Licenses dialog, and the keyboard
 * shortcuts, so each screen only says what is true of it. Settings is
 * a tool tab (state/tabs.ts), not a dialog this hook owns — showSettings
 * just opens it, the same as openEventLog does for the event log.
 */
export function useAppCommands(screen: {
  hasProject: boolean;
  identityOpen: boolean;
  toggleIdentity(): void;
}): {
  ctx: CommandContext;
  about: JSX.Element | null;
  licenses: JSX.Element | null;
} {
  const [aboutOpen, setAboutOpen] = useState(false);
  const [licensesOpen, setLicensesOpen] = useState(false);
  const developerMode = useSettings((s) => s.developerMode);
  const { assetRoot, assetRootStatus, hostStatus, newProject,
          openFromPicker, openOrFocus, saveProjectAs, closeProject,
          attachFolder } = useStore();

  const ctx: CommandContext = {
    hasProject: screen.hasProject, hostReady: hostStatus === "ready",
    newProject: () => { void newProject(); },
    openProject: () => { void openFromPicker(); },
    openRecentPath: (path) => { void openOrFocus(path); },
    saveProjectAs: () => { void saveProjectAs(); },
    closeProject: () => { void closeProject(); },
    attachFolder: () => { void attachFolder(); },
    assetRoot: assetRoot === null ? "unset"
      : assetRootStatus === "missing" ? "missing" : "ok",
    developerMode,
    toggleIdentity: screen.toggleIdentity,
    identityOpen: screen.identityOpen,
    showAbout: () => { setAboutOpen(true); },
    showSettings: () => { useTabs.getState().openTool("settings"); },
    showLicenses: () => { setLicensesOpen(true); },
    exitApp: () => { void invoke("quit_app"); },
    openEventLog: () => { useTabs.getState().openTool("events"); },
  };

  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const command = commandForKey(e);
      if (command === undefined) return;
      if (runCommand(command.id, ctxRef.current)) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return {
    ctx,
    about: aboutOpen ? <AboutDialog onClose={() => setAboutOpen(false)} />
      : null,
    licenses: licensesOpen
      ? <LicensesDialog onClose={() => setLicensesOpen(false)} /> : null,
  };
}
