; SPDX-License-Identifier: Apache-2.0
; NSIS hooks for SCF Editor (referenced by tauri.conf.json).
;
; Windows ships with `.scf` mapped to `SHCmdFile` ("File Explorer Command")
; under HKLM\Software\Classes, and `SHCmdFile` carries `NeverShowExt`, which
; hides the `.scf` extension in File Explorer even when the user has enabled
; "File name extensions".
;
; Associating `.scf` with `SCFEditor.scf` under SHCTX (HKCU\Software\Classes
; for a per-user install) overrides HKLM\Software\Classes\.scf in
; HKEY_CLASSES_ROOT with a ProgID that has neither `NeverShowExt` nor
; `AlwaysShowExt`, so `.scf` follows the user's Explorer preference.

!macro NSIS_HOOK_POSTINSTALL
  ; Quote the executable path in the shell command and icon registration
  ; (Tauri's default APP_ASSOCIATE macro leaves $INSTDIR unquoted, which
  ; contains a space in "SCF Editor").
  WriteRegStr SHCTX "Software\Classes\SCFEditor.scf\DefaultIcon" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
  WriteRegStr SHCTX "Software\Classes\SCFEditor.scf\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""

  ; Notify Explorer so open windows immediately refresh .scf extension visibility.
  !insertmacro UPDATEFILEASSOC
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Tauri's APP_UNASSOCIATE writes an empty default value when there was no
  ; prior per-user association; remove the leftover backup value and key so
  ; HKCU\Software\Classes\.scf does not shadow HKLM after uninstall.
  ReadRegStr $R0 SHCTX "Software\Classes\.scf" ""
  ${If} $R0 == ""
  ${OrIf} $R0 == "SCFEditor.scf"
    DeleteRegValue SHCTX "Software\Classes\.scf" "SCFEditor.scf_backup"
    DeleteRegValue SHCTX "Software\Classes\.scf" ""
    DeleteRegKey /ifempty SHCTX "Software\Classes\.scf"
  ${EndIf}

  !insertmacro UPDATEFILEASSOC
!macroend
