// SPDX-License-Identifier: Apache-2.0
/**
 * windowHost.ts — the desktop app's host, run in its own window.
 *
 * In the desktop app there is no host process: the window runs the host
 * core (scf-host `core.ts`) on the shell's files and SQLite
 * (`tauriPlatform.ts`), and its client talks to it in-process. Every
 * film still has one owner, the core, and every client goes through it,
 * so nothing in docs/scf-write-ownership.md changes except where the
 * owner lives.
 *
 * The core is started once, by the first connect, and lives as long as
 * the page. What it is given (roots, where snapshots and the journal go,
 * the version it reports) comes from the shell (`host_setup` in
 * `src-tauri/src/lib.rs`).
 */

import { invoke } from "@tauri-apps/api/core";
import { connectInProcess, type HostTransport } from "@scf-host/client.ts";
import { createHostCore, type HostCore } from "@scf-host/core.ts";
import registryJson from "@registry/registry.json" with { type: "json" };
import { loadRegistry, type RegistryJson } from "@scf-core/registry.ts";
import { createTauriPlatform } from "./tauriPlatform.ts";
import { windowAuditStore } from "./windowAuditStore.ts";

interface HostSetup {
  roots: string[];
  dataDir: string;
  version: string;
}

let core: Promise<HostCore> | null = null;

async function start(): Promise<HostCore> {
  const [setup, platform] = await Promise.all([
    invoke<HostSetup>("host_setup"), createTauriPlatform(),
  ]);
  // The shell's databases from a previous page are closed by the first
  // open on this one (`tauriSql.ts`), whoever makes it.
  // A trail that cannot be opened must not keep films from opening: the
  // host runs without it and says so.
  const audit = await windowAuditStore().catch((e: unknown) => {
    console.error("audit trail unavailable:", e);
    return undefined;
  });
  const { join } = platform.paths;
  return createHostCore({
    registry: loadRegistry(registryJson as unknown as RegistryJson),
    platform, version: setup.version, roots: setup.roots,
    snapshotDir: join(setup.dataDir, "snapshots"),
    journalDir: join(setup.dataDir, "journal"),
    ...(audit === undefined ? {} : { audit }),
    onAuditError: (e) => { console.error("audit trail write failed:", e); },
  });
}

/** A new connection to the window's host, starting it if need be. */
export async function windowHostTransport(): Promise<HostTransport> {
  if (core === null) {
    const attempt = start();
    // A failed start is tried again by the next connect.
    attempt.catch(() => {
      if (core === attempt) core = null;
    });
    core = attempt;
  }
  return connectInProcess((await core).connect());
}
