// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Build identity, injected at build time.
 *
 * "Which build am I looking at" is the first question anyone asks about
 * a bug report, and until now the app could not answer it. The version
 * comes from package.json; the commit is best-effort, because a build
 * from a tarball has no git and that is not a reason to fail.
 */
const pkg = JSON.parse(
  readFileSync(resolve(here, "package.json"), "utf8")) as {
    version: string;
  };

function gitCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: here, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

// scf-core is consumed as TypeScript source via alias — no build step for
// the core package until it publishes (design decision 6).
export default defineConfig({
  plugins: [react()],
  server: {
    // Cargo's build output is no page's business, and a file it is still
    // writing stops the watcher (EBUSY on Windows) and with it the server.
    watch: { ignored: ["**/src-tauri/**"] },
    // The page loads its sibling packages as source (the aliases below);
    // Vite serves nothing outside this one unless told it may. `docs` is
    // the editor's manual, which scf-mcp bundles for `editor_help`.
    fs: {
      allow: [here, ...["scf-core", "scf-host", "scf-mcp", "docs"]
        .map((p) => resolve(here, "..", p))],
    },
  },
  resolve: {
    // scf-mcp's own copies would be found from its files; one of each.
    dedupe: ["@modelcontextprotocol/sdk", "zod"],
    alias: [
      { find: "@scf-core", replacement: resolve(here, "../scf-core/src") },
      { find: "@registry", replacement: resolve(here, "../scf-core/registry") },
      // The host's client is browser-safe and consumed as source, like
      // scf-core. Its type-only imports of scf-core resolve to the same
      // source. Exact match: `@minimalhumans/scf-core/node` and
      // `/registry.json` are other entries and must keep resolving.
      { find: "@scf-host", replacement: resolve(here, "../scf-host/src") },
      { find: /^@minimalhumans\/scf-core$/,
        replacement: resolve(here, "../scf-core/src/index.ts") },
      // Node's SQLite, which only the tests reach: they run the window's
      // host core on Node (scf-host `nodePlatform.ts`). From source too,
      // or a checkout that never built scf-core cannot run them.
      { find: /^@minimalhumans\/scf-core\/node$/,
        replacement: resolve(here, "../scf-core/src/node.ts") },
      // The MCP's tools, which the desktop window serves (src/mcp). They
      // import the host's client by package name; it must be the same
      // module as the window's, or its errors are not its errors.
      { find: "@scf-mcp", replacement: resolve(here, "../scf-mcp/src") },
      { find: /^@minimalhumans\/scf-host\/client$/,
        replacement: resolve(here, "../scf-host/src/client.ts") },
    ],
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_COMMIT__: JSON.stringify(gitCommit()),
    __APP_BUILT__: JSON.stringify(new Date().toISOString().slice(0, 10)),
  },
});
