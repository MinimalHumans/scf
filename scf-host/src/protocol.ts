// SPDX-License-Identifier: Apache-2.0
/**
 * protocol.ts — what a client and the host say to each other.
 *
 * Plain data only, and no imports from Node, so the window and the MCP
 * can depend on it. The host core (`core.ts`) answers these requests
 * without knowing how they arrived.
 */

export const PROTOCOL_VERSION = 1;

export type ErrorCode =
  | "bad_request"      // malformed request or arguments
  | "unknown_method"
  | "unknown_op"
  | "no_film"          // a call that needs an open file, before `open`
  | "not_found"        // the path does not exist
  | "not_scf"          // the file is not a .scf
  | "bad_query"        // `query` was not a single read statement
  | "read_only"        // the connection opened the film read-only
  | "integrity_gate"   // the write would have added integrity findings
  | "outside_roots"    // a path the host may not list or create under
  | "exists"           // create/saveAs would overwrite a file
  | "stale_revision"   // the caller's view of the file is out of date
  | "external_change"  // the file changed on disk under the host
  | "failed";          // the operation itself failed

export interface HostError {
  code: ErrorCode;
  message: string;
  /**
   * The thrown error's class name and own JSON-safe fields, so a client
   * can tell a `SharedSetError` from any other failure and read what it
   * carried. Present only for `failed`.
   */
  name?: string;
  data?: Record<string, unknown>;
}

/** One write, as the host recorded it. */
export interface JournalEntry {
  at: string;
  /** The film's revision after the write. */
  revision: number;
  /** The client's own name, e.g. "window" or "mcp: Claude Desktop". */
  by: string;
  via: "op" | "call";
  name: string;
  /** The arguments, cut short. Enough to read, not to replay. */
  args: string;
  ok: boolean;
  /** For a failed write, why. */
  error?: string;
}

/** An integrity finding a write would add (scf-core's `GateFinding`). */
export interface GateFindingInfo {
  kind: string;
  key: string;
  description: string;
}

/** A question a write would raise without being refused (`GateNote`). */
export interface GateNoteInfo {
  kind: string;
  key: string;
  description: string;
}

export interface HostRequest {
  id: number;
  method: string;
  params?: unknown;
}

export type HostResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: HostError };

/** Pushed to every client attached to a film. */
export type HostEvent =
  | { event: "revision"; path: string; revision: number; by: string }
  | { event: "reload"; path: string; revision: number };

export type SqlJson = string | number | null | { $b64: string };
export type JsonRow = Record<string, SqlJson>;

export interface OpInfo {
  name: string;
  summary: string;
  destructive: boolean;
  /** JSON Schema of the op's arguments. */
  args: Record<string, unknown>;
}

export interface FilmInfo {
  path: string;
  revision: number;
  clients: number;
}

/** Method name → [params, result]. The client library types its calls from this. */
export interface HostMethods {
  hello: [{ client: string; protocol?: number },
          { protocol: number; version: string }];
  open: [{ path: string; readOnly?: boolean; migrate?: boolean;
           /** Stamped into the file when migrating. */
           editorVersion?: string },
         { path: string; revision: number; readOnly: boolean }];
  /**
   * Make a new `.scf` and open it. With `bytes` (base64) the file is
   * those bytes, checked to be an SCF; without, it is an empty film.
   * Never overwrites, and confined to the host's roots when any are
   * configured (the desktop app has none by default).
   */
  create: [{ path: string; bytes?: string; editorVersion?: string },
           { path: string; revision: number; readOnly: boolean }];
  /**
   * Copy the open film to a new path and move this connection there.
   * The old file is left as it was. Never overwrites; same root
   * confinement as `create`.
   */
  saveAs: [{ path: string },
           { path: string; revision: number; readOnly: boolean }];
  close: [Record<string, never>, null];
  /** Re-read the file after an `external_change`. Revisions keep rising. */
  reload: [Record<string, never>, { revision: number }];
  query: [{ sql: string; params?: (string | number | null)[] },
          JsonRow[]];
  ops: [Record<string, never>, OpInfo[]];
  op: [{ name: string; args?: unknown; expectedRevision?: number;
         /** Refuse a write that adds an integrity finding (default on
          *  for `op`; pass false to opt out). */
         integrityGate?: boolean;
         /** Report what the write would do, and roll it back. Nothing
          *  changes: no snapshot, no journal entry, no new revision. */
         dryRun?: boolean },
       { result: unknown; revision: number;
         /** Set on the first write that took a snapshot of the file. */
         snapshot?: string;
         /** For a dry run: the blocking findings the write would add,
          *  and the questions it would raise (`noted`). */
         dryRun?: { added: GateFindingInfo[]; noted?: GateNoteInfo[] } }];
  /** Ask the host to exit. Refused while any other client is connected. */
  shutdown: [Record<string, never>, null];
  /** Recent writes to the open film, newest last, with who made them. */
  journal: [{ limit?: number }, { entries: JournalEntry[] }];
  /** A function from the window's call table (`scf-core` ops/calls.ts). */
  call: [{ name: string; args?: unknown[]; expectedRevision?: number },
         { result: unknown; revision: number }];
  status: [Record<string, never>, { films: FilmInfo[]; current: string | null }];
}

export type MethodName = keyof HostMethods;
