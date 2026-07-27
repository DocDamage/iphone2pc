$ErrorActionPreference = "Stop"

$appleDevices = Get-StartApps | Where-Object {
  $_.Name -eq "Apple Devices" -or $_.AppID -match "AppleInc\.AppleDevices"
} | Select-Object -First 1

if ($null -ne $appleDevices) {
  Start-Process "explorer.exe" -ArgumentList "shell:AppsFolder\$($appleDevices.AppID)"
  "Apple Devices opened. Select your iPhone, then Files, then PocketDock."
  exit 0
}

Start-Process "ms-windows-store://search/?query=Apple%20Devices"
"Apple Devices is not installed. Microsoft Store search opened."
