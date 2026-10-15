Set-StrictMode -Version Latest

Add-Type -AssemblyName System.IO.Compression.FileSystem

function Write-RestoreJournal {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][Collections.IDictionary]$State
  )

  $directory = Split-Path -Parent $Path
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
  $State.updatedAtUtc = [DateTime]::UtcNow.ToString('o')
  $temporary = "$Path.$([Guid]::NewGuid().ToString('N')).tmp"
  try {
    [IO.File]::WriteAllText(
      $temporary,
      ($State | ConvertTo-Json -Depth 8),
      [Text.UTF8Encoding]::new($false)
    )
    Move-Item -LiteralPath $temporary -Destination $Path -Force
  } finally {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
  }
}

function Read-RestoreJournal {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  try {
    return [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8) | ConvertFrom-Json
  } catch {
    throw "restore_journal_unreadable:$Path"
  }
}

function Assert-NoInterruptedRestore {
  param([Parameter(Mandatory = $true)][string]$JournalPath)

  $journal = Read-RestoreJournal $JournalPath
  if ($null -eq $journal) { return }
  $stateProperty = $journal.PSObject.Properties['state']
  if ($null -eq $stateProperty) { throw "restore_journal_invalid_state:$JournalPath" }
  if ($stateProperty.Value -in @('completed', 'rolled_back')) { return }
  throw "restore_interrupted_manual_recovery_required:$JournalPath"
}

function Expand-ValidatedArchive {
  param(
    [Parameter(Mandatory = $true)][string]$ArchivePath,
    [Parameter(Mandatory = $true)][string]$DestinationPath,
    [int]$MaxEntries = 10000,
    [long]$MaxExpandedBytes = 2147483648,
    [scriptblock]$ExtractOperation = {
      param($Entry, $Target)
      [IO.Compression.ZipFileExtensions]::ExtractToFile($Entry, $Target, $false)
    }
  )

  $destination = [IO.Path]::GetFullPath($DestinationPath)
  if (Test-Path -LiteralPath $destination) {
    throw "archive_destination_exists:$destination"
  }
  $prefix = $destination.TrimEnd('\') + '\'
  $entries = @()
  $targets = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  try {
    $archive = [IO.Compression.ZipFile]::OpenRead($ArchivePath)
  } catch {
    throw 'archive_invalid_zip'
  }
  try {
    if ($archive.Entries.Count -eq 0) { throw 'archive_empty' }
    if ($archive.Entries.Count -gt $MaxEntries) { throw 'archive_too_many_entries' }
    [long]$expandedBytes = 0
    foreach ($entry in $archive.Entries) {
      if ([IO.Path]::IsPathRooted($entry.FullName)) { throw 'archive_unsafe_path' }
      $expandedBytes += $entry.Length
      if ($expandedBytes -gt $MaxExpandedBytes) { throw 'archive_expanded_size_limit' }
      $candidate = [IO.Path]::GetFullPath((Join-Path $destination $entry.FullName))
      if (-not $candidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'archive_unsafe_path'
      }
      if (-not $targets.Add($candidate)) { throw 'archive_duplicate_path' }
      $unixMode = ($entry.ExternalAttributes -shr 16) -band 0xF000
      if ($unixMode -eq 0xA000) { throw 'archive_symbolic_link_not_allowed' }
      $entries += [pscustomobject]@{ Entry = $entry; Target = $candidate }
    }

    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    try {
      foreach ($item in $entries) {
        if ($item.Entry.FullName.EndsWith('/') -or $item.Entry.FullName.EndsWith('\')) {
          New-Item -ItemType Directory -Path $item.Target -Force | Out-Null
          continue
        }
        $parent = Split-Path -Parent $item.Target
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
        & $ExtractOperation $item.Entry $item.Target
      }
    } catch {
      Remove-Item -LiteralPath $destination -Recurse -Force -ErrorAction SilentlyContinue
      throw
    }
  } finally {
    $archive.Dispose()
  }
}

function Assert-HomesRestoreLayout {
  param([Parameter(Mandatory = $true)][string]$Path)

  $homeFiles = @(Get-ChildItem -LiteralPath $Path -Recurse -File -Filter 'home.json')
  if ($homeFiles.Count -eq 0) { throw 'homes_restore_missing_home_json' }
  foreach ($homeFile in $homeFiles) {
    try {
      $homeDocument = [IO.File]::ReadAllText($homeFile.FullName, [Text.Encoding]::UTF8) | ConvertFrom-Json
    } catch {
      throw "homes_restore_invalid_json:$($homeFile.FullName)"
    }
    $homeIdProperty = $homeDocument.PSObject.Properties['homeId']
    if ($null -eq $homeIdProperty -or [string]::IsNullOrWhiteSpace([string]$homeIdProperty.Value)) {
      throw "homes_restore_missing_home_id:$($homeFile.FullName)"
    }
  }
}

function Assert-IdentityRestoreLayout {
  param([Parameter(Mandatory = $true)][string]$Path)

  $database = Join-Path $Path 'h2\keycloakdb.mv.db'
  if (-not (Test-Path -LiteralPath $database -PathType Leaf)) {
    throw 'identity_restore_missing_keycloak_database'
  }
  if ((Get-Item -LiteralPath $database).Length -eq 0) {
    throw 'identity_restore_empty_keycloak_database'
  }
}

function Get-RestoreManifestComponent {
  param([Parameter(Mandatory = $true)][string]$Path)

  $file = Get-Item -LiteralPath $Path
  $stream = [IO.File]::OpenRead($file.FullName)
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $hash = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '')
  } finally {
    $sha.Dispose()
    $stream.Dispose()
  }
  return [ordered]@{
    fileName = $file.Name
    length = $file.Length
    sha256 = $hash
  }
}

