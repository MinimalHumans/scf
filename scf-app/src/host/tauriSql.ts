// SPDX-License-Identifier: Apache-2.0
/**
 * tauriSql.ts — scf-core's SQLite seam in the desktop app, without a
 * host process.
 *
 * The shell opens the `.scf` itself (`src-tauri/src/sql.rs`) and runs
 * each statement it is handed, so scf-core runs here, in the window,
 * against the file on disk: every commit is durable as it is in the
 * Node driver (`scf-core/src/node.ts`), which this mirrors.
 *
 * Values cross as the host protocol spells them (`SqlJson`): a blob is
 * `{ $b64 }` both ways.
 *
 * Statements go over the shell's loopback socket (`sql_socket.rs`),
 * not `invoke`, which on Windows costs about a millisecond a statement —
 * seconds, for an import that awaits a few thousand of them one by
 * one.
 */

import { invoke } from "@tauri-apps/api/core";
import type { Row, SqlExec, SqlValue } from "@scf-core/db.ts";
import type { Registry } from "@scf-core/registry.ts";
import { createSession, type Session } from "@scf-core/session.ts";
import { fromBase64, toBase64 } from "@scf-host/platform.ts";

type SqlJson = string | number | null | { $b64: string };

interface Rows {
  columns: string[];
  rows: SqlJson[][];
}

function encode(v: SqlValue): SqlJson {
  if (v instanceof Uint8Array) return { $b64: toBase64(v) };
  if (typeof v === "boolean") return v ? 1 : 0;
  return v;
}

function decode(v: SqlJson): SqlValue {
  return v !== null && typeof v === "object" ? fromBase64(v.$b64) : v;
}

type Run = (db: number, sql: string, params: SqlJson[]) => Promise<Rows>;

interface Reply extends Partial<Rows> {
  id: number;
  error?: string;
}

/** One socket for the window, opened on first use. */
let socket: Promise<Run> | null = null;

function viaSocket(): Promise<Run> {
  socket ??= (async () => {
    const where = await invoke<{ url: string; token: string }>("sql_socket");
    const ws = new WebSocket(
      `${where.url}?token=${encodeURIComponent(where.token)}`);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => { resolve(); };
      ws.onerror = () => { reject(new Error("no SQL socket")); };
    });
    const waiting = new Map<number, {
      resolve: (rows: Rows) => void; reject: (e: Error) => void;
    }>();
    let next = 0;
    ws.onmessage = (e: MessageEvent<string>) => {
      const reply = JSON.parse(e.data) as Reply;
      const w = waiting.get(reply.id);
      if (w === undefined) return;
      waiting.delete(reply.id);
      if (reply.error !== undefined) w.reject(new Error(reply.error));
      else w.resolve({ columns: reply.columns!, rows: reply.rows! });
    };
    ws.onclose = () => {
      socket = null;
      for (const w of waiting.values()) w.reject(new Error("SQL socket closed"));
      waiting.clear();
    };
    return (db, sql, params) => new Promise<Rows>((resolve, reject) => {
      next += 1;
      waiting.set(next, { resolve, reject });
      ws.send(JSON.stringify({ id: next, db, sql, params }));
    });
  })();
  return socket;
}

export interface TauriDatabase {
  exec: SqlExec;
  close: () => Promise<void>;
}

/**
 * A reload leaves the last page's databases open in the shell; this
 * page closes them once, before its own first open. It has to come
 * before every open, not only the host's: `app.db` and the audit trail
 * open on their own schedule, and a reset after one of them had opened
 * closed it under the page ("no open database 1" on the start screen).
 */
let reset: Promise<void> | null = null;

function resetOnce(): Promise<void> {
  reset ??= invoke<void>("sql_reset");
  reset.catch(() => { reset = null; });
  return reset;
}

export async function openTauriDatabase(
    path: string,
    options: { readOnly?: boolean } = {}): Promise<TauriDatabase> {
  await resetOnce();
  const db = await invoke<number>("sql_open", {
    path, readOnly: options.readOnly ?? false,
  });
  const run = await viaSocket();
  const exec: SqlExec = async (sql, params = []) => {
    const out = await run(db, sql, params.map(encode));
    return out.rows.map((values) => {
      const row: Row = {};
      out.columns.forEach((name, i) => { row[name] = decode(values[i]!); });
      return row;
    });
  };
  return { exec, close: () => invoke("sql_close", { db }) };
}

/** `openNodeSession`, for the desktop app. */
export async function openTauriSession(
    path: string, registry: Registry,
    options: { readOnly?: boolean } = {}): Promise<Session> {
  const db = await openTauriDatabase(path, options);
  return createSession(registry, {
    exec: db.exec,
    persist: () => Promise.resolve(true),
    close: db.close,
    fingerprint: () => invoke<string>("file_fingerprint", { path }),
  }, { readOnly: options.readOnly ?? false });
}
