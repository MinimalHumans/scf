// SPDX-License-Identifier: Apache-2.0
/**
 * externalLinks.ts — links out of the app open in the system browser.
 *
 * The desktop webview does nothing with a `target="_blank"` link or a
 * `window.open`, and following an http(s) link in place would replace
 * the editor. So every such link is handed to the OS instead, wherever
 * it is written.
 */

import { openUrl } from "@tauri-apps/plugin-opener";

const EXTERNAL = new Set(["http:", "https:", "mailto:"]);

function externalUrl(href: string): string | null {
  try {
    const url = new URL(href, window.location.href);
    if (!EXTERNAL.has(url.protocol)) return null;
    if (url.origin === window.location.origin) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Open an http(s) address in the system browser. */
export function openExternal(url: string): void {
  open(url);
}

function open(url: string): void {
  void openUrl(url).catch((e: unknown) => {
    console.error("Could not open link", url, e);
  });
}

export function routeExternalLinks(): void {
  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest("a[href]");
    if (anchor === null) return;
    const url = externalUrl(anchor.getAttribute("href") ?? "");
    if (url === null) return;
    event.preventDefault();
    open(url);
  });

  window.open = (url) => {
    const external = url === undefined ? null : externalUrl(String(url));
    if (external !== null) open(external);
    return null;
  };
}
