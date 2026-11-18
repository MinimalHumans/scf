// SPDX-License-Identifier: Apache-2.0
/**
 * sessionId.ts: an id is never given twice. Pinned at both ends — the
 * shuffle itself gives every count its own id, and the count and salt
 * behind it are `app.db`'s, so they carry on where the last server
 * stopped.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { openNodeAppStore, type AppStore } from "@minimalhumans/scf-host";
import {
  CAPACITY, COUNTER_PREF, SALT_PREF, createSessionIds, saltKey, sessionIdOf,
} from "../src/sessionId.ts";

const FOUR = 36 ** 4;

describe("sessionIdOf", () => {
  test("every one of the first 36^4 sessions gets its own four " +
      "characters of base 36", async () => {
    const key = await saltKey("a machine");
    const seen = new Uint8Array(FOUR);
    for (let serial = 0; serial < FOUR; serial++) {
      const id = sessionIdOf(serial, key);
      if (!/^[0-9a-z]{4}$/.test(id)) throw new Error(`${serial}: "${id}"`);
      seen[parseInt(id, 36)]! += 1;
    }
    expect(seen.every((n) => n === 1)).toBe(true);
  });

  test("ids grow a character when a length runs out, and never beyond " +
      "what a salt can give", async () => {
    const key = await saltKey("a machine");
    expect(sessionIdOf(FOUR - 1, key)).toHaveLength(4);
    expect(sessionIdOf(FOUR, key)).toHaveLength(5);
    expect(sessionIdOf(FOUR + 36 ** 5 - 1, key)).toHaveLength(5);
    expect(sessionIdOf(FOUR + 36 ** 5, key)).toHaveLength(6);
    expect(sessionIdOf(CAPACITY - 1, key)).toMatch(/^[0-9a-z]{10}$/);
    expect(Number.isSafeInteger(CAPACITY)).toBe(true);
    // Longer ids are shuffled too: neighbours are not neighbours.
    const five = Array.from({ length: 5000 },
      (_, i) => sessionIdOf(FOUR + i, key));
    expect(new Set(five).size).toBe(5000);
    expect(parseInt(five[1]!, 36) - parseInt(five[0]!, 36)).not.toBe(1);
  });

  test("the salt decides the order: another machine's ids are not " +
      "this one's", async () => {
    const here = await saltKey("this machine");
    const there = await saltKey("that machine");
    const mine = Array.from({ length: 200 }, (_, i) => sessionIdOf(i, here));
    const theirs = Array.from({ length: 200 },
      (_, i) => sessionIdOf(i, there));
    expect(mine.filter((id, i) => id === theirs[i]).length).toBeLessThan(3);
    expect(mine).toEqual(
      Array.from({ length: 200 }, (_, i) => sessionIdOf(i, here)));
  });
});

describe("createSessionIds", () => {
  let dir: string;
  let store: AppStore;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "scf-mcp-session-ids-"));
    store = await openNodeAppStore(join(dir, "app.db"));
  });
  afterEach(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const machine = () => Promise.resolve("MACHINE-1");

  test("counts in app.db, salted from the machine's identifier",
      async () => {
    const ids = createSessionIds(store, machine);
    const first = await ids.next();
    const salt = await store.getPref(SALT_PREF);
    expect(salt?.startsWith("MACHINE-1:")).toBe(true);
    expect(await store.getPref(COUNTER_PREF)).toBe("1");
    const key = await saltKey(salt!);
    expect(first).toBe(sessionIdOf(0, key));
    expect(await ids.next()).toBe(sessionIdOf(1, key));
    expect(await store.getPref(COUNTER_PREF)).toBe("2");
    expect(await store.getPref(SALT_PREF)).toBe(salt);
  });

  test("carries on after a restart, and across servers sharing the " +
      "store, without repeating an id", async () => {
    const path = join(dir, "app.db");
    const given: string[] = [];
    const a = createSessionIds(store, machine);
    const b = createSessionIds(store, machine);
    given.push(...await Promise.all(
      Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? a : b).next())));
    await store.close();

    store = await openNodeAppStore(path);
    const later = createSessionIds(store, machine);
    for (let i = 0; i < 40; i++) given.push(await later.next());
    expect(new Set(given).size).toBe(80);
    expect(await store.getPref(COUNTER_PREF)).toBe("80");
  });

  test("a salt that has given every id is replaced, and the count " +
      "starts again from zero", async () => {
    const ids = createSessionIds(store, machine);
    await ids.next();
    const salt = await store.getPref(SALT_PREF);
    // The last id this salt has, then one more than it has.
    await store.setPref(COUNTER_PREF, String(CAPACITY - 1));
    expect(await ids.next()).toBe(
      sessionIdOf(CAPACITY - 1, await saltKey(salt!)));
    expect(await store.getPref(SALT_PREF)).toBe(salt);

    const after = await ids.next();
    const renewed = await store.getPref(SALT_PREF);
    expect(renewed).not.toBe(salt);
    expect(renewed?.startsWith("MACHINE-1:")).toBe(true);
    expect(await store.getPref(COUNTER_PREF)).toBe("1");
    expect(after).toBe(sessionIdOf(0, await saltKey(renewed!)));
    expect(await ids.next()).toBe(sessionIdOf(1, await saltKey(renewed!)));
  });

  test("a machine that will not say what it is still gets a salt of " +
      "its own", async () => {
    const ids = createSessionIds(store, () => Promise.resolve(""));
    expect(await ids.next()).toMatch(/^[0-9a-z]{4}$/);
    expect((await store.getPref(SALT_PREF))!.length).toBeGreaterThan(30);
  });
});
