// SPDX-License-Identifier: Apache-2.0
/**
 * nodePlatform.ts — the MCP server's platform (platform.ts) on Node's
 * files, for the tests. The host is whatever the caller connects to; the
 * tests give it a host core in the same process, as the desktop window
 * does.
 */

import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { resolve } from "node:path";
import type { AppStore } from "@minimalhumans/scf-host";
import { makeNodeLocator } from "./nodeLocator.ts";
import type { McpPlatform } from "./platform.ts";

export interface NodePlatformOptions {
  connect: McpPlatform["connect"];
  appStore: AppStore;
}

export function makeNodePlatform(options: NodePlatformOptions): McpPlatform {
  return {
    connect: options.connect,
    resolve: (path) => resolve(path),
    locator: makeNodeLocator,
    appStore: options.appStore,
    machineId: () => Promise.resolve(hostname()),
    readText: (path) => readFile(path, "utf8"),
    log: (message) => { process.stderr.write(`${message}\n`); },
  };
}
