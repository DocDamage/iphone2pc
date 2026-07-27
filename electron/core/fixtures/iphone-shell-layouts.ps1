param(
  [Parameter(Mandatory = $true)]
  [string]$HelperPath
)

$ErrorActionPreference = "Stop"
. $HelperPath

function New-FixtureFolderItem {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [string]$Type = "File folder",
    [object[]]$Children = @(),
    [bool]$Locked = $false
  )

  $item = [PSCustomObject]@{
    Name = $Name
    Type = $Type
    IsFolder = $true
    FixtureChildren = @($Children)
    FixtureLocked = $Locked
  }
  $item | Add-Member -MemberType ScriptProperty -Name GetFolder -Value {
    if ($this.FixtureLocked) {
      throw "Fixture folder is locked."
    }
    $folder = [PSCustomObject]@{
      FixtureChildren = @($this.FixtureChildren)
    }
    $folder | Add-Member -MemberType ScriptMethod -Name Items -Value {
      return $this.FixtureChildren
    }
    return $folder
  }
  return $item
}

$classicBucket = New-FixtureFolderItem -Name "100APPLE"
$classicDcim = New-FixtureFolderItem -Name "DCIM" -Children @($classicBucket)
$classicStorage = New-FixtureFolderItem `
  -Name "Stockage interne" `
  -Type "Portable Device Storage" `
  -Children @($classicDcim)
$classic = Resolve-PocketDockMediaLayout -StorageItem $classicStorage

$flatStorage = New-FixtureFolderItem `
  -Name "Interner Speicher" `
  -Type "Portable Device Storage" `
  -Children @(
    (New-FixtureFolderItem -Name "202506_a"),
    (New-FixtureFolderItem -Name "202504_d"),
    (New-FixtureFolderItem -Name "Documents")
  )
$flat = Resolve-PocketDockMediaLayout -StorageItem $flatStorage

$legacyFlatStorage = New-FixtureFolderItem `
  -Name "Internal Storage" `
  -Type "DCF" `
  -Children @(
    (New-FixtureFolderItem -Name "100APPLE"),
    (New-FixtureFolderItem -Name "101CLOUD")
  )
$legacyFlat = Resolve-PocketDockMediaLayout -StorageItem $legacyFlatStorage

$arbitraryStorage = New-FixtureFolderItem `
  -Name "Storage" `
  -Type "Portable Device Storage" `
  -Children @(
    (New-FixtureFolderItem -Name "Documents"),
    (New-FixtureFolderItem -Name "Downloads")
  )
$arbitrary = Resolve-PocketDockMediaLayout -StorageItem $arbitraryStorage

$noisyDcfStorage = New-FixtureFolderItem `
  -Name "Internal Storage" `
  -Type "DCF" `
  -Children @((New-FixtureFolderItem -Name "Documents"))
$noisyDcf = Resolve-PocketDockMediaLayout -StorageItem $noisyDcfStorage

$emptyDcfStorage = New-FixtureFolderItem `
  -Name "Internal Storage" `
  -Type "DCF"
$emptyDcf = Resolve-PocketDockMediaLayout -StorageItem $emptyDcfStorage

$lockedStorage = New-FixtureFolderItem `
  -Name "Internal Storage" `
  -Type "DCF" `
  -Locked $true
$locked = Resolve-PocketDockMediaLayout -StorageItem $lockedStorage

$localizedRoot = New-FixtureFolderItem `
  -Name "Mon iPhone" `
  -Type "Portable Device" `
  -Children @($classicStorage)
$localizedStorage = Find-PocketDockStorageItem -RootItem $localizedRoot

[PSCustomObject]@{
  classic = [PSCustomObject]@{
    ready = $classic.Ready
    kind = $classic.Kind
    rootName = $classic.RootItem.Name
    mediaFolderCount = $classic.MediaFolderCount
  }
  flat = [PSCustomObject]@{
    ready = $flat.Ready
    kind = $flat.Kind
    buckets = @($flat.BucketItems | ForEach-Object { $_.Name })
  }
  legacyFlat = [PSCustomObject]@{
    ready = $legacyFlat.Ready
    kind = $legacyFlat.Kind
    buckets = @($legacyFlat.BucketItems | ForEach-Object { $_.Name })
  }
  arbitrary = [PSCustomObject]@{
    ready = $arbitrary.Ready
    kind = $arbitrary.Kind
  }
  noisyDcf = [PSCustomObject]@{
    ready = $noisyDcf.Ready
    kind = $noisyDcf.Kind
  }
  emptyDcf = [PSCustomObject]@{
    ready = $emptyDcf.Ready
    kind = $emptyDcf.Kind
  }
  locked = [PSCustomObject]@{
    ready = $locked.Ready
    kind = $locked.Kind
  }
  localizedStorageName = $localizedStorage.Name
  bucketNames = [PSCustomObject]@{
    recent = Test-PocketDockMediaBucketName -Name "202506_a"
    recentVariant = Test-PocketDockMediaBucketName -Name "202504_d-2"
    legacy = Test-PocketDockMediaBucketName -Name "100APPLE"
    cloud = Test-PocketDockMediaBucketName -Name "101CLOUD"
    documents = Test-PocketDockMediaBucketName -Name "Documents"
    incompleteDate = Test-PocketDockMediaBucketName -Name "202506"
    invalidMonth = Test-PocketDockMediaBucketName -Name "202613_a"
    randomFolder = Test-PocketDockMediaBucketName -Name "random_folder"
  }
} | ConvertTo-Json -Compress -Depth 6
