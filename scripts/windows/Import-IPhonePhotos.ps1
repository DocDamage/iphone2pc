param(
  [Parameter(Mandatory = $true)]
  [string]$Destination,
  [Parameter(Mandatory = $true)]
  [string]$DeviceId
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "IPhoneShellHelpers.ps1")
$shell = New-Object -ComObject Shell.Application
$thisPc = $shell.Namespace(17)
if ($null -eq $thisPc) {
  throw "Windows could not open This PC. Restart Windows Explorer and try again."
}

$preferredName = if ($DeviceId.StartsWith("shell:", [System.StringComparison]::OrdinalIgnoreCase)) {
  $DeviceId.Substring(6)
} else {
  ""
}
$appleDriverDetected = $false
try {
  $appleDriverDetected = @(Get-PnpDevice -PresentOnly -ErrorAction Stop | Where-Object {
    (
      $_.FriendlyName -match "iPhone|iPad|Apple Mobile Device" -or
      $_.InstanceId -match "VID_05AC"
    ) -and (
      $_.Class -match "PortableDevice|WPD|USB" -or
      $_.FriendlyName -match "iPhone|iPad|Apple Mobile Device"
    )
  }).Count -gt 0
} catch {
  $appleDriverDetected = $false
}

$candidates = @()
foreach ($rootItem in @($thisPc.Items())) {
  $manufacturer = ""
  try {
    $manufacturer = [string]$rootItem.ExtendedProperty("System.Devices.Manufacturer")
  } catch {
    $manufacturer = ""
  }
  $manufacturerLooksApple = $manufacturer -match "Apple"
  $shellPath = ""
  try {
    $shellPath = [string]$rootItem.Path
  } catch {
    $shellPath = ""
  }
  $pathLooksApple = $shellPath -match "VID_05AC"
  if (
    $rootItem.Name -notmatch "iPhone|iPad|Apple" -and
    -not $manufacturerLooksApple -and
    -not $pathLooksApple
  ) {
    continue
  }
  $storage = $null
  $mediaLayout = $null
  try {
    $storage = Find-PocketDockStorageItem -RootItem $rootItem
    if ($null -ne $storage) {
      $mediaLayout = Resolve-PocketDockMediaLayout -StorageItem $storage
    }
  } catch {
    $storage = $null
    $mediaLayout = $null
  }

  $candidates += [PSCustomObject]@{
    Id = Get-PocketDockShellDeviceId -RootItem $rootItem
    Name = $rootItem.Name
    Root = $rootItem
    Storage = $storage
    MediaLayout = $mediaLayout
  }
}

$device = $candidates | Where-Object {
  $_.Id -ceq $DeviceId
} | Select-Object -First 1
if ($null -eq $device -and $preferredName) {
  $device = $candidates | Where-Object {
    $_.Name -eq $preferredName
  } | Select-Object -First 1
}
if ($null -eq $device -and -not $preferredName) {
  $device = $candidates | Where-Object {
    $null -ne $_.MediaLayout -and $_.MediaLayout.Ready
  } | Select-Object -First 1
}
if ($null -eq $device) {
  throw "The Apple driver sees the cable, but PocketDock cannot open the iPhone in Windows Shell. Unlock the iPhone, tap Trust, open Internal Storage in File Explorer once, then retry."
}
if ($null -eq $device.Storage) {
  throw "The iPhone storage is locked. Unlock the phone, tap Trust, keep its screen on, and retry."
}
if ($null -eq $device.MediaLayout -or -not $device.MediaLayout.Ready) {
  throw "Internal Storage is visible, but Windows did not expose a supported Camera Roll media layout. Confirm the Camera Roll contains local photos or videos, then reconnect."
}

New-Item -ItemType Directory -Path $Destination -Force | Out-Null
$imported = 0
$skipped = 0
$failed = 0
$copiedBytes = [int64]0
$failures = @()

function Get-SafePortableName {
  param([Parameter(Mandatory = $true)][string]$Name)
  $safe = [regex]::Replace($Name, '[<>:"/\\|?*]', "_").Trim().TrimEnd([char]".")
  if ([string]::IsNullOrWhiteSpace($safe)) {
    return "Unnamed"
  }
  return $safe
}

function Copy-PortableFolder {
  param(
    [Parameter(Mandatory = $true)]$PortableFolder,
    [Parameter(Mandatory = $true)][string]$TargetDirectory
  )

  New-Item -ItemType Directory -Path $TargetDirectory -Force | Out-Null
  $targetShellFolder = $shell.Namespace($TargetDirectory)
  if ($null -eq $targetShellFolder) {
    throw "Windows Shell could not open the destination '$TargetDirectory'."
  }

  foreach ($item in @($PortableFolder.Items())) {
    $safeName = Get-SafePortableName -Name $item.Name
    if ($item.IsFolder) {
      Copy-PortableFolder `
        -PortableFolder $item.GetFolder `
        -TargetDirectory (Join-Path $TargetDirectory $safeName)
      continue
    }

    $targetPath = Join-Path $TargetDirectory $safeName
    if (Test-Path -LiteralPath $targetPath -PathType Leaf) {
      $script:skipped++
      continue
    }

    try {
      # FOF_SILENT | FOF_NOCONFIRMATION | FOF_NOERRORUI.
      $targetShellFolder.CopyHere($item, 1044)
      $deadline = (Get-Date).AddMinutes(30)
      $lastLength = -1
      $stableChecks = 0
      while ((Get-Date) -lt $deadline) {
        if (Test-Path -LiteralPath $targetPath -PathType Leaf) {
          $length = (Get-Item -LiteralPath $targetPath).Length
          if ($length -gt 0 -and $length -eq $lastLength) {
            $stableChecks++
          } else {
            $stableChecks = 0
          }
          $lastLength = $length
          if ($stableChecks -ge 4) {
            break
          }
        }
        Start-Sleep -Milliseconds 500
      }

      if ((Test-Path -LiteralPath $targetPath -PathType Leaf) -and
          (Get-Item -LiteralPath $targetPath).Length -gt 0) {
        $script:imported++
        $script:copiedBytes += (Get-Item -LiteralPath $targetPath).Length
      } else {
        throw "Windows did not finish the copy within 30 minutes."
      }
    } catch {
      $script:failed++
      if ($script:failures.Count -lt 50) {
        $script:failures += "$($item.Name): $($_.Exception.Message)"
      }
      Remove-Item -LiteralPath $targetPath -Force -ErrorAction SilentlyContinue
    }
  }
}

if ($device.MediaLayout.Kind -eq "classic-dcim") {
  Copy-PortableFolder `
    -PortableFolder $device.MediaLayout.RootItem.GetFolder `
    -TargetDirectory $Destination
} else {
  foreach ($bucket in @($device.MediaLayout.BucketItems)) {
    $safeBucketName = Get-SafePortableName -Name $bucket.Name
    Copy-PortableFolder `
      -PortableFolder $bucket.GetFolder `
      -TargetDirectory (Join-Path $Destination $safeBucketName)
  }
}
[PSCustomObject]@{
  imported = $imported
  skipped = $skipped
  failed = $failed
  bytes = $copiedBytes
  failures = @($failures)
} | ConvertTo-Json -Compress -Depth 4
