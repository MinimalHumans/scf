# NSIS installer: silent uninstall + theming (plan)

## Silent uninstall

Tauri's NSIS output honors the standard NSIS `/S` silent switch on both the
installer and the uninstaller. Running the uninstaller via Control Panel /
Settings → Apps is always interactive; for a fully silent uninstall with
defaults, invoke the uninstaller binary directly:

```
"C:\Program Files\SCF Editor\uninstall.exe" /S
```

(path depends on per-user vs per-machine install; per-machine needs an
elevated shell). The registry `UninstallString` for the app (under
`HKLM/HKCU\...\Uninstall\<ProductName>`) points at this same exe, so `/S` can
be appended to that value when scripting an uninstall.

`installMode` is currently `"both"` (`scf-app/src-tauri/tauri.conf.json`),
which normally shows a page for current-user vs all-users. In silent mode
(`/S`) NSIS skips all pages and uses the default selection, so this shouldn't
itself force a prompt. To force a specific mode explicitly, pass
`/CURRENTUSER` or `/ALLUSERS` alongside `/S`. These two flags aren't listed on
Tauri's official NSIS docs page — they match the pattern used by other Tauri
apps' silent-install docs — so verify before relying on them in a script.

## Styling/theming the installer

`bundle.windows.nsis` in `tauri.conf.json` supports branding fields not
currently in use:

- `headerImage` — 150×57 BMP shown on installer pages
- `sidebarImage` — 164×314 BMP for the Welcome/Finish pages
- `installerIcon` / `uninstallerIcon` — custom .ico for each binary
- `uninstallerHeaderImage` — defaults to `headerImage` if unset
- `startMenuFolder` — custom Start Menu folder name
- `languages` / `displayLanguageSelector` / `customLanguageFiles` —
  multi-language support and a language-picker page

Example addition to the existing `nsis` block:

```json
"nsis": {
  "installMode": "both",
  "installerHooks": "nsis-hooks.nsh",
  "headerImage": "icons/nsis-header.bmp",
  "sidebarImage": "icons/nsis-sidebar.bmp",
  "installerIcon": "icons/installer.ico"
}
```

For anything beyond these (custom page layout, different MUI theme, extra
pages), set `template` to a custom `.nsi` file forked from Tauri's default —
full control, but then it needs to be kept in sync with Tauri's template
across upgrades. The repo already uses the lighter-weight `installerHooks`
mechanism (`nsis-hooks.nsh`) for the `.scf` file-association logic, which is
the right tool for adding behavior (vs. `template`, which changes the UI/flow
itself).

## Open follow-ups

- Add header/sidebar image fields + placeholder BMPs to `tauri.conf.json`.
- Document the silent-uninstall invocation in `docs/release-checklist.md`.
