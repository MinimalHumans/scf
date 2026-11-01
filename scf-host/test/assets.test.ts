// SPDX-License-Identifier: Apache-2.0
/**
 * assets.ts over the real Node platform: identifier resolution end to
 * end (through scf-core's resolveIdentifier), the unaddressed/missing
 * distinction, a `..` escape, and reading bytes.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { resolveIdentifier } from "@minimalhumans/scf-core";
import { createAssetAccess } from "../src/assets.ts";
import { nodePlatform } from "../src/nodePlatform.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "scf-assets-"));
  writeFileSync(join(dir, "hero.png"), "0123456789");
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const access = createAssetAccess(nodePlatform);

describe("resolution, through resolveIdentifier", () => {
  test("resolves a file that is there", async () => {
    const r = await resolveIdentifier("@project/hero.png", access.locate(dir));
    expect(r.state).toBe("resolved");
    expect(r.sizeBytes).toBe(10);
  });

  test("missing: a mapped root with nothing at the path", async () => {
    const r = await resolveIdentifier(
      "@project/nope.png", access.locate(dir));
    expect(r.state).toBe("missing");
  });

  test("unaddressed: no root attached", async () => {
    const r = await resolveIdentifier("@project/hero.png", access.locate(null));
    expect(r.state).toBe("unaddressed");
  });

  test("unaddressed: a root name other than @project", async () => {
    const r = await resolveIdentifier("@other/hero.png", access.locate(dir));
    expect(r.state).toBe("unaddressed");
  });

  test("out-of-root: a '..' escape is refused before the locator runs",
      async () => {
    const r = await resolveIdentifier(
      "@project/../outside.png", access.locate(dir));
    expect(r.state).toBe("out-of-root");
  });
});

describe("exists", () => {
  test("true for a resolvable identifier", async () => {
    expect(await access.exists(dir, "@project/hero.png")).toBe(true);
  });
  test("false: nothing there, no root, wrong root, escape, absolute",
      async () => {
    expect(await access.exists(dir, "@project/nope.png")).toBe(false);
    expect(await access.exists(null, "@project/hero.png")).toBe(false);
    expect(await access.exists(dir, "@other/hero.png")).toBe(false);
    expect(await access.exists(dir, "@project/../hero.png")).toBe(false);
    expect(await access.exists(dir, join(dir, "hero.png"))).toBe(false);
  });
});

describe("resolve", () => {
  test("the real path, for a resolvable identifier", async () => {
    expect(await access.resolve(dir, "@project/hero.png"))
      .toBe(join(dir, "hero.png"));
  });
  test("null: nothing there, no root, wrong root, escape, absolute",
      async () => {
    expect(await access.resolve(dir, "@project/nope.png"))
      .toBe(join(dir, "nope.png")); // resolve names a path, not a fact
    expect(await access.resolve(null, "@project/hero.png")).toBeNull();
    expect(await access.resolve(dir, "@other/hero.png")).toBeNull();
    expect(await access.resolve(dir, "@project/../hero.png")).toBeNull();
    expect(await access.resolve(dir, join(dir, "hero.png"))).toBeNull();
  });
});

describe("read", () => {
  test("the whole file", async () => {
    const bytes = await access.read(dir, "@project/hero.png");
    expect(Buffer.from(bytes!).toString()).toBe("0123456789");
  });
  test("a byte range", async () => {
    const bytes = await access.read(
      dir, "@project/hero.png", { offset: 2, length: 3 });
    expect(Buffer.from(bytes!).toString()).toBe("234");
  });
  test("null when it does not resolve", async () => {
    expect(await access.read(dir, "@project/nope.png")).toBeNull();
    expect(await access.read(dir, "@project/../hero.png")).toBeNull();
    expect(await access.read(null, "@project/hero.png")).toBeNull();
  });
});
