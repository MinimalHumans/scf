// SPDX-License-Identifier: Apache-2.0
/**
 * assetLocator.ts — the I/O half of asset resolution, now through the
 * shell (file-management-plan.md §3.4): `scf-host/assets.ts` resolves
 * `@project/...` identifiers against the project's asset root, a plain
 * path, over the window's own file commands. `scf-core/assets.ts`
 * still owns the grammar and the state machine and knows nothing of
 * either.
 */

import { createAssetAccess, type AssetAccess } from "@scf-host/assets.ts";
import type { FileLocator } from "@scf-core/assets.ts";
import { createTauriPlatform } from "../host/tauriPlatform.ts";

let accessPromise: Promise<AssetAccess> | null = null;
function assetAccess(): Promise<AssetAccess> {
  accessPromise ??= createTauriPlatform().then(createAssetAccess);
  return accessPromise;
}

export function makeLocator(assetRoot: string | null): FileLocator {
  return async (root, path) => (await assetAccess()).locate(assetRoot)(root, path);
}

/**
 * The bytes at `path` under `assetRoot`, or null.
 *
 * Exported because thumbnail generation wants the bytes ONCE and does
 * not want an object URL: it decodes straight from them and caches a
 * small raster, so routing it through `assetObjectUrl` would create a
 * URL whose only purpose is to be revoked a moment later.
 */
export async function fileAt(
  assetRoot: string | null, path: string,
): Promise<Uint8Array | null> {
  if (assetRoot === null) return null;
  return (await assetAccess()).read(assetRoot, `@project/${path}`);
}

/**
 * The head of a text asset. Truncated because a 40MB log has no
 * business entering the DOM, and a preview is a look rather than a
 * read.
 */
export async function readAssetText(
  assetRoot: string | null, path: string, limit: number,
): Promise<string | null> {
  if (assetRoot === null) return null;
  const access = await assetAccess();
  const head = await access.read(
    assetRoot, `@project/${path}`, { offset: 0, length: limit });
  if (head === null) return null;
  const text = new TextDecoder().decode(head);
  if (head.length < limit) return text;
  // The head may have been read whole if the file is shorter than
  // `limit` and the range still reported `head.length === limit` by
  // coincidence; a size check settles it.
  const size = (await access.locate(assetRoot)("project", path))
    ?.sizeBytes ?? null;
  return size !== null && size > limit
    ? `${text}\n\n… truncated at ${Math.round(limit / 1024)} KB` : text;
}

/**
 * The leading bytes of an asset, with the file's own size and mtime.
 *
 * Sliced rather than read whole: header parsing needs the first tens of
 * KB, and a 400MB plate has no business being pulled into memory to
 * report its dimensions.
 */
export async function readAssetBytes(
  assetRoot: string | null, path: string, limit: number,
): Promise<{ bytes: ArrayBuffer; size: number;
             lastModified: number } | null> {
  if (assetRoot === null) return null;
  const access = await assetAccess();
  const located = await access.locate(assetRoot)("project", path);
  if (located === undefined || located === null) return null;
  const bytes = await access.read(
    assetRoot, `@project/${path}`, { offset: 0, length: limit });
  if (bytes === null) return null;
  // A fresh, exactly-sized copy: `bytes`'s own buffer is typed
  // `ArrayBufferLike` (it could in principle be a `SharedArrayBuffer`),
  // and callers of this function want a plain `ArrayBuffer`.
  const copy = new Uint8Array(bytes);
  return {
    bytes: copy.buffer,
    size: located.sizeBytes ?? bytes.length,
    lastModified: located.mtime === null ? 0 : Date.parse(located.mtime),
  };
}

/**
 * `path`'s real, absolute location under `assetRoot`, or null.
 *
 * Exported for `objectUrlCache.ts` only: the media server (Phase 2 of
 * docs/media-server-spec.md) needs the real path to register a handle
 * for, but that path is never meant to travel any further than the one
 * Rust command that consumes it — it does not cross into a URL, and
 * nothing else in the window should be reaching for it.
 */
export async function resolvedAbsolutePath(
  assetRoot: string | null, path: string,
): Promise<string | null> {
  if (assetRoot === null) return null;
  return (await assetAccess()).resolve(assetRoot, `@project/${path}`);
}

/** An object URL for a resolved asset, or null. Caller revokes it. */
export async function assetObjectUrl(
  assetRoot: string | null, path: string,
): Promise<string | null> {
  const bytes = await fileAt(assetRoot, path);
  return bytes === null ? null
    : URL.createObjectURL(new Blob([new Uint8Array(bytes)]));
}
