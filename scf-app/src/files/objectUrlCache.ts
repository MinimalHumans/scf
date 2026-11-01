// SPDX-License-Identifier: Apache-2.0
/**
 * objectUrlCache — one media-server URL per file, however many
 * thumbnails are looking at it.
 *
 * Through Phase 1 of the media server this held a Blob object URL,
 * refcounted and revoked after a grace period because a Blob costs
 * real memory to keep alive and because two components can be looking
 * at the same plate at once (a bundle list, a binding, a subject's
 * anchor, the asset browser). Phase 2 (docs/media-server-spec.md)
 * replaced the blob with a loopback HTTP URL — `http://127.0.0.1:
 * <port>/media?h=<handle>&t=<token>` — and that changes what this
 * module has to do: a URL *string* naming a handle the Rust side
 * already knows about costs nothing to hold for the rest of the
 * session, so there is no refcount, no grace period and nothing to
 * revoke. What's left is a plain memoizing cache, so acquiring the
 * same file twice shares one resolve-and-register round trip instead
 * of paying for it again.
 *
 * `release` stays, as a no-op, only so the seven existing call sites
 * (`ShotFrame.tsx`, `AssetThumb.tsx`, `AssetPreview.tsx`,
 * `AnchorScope.tsx`, and whatever else calls `acquire`) need no
 * changes at all — the public shape of this module is unchanged even
 * though nothing it returns needs giving back any more.
 *
 * Phase 3 adds `acquireMeta`, over the same cached (handle, server
 * info) pair `acquire` uses — an asset already shown in a preview does
 * not pay for a second registration just to also ask `/meta` about it.
 *
 * Phase 4 adds `startConversion`/`jobStatus`/`cancelJob`: asking
 * `/media` directly (the same request `acquire`'s URL would trigger if
 * used as an `<img>`/`<video>` `src`) is what actually decides whether
 * a conversion is needed, so `startConversion` is the one true way to
 * find out — there is no separate "does this need converting" check to
 * get out of sync with the real answer.
 */

import { invoke } from "@tauri-apps/api/core";
import { resolvedAbsolutePath } from "./assetLocator.ts";

interface ServerInfo { url: string; token: string }

/** Fetched once for the whole session — every `<img>`/`<video>` the
 *  window ever shows uses the same loopback server. */
let serverInfo: Promise<ServerInfo> | null = null;
function mediaServerInfo(): Promise<ServerInfo> {
  serverInfo ??= invoke<ServerInfo>("media_server_info");
  return serverInfo;
}

interface Registered { handle: string; info: ServerInfo }

interface Entry {
  value: Registered | null;
  /** In-flight resolve-and-register, so ten rows appearing at once make
   *  one round trip. */
  pending: Promise<Registered | null> | null;
}

const entries = new Map<string, Entry>();

function keyFor(root: string | null, path: string): string {
  return `${root ?? "-"}:${path}`;
}

async function register(
  root: string | null, path: string,
): Promise<Registered | null> {
  const absolute = await resolvedAbsolutePath(root, path);
  if (absolute === null) return null;
  const [info, handle] = await Promise.all([
    mediaServerInfo(),
    invoke<string>("media_register_asset", { path: absolute }),
  ]);
  return { handle, info };
}

/**
 * The (handle, server info) pair for this file, resolving and
 * registering it if needed and caching the result.
 *
 * A failed resolution is never cached — a file that is not there yet
 * (or not any more) may resolve differently next time, and the cost of
 * retrying is one small round trip, not a decode.
 */
async function acquireEntry(
  root: string | null, path: string,
): Promise<Registered | null> {
  const key = keyFor(root, path);
  let entry = entries.get(key);
  if (entry === undefined) {
    entry = { value: null, pending: null };
    entries.set(key, entry);
  }
  if (entry.value !== null) return entry.value;

  entry.pending ??= register(root, path);
  const value = await entry.pending;
  entry.pending = null;
  if (value !== null) entry.value = value;
  return value;
}

