<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# SCF Editor changelog

The editor ships on its own version line, separate from the spec
(`spec/CHANGELOG.md`). Each heading matches an `editor-X.Y.Z` tag; the
desktop release workflow copies that section into the GitHub release
notes.

## 0.2.5

- **Changed:** MCP writes are much faster for batch edits, such as
  updating several shot descriptions in one call. Writes take
  field-shaped values and can be batched with row-scoped plans
  (proposals 42 and 43). A row change that would cause a conflict is
  still rejected.

## 0.2.4

Rebuild of 0.2.3 with a fix to the release workflow: the Linux build
could hang indefinitely when the runner's apt mirror was unreachable, so
0.2.3 never published. No changes to the app itself.

## 0.2.3

- **Fixed:** the app could fail to start on a fresh machine with
  "Unhandled failure: no open database 1" — the very first launch, before
  any project had been opened.
- **Fixed:** blurry asset thumbnails in the gallery and script views.
- **Removed:** deprecated buttons on the script page.
- **Added:** the dossier now shows a character's relationships
  (who, what kind, which direction), and references to a superseded
  asset now resolve to its successor instead of showing the replaced one.

## 0.2.2

Carries CLI file opening, the dedicated file-association icon, and the
Claude Desktop registration helper.
