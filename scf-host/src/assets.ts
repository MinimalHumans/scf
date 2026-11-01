// SPDX-License-Identifier: Apache-2.0
/**
 * assets.ts — the one place that reads asset bytes
 * (docs/file-management-plan.md §3.4).
 *
 * A project has one asset root (`PROJECT_ROOT`, "project") — a plain
 * folder path, or null when nothing is attached. This module resolves
 * `@project/...` identifiers against it, through the host's own file
 * primitives (`HostPlatform.stat`/`readBytes`), so the window and the
 * standalone MCP share one implementation: the window wires it over
 * `tauriPlatform.ts`, the MCP (and this package's tests) over
 * `nodePlatform.ts`.
 *
 * Read-only, as conventions §9 requires. This is the seam a
 * multi-user host later replaces with a media translator.
 */

import {
  escapesRoot, parseIdentifier, PROJECT_ROOT,
  type FileLocator, type LocatedFile,
} from "@minimalhumans/scf-core";
import type { HostPlatform } from "./platform.ts";

export interface ByteRange { offset: number; length: number }

export interface AssetAccess {
  /**
   * A `FileLocator` over `assetRoot`: unaddressed (`undefined`) for any
   * root name other than `@project`, or when `assetRoot` is null;
   * missing (`null`) when nothing is at the resolved path; otherwise
   * found. `path` is assumed already checked for a `..` escape, as
   * `resolveIdentifier` does before ever calling a locator.
   */
  locate(assetRoot: string | null): FileLocator;
  /**
   * Whether `identifier` (a raw `@project/...` string) resolves to
   * something under `assetRoot`. False for an absolute identifier, a
   * `..` escape, a root other than `@project`, or nothing there.
   */
  exists(assetRoot: string | null, identifier: string): Promise<boolean>;
  /**
   * The bytes `identifier` resolves to, or the byte range of them, or
   * null when it does not resolve (see `exists`).
   */
  read(assetRoot: string | null, identifier: string,
       range?: ByteRange): Promise<Uint8Array | null>;
  /**
   * `identifier`'s real path under `assetRoot`, or null (see `exists`).
   * The media server (docs/media-server-spec.md §2) is the one caller
   * that wants a path rather than bytes — it hands that path to the
   * window's own filesystem, never back out to the browser.
   */
  resolve(assetRoot: string | null, identifier: string): Promise<string | null>;
}

/** `identifier`'s real path under `assetRoot`, or null if it cannot
 *  resolve there at all (wrong root, absolute, escapes, unmapped). */
function resolvedPath(
    platform: HostPlatform, assetRoot: string | null,
    rawIdentifier: string): string | null {
  if (assetRoot === null) return null;
  const identifier = parseIdentifier(rawIdentifier);
  if (identifier === null) return null;
  if (identifier.absolute || identifier.root !== PROJECT_ROOT) return null;
  if (escapesRoot(identifier.path)) return null;
  return platform.paths.join(assetRoot, identifier.path);
}

export function createAssetAccess(platform: HostPlatform): AssetAccess {
  return {
    locate(assetRoot) {
      return async (root, path) => {
        if (assetRoot === null || root !== PROJECT_ROOT) return undefined;
        const st = await platform.stat(platform.paths.join(assetRoot, path));
        if (st === null) return null;
        const located: LocatedFile =
          { materialised: true, sizeBytes: st.size, mtime: st.modified };
        return located;
      };
    },

    async exists(assetRoot, identifier) {
      const path = resolvedPath(platform, assetRoot, identifier);
      if (path === null) return false;
      return await platform.stat(path) !== null;
    },

    async read(assetRoot, identifier, range) {
      const path = resolvedPath(platform, assetRoot, identifier);
      if (path === null) return null;
      try {
        return await platform.readBytes(path, range);
      } catch {
        return null;
      }
    },

    async resolve(assetRoot, identifier) {
      return resolvedPath(platform, assetRoot, identifier);
    },
  };
}
