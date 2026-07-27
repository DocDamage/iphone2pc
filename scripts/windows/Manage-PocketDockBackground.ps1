param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Install", "Uninstall")]
  [string]$Action,

  [Parameter(Mandatory = $true)]
  [string]$ExecutablePath
)

$ErrorActionPreference = "Stop"
$taskName = "PocketDock Background Service"

if ($Action -eq "Uninstall") {
  schtasks.exe /Delete /TN $taskName /F | Out-Null
  exit 0
}

if (-not (Test-Path -LiteralPath $ExecutablePath)) {
  throw "PocketDock executable was not found."
}

$quotedExecutable = '"' + $ExecutablePath.Replace('"', '""') + '"'
$taskCommand = "$quotedExecutable --background-service"
schtasks.exe /Create /TN $taskName /SC ONLOGON /RL LIMITED /TR $taskCommand /F | Out-Null
schtasks.exe /Run /TN $taskName | Out-Null
