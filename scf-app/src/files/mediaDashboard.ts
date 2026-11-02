// SPDX-License-Identifier: Apache-2.0
/**
 * mediaDashboard — read-only data for Phase 7's dashboard (docs/
 * media-server-spec.md §9).
 *
 * `listJobs` reads the job queue (plus worker slot usage) over the
 * media server's own loopback HTTP API — the same token-gated surface
 * `objectUrlCache.ts`'s `cancelJob`/`retryJob` already use, and for
 * the same reason: no absolute path ever crosses this boundary (spec
 * §13), so `DashboardJob.fileName` is a bare file name, never the
 * real path a job was queued for.
 *
 * `getCacheStats` goes through the host instead (`media_cache_stats`,
 * a Tauri command rather than HTTP) — the same split `objectUrlCache.
 * ts`'s `flushCache` already makes, because a project id is a real
 * filesystem path in this implementation and the loopback API never
 * accepts or returns one.
 */

import { invoke } from "@tauri-apps/api/core";
import { mediaServerInfo } from "./objectUrlCache.ts";

export type JobState = "queued" | "running" | "done" | "failed" | "cancelled";

/** The three tiers `media-server`'s queue actually has (docs/
 *  media-server-spec.md §6) — `"requested"` is the default a job gets
 *  when nothing more specific asked for one. */
export const PRIORITY_TIERS = ["background", "requested", "preview"] as const;
export type PriorityTier = typeof PRIORITY_TIERS[number];

export interface DashboardJob {
  id: string;
  state: JobState;
  error: string | null;
  stderrTail: string | null;
  priority: string;
  backendId: string | null;
  fileName: string | null;
  progress: number | null;
  /** The source file's size, read live off disk — `null` when it's no
   *  longer there to stat, or this is an older job row with no input
   *  path recorded at all. */
  sourceBytes: number | null;
  /** How much the `.part` file holds right now, only while `state` is
   *  `"running"` — what's actually been written so far, never a
   *  projected final size (nothing here guesses at one). */
  partialBytes: number | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface WorkerStatus {
  videoInUse: number;
  videoMax: number;
  stillInUse: number;
  stillMax: number;
}

export interface JobsResponse {
  jobs: DashboardJob[];
  workers: WorkerStatus;
}

export async function listJobs(): Promise<JobsResponse> {
  const info = await mediaServerInfo();
  const res = await fetch(`${info.url}/jobs?t=${info.token}`);
  if (!res.ok) throw new Error(`jobs request failed: ${String(res.status)}`);
  return await res.json() as JobsResponse;
}

export interface KindCacheStats {
  count: number;
  bytes: number;
  hits: number;
  capBytes: number;
  /** `null` when no project was given to scope usage to. */
  projectUsageBytes: number | null;
}

export interface CacheStats {
  video: KindCacheStats;
  stills: KindCacheStats;
}

export async function getCacheStats(projectId: string | null): Promise<CacheStats> {
  return await invoke<CacheStats>("media_cache_stats", { projectId });
}
