// SPDX-License-Identifier: Apache-2.0
// A Markdown file's text, as Vite (the window's build, and vitest)
// imports it with `?raw`. editorManual.ts bundles the manual this way.
declare module "*.md?raw" {
  const text: string;
  export default text;
}
