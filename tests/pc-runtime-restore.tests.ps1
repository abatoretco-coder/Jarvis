$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot '..\scripts\pc-restore.ps1')

$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("jarvis-pc-restore-tests-{0}" -f [Guid]::NewGuid().ToString('N'))
$passed = 0

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw "assertion_failed:$Message" }
}

function Assert-Throws([scriptblock]$Action, [string]$Expected) {
  try {
    & $Action
  } catch {
    if ($_.Exception.Message -notlike "*$Expected*") {
      throw "assertion_failed:expected '$Expected', received '$($_.Exception.Message)'"
    }
    return
  }
  throw "assertion_failed:expected '$Expected'"
}

function Invoke-Test([string]$Name, [scriptblock]$Action) {
  & $Action
  $script:passed += 1
  Write-Host "PASS $Name"
}

function New-TestArchive([string]$Path, [array]$Entries) {
  $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew)
  $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create)
  try {
    foreach ($item in $Entries) {
      $entry = $archive.CreateEntry([string]$item.Name)
      if ($item.Name.EndsWith('/')) { continue }
      $writer = [IO.StreamWriter]::new($entry.Open(), [Text.UTF8Encoding]::new($false))
      try { $writer.Write([string]$item.Content) } finally { $writer.Dispose() }
    }
  } finally {
    $archive.Dispose()
    $stream.Dispose()
  }
}

function New-InstallFixture([string]$Name) {
  $root = Join-Path $testRoot $Name
  $active = Join-Path $root 'active'
  $staged = Join-Path $root 'staged'
  New-Item -ItemType Directory -Path $active, $staged -Force | Out-Null
  $oldDatabase = Join-Path $active 'database.sqlite'
  $newDatabase = Join-Path $staged 'database.sqlite'
  [IO.File]::WriteAllText($oldDatabase, 'old-database')
  [IO.File]::WriteAllText($newDatabase, 'new-database')
  $oldHomes = Join-Path $active 'homes'
  $newHomes = Join-Path $staged 'homes'
  New-Item -ItemType Directory -Path $oldHomes, $newHomes -Force | Out-Null
  [IO.File]::WriteAllText((Join-Path $oldHomes 'state.txt'), 'old-homes')
  [IO.File]::WriteAllText((Join-Path $newHomes 'state.txt'), 'new-homes')
  return @{
    Root = $root
    Journal = Join-Path $root 'restore-state.json'
    Quarantine = Join-Path $root 'quarantine'
    OldDatabase = $oldDatabase
    NewDatabase = $newDatabase
    OldHomes = $oldHomes
    NewHomes = $newHomes
    Components = @(
      @{ Name = 'database'; Staged = $newDatabase; Target = $oldDatabase },
      @{ Name = 'homes'; Staged = $newHomes; Target = $oldHomes }
    )
  }
}

function New-TestJournal([string]$Name) {
  return [ordered]@{
    schemaVersion = 1
    operationId = $Name
    profile = 'pc-preprod'
    backupFile = 'fixture.database.jarvisdb'
    quarantineRoot = 'fixture'
    state = 'prevalidated'
    startedAtUtc = [DateTime]::UtcNow.ToString('o')
  }
}

function New-SingleComponentFixture([string]$Name, [string]$ComponentName) {
  $root = Join-Path $testRoot $Name
  $active = Join-Path $root 'active'
  $stagedRoot = Join-Path $root 'staged'
  New-Item -ItemType Directory -Path $active, $stagedRoot -Force | Out-Null
  if ($ComponentName -eq 'database') {
    $target = Join-Path $active 'conversation.sqlite'
    $staged = Join-Path $stagedRoot 'conversation.sqlite'
    [IO.File]::WriteAllText($target, 'old-database')
    [IO.File]::WriteAllText($staged, 'new-database')
  } else {
    $target = Join-Path $active $ComponentName
    $staged = Join-Path $stagedRoot $ComponentName
    New-Item -ItemType Directory -Path $target, $staged -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $target 'marker.txt'), "old-$ComponentName")
    [IO.File]::WriteAllText((Join-Path $staged 'marker.txt'), "new-$ComponentName")
  }
  return @{
    Root = $root
    Journal = Join-Path $root 'restore-state.json'
    Quarantine = Join-Path $root 'quarantine'
    Target = $target
    Staged = $staged
    Component = @{ Name = $ComponentName; Staged = $staged; Target = $target }
  }
}

