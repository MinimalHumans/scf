// SPDX-License-Identifier: Apache-2.0
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./ui/App.tsx";
import { useStore } from "./state/store.ts";

// Last-resort surfacing: nothing may fail silently. Any uncaught error
// or unhandled rejection becomes a visible toast (and stays in the
// console with its stack).
// Deferred: these can fire while React is mid-render (dev mode rethrows
// through the DOM), and a synchronous setState there is itself an error.
window.addEventListener("error", (event) => {
  const message = event.message;
  queueMicrotask(() => {
    useStore.setState({ errorMessage: `Unexpected error: ${message}` });
  });
});
window.addEventListener("unhandledrejection", (event) => {
  const reason: unknown = event.reason;
  const message = reason instanceof Error ? reason.message : String(reason);
  queueMicrotask(() => {
    useStore.setState({ errorMessage: `Unhandled failure: ${message}` });
  });
});
import "./styles.css";

// In the desktop app the window also serves agents' MCP pipes.
if ("__TAURI_INTERNALS__" in window) {
  void import("./mcp/windowMcp.ts").then((m) => m.serveMcp());
  void import("./host/externalLinks.ts").then((m) => m.routeExternalLinks());
  void import("./files/launchOpen.ts").then((m) => m.routeLaunchFile());
}

const rootEl = document.getElementById("root");
if (rootEl !== null) {
  createRoot(rootEl).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
