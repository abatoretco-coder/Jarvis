param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet('provision', 'set-owner', 'config', 'start', 'stop', 'restart', 'status', 'logs', 'backup', 'restore', 'drill', 'test')]
  [string]$Command,
  [ValidateSet('dev', 'test', 'pc-preprod', 'pc-preprod-full')]
  [string]$Profile = 'pc-preprod',
  [string]$EnvFile = '',
  [string]$BackupPath = '',
  [string]$OwnerSubject = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.Security
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $PSScriptRoot 'pc-restore.ps1')
$composeFile = Join-Path $repositoryRoot 'compose.pc.yaml'
$runtimeRoot = Join-Path $repositoryRoot 'runtime'
$dataRoot = Join-Path $runtimeRoot 'pc-preprod\data'
$databasePath = Join-Path $dataRoot 'conversation-memory.sqlite'
$homesDataRoot = Join-Path $dataRoot 'homes'
$identityDataRoot = Join-Path $runtimeRoot 'pc-preprod\identity'
$backupRoot = Join-Path $runtimeRoot 'backups'
$secretsRoot = Join-Path $runtimeRoot 'pc-preprod\secrets'
$protectedIdentitySecret = Join-Path $secretsRoot 'keycloak-bootstrap-admin.dpapi'
$protectedBackupSecret = Join-Path $secretsRoot 'backup-passphrase.dpapi'
$restoreJournalPath = Join-Path $runtimeRoot 'pc-preprod\restore-state.json'
$runtimeOperationLockPath = Join-Path $runtimeRoot 'pc-preprod\backup-restore.lock'

function New-RandomSecret([int]$Bytes = 48) {
  $buffer = [byte[]]::new($Bytes)
  $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $generator.GetBytes($buffer)
  } finally {
    $generator.Dispose()
  }
  return [Convert]::ToBase64String($buffer).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function New-RandomBytes([int]$Bytes) {
  $buffer = [byte[]]::new($Bytes)
  $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $generator.GetBytes($buffer)
  } finally {
    $generator.Dispose()
  }
  return $buffer
}

function Assert-SafeEnvironmentValue([string]$Name, [string]$Value, [int]$MaxLength, [bool]$AllowEmpty = $false) {
  if ((-not $AllowEmpty -and [string]::IsNullOrWhiteSpace($Value)) -or $Value.Length -gt $MaxLength) {
    throw "$Name has an invalid length."
  }
  if ($Value -match '[\r\n\x00-\x1F]') {
    throw "$Name contains forbidden control characters."
  }
}

