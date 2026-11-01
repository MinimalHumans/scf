// SPDX-License-Identifier: Apache-2.0
/**
 * objectUrlCache.test.ts — the handle cache, which is the part that
 * dedups work.
 *
 * Since a media-server URL (Phase 2 of docs/media-server-spec.md) is a
 * plain string the Rust side already knows about, there is nothing to
 * revoke and no grace period any more — what matters now is that
 * concurrent and repeat lookups for the same file share one resolve-
 * and-register round trip, that a failed resolution is retried rather
 * than stuck, and that `revokeAll` (still the project-close/root-change
 * boundary) actually clears stale entries.
 *
 * No view is imported (the app rule: anything under ui/ spawns the SQL
 * worker).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const resolves = vi.hoisted(() => ({ count: 0, fail: false }));
const registers = vi.hoisted(() => ({ count: 0 }));
const infoCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock("../src/files/assetLocator.ts", () => ({
  resolvedAbsolutePath: async (root: unknown, path: string) => {
    resolves.count += 1;
    // A resolve is asynchronous, which is the whole reason the
    // simultaneous-acquire case below exists.
    await Promise.resolve();
    return resolves.fail ? null : `C:\\${String(root)}\\${path}`;
  },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "media_server_info") {
      infoCalls.count += 1;
      await Promise.resolve();
      return { url: "http://127.0.0.1:4321", token: "tok" };
    }
    if (cmd === "media_register_asset") {
      registers.count += 1;
      await Promise.resolve();
      return `handle-${String(registers.count)}-${String(args?.["path"])}`;
    }
    throw new Error(`unexpected invoke: ${cmd}`);
  },
}));

const { acquire, acquireMeta, release, revokeAll } =
  await import("../src/files/objectUrlCache.ts");

const ROOT = "/projects/a";
const OTHER = "/projects/b";

const fetchCalls = vi.hoisted(() => ({ urls: [] as string[], ok: true, body: {} as unknown }));

beforeEach(() => {
  resolves.count = 0;
  resolves.fail = false;
  registers.count = 0;
  infoCalls.count = 0;
  fetchCalls.urls = [];
  fetchCalls.ok = true;
  fetchCalls.body = { probe: { container: "mov" }, verdict: "passthrough" };
  vi.stubGlobal("fetch", async (url: string) => {
    fetchCalls.urls.push(url);
    return {
      ok: fetchCalls.ok,
      json: async () => fetchCalls.body,
    };
  });
});

afterEach(() => { revokeAll(); vi.unstubAllGlobals(); });

describe("objectUrlCache", () => {
  test("two holders of one file share a single resolve-and-register",
       async () => {
    const a = await acquire(ROOT, "assets/x.png");
    const b = await acquire(ROOT, "assets/x.png");
    expect(a).toBe(b);
    expect(resolves.count).toBe(1);
    expect(registers.count).toBe(1);
  });

  // Ten rows scrolling into view at once must not become ten round
  // trips for the same plate while the first is still in flight.
  test("simultaneous acquires collapse into one round trip", async () => {
    const all = await Promise.all(
      Array.from({ length: 10 }, () => acquire(ROOT, "assets/x.png")));
    expect(resolves.count).toBe(1);
    expect(registers.count).toBe(1);
    expect(new Set(all).size).toBe(1);
  });

  test("the URL carries the server's origin, a handle and the token",
       async () => {
    const url = await acquire(ROOT, "assets/x.png");
    expect(url).toMatch(
      /^http:\/\/127\.0\.0\.1:4321\/media\?h=handle-.+&t=tok$/);
  });

  test("the server's own info is fetched at most once across many assets",
       async () => {
    const before = infoCalls.count;
    await acquire(ROOT, "assets/x.png");
    await acquire(ROOT, "assets/y.png");
    await acquire(OTHER, "assets/x.png");
    expect(infoCalls.count - before).toBeLessThanOrEqual(1);
  });

  test("the same path under two different roots is two entries",
       async () => {
    const a = await acquire(ROOT, "assets/x.png");
    const b = await acquire(OTHER, "assets/x.png");
    expect(a).not.toBe(b);
    expect(resolves.count).toBe(2);
  });

  test("an identifier that does not resolve is retried, not stuck",
       async () => {
    resolves.fail = true;
    expect(await acquire(ROOT, "assets/gone.png")).toBeNull();
    expect(await acquire(ROOT, "assets/gone.png")).toBeNull();
    expect(resolves.count).toBe(2);
    resolves.fail = false;
    expect(await acquire(ROOT, "assets/gone.png")).not.toBeNull();
  });

  test("release is a no-op — acquiring again still returns the cached URL",
       async () => {
    const a = await acquire(ROOT, "assets/x.png");
    release(ROOT, "assets/x.png");
    release(ROOT, "assets/x.png"); // more releases than acquires: still fine
    const b = await acquire(ROOT, "assets/x.png");
    expect(b).toBe(a);
    expect(registers.count).toBe(1);
  });

  test("releasing something never acquired does nothing", () => {
    expect(() => release(ROOT, "assets/never.png")).not.toThrow();
  });

  // The root changed under a live session. A cached URL into the
  // previous folder would otherwise keep resolving under the new
  // project's identical relative path, which is worse than a blank
  // thumbnail because it looks like it worked.
  test("revokeAll drops everything, so the next acquire resolves again",
       async () => {
    await acquire(ROOT, "assets/x.png");
    revokeAll();
    await acquire(ROOT, "assets/x.png");
    expect(resolves.count).toBe(2);
    expect(registers.count).toBe(2);
  });
});

describe("acquireMeta", () => {
  test("fetches /meta on the same origin, handle and token as /media",
       async () => {
    const result = await acquireMeta(ROOT, "assets/x.mov");
    expect(fetchCalls.urls).toHaveLength(1);
    expect(fetchCalls.urls[0]).toMatch(
      /^http:\/\/127\.0\.0\.1:4321\/meta\?h=handle-.+&t=tok$/);
    expect(result).toEqual({ probe: { container: "mov" }, verdict: "passthrough" });
  });

  test("shares the registration an earlier acquire already made",
       async () => {
    await acquire(ROOT, "assets/x.mov");
    await acquireMeta(ROOT, "assets/x.mov");
    expect(resolves.count).toBe(1);
    expect(registers.count).toBe(1);
  });

  test("a non-ok response is null, not a thrown error", async () => {
    fetchCalls.ok = false;
    expect(await acquireMeta(ROOT, "assets/x.mov")).toBeNull();
  });

  test("an identifier that does not resolve never reaches fetch",
       async () => {
    resolves.fail = true;
    expect(await acquireMeta(ROOT, "assets/gone.mov")).toBeNull();
    expect(fetchCalls.urls).toHaveLength(0);
  });

  test("a network failure is null, not a thrown error", async () => {
    vi.stubGlobal("fetch", async () => { throw new Error("offline"); });
    expect(await acquireMeta(ROOT, "assets/x.mov")).toBeNull();
  });
});
