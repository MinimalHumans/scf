// SPDX-License-Identifier: Apache-2.0
/**
 * Shared harness: an MCP server as the desktop window runs one, a client
 * of a host core in the same process (here on Node's files and SQLite),
 * spoken to in raw JSON-RPC over the SDK's in-memory transport.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import {
  loadRegistry, type RegistryJson,
} from "@minimalhumans/scf-core";
import registryJson from "@minimalhumans/scf-core/registry.json" with { type: "json" };
import { createHostCore, openNodeAppStore } from "@minimalhumans/scf-host";
import { HostClient, connectInProcess } from "@minimalhumans/scf-host/client";
import { parseConfig } from "../src/config.ts";
import { createScfMcpServer } from "../src/mcpServer.ts";
import { makeNodePlatform } from "../src/nodePlatform.ts";
import type { McpPlatform } from "../src/platform.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURE = join(HERE, "..", "..", "fixtures", "hollow_creek.scf");

export interface Server {
  send: (method: string, params?: unknown) => Promise<unknown>;
  /** What the server told the client about itself at the handshake. */
  instructions: string;
  kill: () => void;
  /** The process the server runs in, to ask the OS what it holds open. */
  pid: number | undefined;
}

/**
 * The host every test server shares, with its snapshots and journal in a
 * directory of its own, as the desktop window's host shares itself among
 * the agents it serves.
 */
export const HOST_DIR = mkdtempSync(join(tmpdir(), "scf-mcp-host-"));
const core = createHostCore({
  registry: loadRegistry(registryJson as unknown as RegistryJson),
  roots: [tmpdir()],
  snapshotDir: join(HOST_DIR, "snapshots"),
  journalDir: join(HOST_DIR, "journal"),
});

/** Registered by whichever test file imports this one. */
afterAll(async () => {
  await core.shutdown();
  rmSync(HOST_DIR, { recursive: true, force: true });
});

/** How a test client answers the server asking the person something. */
export type Elicit = (message: string) =>
  { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> };

/**
 * A server with these arguments. Each gets its own config directory, so
 * its `app.db` (scf-host `nodeAppStore.ts`) never touches the real
 * user's, and tests do not leak into each other; pass `configDir` to
 * share one across two servers, e.g. to prove persistence survives a
 * restart.
 */
export async function startServer(
    args: string[], configDir: string = mkdtempSync(
      join(tmpdir(), "scf-mcp-test-")),
    elicit?: Elicit): Promise<Server> {
  const appStore = await openNodeAppStore(join(configDir, "app.db"));
  const platform: McpPlatform = makeNodePlatform({
    connect: (name) =>
      HostClient.connect(connectInProcess(core.connect()), { name }),
    appStore,
  });
  const config = await parseConfig(args, {
    readText: platform.readText, resolve: platform.resolve,
  });
  const server = await createScfMcpServer(platform, config);
  const [client, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);

  let nextId = 1;
  const pending = new Map<number, (result: unknown) => void>();
  client.onmessage = (message: JSONRPCMessage) => {
    const msg = message as
      { id?: number; result?: unknown; error?: unknown; method?: string;
        params?: { message?: string } };
    if (msg.method === "elicitation/create" && msg.id !== undefined) {
      const answer = elicit?.(msg.params?.message ?? "") ??
        { action: "decline" as const };
      void client.send({ jsonrpc: "2.0", id: msg.id, result: answer });
      return;
    }
    if (msg.id !== undefined && msg.method === undefined) {
      pending.get(msg.id)?.(
        msg.error !== undefined ? { rpcError: msg.error } : msg.result);
    }
  };
  await client.start();

  const send = (method: string, params?: unknown): Promise<unknown> => {
    const id = nextId++;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      void client.send(
        { jsonrpc: "2.0", id, method, params } as JSONRPCMessage);
    });
  };

  const hello = await send("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: elicit === undefined ? {} : { elicitation: {} },
    clientInfo: { name: "smoke", version: "0.0.1" },
  }) as { instructions?: string };
  await client.send(
    { jsonrpc: "2.0", method: "notifications/initialized" });
  return {
    send,
    instructions: hello.instructions ?? "",
    // Closes app.db's own connection too: on Windows, a caller that
    // then removes `configDir` (most do, in a `finally`) gets EPERM if
    // this is left open — unlike Linux/macOS, Windows refuses to
    // delete a file a handle is still held on.
    kill: () => { void server.close(); void appStore.close(); },
    pid: process.pid,
  };
}


export interface ToolResult {
  content: Array<{ text: string }>;
  isError?: boolean;
}

/** Call a tool and return its JSON text, or the error text. */
export async function callTool(
    server: Server, name: string, args: Record<string, unknown> = {}):
    Promise<{ isError: boolean; text: string; json: unknown }> {
  const r = await server.send("tools/call", { name, arguments: args }) as
    ToolResult;
  const text = r.content[0]?.text ?? "";
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* plain text */ }
  return { isError: r.isError === true, text, json };
}

/** Open a film, as an agent does first, and return its session id. */
export async function openFilm(
    server: Server, scfPath: string): Promise<string> {
  const r = await callTool(server, "open", { scfPath });
  if (r.isError) throw new Error(`open ${scfPath}: ${r.text}`);
  return (r.json as { session_id: string }).session_id;
}

/**
 * `server` as one conversation that has a film open sees it: every tool
 * call that works on a film carries `sessionId`, as an agent's would.
 */
export function inSession(server: Server, sessionId: string): Server {
  return {
    ...server,
    send: (method, params) => {
      const call = params as
        { name?: string; arguments?: Record<string, unknown> } | undefined;
      const named = method !== "tools/call" || call === undefined ||
        call.name === "open" || call.name === "recent_files";
      return server.send(method, named ? params : {
        ...call, arguments: { session_id: sessionId, ...call.arguments },
      });
    },
  };
}
