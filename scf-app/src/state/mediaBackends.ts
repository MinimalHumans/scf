// SPDX-License-Identifier: Apache-2.0
/**
 * mediaBackends.ts — manual path overrides for the media server's
 * external backends (docs/media-server-spec.md §3), kept in `app.db`'s
 * `pref` table like the rest of `settings.ts`.
 *
 * Its own file rather than a few more keys in `settings.ts`: this
 * subsystem grows through the media server's later phases (concurrency
 * limits, cache location, eligible-type bounds — spec §8), and giving it
 * one home from the start beats folding an unrelated settings surface
 * into `settings.ts` as it does.
 *
 * `media-core` (the Rust side) never reads or writes these itself — it
 * only ever receives a resolved override map as a plain argument. This
 * module is where that map comes from.
 */

import { invoke } from "@tauri-apps/api/core";
import { windowAppStore } from "../host/windowAppStore.ts";

export type BackendId = "ffmpeg" | "ffprobe" | "magick" | "oiiotool";

export const BACKEND_IDS: readonly BackendId[] =
  ["ffmpeg", "ffprobe", "magick", "oiiotool"];

function prefKey(id: BackendId): string {
  return `media.${id}.path`;
}

/** Every binary's manual override path, empty for one left on
 *  auto-detect. */
export async function getOverrides(): Promise<Record<BackendId, string>> {
  const store = await windowAppStore();
  const values = await Promise.all(
    BACKEND_IDS.map((id) => store.getPref(prefKey(id))));
  const overrides = {} as Record<BackendId, string>;
  BACKEND_IDS.forEach((id, i) => { overrides[id] = values[i] ?? ""; });
  return overrides;
}

/** `path` empty clears the override and returns that binary to
 *  auto-detection. */
export async function setOverride(id: BackendId, path: string): Promise<void> {
  const store = await windowAppStore();
  await store.setPref(prefKey(id), path.trim());
}

export interface BackendStatus {
  id: BackendId;
  path: string | null;
  version: string | null;
  ok: boolean;
  error: string | null;
  notable: string[];
}

/** Only the overrides that are actually set are worth sending — an
 *  empty string would otherwise tell the Rust side to treat "auto
 *  detect" as "pinned to an empty path". */
function nonEmpty(overrides: Record<BackendId, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of BACKEND_IDS) {
    if (overrides[id] !== "") out[id] = overrides[id];
  }
  return out;
}

/** Runs detection for all four backends against the currently saved
 *  overrides. */
export async function detectBackends(
  overrides: Record<BackendId, string>,
): Promise<BackendStatus[]> {
  return invoke<BackendStatus[]>(
    "media_detect_backends", { overrides: nonEmpty(overrides) });
}