function Read-ComponentMarker([string]$ComponentName, [string]$Path) {
  if ($ComponentName -eq 'database') { return Get-Content -Raw $Path }
  return Get-Content -Raw (Join-Path $Path 'marker.txt')
}

New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
try {
  Invoke-Test 'corrupt decrypted identity ZIP is rejected before extraction' {
    $archive = Join-Path $testRoot 'corrupt-identity.zip'
    $destination = Join-Path $testRoot 'corrupt-identity'
    [IO.File]::WriteAllText($archive, 'not-a-zip')
    Assert-Throws { Expand-ValidatedArchive $archive $destination } 'archive_invalid_zip'
    Assert-True (-not (Test-Path -LiteralPath $destination)) 'corrupt archive created a destination'
  }

  Invoke-Test 'unsafe middle entry is rejected before any extraction' {
    $archive = Join-Path $testRoot 'unsafe-middle.zip'
    $destination = Join-Path $testRoot 'unsafe-middle'
    $escaped = Join-Path $testRoot 'escaped.txt'
    New-TestArchive $archive @(
      @{ Name = 'home/home.json'; Content = '{"homeId":"safe"}' },
      @{ Name = '../escaped.txt'; Content = 'unsafe' },
      @{ Name = 'home/after.txt'; Content = 'after' }
    )
    Assert-Throws { Expand-ValidatedArchive $archive $destination } 'archive_unsafe_path'
    Assert-True (-not (Test-Path -LiteralPath $destination)) 'archive was partially extracted'
    Assert-True (-not (Test-Path -LiteralPath $escaped)) 'entry escaped extraction root'
  }

  Invoke-Test 'invalid middle file removes the partially extracted staging directory' {
    $archive = Join-Path $testRoot 'invalid-middle.zip'
    $destination = Join-Path $testRoot 'invalid-middle'
    New-TestArchive $archive @(
      @{ Name = 'home/first.txt'; Content = 'first' },
      @{ Name = 'home/invalid.txt'; Content = 'invalid' },
      @{ Name = 'home/after.txt'; Content = 'after' }
    )
    $extract = {
      param($Entry, $Target)
      if ($Entry.FullName -eq 'home/invalid.txt') { throw 'simulated_invalid_middle_file' }
      [IO.Compression.ZipFileExtensions]::ExtractToFile($Entry, $Target, $false)
    }
    Assert-Throws {
      Expand-ValidatedArchive $archive $destination -ExtractOperation $extract
    } 'simulated_invalid_middle_file'
    Assert-True (-not (Test-Path -LiteralPath $destination)) 'partial extraction was retained'
  }

  Invoke-Test 'homes and identity layouts require their structural files' {
    $homes = Join-Path $testRoot 'valid-homes\home-1'
    $identity = Join-Path $testRoot 'valid-identity\h2'
    New-Item -ItemType Directory -Path $homes, $identity -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $homes 'home.json'), '{"homeId":"home-1"}')
    [IO.File]::WriteAllText((Join-Path $identity 'keycloakdb.mv.db'), 'keycloak')
    Assert-HomesRestoreLayout (Split-Path -Parent $homes)
    Assert-IdentityRestoreLayout (Split-Path -Parent $identity)
    [IO.File]::WriteAllText((Join-Path $homes 'home.json'), '{}')
    Assert-Throws { Assert-HomesRestoreLayout (Split-Path -Parent $homes) } 'homes_restore_missing_home_id'
  }

  Invoke-Test 'manifest verifies both PC profiles and detects mixed components' {
    $root = Join-Path $testRoot 'manifests'
    New-Item -ItemType Directory -Path $root -Force | Out-Null
    $database = Join-Path $root 'set.database.jarvisdb'
    $homes = Join-Path $root 'set.homes.zip.jarvisdb'
    $identity = Join-Path $root 'set.identity.zip.jarvisdb'
    [IO.File]::WriteAllText($database, 'database')
    [IO.File]::WriteAllText($homes, 'homes')
    [IO.File]::WriteAllText($identity, 'identity')
    foreach ($profile in @('pc-preprod', 'pc-preprod-full')) {
      $components = @{ database = $database; homes = $homes }
      if ($profile -eq 'pc-preprod-full') { $components.identity = $identity }
      $serialized = [ordered]@{ schemaVersion = 1; profile = $profile; components = [ordered]@{} }
      foreach ($name in $components.Keys) {
        $serialized.components[$name] = Get-RestoreManifestComponent $components[$name]
      }
      $manifest = Join-Path $root "$profile.json"
      [IO.File]::WriteAllText($manifest, ($serialized | ConvertTo-Json -Depth 6))
      Assert-RestoreManifest $manifest $profile $components
    }
    [IO.File]::AppendAllText($homes, 'tampered')
    Assert-Throws {
      Assert-RestoreManifest (Join-Path $root 'pc-preprod.json') 'pc-preprod' @{ database = $database; homes = $homes }
    } 'restore_manifest_component_mismatch:homes'
    Assert-True (
      -not (Test-RestoreManifestIfPresent (Join-Path $root 'legacy-missing.json') 'pc-preprod' @{ database = $database; homes = $homes })
    ) 'legacy backup without a manifest was rejected'
  }

  Invoke-Test 'home installation disk error restores every previous component' {
    $fixture = New-InstallFixture 'home-disk-error'
    $move = {
      param($Source, $Destination)
      if ($Source -eq $fixture.NewHomes) { throw 'simulated_home_disk_error' }
      Move-Item -LiteralPath $Source -Destination $Destination
    }
    Assert-Throws {
      Invoke-ControlledRestoreInstallation `
        -JournalPath $fixture.Journal `
        -Journal (New-TestJournal 'home-disk-error') `
        -Components $fixture.Components `
        -QuarantineRoot $fixture.Quarantine `
        -ValidateInstalled {} `
        -StartRuntime {} `
        -RestartPreviousRuntime {} `
        -MoveOperation $move
    } 'restore_failed_rolled_back:simulated_home_disk_error'
    Assert-True ((Get-Content -Raw $fixture.OldDatabase) -eq 'old-database') 'database was not restored'
    Assert-True ((Get-Content -Raw (Join-Path $fixture.OldHomes 'state.txt')) -eq 'old-homes') 'homes were not restored'
    Assert-True ((Read-RestoreJournal $fixture.Journal).state -eq 'rolled_back') 'journal did not record rollback'
  }

  Invoke-Test 'database quarantine move failure leaves active data untouched' {
    $fixture = New-InstallFixture 'database-move-error'
    $move = {
      param($Source, $Destination)
      if ($Source -eq $fixture.OldDatabase) { throw 'simulated_database_move_error' }
      Move-Item -LiteralPath $Source -Destination $Destination
    }
    Assert-Throws {
      Invoke-ControlledRestoreInstallation `
        -JournalPath $fixture.Journal `
        -Journal (New-TestJournal 'database-move-error') `
        -Components $fixture.Components `
        -QuarantineRoot $fixture.Quarantine `
        -ValidateInstalled {} `
        -StartRuntime {} `
        -MoveOperation $move
    } 'restore_failed_rolled_back:simulated_database_move_error'
    Assert-True ((Get-Content -Raw $fixture.OldDatabase) -eq 'old-database') 'active database changed'
    Assert-True (Test-Path -LiteralPath $fixture.NewDatabase) 'staged database was lost'
  }

  foreach ($componentName in @('database', 'homes', 'identity')) {
    Invoke-Test "reconciles $componentName interruption after previous data moved but before journal update" {
      $fixture = New-SingleComponentFixture "post-previous-$componentName" $componentName
      $move = {
        param($Source, $Destination)
        Move-Item -LiteralPath $Source -Destination $Destination
        if ($Source -eq $fixture.Target) { throw "simulated_post_previous_move_$componentName" }
      }
      Assert-Throws {
        Invoke-ControlledRestoreInstallation `
          -JournalPath $fixture.Journal `
          -Journal (New-TestJournal "post-previous-$componentName") `
          -Components @($fixture.Component) `
          -QuarantineRoot $fixture.Quarantine `
          -ValidateInstalled {} `
          -StartRuntime {} `
          -MoveOperation $move
      } "restore_failed_rolled_back:simulated_post_previous_move_$componentName"
      Assert-True (
        (Read-ComponentMarker $componentName $fixture.Target) -eq "old-$componentName"
      ) "$componentName previous data was not restored"
      Assert-True (Test-Path -LiteralPath $fixture.Staged) "$componentName staging was lost"
      Assert-True ((Read-RestoreJournal $fixture.Journal).state -eq 'rolled_back') "$componentName rollback state is wrong"
    }

    Invoke-Test "reconciles $componentName interruption after new data installed but before journal update" {
      $fixture = New-SingleComponentFixture "post-install-$componentName" $componentName
      $move = {
        param($Source, $Destination)
        Move-Item -LiteralPath $Source -Destination $Destination
        if ($Source -eq $fixture.Staged) { throw "simulated_post_install_move_$componentName" }
      }
      Assert-Throws {
        Invoke-ControlledRestoreInstallation `
          -JournalPath $fixture.Journal `
          -Journal (New-TestJournal "post-install-$componentName") `
          -Components @($fixture.Component) `
          -QuarantineRoot $fixture.Quarantine `
          -ValidateInstalled {} `
          -StartRuntime {} `
          -MoveOperation $move
      } "restore_failed_rolled_back:simulated_post_install_move_$componentName"
      Assert-True (
        (Read-ComponentMarker $componentName $fixture.Target) -eq "old-$componentName"
      ) "$componentName previous data was not restored"
      $failed = Join-Path $fixture.Quarantine "failed-install\$componentName"
      Assert-True (
        (Read-ComponentMarker $componentName $failed) -eq "new-$componentName"
      ) "$componentName installed data was not retained for diagnostics"
      Assert-True ((Read-RestoreJournal $fixture.Journal).state -eq 'rolled_back') "$componentName rollback state is wrong"
    }
  }

  Invoke-Test 'ambiguous component provenance blocks rollback without overwriting any path' {
    $fixture = New-SingleComponentFixture 'ambiguous-provenance' 'homes'
    $move = {
      param($Source, $Destination)
      Move-Item -LiteralPath $Source -Destination $Destination
      if ($Source -eq $fixture.Target) {
        New-Item -ItemType Directory -Path $fixture.Target -Force | Out-Null
        [IO.File]::WriteAllText((Join-Path $fixture.Target 'marker.txt'), 'unknown-homes')
        throw 'simulated_unknown_target_after_previous_move'
      }
    }
    Assert-Throws {
      Invoke-ControlledRestoreInstallation `
        -JournalPath $fixture.Journal `
        -Journal (New-TestJournal 'ambiguous-provenance') `
        -Components @($fixture.Component) `
        -QuarantineRoot $fixture.Quarantine `
        -ValidateInstalled {} `
        -StartRuntime {} `
        -MoveOperation $move
    } 'restore_failed_manual_recovery_required'
    Assert-True ((Read-ComponentMarker 'homes' $fixture.Target) -eq 'unknown-homes') 'uncertain target was overwritten'
    Assert-True ((Read-ComponentMarker 'homes' (Join-Path $fixture.Quarantine 'homes')) -eq 'old-homes') 'previous data was changed'
    Assert-True ((Read-ComponentMarker 'homes' $fixture.Staged) -eq 'new-homes') 'staging data was changed'
  }

  Invoke-Test 'Docker start failure stops the partial runtime and restores old data' {
    $fixture = New-InstallFixture 'docker-start-error'
    $calls = @{ Start = 0; Stop = 0 }
    Assert-Throws {
      Invoke-ControlledRestoreInstallation `
        -JournalPath $fixture.Journal `
        -Journal (New-TestJournal 'docker-start-error') `
        -Components $fixture.Components `
        -QuarantineRoot $fixture.Quarantine `
        -ValidateInstalled {} `
        -StartRuntime { $calls.Start += 1; throw 'simulated_docker_start_error' } `
        -PrepareRollback { $calls.Stop += 1 } `
        -RestartPreviousRuntime { $calls.Start += 1 }
    } 'restore_failed_rolled_back:simulated_docker_start_error'
    Assert-True ($calls.Stop -eq 1) 'partial runtime was not stopped before rollback'
    Assert-True ($calls.Start -eq 2) 'previous runtime was not restarted'
    Assert-True ((Get-Content -Raw $fixture.OldDatabase) -eq 'old-database') 'old database was not restored'
    Assert-True (Test-Path -LiteralPath (Join-Path $fixture.Quarantine 'failed-install\database')) 'failed database was not retained'
  }

  Invoke-Test 'successful installation retains the previous complete set in quarantine' {
    $fixture = New-InstallFixture 'successful-install'
    $calls = @{ Validate = 0; Start = 0 }
    Invoke-ControlledRestoreInstallation `
      -JournalPath $fixture.Journal `
      -Journal (New-TestJournal 'successful-install') `
      -Components $fixture.Components `
      -QuarantineRoot $fixture.Quarantine `
      -ValidateInstalled { $calls.Validate += 1 } `
      -StartRuntime { $calls.Start += 1 }
    Assert-True ((Get-Content -Raw $fixture.OldDatabase) -eq 'new-database') 'new database was not installed'
    Assert-True ((Get-Content -Raw (Join-Path $fixture.OldHomes 'state.txt')) -eq 'new-homes') 'new homes were not installed'
    Assert-True ((Get-Content -Raw (Join-Path $fixture.Quarantine 'database')) -eq 'old-database') 'old database was not retained'
    Assert-True ((Read-RestoreJournal $fixture.Journal).state -eq 'completed') 'journal did not record completion'
    Assert-True ($calls.Validate -eq 1 -and $calls.Start -eq 1) 'validation or startup was skipped'
  }

  Invoke-Test 'interrupted restoration blocks launch until state is reconciled' {
    $fixture = New-SingleComponentFixture 'interrupted' 'identity'
    $journalPath = $fixture.Journal
    $journal = New-TestJournal 'interrupted'
    $previous = Join-Path $fixture.Quarantine 'identity'
    New-Item -ItemType Directory -Path $fixture.Quarantine -Force | Out-Null
    $journal.quarantineRoot = $fixture.Quarantine
    $journal.components = @{
      identity = [ordered]@{
        target = $fixture.Target
        staged = $fixture.Staged
        previous = $previous
        hadPrevious = $true
        previousMoved = $false
        installed = $false
      }
    }
    $journal.state = 'installing'
    Write-RestoreJournal $journalPath $journal
    Move-Item -LiteralPath $fixture.Target -Destination $previous
    Assert-Throws { Assert-NoInterruptedRestore $journalPath } 'restore_interrupted_manual_recovery_required'
    $report = Read-RestoreJournal ($journalPath -replace '\.json$', '.reconciliation.json')
    Assert-True ($report.safeComponentObservations) 'interrupted state was not reconstructed'
    Assert-True ($report.components.identity.previousMoved) 'quarantined identity was not detected'
    Assert-True (-not $report.components.identity.installed) 'missing target was misclassified as installed'
    $journal.state = 'rolled_back'
    Write-RestoreJournal $journalPath $journal
    Assert-NoInterruptedRestore $journalPath
  }

  Write-Host "PC restore failure harness passed ($passed scenarios)." -ForegroundColor Green
} finally {
  if (Test-Path -LiteralPath $testRoot) {
    Remove-Item -LiteralPath $testRoot -Recurse -Force
  }
}
