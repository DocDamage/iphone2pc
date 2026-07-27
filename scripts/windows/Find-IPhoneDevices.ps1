$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "IPhoneShellHelpers.ps1")
$devices = @()
$applePnpDevices = @()

try {
  $applePnpDevices = @(Get-PnpDevice -PresentOnly -ErrorAction Stop | Where-Object {
    (
      $_.FriendlyName -match "iPhone|iPad|Apple Mobile Device" -or
      $_.InstanceId -match "VID_05AC"
    ) -and (
      $_.Class -match "PortableDevice|WPD|USB" -or
      $_.FriendlyName -match "iPhone|iPad|Apple Mobile Device"
    )
  })
} catch {
  $applePnpDevices = @()
}

$driverDetected = $applePnpDevices.Count -gt 0
try {
  $shell = New-Object -ComObject Shell.Application
  $thisPc = $shell.Namespace(17)
  if ($null -ne $thisPc) {
    foreach ($item in @($thisPc.Items())) {
      $nameLooksApple = $item.Name -match "iPhone|iPad|Apple"
      $manufacturer = ""
      try {
        $manufacturer = [string]$item.ExtendedProperty("System.Devices.Manufacturer")
      } catch {
        $manufacturer = ""
      }
      $manufacturerLooksApple = $manufacturer -match "Apple"
      $shellPath = ""
      try {
        $shellPath = [string]$item.Path
      } catch {
        $shellPath = ""
      }
      $pathLooksApple = $shellPath -match "VID_05AC"
      if (-not $nameLooksApple -and -not $manufacturerLooksApple -and -not $pathLooksApple) {
        continue
      }
      $storage = $null
      $mediaLayout = $null
      $shellReadable = $false

      try {
        @($item.GetFolder.Items()) | Out-Null
        $shellReadable = $true
        $storage = Find-PocketDockStorageItem -RootItem $item
        if ($null -ne $storage) {
          $mediaLayout = Resolve-PocketDockMediaLayout -StorageItem $storage
        }
      } catch {
        $shellReadable = $false
      }

      $code = "trust-required"
      $status = "Unavailable"
      $description = "Windows sees the iPhone, but its portable storage is locked."
      $action = "Unlock the iPhone, tap Trust, keep its screen on, then scan again."

      if ($null -ne $storage -and $null -ne $mediaLayout -and $mediaLayout.Ready) {
        $code = "dcim-ready"
        $status = "Ready"
        $description = if ($mediaLayout.Kind -eq "flat-dcf-empty") {
          "Windows Shell can access the Camera Roll; it currently has no exposed media folders."
        } elseif ($mediaLayout.Kind -eq "classic-dcim") {
          "Windows Shell can read Internal Storage and the Camera Roll (DCIM)."
        } else {
          "Windows Shell can read the iPhone Camera Roll media folders."
        }
        $action = "Camera Roll import is ready. Keep the iPhone unlocked until copying finishes."
      } elseif ($null -ne $storage) {
        $code = "dcim-missing"
        $description = "Internal Storage is visible, but Windows did not expose a supported Camera Roll media layout."
        $action = "Unlock the iPhone, confirm Camera Roll contains local media, reconnect, and scan again."
      } elseif (-not $shellReadable) {
        $description = "The iPhone appears in This PC, but Windows could not open its portable-device folder."
      }

      $devices += [PSCustomObject]@{
        InstanceId = Get-PocketDockShellDeviceId -RootItem $item
        FriendlyName = $item.Name
        Status = $status
        Description = $description
        DiagnosticCode = $code
        DriverDetected = $true
        ShellDetected = $true
        StorageDetected = $null -ne $storage
        DcimDetected = $null -ne $mediaLayout -and $mediaLayout.Ready
        RecommendedAction = $action
      }
    }
  }
} catch {
  # PnP capability reporting below remains available if Shell COM fails.
}

if ($devices.Count -eq 0 -and $driverDetected) {
  $preferred = $applePnpDevices | Where-Object {
    $_.FriendlyName -match "iPhone|iPad"
  } | Select-Object -First 1
  if ($null -eq $preferred) {
    $preferred = $applePnpDevices | Select-Object -First 1
  }
  $driverHealthy = $null -eq $preferred.Status -or $preferred.Status -eq "OK"
  $friendlyName = if ($preferred.FriendlyName) {
    $preferred.FriendlyName
  } else {
    "Apple iPhone"
  }
  $devices += [PSCustomObject]@{
    InstanceId = "pnp:$($preferred.InstanceId)"
    FriendlyName = $friendlyName
    Status = "Unavailable"
    Description = if ($driverHealthy) {
      "The Apple USB driver sees the cable, but Windows Shell cannot access iPhone storage."
    } else {
      "Windows reports a problem with the Apple USB device driver."
    }
    DiagnosticCode = if ($driverHealthy) { "driver-only" } else { "driver-error" }
    DriverDetected = $true
    ShellDetected = $false
    StorageDetected = $false
    DcimDetected = $false
    RecommendedAction = if ($driverHealthy) {
      "Unlock the iPhone, tap Trust, keep its screen on, open it once in File Explorer, then scan again."
    } else {
      "Repair or reinstall Apple Devices for Windows, reconnect the cable, and scan again."
    }
  }
}

@($devices) | ConvertTo-Json -Compress