/** This file's media-server URL, creating and caching it if needed. */
export async function acquire(
  root: string | null, path: string,
): Promise<string | null> {
  const r = await acquireEntry(root, path);
  return r === null ? null : `${r.info.url}/media?h=${r.handle}&t=${r.info.token}`;
}

/** Mirrors `media-core`'s `ProbeResult`/`Verdict` (Phase 3 — see
 *  `media-server/src/serve.rs`'s `/meta` route). All of `probe`'s
 *  fields are `null` rather than absent when ffprobe couldn't tell —
 *  a video with no audio track, say — never an error on their own. */
export interface AssetMeta {
  probe: {
    container: string | null;
    videoCodec: string | null;
    audioCodec: string | null;
    width: number | null;
    height: number | null;
    durationSecs: number | null;
    fps: number | null;
  };
  verdict: "passthrough" | "remux" | "transcode" | "unsupported";
}

/**
 * Real probed facts for this file — resolution, duration, codec — and
 * an informational verdict, via the media server's `/meta` route. Null
 * when the file doesn't resolve, ffprobe isn't configured, or ffprobe
 * couldn't read it (not a media file, corrupt) — all three are quiet
 * "nothing to show" cases here, not thrown errors; the caller (`Asset
 * FileFacts.tsx`) decides what, if anything, to say about their
 * absence.
 */
export async function acquireMeta(
  root: string | null, path: string,
): Promise<AssetMeta | null> {
  const r = await acquireEntry(root, path);
  if (r === null) return null;
  try {
    const res = await fetch(`${r.info.url}/meta?h=${r.handle}&t=${r.info.token}`);
    if (!res.ok) return null;
    return await res.json() as AssetMeta;
  } catch {
    return null;
  }
}

export interface JobStatus {
  id: string;
  state: "queued" | "running" | "done" | "failed" | "cancelled";
  error: string | null;
  /** 0-1, or `null` before ffmpeg's first progress line arrives. */
  progress: number | null;
}

/**
 * Asks `/media` for this file directly — exactly the request an
 * `<img>`/`<video>` `src` of `acquire`'s URL would make. A `200`
 * (already cached, or genuinely native) or anything that isn't `202`
 * means there is nothing to queue: `null`. A `202` means a conversion
 * is now queued or running (an identical in-flight request elsewhere
 * attaches to the same job — media-server's own dedup, not this
 * module's), and its job id is returned to poll.
 */
export async function startConversion(
  root: string | null, path: string,
): Promise<string | null> {
  const r = await acquireEntry(root, path);
  if (r === null) return null;
  try {
    const res = await fetch(`${r.info.url}/media?h=${r.handle}&t=${r.info.token}`);
    if (res.status !== 202) return null;
    const body = await res.json() as { jobId: string };
    return body.jobId;
  } catch {
    return null;
  }
}

export async function jobStatus(jobId: string): Promise<JobStatus | null> {
  const info = await mediaServerInfo();
  try {
    const res = await fetch(`${info.url}/jobs/${jobId}?t=${info.token}`);
    if (!res.ok) return null;
    return await res.json() as JobStatus;
  } catch {
    return null;
  }
}

/** Best-effort — the job may already have finished by the time this
 *  arrives, which is a normal race, not a failure worth surfacing. */
export async function cancelJob(jobId: string): Promise<void> {
  const info = await mediaServerInfo();
  await fetch(`${info.url}/jobs/${jobId}/cancel?t=${info.token}`, { method: "POST" })
    .catch(() => undefined);
}

/**
 * A documented no-op. Kept only so every existing caller — paired with
 * `acquire` on the assumption that something must eventually be given
 * back — needs no change. See the module comment: there is nothing left
 * to give back.
 */
export function release(_root: string | null, _path: string): void {
  // Intentionally empty.
}

/**
 * Drop everything. Called when the project closes or its root changes:
 * a cached URL from the previous folder would otherwise keep resolving
 * under the new project's identical relative path, serving the wrong
 * file silently — worse than a blank thumbnail because it looks like it
 * worked. Nothing needs revoking on the Rust side any more (a handle
 * stays valid, harmlessly, for the rest of the session); only this
 * cache needs clearing.
 */
export function revokeAll(): void {
  entries.clear();
}
