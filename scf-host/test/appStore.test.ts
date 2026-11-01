// SPDX-License-Identifier: Apache-2.0
/**
 * appStore.ts owns app.db's schema, migration and queries; this exercises
 * it against the real Node driver (nodeAppStore.ts), the way the window
 * and the standalone MCP will use it in practice.
 */

import {
  existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { openNodeAppStore } from "../src/nodeAppStore.ts";
import {
  openVerified, type AppDb, type AppStore, type AppStoreFs, type OpenAppDb,
} from "../src/appStore.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "scf-app-store-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("schema and migration", () => {
  test("creates the project and pref tables on first open", async () => {
    const store = await openNodeAppStore(join(dir, "app.db"));
    try {
      expect(await store.getProject("/films/a.scf")).toBeNull();
      expect(await store.getPref("lastProjectFolder")).toBeNull();
    } finally {
      await store.close();
    }
  });

  test("touchProject creates a row, reopening the file keeps it", async () => {
    const path = join(dir, "app.db");
    const first = await openNodeAppStore(path);
    await first.touchProject("/films/a.scf", {
      uuid: "u1", title: "A Film", baseName: "a", assetRoot: "/films/assets",
    });
    await first.close();

    const second = await openNodeAppStore(path);
    try {
      expect(await second.getProject("/films/a.scf")).toEqual({
        pathKey: "/films/a.scf", scfPath: "/films/a.scf", uuid: "u1",
        title: "A Film", baseName: "a", assetRoot: "/films/assets",
        lastOpened: expect.any(String),
      });
    } finally {
      await second.close();
    }
  });

  test("touchProject leaves omitted fields, overwrites given ones " +
      "(null clears)", async () => {
    const store = await openNodeAppStore(join(dir, "app.db"));
    try {
      await store.touchProject("/films/a.scf", { uuid: "u1", title: "A" });
      const row = await store.touchProject("/films/a.scf", { title: null });
      expect(row.uuid).toBe("u1");
      expect(row.title).toBeNull();
    } finally {
      await store.close();
    }
  });

  test("setAssetRoot and forgetProject", async () => {
    const store = await openNodeAppStore(join(dir, "app.db"));
    try {
      await store.touchProject("/films/a.scf");
      await store.setAssetRoot("/films/a.scf", "/films/assets");
      expect((await store.getProject("/films/a.scf"))?.assetRoot)
        .toBe("/films/assets");
      await store.forgetProject("/films/a.scf");
      expect(await store.getProject("/films/a.scf")).toBeNull();
    } finally {
      await store.close();
    }
  });

  test("recentProjects orders most recently opened first", async () => {
    const store = await openNodeAppStore(join(dir, "app.db"));
    try {
      await store.touchProject("/films/a.scf");
      await store.touchProject("/films/b.scf");
      await store.touchProject("/films/a.scf");
      const recent = await store.recentProjects();
      expect(recent.map((r) => r.scfPath)).toEqual([
        "/films/a.scf", "/films/b.scf",
      ]);
    } finally {
      await store.close();
    }
  });

  test("imports legacy recentFiles only on first creation", async () => {
    const path = join(dir, "app.db");
    const first = await openNodeAppStore(path, {
      importLegacyRecentFiles: () =>
        Promise.resolve(["/films/old1.scf", "/films/old2.scf"]),
    });
    expect((await first.recentProjects()).map((r) => r.scfPath)).toEqual([
      "/films/old1.scf", "/films/old2.scf",
    ]);
    await first.close();

    const second = await openNodeAppStore(path, {
      importLegacyRecentFiles: () => Promise.resolve(["/films/new.scf"]),
    });
    try {
      expect((await second.recentProjects()).map((r) => r.scfPath))
        .not.toContain("/films/new.scf");
    } finally {
      await second.close();
    }
  });
});

describe("path-key normalisation", () => {
  test("case-insensitive keys fold two spellings to one row", async () => {
    const store = await openNodeAppStore(join(dir, "app.db"), {
      caseInsensitiveKeys: true,
    });
    try {
      await store.touchProject("C:\\Films\\A.scf", { uuid: "u1" });
      const row = await store.getProject("c:\\films\\a.scf");
      expect(row?.uuid).toBe("u1");
      // The spelling as the user would recognise it is kept, from
      // whichever call wrote it last.
      expect(row?.scfPath).toBe("C:\\Films\\A.scf");
    } finally {
      await store.close();
    }
  });

  test("case-sensitive keys keep two spellings apart", async () => {
    const store = await openNodeAppStore(join(dir, "app.db"), {
      caseInsensitiveKeys: false,
    });
    try {
      await store.touchProject("/films/A.scf", { uuid: "u1" });
      expect(await store.getProject("/films/a.scf")).toBeNull();
      expect((await store.getProject("/films/A.scf"))?.uuid).toBe("u1");
    } finally {
      await store.close();
    }
  });
});

describe("two writers", () => {
  test("two connections to the same file can both write", async () => {
    const path = join(dir, "app.db");
    const a = await openNodeAppStore(path);
    const b = await openNodeAppStore(path);
    try {
      await Promise.all([
        a.touchProject("/films/a.scf"),
        b.touchProject("/films/b.scf"),
      ]);
      expect(await a.getProject("/films/b.scf")).not.toBeNull();
      expect(await b.getProject("/films/a.scf")).not.toBeNull();
    } finally {
      await a.close();
      await b.close();
    }
  });
});

describe("corruption", () => {
  test("a file that is not a database is backed up and replaced", async () => {
    const path = join(dir, "app.db");
    writeFileSync(path, "not a sqlite file at all");

    const store = await openNodeAppStore(path);
    try {
      expect(existsSync(`${path}.bak`)).toBe(true);
      expect(readFileSync(`${path}.bak`, "utf8"))
        .toBe("not a sqlite file at all");
      // The fresh file works normally.
      await store.touchProject("/films/a.scf", { uuid: "u1" });
      expect((await store.getProject("/films/a.scf"))?.uuid).toBe("u1");
    } finally {
      await store.close();
    }
  });

  test("a missing file is not treated as corruption (no .bak)", async () => {
    const path = join(dir, "app.db");
    const store: AppStore = await openNodeAppStore(path);
    await store.close();
    expect(existsSync(`${path}.bak`)).toBe(false);
  });

  test("a prior good backup is restored automatically, not wiped blank",
      async () => {
    const path = join(dir, "app.db");
    const good = await openNodeAppStore(path);
    await good.touchProject("/films/a.scf", { uuid: "u1" });
    await good.close();
    // A known-good backup already sitting there, as if from an earlier
    // recovery (or just a copy the user made).
    writeFileSync(`${path}.bak`, readFileSync(path));
    // The live file then goes bad.
    writeFileSync(path, "not a sqlite file at all");

    const store = await openNodeAppStore(path);
    try {
      // Recovered with no action needed — the project row survived.
      expect((await store.getProject("/films/a.scf"))?.uuid).toBe("u1");
      // The freshly-corrupt file is preserved under the name a person
      // would know to look for...
      expect(readFileSync(`${path}.bak`, "utf8"))
        .toBe("not a sqlite file at all");
      // ...and the backup that was there before was promoted straight
      // back into place rather than silently overwritten — it IS the
      // live file now, so there is no separate timestamped leftover.
      expect(readdirSync(dir).some((f) => /\.bak-\d+$/.test(f))).toBe(false);
    } finally {
      await store.close();
    }
  });

  test("a prior backup that is also bad still falls through to a fresh " +
      "database, and nothing on disk is destroyed", async () => {
    const path = join(dir, "app.db");
    writeFileSync(`${path}.bak`, "also not a database");
    writeFileSync(path, "not a sqlite file at all");

    const store = await openNodeAppStore(path);
    try {
      expect(await store.getProject("/films/a.scf")).toBeNull();
      await store.touchProject("/films/a.scf", { uuid: "u2" });
      expect((await store.getProject("/films/a.scf"))?.uuid).toBe("u2");
    } finally {
      await store.close();
    }
    const files = readdirSync(dir);
    expect(files).toContain("app.db.bak");
    expect(files.some((f) => /\.bak-\d+$/.test(f))).toBe(true);
  });
});

describe("lock contention vs. corruption", () => {
  function fakeDb(): AppDb {
    return {
      exec: (sql) => Promise.resolve(
        /quick_check/i.test(sql) ? [{ quick_check: "ok" }] : []),
      close: () => Promise.resolve(),
    };
  }

  /** Only the main file exists — no `.bak` sitting there already, which
   *  is what every test in this block means by "no backup" (distinct
   *  from `rename` never being called, which only the lock-contention
   *  tests actually expect). */
  function fsExpectingNoBackup(): AppStoreFs & { renamed: boolean } {
    const fs = {
      renamed: false,
      exists: (p: string) => Promise.resolve(p === "/fake/app.db"),
      remove: () => Promise.resolve(),
      rename: () => { fs.renamed = true; return Promise.resolve(); },
    };
    return fs;
  }

  test("retries past transient lock contention without backing up",
      async () => {
    let attempts = 0;
    const open: OpenAppDb = () => {
      attempts += 1;
      return attempts < 3
        ? Promise.reject(new Error("database is locked"))
        : Promise.resolve(fakeDb());
    };
    const fs = fsExpectingNoBackup();
    const db = await openVerified("/fake/app.db", open, fs);
    await db.close();
    expect(attempts).toBe(3);
    expect(fs.renamed).toBe(false);
  });

  test("surfaces a lock that never clears, instead of wiping the file",
      async () => {
    const open: OpenAppDb = () =>
      Promise.reject(new Error("database is locked"));
    const fs = fsExpectingNoBackup();
    await expect(openVerified("/fake/app.db", open, fs))
      .rejects.toThrow(/locked/);
    expect(fs.renamed).toBe(false);
  });

  test("a non-lock failure still backs up and recreates", async () => {
    let attempts = 0;
    const open: OpenAppDb = () => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new Error("file is not a database"))
        : Promise.resolve(fakeDb());
    };
    const fs = fsExpectingNoBackup();
    const db = await openVerified("/fake/app.db", open, fs);
    await db.close();
    expect(attempts).toBe(2);
    expect(fs.renamed).toBe(true);
  });
});