function Assert-RestoreManifest {
  param(
    [Parameter(Mandatory = $true)][string]$ManifestPath,
    [Parameter(Mandatory = $true)][string]$Profile,
    [Parameter(Mandatory = $true)][hashtable]$Components
  )

  try {
    $manifest = [IO.File]::ReadAllText($ManifestPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
  } catch {
    throw 'restore_manifest_invalid_json'
  }
  $schemaProperty = $manifest.PSObject.Properties['schemaVersion']
  $profileProperty = $manifest.PSObject.Properties['profile']
  $componentsProperty = $manifest.PSObject.Properties['components']
  if ($null -eq $schemaProperty -or $null -eq $profileProperty -or $null -eq $componentsProperty) {
    throw 'restore_manifest_invalid_structure'
  }
  if ($schemaProperty.Value -ne 1 -or $profileProperty.Value -ne $Profile) {
    throw 'restore_manifest_incompatible'
  }
  foreach ($name in $Components.Keys) {
    $expectedProperty = $componentsProperty.Value.PSObject.Properties[$name]
    if ($null -eq $expectedProperty) { throw "restore_manifest_missing_component:$name" }
    $expected = $expectedProperty.Value
    foreach ($propertyName in @('fileName', 'length', 'sha256')) {
      if ($null -eq $expected.PSObject.Properties[$propertyName]) {
        throw "restore_manifest_invalid_component:$name"
      }
    }
    $actual = Get-RestoreManifestComponent $Components[$name]
    if (
      $expected.fileName -ne $actual.fileName -or
      [long]$expected.length -ne [long]$actual.length -or
      $expected.sha256 -ne $actual.sha256
    ) {
      throw "restore_manifest_component_mismatch:$name"
    }
  }
}

function Test-RestoreManifestIfPresent {
  param(
    [Parameter(Mandatory = $true)][string]$ManifestPath,
    [Parameter(Mandatory = $true)][string]$Profile,
    [Parameter(Mandatory = $true)][hashtable]$Components
  )

  if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) { return $false }
  Assert-RestoreManifest $ManifestPath $Profile $Components
  return $true
}

