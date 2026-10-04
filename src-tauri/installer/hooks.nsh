; Sheer NSIS hooks (ADR-053 section 5). Tauri includes this file through bundle.windows.nsis.installerHooks.
;
; .pdf registration WITHOUT taking over the default: Sheer appears in "Open with" and in Settings > Default apps, and
; the user's current default is never changed. Nothing here writes the (Default) value of Software\Classes\.pdf.
; Everything is under HKCU (the installer is per-user, no admin). PREUNINSTALL removes exactly what POSTINSTALL wrote.

!define SHEER_PROGID "Sheer.Document.pdf"
!define SHEER_APPKEY "Software\Sheer\Capabilities"

!macro NSIS_HOOK_POSTINSTALL
  ; The ProgID: how to open a file and which icon to show for it.
  WriteRegStr HKCU "Software\Classes\${SHEER_PROGID}" "" "PDF document"
  WriteRegStr HKCU "Software\Classes\${SHEER_PROGID}\DefaultIcon" "" "$INSTDIR\${MAINBINARYNAME}.exe,0"
  WriteRegStr HKCU "Software\Classes\${SHEER_PROGID}\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
  ; Offer it for .pdf (an empty value named after the ProgID is the "Open with" list entry).
  WriteRegStr HKCU "Software\Classes\.pdf\OpenWithProgids" "${SHEER_PROGID}" ""
  ; Capabilities, so Settings > Default apps lists Sheer and can make it the default on the user's request.
  WriteRegStr HKCU "${SHEER_APPKEY}" "ApplicationName" "${PRODUCTNAME}"
  WriteRegStr HKCU "${SHEER_APPKEY}" "ApplicationDescription" "${PRODUCTNAME}"
  WriteRegStr HKCU "${SHEER_APPKEY}\FileAssociations" ".pdf" "${SHEER_PROGID}"
  WriteRegStr HKCU "Software\RegisteredApplications" "Sheer" "${SHEER_APPKEY}"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DeleteRegValue HKCU "Software\Classes\.pdf\OpenWithProgids" "${SHEER_PROGID}"
  DeleteRegKey HKCU "Software\Classes\${SHEER_PROGID}"
  DeleteRegValue HKCU "Software\RegisteredApplications" "Sheer"
  DeleteRegKey HKCU "Software\Sheer\Capabilities"
  DeleteRegKey /ifempty HKCU "Software\Sheer"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