describe("suggestionsFor", () => {
  test("a uuid hit is offered, most recent first, never applied",
      async () => {
    const store = await openNodeAppStore(join(dir, "app.db"));
    try {
      // Touched first, so it is the OLDER of the two by last_opened —
      // named for when it happened, not alphabetically.
      await store.touchProject("/films/touched-first.scf", {
        uuid: "u1", assetRoot: "/assets/first",
      });
      // last_opened is millisecond-resolution; without a gap the two
      // touches can tie and the order between them is then undefined.
      await new Promise((r) => { setTimeout(r, 2); });
      await store.touchProject("/films/touched-second.scf", {
        uuid: "u1", assetRoot: "/assets/second",
      });
      const suggestions = await store.suggestionsFor(
        { uuid: "u1", title: null, baseName: null }, "/films/new.scf");
      expect(suggestions.map((s) => s.scfPath)).toEqual([
        "/films/touched-second.scf", "/films/touched-first.scf",
      ]);
      expect(suggestions.every((s) => s.strength === "uuid")).toBe(true);
      // Offering never writes anything.
      expect(await store.getProject("/films/new.scf")).toBeNull();
    } finally {
      await store.close();
    }
  });

  test("a title or base-name hit is offered when there is no uuid hit",
      async () => {
    const store = await openNodeAppStore(join(dir, "app.db"));
    try {
      await store.touchProject(
        "/films/by-title.scf", { title: "Hollow Creek", assetRoot: "/assets/hc" });
      await store.touchProject(
        "/films/by-base.scf", { baseName: "hollow_creek", assetRoot: "/assets/hc" });
      const suggestions = await store.suggestionsFor({
        uuid: null, title: "Hollow Creek", baseName: "hollow_creek",
      }, "/films/new.scf");
      expect(suggestions.map((s) => s.scfPath).sort()).toEqual([
        "/films/by-base.scf", "/films/by-title.scf",
      ]);
      expect(suggestions.every((s) => s.strength === "name")).toBe(true);
    } finally {
      await store.close();
    }
  });

  test("a uuid hit suppresses a weak hit on the same row", async () => {
    const store = await openNodeAppStore(join(dir, "app.db"));
    try {
      await store.touchProject("/films/old.scf",
        { uuid: "u1", title: "Hollow Creek", assetRoot: "/assets/hc" });
      const suggestions = await store.suggestionsFor(
        { uuid: "u1", title: "Hollow Creek", baseName: null },
        "/films/new.scf");
      expect(suggestions).toHaveLength(1);
      expect(suggestions[0]?.strength).toBe("uuid");
    } finally {
      await store.close();
    }
  });

  test("the path itself is never offered as its own suggestion",
      async () => {
    const store = await openNodeAppStore(join(dir, "app.db"));
    try {
      await store.touchProject("/films/a.scf", { uuid: "u1", assetRoot: "/assets/a" });
      const suggestions = await store.suggestionsFor(
        { uuid: "u1", title: null, baseName: null }, "/films/a.scf");
      expect(suggestions).toEqual([]);
    } finally {
      await store.close();
    }
  });

  test("a matching project with no asset root is never offered", async () => {
    const store = await openNodeAppStore(join(dir, "app.db"));
    try {
      // Same uuid, but no asset root attached to it.
      await store.touchProject("/films/unmapped.scf", { uuid: "u1" });
      const suggestions = await store.suggestionsFor(
        { uuid: "u1", title: null, baseName: null }, "/films/new.scf");
      expect(suggestions).toEqual([]);
    } finally {
      await store.close();
    }
  });

  test("nothing to go on offers nothing", async () => {
    const store = await openNodeAppStore(join(dir, "app.db"));
    try {
      await store.touchProject("/films/a.scf", {
        title: "Something else", assetRoot: "/assets/a",
      });
      const suggestions = await store.suggestionsFor(
        { uuid: null, title: null, baseName: null }, "/films/new.scf");
      expect(suggestions).toEqual([]);
    } finally {
      await store.close();
    }
  });
});
