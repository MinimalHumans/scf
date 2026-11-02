// SPDX-License-Identifier: Apache-2.0
/**
 * settings.ts — app-wide settings, kept in `app.db`'s `pref` table
 * (scf-host `appStore.ts`) rather than browser storage: they are not
 * tied to one project, and `app.db` is already shared with the
 * standalone MCP, so a setting changed here is seen there too.
 *
 * Per-project settings (the asset root pairing) stay where they are,
 * in the `project` table — this store is only for the rest.
 */

import { create } from "zustand";
import { windowAppStore } from "../host/windowAppStore.ts";
import { windowAuditStore } from "../host/windowAuditStore.ts";

const DEVELOPER_MODE_PREF = "developerMode";
const REMEMBER_TABS_PREF = "rememberOpenTabs";
/** Where the open-tab list itself is kept (projectTabs.ts, written by
 *  store.ts); named here because turning this setting off also clears
 *  it. */
export const OPEN_TABS_PREF = "openTabs";

/** Global media-pipeline knobs (Settings > Media) — `getPref`/`setPref`
 *  are string-only, so each is serialized with `String()`/parsed with
 *  `Number()`, same as the booleans above do with `"1"`/`"0"`. */
const VIDEO_WORKERS_PREF = "mediaVideoWorkers";
const STILL_WORKERS_PREF = "mediaStillWorkers";
const PROXY_RESOLUTION_PREF = "mediaProxyResolution";
const CACHE_LIMIT_GB_PREF = "mediaCacheLimitGb";

/** Mirrors `media-server/src/queue.rs`'s current `MAX_VIDEO_JOBS`/
 *  `MAX_STILL_JOBS` consts — the defaults shown until a user changes
 *  them (and until stage 2 actually threads the setting into Rust). */
const DEFAULT_VIDEO_WORKERS = 1;
const DEFAULT_STILL_WORKERS = 2;
/** Mirrors `queue.rs`'s `default_derived_params()` resolution_cap. */
const DEFAULT_PROXY_RESOLUTION = 1080;
/** Mirrors `media-core/src/cache.rs`'s `DEFAULT_VIDEO_CAP_BYTES` (2 GB)
 *  + `DEFAULT_STILL_CAP_BYTES` (0.5 GB) combined. */
const DEFAULT_CACHE_LIMIT_GB = 2.5;

export const PROXY_RESOLUTIONS = [720, 1080, 1440] as const;
export type ProxyResolution = typeof PROXY_RESOLUTIONS[number];

interface SettingsState {
  /** False until `load` has returned once. */
  loaded: boolean;
  /** Developer-only tools (the row identity inspector); off by default. */
  developerMode: boolean;
  /** Reopen every tab that was open last time, on by default. */
  rememberTabs: boolean;
  /** Concurrent ffmpeg/magick/oiiotool worker slots, one setting per
   *  pool (queue.rs's video/still split). */
  videoWorkers: number;
  stillWorkers: number;
  /** Target long-edge/height for a video proxy, in pixels. */
  proxyResolution: ProxyResolution;
  /** Combined cache ceiling across both pools, in GB. */
  cacheLimitGb: number;
  load(): Promise<void>;
  setDeveloperMode(on: boolean): Promise<void>;
  setRememberTabs(on: boolean): Promise<void>;
  setVideoWorkers(n: number): Promise<void>;
  setStillWorkers(n: number): Promise<void>;
  setProxyResolution(n: ProxyResolution): Promise<void>;
  setCacheLimitGb(gb: number): Promise<void>;
}

/** A settings change is app-scope, not a project write, so it is
 *  appended directly rather than through the host's write path. */
async function logSettingsChange(action: string, summary: string):
    Promise<void> {
  const store = await windowAuditStore().catch(() => null);
  await store?.append({
    actorKind: "user", actorName: "window", scope: "app", action, summary,
  }).catch((e: unknown) => { console.error("audit trail write failed:", e); });
}

