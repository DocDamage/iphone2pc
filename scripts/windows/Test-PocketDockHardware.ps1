param(
  [string]$BaseUrl = "",
  [string]$OutputPath = ""
)

$ErrorActionPreference = "Stop"
$checks = @()

$checks += [pscustomobject]@{
  id = "windows"
  status = if ([Environment]::OSVersion.Version.Major -ge 10) { "pass" } else { "fail" }
  detail = [Environment]::OSVersion.VersionString
}

try {
  $devicesJson = & (Join-Path $PSScriptRoot "Find-IPhoneDevices.ps1")
  $devices = @($devicesJson | ConvertFrom-Json)
  $readyDevices = @($devices | Where-Object {
    $_.DiagnosticCode -eq "dcim-ready" -and $_.DcimDetected -eq $true
  })
  $driverDevices = @($devices | Where-Object { $_.DriverDetected -eq $true })
  $checks += [pscustomobject]@{
    id = "usb-dcim"
    status = if ($readyDevices.Count -gt 0) {
      "pass"
    } elseif ($driverDevices.Count -gt 0) {
      "warning"
    } else {
      "info"
    }
    detail = if ($readyDevices.Count -gt 0) {
      "$($readyDevices.Count) iPhone Camera Roll(s) expose readable media through Windows Shell."
    } elseif ($driverDevices.Count -gt 0) {
      $devices[0].Description
    } else {
      "No Apple USB driver is currently visible."
    }
  }
  foreach ($device in $devices) {
    $checks += [pscustomobject]@{
      id = "usb-stage-$($device.DiagnosticCode)"
      status = if ($device.DcimDetected -eq $true) { "pass" } else { "warning" }
      detail = "$($device.FriendlyName): driver=$($device.DriverDetected), shell=$($device.ShellDetected), storage=$($device.StorageDetected), dcim=$($device.DcimDetected). $($device.RecommendedAction)"
    }
  }
} catch {
  $checks += [pscustomobject]@{
    id = "usb-dcim"
    status = "warning"
    detail = $_.Exception.Message
  }
}

if ($BaseUrl) {
  try {
    $status = Invoke-RestMethod -Uri "$($BaseUrl.TrimEnd('/'))/api/status" -TimeoutSec 10
    $checks += [pscustomobject]@{
      id = "lan-status"
      status = if ($status.requiresPairing) { "pass" } else { "warning" }
      detail = "PocketDock status endpoint reached: $($status.name)"
    }
  } catch {
    $checks += [pscustomobject]@{
      id = "lan-status"
      status = "fail"
      detail = $_.Exception.Message
    }
  }
}

$report = [pscustomobject]@{
  generatedAt = (Get-Date).ToUniversalTime().ToString("o")
  computer = $env:COMPUTERNAME
  checks = $checks
  note = "USB covers Windows camera-roll import. PocketDock arbitrary-file transport uses LAN or relay."
}
$json = $report | ConvertTo-Json -Depth 5
if ($OutputPath) {
  [IO.File]::WriteAllText($OutputPath, $json, [Text.UTF8Encoding]::new($false))
}
$json