function Invoke-ControlledRestoreInstallation {
  param(
    [Parameter(Mandatory = $true)][string]$JournalPath,
    [Parameter(Mandatory = $true)][Collections.IDictionary]$Journal,
    [Parameter(Mandatory = $true)][array]$Components,
    [Parameter(Mandatory = $true)][string]$QuarantineRoot,
    [Parameter(Mandatory = $true)][scriptblock]$ValidateInstalled,
    [Parameter(Mandatory = $true)][scriptblock]$StartRuntime,
    [scriptblock]$PrepareRollback,
    [scriptblock]$RestartPreviousRuntime,
    [scriptblock]$MoveOperation = { param($Source, $Destination) Move-Item -LiteralPath $Source -Destination $Destination }
  )

  New-Item -ItemType Directory -Path $QuarantineRoot -Force | Out-Null
  $installedRoot = Join-Path $QuarantineRoot 'failed-install'
  $Journal.state = 'installing'
  $Journal.components = @{}
  Write-RestoreJournal $JournalPath $Journal

  try {
    foreach ($component in $Components) {
      $name = [string]$component.Name
      $target = [string]$component.Target
      $staged = if ($null -eq $component.Staged) { '' } else { [string]$component.Staged }
      $previous = Join-Path $QuarantineRoot $name
      $hadPrevious = Test-Path -LiteralPath $target
      $Journal.components[$name] = [ordered]@{
        target = $target
        staged = $staged
        previous = $previous
        hadPrevious = $hadPrevious
        previousMoved = $false
        installed = $false
      }
      Write-RestoreJournal $JournalPath $Journal
      if ($hadPrevious) {
        & $MoveOperation $target $previous
        $Journal.components[$name].previousMoved = $true
        Write-RestoreJournal $JournalPath $Journal
      }
      if (-not [string]::IsNullOrWhiteSpace($staged)) {
        & $MoveOperation $staged $target
        $Journal.components[$name].installed = $true
        Write-RestoreJournal $JournalPath $Journal
      }
    }

    $Journal.state = 'validating_installed'
    Write-RestoreJournal $JournalPath $Journal
    & $ValidateInstalled
    $Journal.state = 'starting_runtime'
    Write-RestoreJournal $JournalPath $Journal
    & $StartRuntime
    $Journal.state = 'completed'
    Write-RestoreJournal $JournalPath $Journal
  } catch {
    $originalError = $_
    $Journal.state = 'rolling_back'
    $Journal.failure = $originalError.Exception.Message
    try { Write-RestoreJournal $JournalPath $Journal } catch { }
    try {
      if ($PrepareRollback) { & $PrepareRollback }
      New-Item -ItemType Directory -Path $installedRoot -Force | Out-Null
      $rollbackComponents = @($Components)
      [Array]::Reverse($rollbackComponents)
      foreach ($component in $rollbackComponents) {
        $name = [string]$component.Name
        if (-not $Journal.components.ContainsKey($name)) { continue }
        $target = [string]$component.Target
        $state = $Journal.components[$name]
        if ($state.installed -and (Test-Path -LiteralPath $target)) {
          & $MoveOperation $target (Join-Path $installedRoot $name)
        }
        if ($state.previousMoved) {
          if (Test-Path -LiteralPath $target) {
            throw "restore_rollback_target_occupied:$target"
          }
          & $MoveOperation ([string]$state.previous) $target
        }
      }
      if ($RestartPreviousRuntime) { & $RestartPreviousRuntime }
      $Journal.state = 'rolled_back'
      Write-RestoreJournal $JournalPath $Journal
    } catch {
      $Journal.state = 'manual_recovery_required'
      $Journal.rollbackFailure = $_.Exception.Message
      try { Write-RestoreJournal $JournalPath $Journal } catch { }
      throw "restore_failed_manual_recovery_required:$JournalPath"
    }
    throw "restore_failed_rolled_back:$($originalError.Exception.Message)"
  }
}
