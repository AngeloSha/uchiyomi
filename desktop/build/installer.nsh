; Uchiyomi Desktop: included by electron-builder's NSIS templates (build/installer.nsh is picked up by name).
;
; ⚠️ Uchiyomi.exe is not the only process running from the install folder: it starts PostgreSQL
; (resources\pg\bin\postgres.exe, six processes) and, once installed, the extension engine's java.exe. The stock
; "app is running" check stops Uchiyomi.exe and nothing else, so an install or uninstall over a running app left
; postgres.exe holding files -- and still exited 0 (spike S5). So before the stock check, ask the running app for
; its ordered shutdown (the bff finishes its chapter, the engine closes its database, postgres stops cleanly):
; `Uchiyomi.exe --quit-for-update` returns once that instance has exited, or at once when none is running.
; The in-app updater already does this itself before it starts the installer; this covers a Setup.exe the user
; downloaded and ran by hand, and Uninstall.

; The stock macro's helpers, which it only includes when no customCheckAppRunning is defined.
!include "getProcessInfo.nsh"
Var pid

!macro customCheckAppRunning
  ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    DetailPrint "Stopping Uchiyomi..."
    nsExec::Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --quit-for-update'
    Pop $0
  ${EndIf}
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro _CHECK_APP_RUNNING
!macroend
