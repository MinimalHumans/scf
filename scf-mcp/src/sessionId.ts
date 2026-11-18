// SPDX-License-Identifier: Apache-2.0
/**
 * sessionId.ts — the ids `open` hands out, and why one is never handed
 * out twice.
 *
 * An id is a count of the sessions this machine has ever opened, put
 * through a keyed shuffle and written in base 36. The count is in
 * `app.db`, so it carries on across restarts and is shared by every
 * server on the machine; the key is a hash of a salt, also in `app.db`,
 * made from the machine's identifier. The shuffle is a permutation: under
 * one salt, different counts always give different ids. So an id from a
 * conversation that outlived its server can be unknown to the next one,
 * and can never be the id of some other film.
 *
 * Ids are four characters until those run out (36^4 of them), then five,
 * and so on. Ten is the longest, because 36^10 is the last power that is
 * still an exact number here. A salt that has given every id it has is
 * replaced by a new one and the count starts again from zero.
 */

import type { AppStore } from "@minimalhumans/scf-host";

const BASE = 36;
const MIN_LENGTH = 4;
const MAX_LENGTH = 10;

export const COUNTER_PREF = "mcp.sessionCounter";
export const SALT_PREF = "mcp.sessionSalt";

const power = (exponent: number): number => {
  let n = 1;
  for (let i = 0; i < exponent; i++) n *= BASE;
  return n;
};

/** How many ids one salt gives: every length from the shortest up. */
export const CAPACITY = Array.from(
  { length: MAX_LENGTH - MIN_LENGTH + 1 }, (_, i) => power(MIN_LENGTH + i))
  .reduce((a, b) => a + b, 0);

/** The key a salt shuffles with: its SHA-256, as eight 32-bit words. */
export async function saltKey(salt: string): Promise<number[]> {
  const digest = new DataView(await crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(salt)));
  return Array.from({ length: 8 }, (_, i) => digest.getUint32(i * 4));
}

/** MurmurHash3's 32-bit finaliser: every input bit reaches every output. */
function mix(x: number): number {
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  return (x ^ (x >>> 16)) >>> 0;
}

/**
 * The id for the `serial`th session (from 0, below `CAPACITY`) under
 * `key`. The serial picks the length, then its place among ids of that
 * length is shuffled by a Feistel network: the number is split in two
 * halves and each round adds a hash of one half to the other. A round can
 * be undone, so no two serials meet.
 */
export function sessionIdOf(serial: number, key: readonly number[]): string {
  let length = MIN_LENGTH;
  let n = serial;
  while (n >= power(length)) {
    n -= power(length);
    length += 1;
  }
  const high = power(Math.floor(length / 2));
  const low = power(Math.ceil(length / 2));
  let left = Math.floor(n / low);
  let right = n % low;
  key.forEach((word, round) => {
    if (round % 2 === 0) left = (left + mix(right ^ word)) % high;
    else right = (right + mix(left ^ word)) % low;
  });
  return (left * low + right).toString(BASE).padStart(length, "0");
}

export interface SessionIds {
  /** An id no session on this machine has had. */
  next(): Promise<string>;
}

/**
 * Ids counted in `store` (`app.db`). `machineId` is what the salt starts
 * from; a random part is added so that an `app.db` that was lost and
 * made again, its count back at zero, does not repeat the ids of the one
 * before.
 */
export function createSessionIds(
    store: AppStore, machineId: () => Promise<string>): SessionIds {
  const newSalt = async (): Promise<string> => {
    const salt = `${await machineId()}:${crypto.randomUUID()}`;
    await store.setPref(SALT_PREF, salt);
    return salt;
  };
  return {
    async next() {
      let serial = await store.bumpPref(COUNTER_PREF) - 1;
      let salt = await store.getPref(SALT_PREF);
      if (serial >= CAPACITY) {
        salt = await newSalt();
        await store.setPref(COUNTER_PREF, "1");
        serial = 0;
      }
      salt ??= await newSalt();
      return sessionIdOf(serial, await saltKey(salt));
    },
  };
}