export const useSettings = create<SettingsState>((set) => ({
  loaded: false,
  developerMode: false,
  // Optimistic default: correct for everyone who has never touched the
  // setting, and overwritten by the real value the moment `load` returns
  // — so a tab opened in the instant before that happens is still worth
  // remembering rather than assumed throwaway.
  rememberTabs: true,
  videoWorkers: DEFAULT_VIDEO_WORKERS,
  stillWorkers: DEFAULT_STILL_WORKERS,
  proxyResolution: DEFAULT_PROXY_RESOLUTION,
  cacheLimitGb: DEFAULT_CACHE_LIMIT_GB,

  load: async () => {
    const store = await windowAppStore();
    const [
      developerMode, rememberTabs, videoWorkers, stillWorkers,
      proxyResolution, cacheLimitGb,
    ] = await Promise.all([
      store.getPref(DEVELOPER_MODE_PREF), store.getPref(REMEMBER_TABS_PREF),
      store.getPref(VIDEO_WORKERS_PREF), store.getPref(STILL_WORKERS_PREF),
      store.getPref(PROXY_RESOLUTION_PREF), store.getPref(CACHE_LIMIT_GB_PREF),
    ]);
    set({ developerMode: developerMode === "1",
          rememberTabs: rememberTabs === null ? true : rememberTabs === "1",
          videoWorkers: videoWorkers === null ? DEFAULT_VIDEO_WORKERS : Number(videoWorkers),
          stillWorkers: stillWorkers === null ? DEFAULT_STILL_WORKERS : Number(stillWorkers),
          proxyResolution: (proxyResolution === null
            ? DEFAULT_PROXY_RESOLUTION : Number(proxyResolution)) as ProxyResolution,
          cacheLimitGb: cacheLimitGb === null ? DEFAULT_CACHE_LIMIT_GB : Number(cacheLimitGb),
          loaded: true });
  },

  setDeveloperMode: async (on) => {
    const store = await windowAppStore();
    await store.setPref(DEVELOPER_MODE_PREF, on ? "1" : "0");
    set({ developerMode: on });
    await logSettingsChange(
      "settings.developerMode", on ? "turned on" : "turned off");
  },

  setRememberTabs: async (on) => {
    const store = await windowAppStore();
    await store.setPref(REMEMBER_TABS_PREF, on ? "1" : "0");
    // Turning it off forgets what was open, too — otherwise flipping it
    // back on later would resurrect a stale list nobody asked to keep.
    if (!on) await store.setPref(OPEN_TABS_PREF, "");
    set({ rememberTabs: on });
    await logSettingsChange(
      "settings.rememberTabs", on ? "turned on" : "turned off");
  },

  setVideoWorkers: async (n) => {
    const store = await windowAppStore();
    await store.setPref(VIDEO_WORKERS_PREF, String(n));
    set({ videoWorkers: n });
    await logSettingsChange("settings.media.videoWorkers", `set to ${String(n)}`);
  },

  setStillWorkers: async (n) => {
    const store = await windowAppStore();
    await store.setPref(STILL_WORKERS_PREF, String(n));
    set({ stillWorkers: n });
    await logSettingsChange("settings.media.stillWorkers", `set to ${String(n)}`);
  },

  setProxyResolution: async (n) => {
    const store = await windowAppStore();
    await store.setPref(PROXY_RESOLUTION_PREF, String(n));
    set({ proxyResolution: n });
    await logSettingsChange("settings.media.proxyResolution", `set to ${String(n)}p`);
  },

  setCacheLimitGb: async (gb) => {
    const store = await windowAppStore();
    await store.setPref(CACHE_LIMIT_GB_PREF, String(gb));
    set({ cacheLimitGb: gb });
    await logSettingsChange("settings.media.cacheLimitGb", `set to ${String(gb)} GB`);
  },
}));
