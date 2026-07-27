$ErrorActionPreference = "Stop"

function Get-PocketDockShellDeviceId {
  param([Parameter(Mandatory = $true)]$RootItem)

  $shellPath = ""
  try {
    $shellPath = [string]$RootItem.Path
  } catch {
    $shellPath = ""
  }
  if (-not [string]::IsNullOrWhiteSpace($shellPath)) {
    $encodedPath = [Convert]::ToBase64String(
      [Text.Encoding]::UTF8.GetBytes($shellPath)
    )
    return "shell-path:$encodedPath"
  }
  return "shell:$($RootItem.Name)"
}

function Test-PocketDockFolderItem {
  param([Parameter(Mandatory = $true)]$Item)

  try {
    return [bool]$Item.IsFolder
  } catch {
    return $false
  }
}

function Get-PocketDockFolderItems {
  param([Parameter(Mandatory = $true)]$Item)

  try {
    $folder = $Item.GetFolder
    if ($null -eq $folder) {
      throw "The portable folder is unavailable."
    }
    return [PSCustomObject]@{
      Accessible = $true
      Folder = $folder
      Items = @($folder.Items())
      ErrorMessage = ""
    }
  } catch {
    return [PSCustomObject]@{
      Accessible = $false
      Folder = $null
      Items = @()
      ErrorMessage = $_.Exception.Message
    }
  }
}

function Test-PocketDockMediaBucketName {
  param([Parameter(Mandatory = $true)][string]$Name)

  # Recent iOS versions can expose Camera Roll groups directly below Internal
  # Storage (for example 202506_a) instead of adding a visible DCIM wrapper.
  if ($Name -match '^\d{4}(?:0[1-9]|1[0-2])_[A-Za-z0-9][A-Za-z0-9_-]*$') {
    return $true
  }

  # Known Apple DCF names cover local, iCloud, sync, and imported buckets when
  # Windows flattens the DCIM directory.
  return $Name -match '^[1-9]\d{2}(?:APPLE|CLOUD|SYNCD|IMPRT)$'
}

function Resolve-PocketDockMediaLayout {
  param([Parameter(Mandatory = $true)]$StorageItem)

  $storageContents = Get-PocketDockFolderItems -Item $StorageItem
  if (-not $storageContents.Accessible) {
    return [PSCustomObject]@{
      Ready = $false
      Kind = "storage-locked"
      RootItem = $null
      BucketItems = @()
      MediaFolderCount = 0
      ErrorMessage = $storageContents.ErrorMessage
    }
  }

  $dcim = $storageContents.Items | Where-Object {
    (Test-PocketDockFolderItem -Item $_) -and $_.Name -ieq "DCIM"
  } | Select-Object -First 1
  if ($null -ne $dcim) {
    $dcimContents = Get-PocketDockFolderItems -Item $dcim
    if (-not $dcimContents.Accessible) {
      return [PSCustomObject]@{
        Ready = $false
        Kind = "dcim-locked"
        RootItem = $dcim
        BucketItems = @()
        MediaFolderCount = 0
        ErrorMessage = $dcimContents.ErrorMessage
      }
    }
    return [PSCustomObject]@{
      Ready = $true
      Kind = "classic-dcim"
      RootItem = $dcim
      BucketItems = @()
      MediaFolderCount = @($dcimContents.Items | Where-Object {
        Test-PocketDockFolderItem -Item $_
      }).Count
      ErrorMessage = ""
    }
  }

  $storageType = ""
  try {
    $storageType = [string]$StorageItem.Type
  } catch {
    $storageType = ""
  }
  $buckets = @($storageContents.Items | Where-Object {
    (Test-PocketDockFolderItem -Item $_) -and
    (Test-PocketDockMediaBucketName -Name ([string]$_.Name))
  })
  if ($buckets.Count -gt 0) {
    return [PSCustomObject]@{
      Ready = $true
      Kind = "flat-dcf"
      RootItem = $StorageItem
      BucketItems = $buckets
      MediaFolderCount = $buckets.Count
      ErrorMessage = ""
    }
  }

  if ($storageType -ine "DCF") {
    return [PSCustomObject]@{
      Ready = $false
      Kind = "unknown"
      RootItem = $null
      BucketItems = @()
      MediaFolderCount = 0
      ErrorMessage = ""
    }
  }

  # An enumerable DCF root with no children is a valid, empty Camera Roll. Do
  # not tell the user to repair Trust merely because there is nothing to copy.
  if ($storageContents.Items.Count -eq 0) {
    return [PSCustomObject]@{
      Ready = $true
      Kind = "flat-dcf-empty"
      RootItem = $StorageItem
      BucketItems = @()
      MediaFolderCount = 0
      ErrorMessage = ""
    }
  }

  return [PSCustomObject]@{
    Ready = $false
    Kind = "unknown-dcf"
    RootItem = $null
    BucketItems = @()
    MediaFolderCount = 0
    ErrorMessage = ""
  }
}

function Find-PocketDockStorageItem {
  param([Parameter(Mandatory = $true)]$RootItem)

  $rootContents = Get-PocketDockFolderItems -Item $RootItem
  if (-not $rootContents.Accessible) {
    return $null
  }
  $folders = @($rootContents.Items | Where-Object {
    Test-PocketDockFolderItem -Item $_
  })

  foreach ($folder in $folders) {
    $layout = Resolve-PocketDockMediaLayout -StorageItem $folder
    if ($layout.Ready) {
      return $folder
    }
  }

  $storage = $folders | Where-Object {
    ([string]$_.Type -ieq "DCF") -or
    ([string]$_.Name -match "^(Internal Storage|Storage|Phone)$")
  } | Select-Object -First 1
  if ($null -ne $storage) {
    return $storage
  }

  # Localized Windows installations may give the single Apple storage surface
  # a translated name and a generic type. Keeping it visible lets diagnostics
  # distinguish storage access from a missing/unsupported media layout.
  if ($folders.Count -eq 1) {
    return $folders[0]
  }
  return $null
}
