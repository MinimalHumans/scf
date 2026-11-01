// SPDX-License-Identifier: Apache-2.0
/**
 * windowAppStore.ts — `app.db` (scf-host `appStore.ts`), opened once for
 * the whole window and shared by the editor's native file dialogs
 * (`files/tauriChooser.ts`) and the MCP server it runs alongside
 * (`mcp/windowMcp.ts`), rather than each opening a connection of its
 * own.
 */

import { invoke } from "@tauri-apps/api/core";
import type { AppStore } from "@scf-host/appStore.ts";
import { openTauriAppStore } from "./tauriAppStore.ts";
import { createTauriPlatform } from "./tauriPlatform.ts";

/**
 * The old recent-files list, read once to seed `app.db` the first time
 * it is created (file-management-plan.md §3.1 "Migration");
 * `mcp-config.json` itself is left untouched.
 */
function readLegacyRecentFiles(
    path: string, readText: (p: string) => Promise<string>):
    () => Promise<string[]> {
  return async () => {
    try {
      const parsed = JSON.parse(await readText(path)) as
        { recentFiles?: unknown };
      return Array.isArray(parsed.recentFiles) &&
        parsed.recentFiles.every((p) => typeof p === "string")
        ? parsed.recentFiles : [];
    } catch {
      return [];
    }
  };
}

let store: Promise<AppStore> | null = null;

export function windowAppStore(): Promise<AppStore> {
  store ??= (async () => {
    const files = await createTauriPlatform();
    const { dataDir } = await invoke<{ dataDir: string }>("host_setup");
    return openTauriAppStore(files.paths.join(dataDir, "app.db"), {
      importLegacyRecentFiles: readLegacyRecentFiles(
        files.paths.join(dataDir, "mcp-config.json"), files.readText),
    });
  })();
  // A failed open (e.g. unresolved lock contention) is tried again by
  // the next caller, rather than wedging the window for the session.
  store.catch(() => { store = null; });
  return store;
}
