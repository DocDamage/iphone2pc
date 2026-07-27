!macro customInstall
  WriteRegStr HKCU "Software\Classes\*\shell\PocketDock" "" "Send to iPhone with PocketDock"
  WriteRegStr HKCU "Software\Classes\*\shell\PocketDock" "Icon" "$INSTDIR\PocketDock.exe"
  WriteRegStr HKCU "Software\Classes\*\shell\PocketDock\command" "" '"$INSTDIR\PocketDock.exe" --share "%1"'
  WriteRegStr HKCU "Software\Classes\Directory\shell\PocketDock" "" "Send to iPhone with PocketDock"
  WriteRegStr HKCU "Software\Classes\Directory\shell\PocketDock" "Icon" "$INSTDIR\PocketDock.exe"
  WriteRegStr HKCU "Software\Classes\Directory\shell\PocketDock\command" "" '"$INSTDIR\PocketDock.exe" --share "%1"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="PocketDock Private Transfer"'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="PocketDock Private Transfer" dir=in action=allow profile=private protocol=TCP program="$INSTDIR\PocketDock.exe"'
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\*\shell\PocketDock"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\PocketDock"
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="PocketDock Private Transfer"'
!macroend
