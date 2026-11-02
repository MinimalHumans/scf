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
 *
 * Phase 5 adds `requestStillRender`, the still-image analogue: same
 * `/media` request, plus `layer`/`channel` query params for an EXR's
 * layer picker, and a ready result carries its own url directly since
 * an `<img>` (unlike `<video>`) has nothing to reload once the job
 * finishes — the caller just swaps `src`.
 *
 * Phase 6 passes `root` along as the asset's project id when
 * registering a handle, so the media server's per-project cache quota
 * and flush (docs/media-server-spec.md §7) have something to key on,
 * and adds `retryJob` (the explicit "Retry" action for a failed job,
 * spec §7 "Manual actions") alongside the existing `cancelJob`.
 */

import { invoke } from "@tauri-apps/api/core";
import { resolvedAbsolutePath } from "./assetLocator.ts";
import { windowAppStore } from "../host/windowAppStore.ts";

interface ServerInfo { url: string; token: string }

/** Fetched once for the whole session — every `<img>`/`<video>` the
 *  window ever shows uses the same loopback server. */
let serverInfo: Promise<ServerInfo> | null = null;
/** Exported for `mediaDashboard.ts` (Phase 7), which needs the same
 *  (url, token) pair for its own `fetch` calls — one memoized request
 *  for the whole session, shared rather than duplicated. */
export function mediaServerInfo(): Promise<ServerInfo> {
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
    invoke<string>("media_register_asset", { path: absolute, projectId: root }),
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
  verdict: "passthrough" | "remux" | "transcode" | "render" | "unsupported";
  /** EXR's layer/channel names (Phase 5) — always `[]` for a video/
   *  audio asset, for a magick-backed still format (no introspection),
   *  or for an EXR with no layer structure. The frontend builds its
   *  layer picker from these, never by guessing. */
  layers: string[];
  channels: string[];
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

export type StillRenderResult =
  | { kind: "ready"; url: string }
  | { kind: "queued"; jobId: string }
  | { kind: "unsupported" }
  | { kind: "error"; message: string };

/**
 * The still-image counterpart to `startConversion` (Phase 5): asks
 * `/media` with the chosen `layer`/`channel` (both ignored server-side
 * for a non-EXR format — see `resolve_still_selection`), but — unlike
 * video's "fire and poll a separate `<video>` reload" — a `200`/`206`
 * here means the url is immediately usable as an `<img src>`, so the
 * ready case returns that same url rather than leaving the caller to
 * build it again.
 */
export async function requestStillRender(
  root: string | null, path: string, layer: string, channel: string,
): Promise<StillRenderResult> {
  const r = await acquireEntry(root, path);
  if (r === null) return { kind: "error", message: "could not resolve this asset" };
  const params = new URLSearchParams({ h: r.handle, t: r.info.token });
  if (layer !== "") params.set("layer", layer);
  if (channel !== "") params.set("channel", channel);
  const url = `${r.info.url}/media?${params.toString()}`;
  try {
    const res = await fetch(url);
    if (res.status === 200 || res.status === 206) return { kind: "ready", url };
    if (res.status === 202) {
      const body = await res.json() as { jobId: string };
      return { kind: "queued", jobId: body.jobId };
    }
    if (res.status === 415) return { kind: "unsupported" };
    const body = await res.json().catch(() => null) as { error?: string } | null;
    return { kind: "error", message: body?.error ?? `unexpected ${String(res.status)}` };
  } catch (e) {
    return { kind: "error", message: e instanceof Error ? e.message : String(e) };
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
 * The explicit "Retry" action for a failed job (Phase 6, spec §7
 * "Manual actions"): clears its cache key's negative-cache entry so the
 * next `/media` request for it attempts the conversion again. Does not
 * itself re-request anything — the caller still needs to reload the
 * `<img>`/`<video>` (or call `startConversion`/`requestStillRender`
 * again) to actually trigger that next attempt.
 */
export async function retryJob(jobId: string): Promise<void> {
  const info = await mediaServerInfo();
  await fetch(`${info.url}/jobs/${jobId}/retry?t=${info.token}`, { method: "POST" })
    .catch(() => undefined);
}

/**
 * The Media tab's up/down priority chevrons — bumps `jobId` to
 * `priority` (one of `mediaDashboard.ts`'s `PRIORITY_TIERS`). Best-
 * effort, same as `cancelJob`/`retryJob`: the job may already have
 * finished by the time this arrives, which is a normal race, not a
 * failure worth surfacing.
 */
export async function setJobPriority(jobId: string, priority: string): Promise<void> {
  const info = await mediaServerInfo();
  await fetch(
    `${info.url}/jobs/${jobId}/priority?t=${info.token}&priority=${priority}`,
    { method: "POST" },
  ).catch(() => undefined);
}

/**
 * "Flush project"/"Flush all" (Phase 6, spec §7 "Manual actions"), via
 * the host rather than the media server's own HTTP API — unlike a job
 * id, a project id is a real filesystem path, and the host's `invoke`
 * takes it as a plain argument instead of needing URL-encoding into a
 * query string. `root: null` flushes the whole cache, every project.
 */
export async function flushCache(root: string | null): Promise<void> {
  await invoke("media_cache_flush", { projectId: root });
}

/**
 * Re-pushes `scfPath`'s Media-tab cache limit override (app.db's
 * `project.cache_limit_mb`, written by `scf-host`'s `setCacheLimitMb`)
 * to the running media server, keyed by `assetRoot` — the same string
 * `register` above already passes as `project_id` when registering a
 * handle, and what `serve.rs`'s `enforce_quota` calls key the override
 * map on. The map lives only in memory and starts empty every process
 * start, so this needs to run again on every launch, not just once:
 * `applyAssetRoot` (`state/store.ts`) calls it whenever a project's
 * asset root is (re-)applied. Best-effort — a failure here leaves
 * enforcement on the global limit, which is always a safe fallback,
 * never a broken one.
 */
export async function pushProjectCacheLimitOverride(
    scfPath: string | null, assetRoot: string): Promise<void> {
  if (scfPath === null) return;
  try {
    const store = await windowAppStore();
    const row = await store.getProject(scfPath);
    const mb = row?.cacheLimitMb ?? null;
    await invoke("media_set_project_cache_limit", {
      projectId: assetRoot,
      limitBytes: mb === null ? null : Math.round(mb * 1024 * 1024),
    });
  } catch (e) {
    console.error("project cache limit override push failed:", e);
  }
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