function Save-ProtectedSecret([string]$Path, [string]$Value) {
  New-Item -ItemType Directory -Path $secretsRoot -Force | Out-Null
  $plainBytes = [Text.Encoding]::UTF8.GetBytes($Value)
  try {
    $encryptedBytes = [Security.Cryptography.ProtectedData]::Protect(
      $plainBytes,
      $null,
      [Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    [IO.File]::WriteAllText(
      $Path,
      [Convert]::ToBase64String($encryptedBytes),
      [Text.UTF8Encoding]::new($false)
    )
  } finally {
    [Array]::Clear($plainBytes, 0, $plainBytes.Length)
  }
}

function Read-ProtectedSecret([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
  $encryptedBytes = [Convert]::FromBase64String([IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8))
  $plainBytes = [Security.Cryptography.ProtectedData]::Unprotect(
    $encryptedBytes,
    $null,
    [Security.Cryptography.DataProtectionScope]::CurrentUser
  )
  try {
    return [Text.Encoding]::UTF8.GetString($plainBytes)
  } finally {
    [Array]::Clear($plainBytes, 0, $plainBytes.Length)
  }
}

function Import-ProtectedRuntimeSecrets() {
  if (-not $env:KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD) {
    $env:KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD = Read-ProtectedSecret $protectedIdentitySecret
  }
  if (-not $env:JARVIS_BACKUP_PASSPHRASE) {
    $env:JARVIS_BACKUP_PASSPHRASE = Read-ProtectedSecret $protectedBackupSecret
  }
}

function Initialize-FullProfile() {
  $target = [IO.Path]::GetFullPath((Join-Path $repositoryRoot 'ops\pc\env\pc-preprod-full.env'))
  $allowedRoot = [IO.Path]::GetFullPath((Join-Path $repositoryRoot 'ops\pc\env')).TrimEnd('\') + '\'
  if (-not $target.StartsWith($allowedRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Full-profile environment file must remain under ops/pc/env.'
  }
  if (Test-Path -LiteralPath $target) {
    throw "Environment file already exists; refusing to overwrite: $target"
  }
  if (-not $env:OPENAI_API_KEY) {
    throw 'OPENAI_API_KEY must be present in the current process before provisioning.'
  }
  $normalizedOwnerSubject = $OwnerSubject.Trim()
  Assert-SafeEnvironmentValue 'OPENAI_API_KEY' $env:OPENAI_API_KEY 512
  Assert-SafeEnvironmentValue 'OwnerSubject' $normalizedOwnerSubject 512 $true
  $serviceToken = New-RandomSecret
  $oauthKey = [Convert]::ToBase64String((New-RandomBytes 32))
  $identityPassword = New-RandomSecret
  $backupPassphrase = New-RandomSecret
  $lines = @(
    'LOG_LEVEL=info',
    'REQUIRE_API_KEY=true',
    'ALLOW_LEGACY_API_KEYS=false',
    "SERVICE_API_KEYS_JSON=[{`"id`":`"desktop-local`",`"token`":`"$serviceToken`",`"permissions`":[`"chat`",`"history`",`"home`",`"mail`",`"calendar`",`"todo`",`"nas.operations`"]}]",
    'OIDC_ENABLED=true',
    'OIDC_ISSUER_URL=https://jarvis-abato.duckdns.org/realms/jarvis',
    'OIDC_JWKS_URL=http://identity:8080/realms/jarvis/protocol/openid-connect/certs',
    'OIDC_AUDIENCE=jarvis-api',
    "OIDC_BOOTSTRAP_OWNER_SUBJECT=$normalizedOwnerSubject",
    'OIDC_ALLOW_INSECURE_HTTP=true',
    "OPENAI_API_KEY=$($env:OPENAI_API_KEY)",
    'LLM_PROVIDER=openai',
    'TTS_PROVIDER=none',
    'OPENAI_TTS_VOICE=cedar',
    'OPENAI_TTS_INSTRUCTIONS=Parle exclusivement en francais de France avec une voix d''homme adulte, baryton, naturelle et chaleureuse. Adopte une prononciation francaise metropolitaine native, sans accent anglophone. Garde un timbre grave et nettement masculin, une intonation souple et des pauses legeres. Reste simple, clair et en tutoiement.',
    'NAS_STATUS_ENABLED=false',
    'CULTURE_ENABLED=false',
    "OAUTH_TOKEN_ENCRYPTION_KEY=$oauthKey",
    'OAUTH_TOKEN_KEY_VERSION=1'
  )
  try {
    Save-ProtectedSecret $protectedIdentitySecret $identityPassword
    Save-ProtectedSecret $protectedBackupSecret $backupPassphrase
    [IO.File]::WriteAllLines($target, $lines, [Text.UTF8Encoding]::new($false))
  } catch {
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force }
    if (Test-Path -LiteralPath $protectedIdentitySecret) { Remove-Item -LiteralPath $protectedIdentitySecret -Force }
    if (Test-Path -LiteralPath $protectedBackupSecret) { Remove-Item -LiteralPath $protectedBackupSecret -Force }
    throw
  }
  $env:KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD = $identityPassword
  $env:JARVIS_BACKUP_PASSPHRASE = $backupPassphrase
  Write-Host "Full PC profile provisioned: $target" -ForegroundColor Green
  Write-Host "Runtime secrets protected with Windows DPAPI under: $secretsRoot" -ForegroundColor Green
}

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

if ($EnvFile) {
  $resolvedEnvFile = [IO.Path]::GetFullPath((Join-Path $repositoryRoot $EnvFile))
  if (-not (Test-Path -LiteralPath $resolvedEnvFile -PathType Leaf)) {
    throw "Environment file not found: $resolvedEnvFile"
  }
  $env:JARVIS_ENV_FILE = $resolvedEnvFile
}

Push-Location $repositoryRoot
$runtimeOperationLock = $null
try {
  Import-ProtectedRuntimeSecrets
  if ($Command -in @('start', 'restart', 'backup', 'restore')) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $runtimeOperationLockPath) -Force | Out-Null
    try {
      $runtimeOperationLock = [IO.File]::Open(
        $runtimeOperationLockPath,
        [IO.FileMode]::OpenOrCreate,
        [IO.FileAccess]::ReadWrite,
        [IO.FileShare]::None
      )
    } catch {
      throw 'pc_runtime_operation_already_in_progress'
    }
  }
  if ($Command -in @('start', 'restart', 'backup', 'restore')) {
    Assert-NoInterruptedRestore $restoreJournalPath
  }
  switch ($Command) {
    'provision' {
      if ($Profile -ne 'pc-preprod-full') { throw 'Provisioning is only available for pc-preprod-full.' }
      Initialize-FullProfile
    }
    'set-owner' {
      if ($Profile -ne 'pc-preprod-full') { throw 'Owner bootstrap is only available for pc-preprod-full.' }
      if (-not $EnvFile) { throw 'Provide -EnvFile for owner bootstrap.' }
      $normalizedOwnerSubject = $OwnerSubject.Trim()
      Assert-SafeEnvironmentValue 'OwnerSubject' $normalizedOwnerSubject 512
      $lines = [IO.File]::ReadAllLines($resolvedEnvFile, [Text.Encoding]::UTF8)
      $matches = @($lines | Where-Object { $_ -like 'OIDC_BOOTSTRAP_OWNER_SUBJECT=*' })
      if ($matches.Count -ne 1) { throw 'Environment file must contain exactly one owner subject entry.' }
      $updated = @($lines | ForEach-Object {
        if ($_ -like 'OIDC_BOOTSTRAP_OWNER_SUBJECT=*') {
          "OIDC_BOOTSTRAP_OWNER_SUBJECT=$normalizedOwnerSubject"
        } else {
          $_
        }
      })
      [IO.File]::WriteAllLines($resolvedEnvFile, $updated, [Text.UTF8Encoding]::new($false))
      Write-Host 'Bootstrap owner subject updated.' -ForegroundColor Green
    }
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
      if (-not (Test-Path -LiteralPath $homesDataRoot -PathType Container)) {
        throw "Homes data not found: $homesDataRoot"
      }
      Assert-HomesRestoreLayout $homesDataRoot
      if ($Profile -eq 'pc-preprod-full') {
        Assert-IdentityBootstrapSecret
        if (-not (Test-Path -LiteralPath $identityDataRoot -PathType Container)) {
          throw "Identity data not found: $identityDataRoot"
        }
        Assert-IdentityRestoreLayout $identityDataRoot
      }
      New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
      $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
      $destination = Join-Path $backupRoot ("jarvis-{0}.database.jarvisdb" -f $stamp)
      $archive = Join-Path $backupRoot (".jarvis-{0}.identity.zip" -f $stamp)
      $encryptedIdentity = Join-Path $backupRoot ("jarvis-{0}.identity.zip.jarvisdb" -f $stamp)
      $homesArchive = Join-Path $backupRoot (".jarvis-{0}.homes.zip" -f $stamp)
      $encryptedHomes = Join-Path $backupRoot ("jarvis-{0}.homes.zip.jarvisdb" -f $stamp)
      $manifest = Join-Path $backupRoot (".jarvis-{0}.manifest.json" -f $stamp)
      $encryptedManifest = Join-Path $backupRoot ("jarvis-{0}.manifest.json.jarvisdb" -f $stamp)
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
        $manifestComponents = [ordered]@{
          database = Get-RestoreManifestComponent $destination
          homes = Get-RestoreManifestComponent $encryptedHomes
        }
        if ($Profile -eq 'pc-preprod-full') {
          $manifestComponents.identity = Get-RestoreManifestComponent $encryptedIdentity
        }
        $manifestPayload = [ordered]@{
          schemaVersion = 1
          backupId = $stamp
          createdAtUtc = [DateTime]::UtcNow.ToString('o')
          profile = $Profile
          components = $manifestComponents
        }
        [IO.File]::WriteAllText(
          $manifest,
          ($manifestPayload | ConvertTo-Json -Depth 6),
          [Text.UTF8Encoding]::new($false)
        )
        npm run db:conversation -- encrypt-file --source $manifest --destination $encryptedManifest
        if ($LASTEXITCODE -ne 0) { throw 'Encrypted backup manifest failed.' }
        Write-Host "Encrypted backup manifest created: $encryptedManifest" -ForegroundColor Green
        $backupSucceeded = $true
      } finally {
        if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
        if (Test-Path -LiteralPath $homesArchive) { Remove-Item -LiteralPath $homesArchive -Force }
        if (Test-Path -LiteralPath $manifest) { Remove-Item -LiteralPath $manifest -Force }
        if (-not $backupSucceeded) {
          if (Test-Path -LiteralPath $destination) { Remove-Item -LiteralPath $destination -Force }
          if (Test-Path -LiteralPath $encryptedHomes) { Remove-Item -LiteralPath $encryptedHomes -Force }
          if (Test-Path -LiteralPath $encryptedManifest) { Remove-Item -LiteralPath $encryptedManifest -Force }
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
      $manifestSource = $source -replace '\.database\.jarvisdb$', '.manifest.json.jarvisdb'
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
      $identityPreflight = Join-Path $runtimeRoot (".identity-restore-{0}" -f [Guid]::NewGuid().ToString('N'))
      $manifestPreflight = Join-Path $runtimeRoot (".manifest-restore-{0}.json" -f [Guid]::NewGuid().ToString('N'))
      try {
        npm run db:conversation -- secure-restore --source $source --destination $databasePreflight
        if ($LASTEXITCODE -ne 0) { throw 'Database backup preflight failed; no runtime data was changed.' }
        npm run db:conversation -- decrypt-file --source $homesSource --destination $homesArchive
        if ($LASTEXITCODE -ne 0) { throw 'Homes backup preflight decryption failed; no runtime data was changed.' }
        Expand-ValidatedArchive $homesArchive $homesPreflight
        Assert-HomesRestoreLayout $homesPreflight
        if ($Profile -eq 'pc-preprod-full') {
          npm run db:conversation -- decrypt-file --source $identitySource --destination $identityArchive
          if ($LASTEXITCODE -ne 0) { throw 'Identity backup preflight decryption failed; no runtime data was changed.' }
          Expand-ValidatedArchive $identityArchive $identityPreflight
          Assert-IdentityRestoreLayout $identityPreflight
        }
        if (Test-Path -LiteralPath $manifestSource -PathType Leaf) {
          npm run db:conversation -- decrypt-file --source $manifestSource --destination $manifestPreflight
          if ($LASTEXITCODE -ne 0) { throw 'Backup manifest decryption failed; no runtime data was changed.' }
          $manifestComponents = @{
            database = $source
            homes = $homesSource
          }
          if ($Profile -eq 'pc-preprod-full') { $manifestComponents.identity = $identitySource }
          Test-RestoreManifestIfPresent $manifestPreflight $Profile $manifestComponents | Out-Null
        } else {
          Write-Warning 'Legacy backup has no encrypted manifest; sibling names and component structure were validated, but cross-component hashes are unavailable.'
        }

        $operationId = [Guid]::NewGuid().ToString('N')
        $quarantineRoot = Assert-WithinRuntime (Join-Path $runtimeRoot "pc-preprod\restore-quarantine\$operationId")
        $journal = [ordered]@{
          schemaVersion = 1
          operationId = $operationId
          profile = $Profile
          backupFile = [IO.Path]::GetFileName($source)
          quarantineRoot = $quarantineRoot
          staging = [ordered]@{
            database = $databasePreflight
            homes = $homesPreflight
            identity = if ($Profile -eq 'pc-preprod-full') { $identityPreflight } else { $null }
          }
          state = 'prevalidated'
          startedAtUtc = [DateTime]::UtcNow.ToString('o')
        }
        Write-RestoreJournal $restoreJournalPath $journal
        $journal.state = 'stopping_runtime'
        Write-RestoreJournal $restoreJournalPath $journal
        try {
          Invoke-Compose @('down', '--remove-orphans')
        } catch {
          $journal.state = 'rolled_back'
          $journal.failure = $_.Exception.Message
          Write-RestoreJournal $restoreJournalPath $journal
          throw
        }
        New-Item -ItemType Directory -Path $dataRoot -Force | Out-Null
        $components = @(
          @{ Name = 'database'; Staged = $databasePreflight; Target = $databasePath },
          @{ Name = 'homes'; Staged = $homesPreflight; Target = $homesDataRoot }
        )
        foreach ($suffix in @('-wal', '-shm')) {
          $sidecar = "$databasePath$suffix"
          if (Test-Path -LiteralPath $sidecar) {
            $components += @{ Name = "database$suffix"; Staged = $null; Target = $sidecar }
          }
        }
        if ($Profile -eq 'pc-preprod-full') {
          $components += @{ Name = 'identity'; Staged = $identityPreflight; Target = $identityDataRoot }
        }
        $validateInstalled = {
          npm run db:conversation -- verify --source $databasePath
          if ($LASTEXITCODE -ne 0) { throw 'Installed database verification failed.' }
          Assert-HomesRestoreLayout $homesDataRoot
          if ($Profile -eq 'pc-preprod-full') { Assert-IdentityRestoreLayout $identityDataRoot }
        }
        $startRuntime = { Invoke-Compose @('up', '--detach', '--build', '--wait', '--wait-timeout', '120') }
        Invoke-ControlledRestoreInstallation `
          -JournalPath $restoreJournalPath `
          -Journal $journal `
          -Components $components `
          -QuarantineRoot $quarantineRoot `
          -ValidateInstalled $validateInstalled `
          -StartRuntime $startRuntime `
          -PrepareRollback { Invoke-Compose @('down', '--remove-orphans') } `
          -RestartPreviousRuntime $startRuntime
        Write-Host "Restore completed. Previous data retained under: $quarantineRoot" -ForegroundColor Green
      } finally {
        if (Test-Path -LiteralPath $databasePreflight) { Remove-Item -LiteralPath $databasePreflight -Force }
        if (Test-Path -LiteralPath $identityArchive) { Remove-Item -LiteralPath $identityArchive -Force }
        if (Test-Path -LiteralPath $homesArchive) { Remove-Item -LiteralPath $homesArchive -Force }
        if (Test-Path -LiteralPath $homesPreflight) { Remove-Item -LiteralPath $homesPreflight -Recurse -Force }
        if (Test-Path -LiteralPath $identityPreflight) { Remove-Item -LiteralPath $identityPreflight -Recurse -Force }
        if (Test-Path -LiteralPath $manifestPreflight) { Remove-Item -LiteralPath $manifestPreflight -Force }
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
  if ($runtimeOperationLock) { $runtimeOperationLock.Dispose() }
  Pop-Location
}
