// SPDX-License-Identifier: Apache-2.0
/**
 * platform.ts — what the MCP server needs from wherever it runs.
 *
 * The tools are the same everywhere; how they reach the host, the disk
 * and a log is not. In the desktop app the server runs in the window,
 * beside the host (scf-app `src/mcp/windowMcp.ts`), and its client's
 * working directory is the stdio pipe's, not the window's. The tests run
 * it on Node's files (`nodePlatform.ts`).
 */

import type { FileLocator } from "@minimalhumans/scf-core";
import type { AppStore } from "@minimalhumans/scf-host";
import type { HostClient } from "@minimalhumans/scf-host/client";
import type { RootMap } from "./config.ts";

export interface McpPlatform {
  /**
   * A new connection to the host, under `name` (how the host attributes
   * this connection's writes).
   */
  connect(name: string): Promise<HostClient>;
  /** `path` made absolute against the client's working directory. */
  resolve(path: string): string;
  /** Asset files under `roots`, whose paths are already absolute. */
  locator(roots: RootMap): FileLocator;
  /** `app.db` (file-management-plan.md §3.1): recent files and asset
   *  roots, shared with the editor's window. */
  appStore: AppStore;
  /**
   * What tells this machine from another, the same every time it is
   * asked (`sessionId.ts` salts session ids with it). Empty where the
   * machine will not say.
   */
  machineId(): Promise<string>;
  /** A config file's text (`--config`). */
  readText(path: string): Promise<string>;
  /** Something worth a line in the client's server log. */
  log(message: string): void;
}
