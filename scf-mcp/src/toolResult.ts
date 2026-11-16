// SPDX-License-Identifier: Apache-2.0
/**
 * toolResult.ts — how every tool's answer is put on the wire. One
 * definition, so no two tools can serialise differently.
 *
 * Results are COMPACT JSON: no indentation. A consumer is a program or an
 * agent, not a person reading the raw text, and indentation is about a
 * third of the bytes of a large result. `shot_context` for one shot runs
 * past what some clients accept in a single tool result when indented,
 * and is delivered whole when it is not.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { InvalidSessionError } from "./session.ts";

export function ok(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

export function text(value: string): CallToolResult {
  return { content: [{ type: "text", text: value }] };
}

/** An error as its message; `invalid_session` as its whole payload. */
export function err(e: unknown): CallToolResult {
  const message = e instanceof InvalidSessionError ? JSON.stringify(e.payload)
    : e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text", text: message }], isError: true };
}
