// SPDX-License-Identifier: Apache-2.0
/**
 * launchOpen.ts — a `.scf` double-clicked in Explorer while the app was
 * already running.
 *
 * NSIS's file association runs `scf-editor.exe "%1"`. The shell
 * (lib.rs) finds the running app and sends it an `open-file` event
 * instead of starting a second one (`raise_existing`/`raiser`, and
 * `tauri_plugin_single_instance` as a backstop for the race it
 * describes). By the time that event can arrive this window is long
 * since up, so it is handed straight to the same `openOrFocus` a
 * recent-projects row or File > Open Recent would use. The *first*
 * launch's own file (this process's own argv) is not an event at all —
 * `App.tsx`'s startup sequence fetches it once with the `launch_path`
 * command, in order with `resumeTabs`, rather than racing it here.
 */

import { listen } from "@tauri-apps/api/event";
import { useStore } from "../state/store.ts";

/** Call once, from the Tauri shell only. */
export function routeLaunchFile(): void {
  void listen<string>("open-file", (event) => {
    void useStore.getState().openOrFocus(event.payload);
  });
}
