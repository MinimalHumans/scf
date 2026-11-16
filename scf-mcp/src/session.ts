// SPDX-License-Identifier: Apache-2.0
/**
 * session.ts — what every tool that works on a film says about sessions:
 * the `session_id` it takes, and the one error it gives when that id is
 * no use.
 *
 * `open` gives a film a session id. Every other film tool is told which
 * film it means by that id and by nothing else, because one server can
 * be serving several conversations at once (Claude Desktop starts one
 * for all of them) and "the film opened last" is then somebody else's.
 */

import { z } from "zod";

/**
 * A film tool's `session_id` argument. Advertised as a required string;
 * anything else, or nothing, arrives as "" so that it is refused as
 * `invalid_session` like any other id that names no session, not as a
 * schema error with no way forward in it.
 */
export const SESSION_ID = z.preprocess(
  (v) => (typeof v === "string" ? v : ""), z.string()).describe(
  "The `session_id` that `open` returned for the film.");

/** A film tool's description, with what it needs from `open`. */
export const forSession = (description: string): string =>
  `${description}\n\nTakes the \`session_id\` that \`open\` returned for ` +
  "the film. An `invalid_session` error means call `open` again.";

export interface OpenSession {
  session_id: string;
  path: string;
}

/** The body of an `invalid_session` tool error. */
export interface InvalidSession {
  code: "invalid_session";
  message: string;
  /** The id as given, or null when none (or nothing like one) was. */
  rejected_session_id: string | null;
  /** The sessions this server does have. */
  open_sessions: OpenSession[];
  /** Paths as `recent_files` lists them, most recently opened first. */
  recent_files: string[];
}

/**
 * The session a tool was called with is missing, malformed, unknown, or
 * its film is no longer there. `toolResult.ts` puts `payload` on the wire.
 */
export class InvalidSessionError extends Error {
  readonly payload: InvalidSession;

  constructor(rejected: string | null, openSessions: OpenSession[],
              recentFiles: string[]) {
    super(
      `Session '${rejected ?? ""}' is invalid or unavailable. Call ` +
      "`open` to continue. Reuse a session from `open_sessions`, or call " +
      "`open` with a file path.");
    this.name = "InvalidSessionError";
    this.payload = {
      code: "invalid_session", message: this.message,
      rejected_session_id: rejected, open_sessions: openSessions,
      recent_files: recentFiles,
    };
  }
}
