param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet('config', 'start', 'stop', 'restart', 'status', 'logs', 'backup', 'restore', 'drill', 'test')]
  [string]$Command,
  [ValidateSet('dev', 'test', 'pc-preprod', 'pc-preprod-full')]
  [string]$Profile = 'pc-preprod',
  [string]$EnvFile = '',
  [string]$BackupPath = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$composeFile = Join-Path $repositoryRoot 'compose.pc.yaml'
$runtimeRoot = Join-Path $repositoryRoot 'runtime'
$dataRoot = Join-Path $runtimeRoot 'pc-preprod\data'
$databasePath = Join-Path $dataRoot 'conversation-memory.sqlite'
$homesDataRoot = Join-Path $dataRoot 'homes'
$identityDataRoot = Join-Path $runtimeRoot 'pc-preprod\identity'
$backupRoot = Join-Path $runtimeRoot 'backups'

function Assert-WithinRuntime([string]$Path) {
  $resolved = [IO.Path]::GetFullPath($Path)
  $prefix = $runtimeRoot.TrimEnd('\') + '\'
  if (-not $resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Path must remain under $runtimeRoot"
  }
  return $resolved
}

function Invoke-Compose([string[]]$Arguments) {
  & docker compose --file $composeFile --profile $Profile @Arguments
  if ($LASTEXITCODE -ne 0) { throw "docker compose failed with exit code $LASTEXITCODE" }
}

function Assert-BackupPassphrase() {
  if (-not $env:JARVIS_BACKUP_PASSPHRASE -or $env:JARVIS_BACKUP_PASSPHRASE.Length -lt 32) {
    throw 'Set JARVIS_BACKUP_PASSPHRASE to a unique value of at least 32 characters.'
  }
}

function Assert-IdentityBootstrapSecret() {
  if ($Profile -ne 'pc-preprod-full') { return }
  if (-not $env:KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD -or $env:KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD.Length -lt 32) {
    throw 'Set KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD to a unique value of at least 32 characters.'
  }
}

function Expand-ValidatedArchive([string]$ArchivePath, [string]$DestinationPath) {
  $destination = [IO.Path]::GetFullPath($DestinationPath)
  $prefix = $destination.TrimEnd('\') + '\'
  $archive = [IO.Compression.ZipFile]::OpenRead($ArchivePath)
  try {
    if ($archive.Entries.Count -gt 10000) { throw 'Archive contains too many entries.' }
    [long]$expandedBytes = 0
    foreach ($entry in $archive.Entries) {
      $expandedBytes += $entry.Length
      if ($expandedBytes -gt 2147483648) { throw 'Archive expands beyond the 2 GiB safety limit.' }
      $candidate = [IO.Path]::GetFullPath((Join-Path $destination $entry.FullName))
      if (-not $candidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Archive contains an unsafe path.'
      }
    }
  } finally {
    $archive.Dispose()
  }
  New-Item -ItemType Directory -Path $destination -Force | Out-Null
  Expand-Archive -LiteralPath $ArchivePath -DestinationPath $destination
}

if ($EnvFile) {
  $resolvedEnvFile = [IO.Path]::GetFullPath((Join-Path $repositoryRoot $EnvFile))
  if (-not (Test-Path -LiteralPath $resolvedEnvFile -PathType Leaf)) {
    throw "Environment file not found: $resolvedEnvFile"
  }
  $env:JARVIS_ENV_FILE = $resolvedEnvFile
}

Push-Location $repositoryRoot
try {
  switch ($Command) {
    'config' { Invoke-Compose @('config', '--quiet') }
    'start' {
      Assert-IdentityBootstrapSecret
      New-Item -ItemType Directory -Path $dataRoot -Force | Out-Null
      Invoke-Compose @('up', '--detach', '--build', '--wait')
    }
    'stop' { Invoke-Compose @('down', '--remove-orphans') }
    'restart' {
      Assert-IdentityBootstrapSecret
      Invoke-Compose @('down', '--remove-orphans')
      New-Item -ItemType Directory -Path $dataRoot -Force | Out-Null
      Invoke-Compose @('up', '--detach', '--build', '--wait')
    }
    'status' { Invoke-Compose @('ps') }
    'logs' { Invoke-Compose @('logs', '--tail', '200', '--follow') }
    'test' { Invoke-Compose @('run', '--rm', '--build', 'jarvis-test') }
    'backup' {
      Assert-BackupPassphrase
      if (-not (Test-Path -LiteralPath $databasePath -PathType Leaf)) {
        throw "Database not found: $databasePath"
      }
      if ($Profile -eq 'pc-preprod-full') {
        Assert-IdentityBootstrapSecret
        if (-not (Test-Path -LiteralPath $identityDataRoot -PathType Container)) {
          throw "Identity data not found: $identityDataRoot"
        }
      }
      New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
      $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
      $destination = Join-Path $backupRoot ("jarvis-{0}.database.jarvisdb" -f $stamp)
      $archive = Join-Path $backupRoot (".jarvis-{0}.identity.zip" -f $stamp)
      $encryptedIdentity = Join-Path $backupRoot ("jarvis-{0}.identity.zip.jarvisdb" -f $stamp)
      $homesArchive = Join-Path $backupRoot (".jarvis-{0}.homes.zip" -f $stamp)
      $encryptedHomes = Join-Path $backupRoot ("jarvis-{0}.homes.zip.jarvisdb" -f $stamp)
      $runtimeStopped = $false
      $backupSucceeded = $false
      try {
        Invoke-Compose @('stop', 'jarvis')
        $runtimeStopped = $true
        if ($Profile -eq 'pc-preprod-full') {
          Invoke-Compose @('stop', 'identity')
        }
        npm run db:conversation -- secure-backup --source $databasePath --destination $destination
        if ($LASTEXITCODE -ne 0) { throw 'Encrypted backup failed.' }
        Write-Host "Encrypted backup created: $destination" -ForegroundColor Green
        New-Item -ItemType Directory -Path $homesDataRoot -Force | Out-Null
        [IO.Compression.ZipFile]::CreateFromDirectory(
          $homesDataRoot,
          $homesArchive,
          [IO.Compression.CompressionLevel]::Optimal,
          $false
        )
        npm run db:conversation -- encrypt-file --source $homesArchive --destination $encryptedHomes
        if ($LASTEXITCODE -ne 0) { throw 'Encrypted homes backup failed.' }
        Write-Host "Encrypted homes backup created: $encryptedHomes" -ForegroundColor Green
        if ($Profile -eq 'pc-preprod-full') {
          [IO.Compression.ZipFile]::CreateFromDirectory(
            $identityDataRoot,
            $archive,
            [IO.Compression.CompressionLevel]::Optimal,
            $false
          )
          npm run db:conversation -- encrypt-file --source $archive --destination $encryptedIdentity
          if ($LASTEXITCODE -ne 0) { throw 'Encrypted identity backup failed.' }
          Write-Host "Encrypted identity backup created: $encryptedIdentity" -ForegroundColor Green
        }
        $backupSucceeded = $true
      } finally {
        if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
        if (Test-Path -LiteralPath $homesArchive) { Remove-Item -LiteralPath $homesArchive -Force }
        if (-not $backupSucceeded) {
          if (Test-Path -LiteralPath $destination) { Remove-Item -LiteralPath $destination -Force }
          if (Test-Path -LiteralPath $encryptedHomes) { Remove-Item -LiteralPath $encryptedHomes -Force }
        }
        if ($Profile -eq 'pc-preprod-full' -and -not $backupSucceeded) {
          if (Test-Path -LiteralPath $encryptedIdentity) { Remove-Item -LiteralPath $encryptedIdentity -Force }
        }
        if ($runtimeStopped) { Invoke-Compose @('up', '--detach', '--wait') }
      }
    }
    'restore' {
      Assert-BackupPassphrase
      Assert-IdentityBootstrapSecret
      if (-not $BackupPath) { throw 'Provide -BackupPath for restore.' }
      $source = Assert-WithinRuntime $BackupPath
      if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Backup not found: $source" }
      if (-not $source.EndsWith('.database.jarvisdb', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Restore requires a *.database.jarvisdb backup path.'
      }
      $identitySource = $source -replace '\.database\.jarvisdb$', '.identity.zip.jarvisdb'
      $homesSource = $source -replace '\.database\.jarvisdb$', '.homes.zip.jarvisdb'
      if (-not (Test-Path -LiteralPath $homesSource -PathType Leaf)) {
        throw "Matching homes backup not found: $homesSource"
      }
      if ($Profile -eq 'pc-preprod-full' -and -not (Test-Path -LiteralPath $identitySource -PathType Leaf)) {
        throw "Matching identity backup not found: $identitySource"
      }
      $databasePreflight = Join-Path $runtimeRoot (".database-restore-{0}.sqlite" -f [Guid]::NewGuid().ToString('N'))
      $identityArchive = Join-Path $runtimeRoot (".identity-restore-{0}.zip" -f [Guid]::NewGuid().ToString('N'))
      $homesArchive = Join-Path $runtimeRoot (".homes-restore-{0}.zip" -f [Guid]::NewGuid().ToString('N'))
      $homesPreflight = Join-Path $runtimeRoot (".homes-restore-{0}" -f [Guid]::NewGuid().ToString('N'))
      try {
        npm run db:conversation -- secure-restore --source $source --destination $databasePreflight
        if ($LASTEXITCODE -ne 0) { throw 'Database backup preflight failed; no runtime data was changed.' }
        npm run db:conversation -- decrypt-file --source $homesSource --destination $homesArchive
        if ($LASTEXITCODE -ne 0) { throw 'Homes backup preflight decryption failed; no runtime data was changed.' }
        New-Item -ItemType Directory -Path $homesPreflight -Force | Out-Null
        Expand-ValidatedArchive $homesArchive $homesPreflight
        if ($Profile -eq 'pc-preprod-full') {
          npm run db:conversation -- decrypt-file --source $identitySource --destination $identityArchive
          if ($LASTEXITCODE -ne 0) { throw 'Identity backup preflight decryption failed; no runtime data was changed.' }
          $zip = [IO.Compression.ZipFile]::OpenRead($identityArchive)
          try {
            if ($zip.Entries.Count -eq 0) { throw 'Identity backup archive is empty.' }
          } finally {
            $zip.Dispose()
          }
        }
        Invoke-Compose @('down', '--remove-orphans')
        New-Item -ItemType Directory -Path $dataRoot -Force | Out-Null
        if (Test-Path -LiteralPath $databasePath) {
          $quarantine = Join-Path $dataRoot ("conversation-memory.pre-restore-{0}.sqlite" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
          Move-Item -LiteralPath $databasePath -Destination $quarantine
          foreach ($suffix in @('-wal', '-shm')) {
            $sidecar = "$databasePath$suffix"
            if (Test-Path -LiteralPath $sidecar) { Move-Item -LiteralPath $sidecar -Destination "$quarantine$suffix" }
          }
          Write-Host "Previous database quarantined: $quarantine" -ForegroundColor Yellow
        }
        Move-Item -LiteralPath $databasePreflight -Destination $databasePath
        if (Test-Path -LiteralPath $homesDataRoot) {
          $homesQuarantine = "$homesDataRoot.pre-restore-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
          Move-Item -LiteralPath $homesDataRoot -Destination $homesQuarantine
        }
        Move-Item -LiteralPath $homesPreflight -Destination $homesDataRoot
        if ($Profile -eq 'pc-preprod-full') {
          $identityQuarantine = "$identityDataRoot.pre-restore-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
          if (Test-Path -LiteralPath $identityDataRoot) {
            Move-Item -LiteralPath $identityDataRoot -Destination $identityQuarantine
          }
          New-Item -ItemType Directory -Path $identityDataRoot -Force | Out-Null
          Expand-ValidatedArchive $identityArchive $identityDataRoot
        }
        Invoke-Compose @('up', '--detach', '--build', '--wait')
      } finally {
        if (Test-Path -LiteralPath $databasePreflight) { Remove-Item -LiteralPath $databasePreflight -Force }
        if (Test-Path -LiteralPath $identityArchive) { Remove-Item -LiteralPath $identityArchive -Force }
        if (Test-Path -LiteralPath $homesArchive) { Remove-Item -LiteralPath $homesArchive -Force }
        if (Test-Path -LiteralPath $homesPreflight) { Remove-Item -LiteralPath $homesPreflight -Recurse -Force }
      }
    }
    'drill' {
      Assert-BackupPassphrase
      if (-not (Test-Path -LiteralPath $databasePath -PathType Leaf)) {
        throw "Database not found: $databasePath"
      }
      $drillRoot = Assert-WithinRuntime (Join-Path $runtimeRoot ("drills\{0}" -f [Guid]::NewGuid().ToString('N')))
      New-Item -ItemType Directory -Path $drillRoot -Force | Out-Null
      try {
        $encrypted = Join-Path $drillRoot 'drill.jarvisdb'
        $restored = Join-Path $drillRoot 'restored.sqlite'
        $homesZip = Join-Path $drillRoot 'homes.zip'
        $homesEncrypted = Join-Path $drillRoot 'homes.zip.jarvisdb'
        $homesRestoredZip = Join-Path $drillRoot 'homes-restored.zip'
        $homesRestored = Join-Path $drillRoot 'homes-restored'
        npm run db:conversation -- secure-backup --source $databasePath --destination $encrypted
        if ($LASTEXITCODE -ne 0) { throw 'Drill backup failed.' }
        npm run db:conversation -- secure-restore --source $encrypted --destination $restored
        if ($LASTEXITCODE -ne 0) { throw 'Drill restore failed.' }
        npm run db:conversation -- verify --source $restored
        if ($LASTEXITCODE -ne 0) { throw 'Drill verification failed.' }
        if (Test-Path -LiteralPath $homesDataRoot -PathType Container) {
          [IO.Compression.ZipFile]::CreateFromDirectory($homesDataRoot, $homesZip)
          npm run db:conversation -- encrypt-file --source $homesZip --destination $homesEncrypted
          if ($LASTEXITCODE -ne 0) { throw 'Homes drill encryption failed.' }
          npm run db:conversation -- decrypt-file --source $homesEncrypted --destination $homesRestoredZip
          if ($LASTEXITCODE -ne 0) { throw 'Homes drill decryption failed.' }
          Expand-ValidatedArchive $homesRestoredZip $homesRestored
          $sourceFiles = @(Get-ChildItem -LiteralPath $homesDataRoot -Recurse -File)
          $restoredFiles = @(Get-ChildItem -LiteralPath $homesRestored -Recurse -File)
          if ($sourceFiles.Count -ne $restoredFiles.Count) { throw 'Homes drill file count mismatch.' }
        }
        Write-Host 'Backup/restore drill passed.' -ForegroundColor Green
      } finally {
        $validatedDrillRoot = Assert-WithinRuntime $drillRoot
        if (Test-Path -LiteralPath $validatedDrillRoot) {
          Remove-Item -LiteralPath $validatedDrillRoot -Recurse -Force
        }
      }
    }
  }
} finally {
  Pop-Location
}
