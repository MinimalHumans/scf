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

interface Entry {
  url: string | null;
  /** In-flight resolve-and-register, so ten rows appearing at once make
   *  one round trip. */
  pending: Promise<string | null> | null;
}

const entries = new Map<string, Entry>();

function keyFor(root: string | null, path: string): string {
  return `${root ?? "-"}:${path}`;
}

async function buildUrl(
  root: string | null, path: string,
): Promise<string | null> {
  const absolute = await resolvedAbsolutePath(root, path);
  if (absolute === null) return null;
  const [info, handle] = await Promise.all([
    mediaServerInfo(),
    invoke<string>("media_register_asset", { path: absolute }),
  ]);
  return `${info.url}/media?h=${handle}&t=${info.token}`;
}

/**
 * This file's media-server URL, creating and caching it if needed.
 *
 * A failed resolution is never cached — a file that is not there yet
 * (or not any more) may resolve differently next time, and the cost of
 * retrying is one small round trip, not a decode.
 */
export async function acquire(
  root: string | null, path: string,
): Promise<string | null> {
  const key = keyFor(root, path);
  let entry = entries.get(key);
  if (entry === undefined) {
    entry = { url: null, pending: null };
    entries.set(key, entry);
  }
  if (entry.url !== null) return entry.url;

  entry.pending ??= buildUrl(root, path);
  const url = await entry.pending;
  entry.pending = null;
  if (url !== null) entry.url = url;
  return url;
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
