param(
  [string]$HostIP = "192.168.1.38",
  [string]$Port = "8090",
  [string]$User = "loic",
  [string]$ApiKey = "",
  [string]$OutDir = ".\artifacts\prod-routing",
  [string]$ThreadId = "",
  [string]$JarvisVersionMarker = "",
  [string]$TestProfileVersion = "",
  [string]$ProbeProfilePath = ".\scripts\probe-profiles\routing-probes-v1.json",
  [int]$KeepRuns = 1,
  [int]$RetryCount = 2,
  [int]$RetryDelayMs = 700,
  [int]$ThreadsLimit = 20,
  [int]$ThreadHistoryLimit = 50,
  [bool]$FailOnEndpointFailure = $true,
  [bool]$FailOnCriticalProbeFailure = $true,
  [switch]$RunProbes,
  [switch]$SkipSshLogs
)

$ErrorActionPreference = "Stop"

function Get-EnvValue([string]$Path, [string]$Key) {
  if (-not (Test-Path $Path)) { return $null }
  $line = Get-Content -Path $Path | Where-Object { $_ -match "^\s*$([Regex]::Escape($Key))\s*=" } | Select-Object -First 1
  if (-not $line) { return $null }
  return (($line -split '=', 2)[1]).Trim()
}

function Resolve-ApiKey([string]$explicitApiKey) {
  if ($explicitApiKey -and $explicitApiKey.Trim().Length -gt 0) { return $explicitApiKey.Trim() }

  $fromApiKey = Get-EnvValue '.env' 'API_KEY'
  if ($fromApiKey) { return $fromApiKey }

  $fromApiKeys = Get-EnvValue '.env' 'API_KEYS'
  if ($fromApiKeys) {
    $first = (($fromApiKeys -split ',')[0]).Trim()
    if ($first) { return $first }
  }

  return ''
}

function New-OutputFolder([string]$basePath) {
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $rand = [Guid]::NewGuid().ToString('N').Substring(0, 8)
  $folder = Join-Path $basePath ("{0}-{1}" -f $stamp, $rand)
  New-Item -ItemType Directory -Path $folder -Force | Out-Null
  return $folder
}

function Get-GitCommitShort() {
  try {
    $value = (git rev-parse --short HEAD 2>$null)
    if ($value) { return $value.Trim() }
  } catch {}
  return "unknown"
}

function Get-GitBranch() {
  try {
    $value = (git branch --show-current 2>$null)
    if ($value) { return $value.Trim() }
  } catch {}
  return "unknown"
}

function Get-GitDescribe() {
  try {
    $value = (git describe --tags --always --dirty 2>$null)
    if ($value) { return $value.Trim() }
  } catch {}
  return "unknown"
}

function Get-PackageVersion() {
  try {
    $path = Join-Path (Get-Location).Path 'package.json'
    if (-not (Test-Path $path)) { return "unknown" }
    $pkg = Get-Content -Path $path -Raw | ConvertFrom-Json
    if ($pkg -and $pkg.version) { return [string]$pkg.version }
  } catch {}
  return "unknown"
}

function Resolve-JarvisVersionMarker([string]$explicit, [string]$gitDescribe, [string]$pkgVersion, [string]$gitCommit) {
  if ($explicit -and $explicit.Trim().Length -gt 0) {
    return @{ marker = $explicit.Trim(); source = 'param' }
  }
  if ($gitDescribe -and $gitDescribe -ne 'unknown') {
    return @{ marker = $gitDescribe; source = 'git_describe' }
  }
  if ($pkgVersion -and $pkgVersion -ne 'unknown') {
    return @{ marker = ("pkg-{0}@{1}" -f $pkgVersion, $gitCommit); source = 'package_json' }
  }
  return @{ marker = $gitCommit; source = 'git_commit' }
}

function Save-Json([string]$path, $obj) {
  $json = $obj | ConvertTo-Json -Depth 30
  Save-Text $path $json
}

function Save-Text([string]$path, [string]$text) {
  $dir = Split-Path -Path $path -Parent
  if ($dir -and -not (Test-Path $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }

  $tmp = "{0}.{1}.tmp" -f $path, ([Guid]::NewGuid().ToString('N'))
  Set-Content -Path $tmp -Value $text -Encoding UTF8
  Move-Item -Path $tmp -Destination $path -Force
}

function Parse-JsonSafe([string]$raw) {
  try {
    if (-not $raw) { return $null }
    return ($raw | ConvertFrom-Json)
  } catch {
    return $null
  }
}

function Value-OrDefault($value, $defaultValue) {
  if ($null -eq $value) { return $defaultValue }
  return $value
}

function To-Bool($value, [bool]$defaultValue = $false) {
  if ($null -eq $value) { return $defaultValue }
  if ($value -is [bool]) { return [bool]$value }
  $asText = [string]$value
  if ([string]::IsNullOrWhiteSpace($asText)) { return $defaultValue }
  if ($asText -match '^(1|true|yes|y)$') { return $true }
  if ($asText -match '^(0|false|no|n)$') { return $false }
  return $defaultValue
}

function Is-TransientFailure([string]$errorMessage, [int]$statusCode) {
  if ($statusCode -in @(408, 429, 500, 502, 503, 504)) { return $true }
  $low = ""
  if (-not [string]::IsNullOrWhiteSpace($errorMessage)) {
    $low = $errorMessage.ToLowerInvariant()
  }
  if ($low -match "timed out|timeout|aborted|connection|network|unreachable|refused|temporary") { return $true }
  return $false
}

function Invoke-WithRetry([scriptblock]$operation, [int]$retryCount, [int]$retryDelayMs) {
  $attempt = 0
  while ($true) {
    $attempt += 1
    $result = & $operation
    if ($result.ok) {
      $result.attempts = $attempt
      return $result
    }

    $transient = Is-TransientFailure -errorMessage (Value-OrDefault $result.error "") -statusCode (Value-OrDefault $result.statusCode 0)
    if (-not $transient -or $attempt -gt $retryCount) {
      $result.attempts = $attempt
      return $result
    }

    Start-Sleep -Milliseconds $retryDelayMs
  }
}

function Invoke-JarvisGet([string]$url, [hashtable]$headers, [int]$retryCount, [int]$retryDelayMs) {
  return Invoke-WithRetry -retryCount $retryCount -retryDelayMs $retryDelayMs -operation {
    try {
      $resp = Invoke-WebRequest -Uri $url -Method Get -Headers $headers -UseBasicParsing -TimeoutSec 30
      $raw = [string]$resp.Content
      $parsed = Parse-JsonSafe $raw
      return @{ ok = $true; statusCode = [int]$resp.StatusCode; data = $parsed; raw = $raw }
    } catch {
      $statusCode = 0
      $rawError = ""
      try {
        $response = $_.Exception.Response
        if ($response -and $response.StatusCode) { $statusCode = [int]$response.StatusCode }
        if ($response -and $response.GetResponseStream) {
          $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
          $rawError = $reader.ReadToEnd()
          $reader.Dispose()
        }
      } catch {}
      return @{ ok = $false; statusCode = $statusCode; error = $_.Exception.Message; raw = $rawError }
    }
  }
}

function Invoke-JarvisPost([string]$url, [hashtable]$headers, $bodyObj, [int]$retryCount, [int]$retryDelayMs) {
  return Invoke-WithRetry -retryCount $retryCount -retryDelayMs $retryDelayMs -operation {
    try {
      $body = $bodyObj | ConvertTo-Json -Depth 20
      $resp = Invoke-WebRequest -Uri $url -Method Post -Headers $headers -ContentType 'application/json' -Body $body -UseBasicParsing -TimeoutSec 45
      $raw = [string]$resp.Content
      $parsed = Parse-JsonSafe $raw
      return @{ ok = $true; statusCode = [int]$resp.StatusCode; data = $parsed; raw = $raw; body = $bodyObj }
    } catch {
      $statusCode = 0
      $rawError = ""
      try {
        $response = $_.Exception.Response
        if ($response -and $response.StatusCode) { $statusCode = [int]$response.StatusCode }
        if ($response -and $response.GetResponseStream) {
          $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
          $rawError = $reader.ReadToEnd()
          $reader.Dispose()
        }
      } catch {}
      return @{ ok = $false; statusCode = $statusCode; error = $_.Exception.Message; raw = $rawError; body = $bodyObj }
    }
  }
}

function Capture-ThreadsSnapshot([string]$prefix, [string]$baseUrl, [hashtable]$headers, [string]$threadIdHint, [string]$outputFolder, [int]$threadsLimit, [int]$historyLimit, [int]$retryCount, [int]$retryDelayMs) {
  $result = [ordered]@{
    prefix = $prefix
    threads = "skipped"
    thread_history = "skipped"
    selected_thread_id = $threadIdHint
  }

  $threads = Invoke-JarvisGet "$baseUrl/v1/threads?limit=$threadsLimit" $headers $retryCount $retryDelayMs
  $result.threads = if ($threads.ok) { "ok" } else { "error" }
  if ($threads.ok) {
    Save-Json (Join-Path $outputFolder "$prefix-threads.json") $threads.data
    $items = @()
    if ($threads.data -and $threads.data.items) { $items = @($threads.data.items) }
    if (-not $threadIdHint -and $items.Count -gt 0) {
      $result.selected_thread_id = [string]$items[0].threadId
    }
  } else {
    Save-Text (Join-Path $outputFolder "$prefix-threads.error.txt") ("{0}`n{1}" -f $threads.error, (Value-OrDefault $threads.raw ""))
  }

  if ($result.selected_thread_id) {
    $historyUrl = "$baseUrl/v1/threads/$($result.selected_thread_id)/history?limit=$historyLimit"
    $history = Invoke-JarvisGet $historyUrl $headers $retryCount $retryDelayMs
    $result.thread_history = if ($history.ok) { "ok" } else { "error" }
    if ($history.ok) {
      Save-Json (Join-Path $outputFolder "$prefix-thread-history-$($result.selected_thread_id).json") $history.data
    } else {
      Save-Text (Join-Path $outputFolder "$prefix-thread-history-$($result.selected_thread_id).error.txt") ("{0}`n{1}" -f $history.error, (Value-OrDefault $history.raw ""))
    }
  }

  return $result
}

function Normalize-IndexEntry($raw) {
  if ($null -eq $raw) { return $null }

  $runId = [string](Value-OrDefault $raw.run_id "")
  if (-not $runId) { return $null }

  $jarvisVersionMarker = [string](Value-OrDefault $raw.jarvis_version_marker "")
  if (-not $jarvisVersionMarker) {
    $legacyCommit = [string](Value-OrDefault $raw.jarvis_git_commit (Value-OrDefault $raw.git_commit ""))
    if ($legacyCommit) {
      $jarvisVersionMarker = $legacyCommit
    } else {
      $jarvisVersionMarker = "unknown"
    }
  }

  return [ordered]@{
    generated_at = [string](Value-OrDefault $raw.generated_at "")
    run_id = $runId
    jarvis_version_marker = $jarvisVersionMarker
    jarvis_version_source = [string](Value-OrDefault $raw.jarvis_version_source "unknown")
    jarvis_git_commit = [string](Value-OrDefault $raw.jarvis_git_commit (Value-OrDefault $raw.git_commit "unknown"))
    jarvis_git_branch = [string](Value-OrDefault $raw.jarvis_git_branch (Value-OrDefault $raw.git_branch "unknown"))
    jarvis_package_version = [string](Value-OrDefault $raw.jarvis_package_version "unknown")
    test_profile_version = [string](Value-OrDefault $raw.test_profile_version (Value-OrDefault $raw.probe_set_version "unknown"))
    base_url = [string](Value-OrDefault $raw.base_url "")
    output_folder = [string](Value-OrDefault $raw.output_folder "")
    endpoints = (Value-OrDefault $raw.endpoints @{})
  }
}

function Update-RunIndex([string]$baseDir, [hashtable]$entry) {
  $indexPath = Join-Path $baseDir "index.json"
  $items = @()

  if (Test-Path $indexPath) {
    $existing = Parse-JsonSafe (Get-Content -Path $indexPath -Raw)
    if ($existing -and $existing.items) {
      foreach ($item in @($existing.items)) {
        $normalized = Normalize-IndexEntry $item
        if ($normalized) { $items += $normalized }
      }
    }
  }

  $items = @($entry) + @($items | Where-Object { $_.run_id -ne $entry.run_id })
  if ($items.Count -gt 200) { $items = $items[0..199] }

  $indexDoc = [ordered]@{
    updated_at = (Get-Date).ToString('o')
    items = $items
  }
  Save-Json $indexPath $indexDoc
}

function Get-RunDirectories([string]$baseDir) {
  if (-not (Test-Path $baseDir)) { return @() }
  return @(Get-ChildItem -Path $baseDir -Directory | Where-Object { $_.Name -match '^\d{8}-\d{6}(-[0-9a-f]{8})?$' } | Sort-Object Name -Descending)
}

function Is-SafeRunDirectory([string]$baseDir, $dir) {
  if ($null -eq $dir) { return $false }
  if (-not $dir.Name -or $dir.Name -notmatch '^\d{8}-\d{6}(-[0-9a-f]{8})?$') { return $false }

  $baseFull = [System.IO.Path]::GetFullPath($baseDir)
  $dirFull = [System.IO.Path]::GetFullPath($dir.FullName)
  if (-not $dirFull.StartsWith($baseFull, [System.StringComparison]::OrdinalIgnoreCase)) { return $false }

  return $true
}

function Prune-OldRuns([string]$baseDir, [int]$keepRuns) {
  if ($keepRuns -lt 1) { $keepRuns = 1 }

  $runDirs = Get-RunDirectories $baseDir
  if ($runDirs.Count -le $keepRuns) { return @() }

  $toRemove = @($runDirs | Select-Object -Skip $keepRuns)
  $deleted = @()
  foreach ($dir in $toRemove) {
    if (-not $dir.Name -or $dir.Name -notmatch '^\d{8}-\d{6}(-[0-9a-f]{8})?$') { continue }

    Remove-Item -Path $dir.FullName -Recurse -Force -ErrorAction Stop
    $deleted += $dir.Name
  }

  return $deleted
}

function Rebuild-IndexFromExistingRuns([string]$baseDir) {
  $indexPath = Join-Path $baseDir "index.json"
  $runDirs = Get-RunDirectories $baseDir
  $items = @()

  foreach ($dir in $runDirs) {
    $reportPath = Join-Path $dir.FullName "report.json"
    if (-not (Test-Path $reportPath)) { continue }

    $report = Parse-JsonSafe (Get-Content -Path $reportPath -Raw)
    if (-not $report) { continue }

    $items += [ordered]@{
      generated_at = [string](Value-OrDefault $report.generated_at "")
      run_id = [string](Value-OrDefault $report.run_id $dir.Name)
      jarvis_version_marker = [string](Value-OrDefault $report.jarvis_version_marker "unknown")
      jarvis_version_source = [string](Value-OrDefault $report.jarvis_version_source "unknown")
      jarvis_git_commit = [string](Value-OrDefault $report.jarvis_git_commit "unknown")
      jarvis_git_branch = [string](Value-OrDefault $report.jarvis_git_branch "unknown")
      jarvis_package_version = [string](Value-OrDefault $report.jarvis_package_version "unknown")
      test_profile_version = [string](Value-OrDefault $report.test_profile_version "unknown")
      base_url = [string](Value-OrDefault $report.base_url "")
      output_folder = [string](Value-OrDefault $report.output_folder (Join-Path '.\artifacts\prod-routing' $dir.Name))
      endpoints = (Value-OrDefault $report.endpoints @{})
    }
  }

  $doc = [ordered]@{
    updated_at = (Get-Date).ToString('o')
    items = $items
  }
  Save-Json $indexPath $doc
}

function Read-ProbeProfile([string]$path) {
  if (-not (Test-Path $path)) {
    throw "Probe profile not found: $path"
  }

  $raw = Get-Content -Path $path -Raw
  $doc = Parse-JsonSafe $raw
  if (-not $doc) {
    throw "Probe profile is invalid JSON: $path"
  }

  $profileId = [string](Value-OrDefault $doc.profile_id "custom")
  $profileVersion = [string](Value-OrDefault $doc.profile_version "unknown")
  $tests = @()

  foreach ($item in @($doc.tests)) {
    $id = [string](Value-OrDefault $item.id "")
    $text = [string](Value-OrDefault $item.text "")
    if (-not $id -or -not $text) { continue }

    $tests += [ordered]@{
      id = $id
      text = $text
      critical = (To-Bool (Value-OrDefault $item.critical $true) $true)
      expected_reply_meta_kind = [string](Value-OrDefault $item.expected_reply_meta_kind "")
      expected_reply_meta_source = [string](Value-OrDefault $item.expected_reply_meta_source "")
    }
  }

  if ($tests.Count -eq 0) {
    throw "Probe profile has no valid tests: $path"
  }

  return [ordered]@{
    profile_id = $profileId
    profile_version = $profileVersion
    tests = $tests
  }
}

function Get-PreviousReport([string]$baseDir) {
  $latestPath = Join-Path $baseDir 'latest.json'
  if (-not (Test-Path $latestPath)) { return $null }

  $latest = Parse-JsonSafe (Get-Content -Path $latestPath -Raw)
  if (-not $latest) { return $null }

  $reportFile = [string](Value-OrDefault $latest.report_file "")
  if (-not $reportFile -or -not (Test-Path $reportFile)) { return $null }

  return Parse-JsonSafe (Get-Content -Path $reportFile -Raw)
}

function Compute-ProbeStats($probes) {
  $total = 0
  $ok = 0
  $failed = 0
  $criticalFailed = 0
  $retryCountTotal = 0

  foreach ($p in @($probes)) {
    if ($null -eq $p) { continue }
    $total += 1
    $isOk = To-Bool (Value-OrDefault $p.ok $false) $false
    $isCritical = To-Bool (Value-OrDefault $p.critical $false) $false
    $attempts = [int](Value-OrDefault $p.attempts 1)

    if ($isOk) { $ok += 1 } else { $failed += 1 }
    if (-not $isOk -and $isCritical) { $criticalFailed += 1 }
    if ($attempts -gt 1) { $retryCountTotal += ($attempts - 1) }
  }

  $successRate = 0.0
  if ($total -gt 0) { $successRate = [Math]::Round(($ok * 100.0) / $total, 2) }

  $retryRate = 0.0
  if ($total -gt 0) { $retryRate = [Math]::Round(($retryCountTotal * 100.0) / $total, 2) }

  return [ordered]@{
    total_probes = $total
    probes_ok = $ok
    probes_failed = $failed
    critical_probes_failed = $criticalFailed
    success_rate_pct = $successRate
    retry_count_total = $retryCountTotal
    retry_rate_pct = $retryRate
  }
}

function Compute-EndpointsFailedCount($endpoints) {
  $count = 0
  foreach ($k in $endpoints.Keys) {
    if ([string]$endpoints[$k] -ne 'ok') { $count += 1 }
  }
  return $count
}

function Compute-Regression($previousReport, $currentReport) {
  if (-not $previousReport) {
    return [ordered]@{
      has_previous = $false
      message = 'no_previous_run'
    }
  }

  $prevStats = Compute-ProbeStats (Value-OrDefault $previousReport.probes @())
  $currStats = Compute-ProbeStats (Value-OrDefault $currentReport.probes @())

  $prevEndpointsFailed = Compute-EndpointsFailedCount (Value-OrDefault $previousReport.endpoints @{})
  $currEndpointsFailed = Compute-EndpointsFailedCount (Value-OrDefault $currentReport.endpoints @{})

  return [ordered]@{
    has_previous = $true
    previous_run_id = [string](Value-OrDefault $previousReport.run_id "")
    previous_jarvis_version_marker = [string](Value-OrDefault $previousReport.jarvis_version_marker "")
    current_run_id = [string](Value-OrDefault $currentReport.run_id "")
    current_jarvis_version_marker = [string](Value-OrDefault $currentReport.jarvis_version_marker "")
    probes_ok_delta = ([int]$currStats.probes_ok - [int]$prevStats.probes_ok)
    probes_failed_delta = ([int]$currStats.probes_failed - [int]$prevStats.probes_failed)
    critical_failed_delta = ([int]$currStats.critical_probes_failed - [int]$prevStats.critical_probes_failed)
    success_rate_pct_delta = [Math]::Round(([double]$currStats.success_rate_pct - [double]$prevStats.success_rate_pct), 2)
    endpoints_failed_delta = ([int]$currEndpointsFailed - [int]$prevEndpointsFailed)
  }
}

function Compute-Confidence($report) {
  $score = 100

  if ([string](Value-OrDefault $report.endpoints.health '') -ne 'ok') { $score -= 25 }
  if ([string](Value-OrDefault $report.endpoints.stats '') -ne 'ok') { $score -= 25 }
  if ([string](Value-OrDefault $report.endpoints.ssh_logs '') -ne 'ok') { $score -= 10 }

  $probeStats = Compute-ProbeStats (Value-OrDefault $report.probes @())
  $score -= ([int]$probeStats.critical_probes_failed * 20)
  $score -= (([int]$probeStats.probes_failed - [int]$probeStats.critical_probes_failed) * 5)

  if ([double]$probeStats.retry_rate_pct -ge 30.0) { $score -= 5 }

  if ($score -lt 0) { $score = 0 }
  if ($score -gt 100) { $score = 100 }

  $grade = 'A'
  if ($score -lt 90) { $grade = 'B' }
  if ($score -lt 75) { $grade = 'C' }
  if ($score -lt 60) { $grade = 'D' }
  if ($score -lt 40) { $grade = 'E' }

  return [ordered]@{
    score = $score
    grade = $grade
  }
}

if (-not $PSBoundParameters.ContainsKey('RunProbes')) {
  $RunProbes = $true
}

$probeProfile = Read-ProbeProfile $ProbeProfilePath
if (-not $TestProfileVersion -or [string]::IsNullOrWhiteSpace($TestProfileVersion)) {
  $TestProfileVersion = [string]$probeProfile.profile_version
}

$previousReport = Get-PreviousReport $OutDir
$resolvedApiKey = Resolve-ApiKey $ApiKey
$headers = @{}
if ($resolvedApiKey) { $headers['X-API-Key'] = $resolvedApiKey }

$baseUrl = "http://$HostIP`:$Port"
$outputFolder = New-OutputFolder $OutDir
$runId = Split-Path -Path $outputFolder -Leaf
$gitCommit = Get-GitCommitShort
$gitBranch = Get-GitBranch
$gitDescribe = Get-GitDescribe
$jarvisPackageVersion = Get-PackageVersion
$jarvisVersionResolution = Resolve-JarvisVersionMarker $JarvisVersionMarker $gitDescribe $jarvisPackageVersion $gitCommit
$jarvisVersion = [string]$jarvisVersionResolution.marker
$jarvisVersionSource = [string]$jarvisVersionResolution.source

Write-Host "[prod-collect] output: $outputFolder" -ForegroundColor Cyan
Write-Host "[prod-collect] target: $baseUrl" -ForegroundColor Cyan
Write-Host "[prod-collect] api key: $([bool]$resolvedApiKey)" -ForegroundColor Cyan
Write-Host "[prod-collect] jarvis version: $jarvisVersion ($jarvisVersionSource)" -ForegroundColor Cyan
Write-Host "[prod-collect] probe profile: $($probeProfile.profile_id)@$($probeProfile.profile_version)" -ForegroundColor Cyan

$report = [ordered]@{
  generated_at = (Get-Date).ToString("o")
  run_id = $runId
  jarvis_version_marker = $jarvisVersion
  jarvis_version_source = $jarvisVersionSource
  jarvis_git_commit = $gitCommit
  jarvis_git_branch = $gitBranch
  jarvis_git_describe = $gitDescribe
  jarvis_package_version = $jarvisPackageVersion
  test_profile_id = [string]$probeProfile.profile_id
  test_profile_version = $TestProfileVersion
  tests = $probeProfile.tests
  base_url = $baseUrl
  api_key_present = [bool]$resolvedApiKey
  probes_enabled = [bool]$RunProbes
  endpoints = @{}
  snapshots = @{}
  probes = @()
  latest_thread_id = $null
  output_folder = $outputFolder
  analysis = @{}
}

$marker = [ordered]@{
  marker_type = "jarvis-version-evidence"
  schema_version = "2.0"
  jarvis_version_marker = $jarvisVersion
  jarvis_version_source = $jarvisVersionSource
  jarvis_git_commit = $gitCommit
  jarvis_git_branch = $gitBranch
  jarvis_git_describe = $gitDescribe
  jarvis_package_version = $jarvisPackageVersion
  test_profile_id = [string]$probeProfile.profile_id
  test_profile_version = $TestProfileVersion
  tests = $probeProfile.tests
  run_id = $runId
  generated_at = $report.generated_at
  base_url = $baseUrl
}
Save-Json (Join-Path $outputFolder "jarvis.version.marker.json") $marker

$health = Invoke-JarvisGet "$baseUrl/health" $headers $RetryCount $RetryDelayMs
$report.endpoints.health = if ($health.ok) { "ok" } else { "error" }
if ($health.ok) {
  Save-Json (Join-Path $outputFolder "health.json") $health.data
} else {
  Save-Text (Join-Path $outputFolder "health.error.txt") ("{0}`n{1}" -f $health.error, (Value-OrDefault $health.raw ""))
}

$stats = Invoke-JarvisGet "$baseUrl/v1/stats" $headers $RetryCount $RetryDelayMs
$report.endpoints.stats = if ($stats.ok) { "ok" } else { "error" }
if ($stats.ok) {
  Save-Json (Join-Path $outputFolder "stats.json") $stats.data
} else {
  Save-Text (Join-Path $outputFolder "stats.error.txt") ("{0}`n{1}" -f $stats.error, (Value-OrDefault $stats.raw ""))
}

$preSnapshot = Capture-ThreadsSnapshot "pre" $baseUrl $headers $ThreadId $outputFolder $ThreadsLimit $ThreadHistoryLimit $RetryCount $RetryDelayMs
$report.snapshots.pre = $preSnapshot
if (-not $ThreadId -and $preSnapshot.selected_thread_id) { $ThreadId = $preSnapshot.selected_thread_id }
$report.latest_thread_id = $ThreadId

if ($RunProbes) {
  $probeThread = if ($ThreadId) { $ThreadId } else { "prod-routing-probe-$(Get-Date -Format 'yyyyMMddHHmmss')" }
  $report.probe_thread_id = $probeThread

  $idx = 1
  foreach ($testCase in @($probeProfile.tests)) {
    $probeText = [string]$testCase.text
    $testId = [string]$testCase.id
    $testCritical = To-Bool (Value-OrDefault $testCase.critical $true) $true
    $expectedKind = [string](Value-OrDefault $testCase.expected_reply_meta_kind "")
    $expectedSource = [string](Value-OrDefault $testCase.expected_reply_meta_source "")

    $payload = @{
      threadId = $probeThread
      text = $probeText
      clientContext = @{ channel = "desktop" }
      correlation_id = "prod-routing-probe-$testId-$runId-$idx"
      user_id = "prod-analyzer"
    }

    $probe = Invoke-JarvisPost "$baseUrl/v1/ingest" $headers $payload $RetryCount $RetryDelayMs

    $actualKind = ""
    $actualSource = ""
    if ($probe.ok -and $probe.data -and $probe.data.replyMeta) {
      $actualKind = [string](Value-OrDefault $probe.data.replyMeta.kind "")
      $actualSource = [string](Value-OrDefault $probe.data.replyMeta.source "")
    }

    $kindOk = $true
    if ($expectedKind) { $kindOk = ($expectedKind -eq $actualKind) }

    $sourceOk = $true
    if ($expectedSource) { $sourceOk = ($expectedSource -eq $actualSource) }

    $expectationsOk = ($kindOk -and $sourceOk)
    $effectiveOk = ([bool]$probe.ok -and $expectationsOk)

    $record = [ordered]@{
      index = $idx
      test_id = $testId
      text = $probeText
      critical = $testCritical
      correlation_id = $payload.correlation_id
      request_ok = [bool]$probe.ok
      expectations_ok = [bool]$expectationsOk
      ok = [bool]$effectiveOk
      expected_reply_meta_kind = $expectedKind
      expected_reply_meta_source = $expectedSource
      actual_reply_meta_kind = $actualKind
      actual_reply_meta_source = $actualSource
      output_file = "probe-$idx.json"
      status_code = (Value-OrDefault $probe.statusCode 0)
      attempts = (Value-OrDefault $probe.attempts 1)
    }

    if ($probe.ok) {
      Save-Json (Join-Path $outputFolder "probe-$idx.json") $probe.data
    } else {
      Save-Text (Join-Path $outputFolder "probe-$idx.error.txt") ("{0}`n{1}" -f $probe.error, (Value-OrDefault $probe.raw ""))
      $record.error = $probe.error
    }

    if (-not $expectationsOk) {
      $record.error = "probe_expectation_mismatch"
    }

    $report.probes += $record
    $idx += 1
  }

  $postSnapshot = Capture-ThreadsSnapshot "post" $baseUrl $headers $probeThread $outputFolder $ThreadsLimit $ThreadHistoryLimit $RetryCount $RetryDelayMs
  $report.snapshots.post = $postSnapshot
}

if (-not $SkipSshLogs) {
  $sshExe = 'C:\Windows\System32\OpenSSH\ssh.exe'
  if (-not (Test-Path $sshExe)) { $sshExe = 'ssh.exe' }

  try {
    $logCommand = @'
set -e
cd /opt/naas/stacks/home-assistant
docker logs home-assistant-jarvis-1 --tail 900 2>&1
'@
    $allLogs = ($logCommand | & $sshExe -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$User@$HostIP" "tr -d '\r' | bash -s")
    Save-Text (Join-Path $outputFolder "jarvis.logs.tail900.log") ($allLogs -join [Environment]::NewLine)

    $focus = $allLogs | Select-String -Pattern 'semantic_router_|ingest_complete|ingest_routing_trace|mail_followup_|spotify_deterministic_gate_|ha_agent_router_|multi_intent' -CaseSensitive:$false
    $focusLines = $focus | ForEach-Object { $_.Line }
    Save-Text (Join-Path $outputFolder "jarvis.logs.focus.log") ($focusLines -join [Environment]::NewLine)
    $report.endpoints.ssh_logs = "ok"
  } catch {
    $report.endpoints.ssh_logs = "error"
    Save-Text (Join-Path $outputFolder "jarvis.logs.error.txt") $_.Exception.Message
  }
}

$probeStats = Compute-ProbeStats (Value-OrDefault $report.probes @())
$endpointsFailedCount = Compute-EndpointsFailedCount (Value-OrDefault $report.endpoints @{})
$regression = Compute-Regression $previousReport $report
$confidence = Compute-Confidence $report

$report.analysis = [ordered]@{
  kpis = [ordered]@{
    endpoints_failed_count = $endpointsFailedCount
    total_probes = $probeStats.total_probes
    probes_ok = $probeStats.probes_ok
    probes_failed = $probeStats.probes_failed
    critical_probes_failed = $probeStats.critical_probes_failed
    success_rate_pct = $probeStats.success_rate_pct
    retry_count_total = $probeStats.retry_count_total
    retry_rate_pct = $probeStats.retry_rate_pct
  }
  regression = $regression
  confidence = $confidence
}

$shouldFail = $false
$failureReasons = @()
if ($FailOnEndpointFailure -and $endpointsFailedCount -gt 0) {
  $shouldFail = $true
  $failureReasons += "endpoint_failure"
}
if ($FailOnCriticalProbeFailure -and [int]$probeStats.critical_probes_failed -gt 0) {
  $shouldFail = $true
  $failureReasons += "critical_probe_failure"
}

$report.analysis.outcome = if ($shouldFail) { 'fail' } else { 'pass' }
$report.analysis.failure_reasons = $failureReasons

Save-Json (Join-Path $outputFolder "report.json") $report

$indexEntry = [ordered]@{
  generated_at = $report.generated_at
  run_id = $report.run_id
  jarvis_version_marker = $report.jarvis_version_marker
  jarvis_version_source = $report.jarvis_version_source
  jarvis_git_commit = $report.jarvis_git_commit
  jarvis_git_branch = $report.jarvis_git_branch
  jarvis_package_version = $report.jarvis_package_version
  test_profile_version = $report.test_profile_version
  base_url = $report.base_url
  output_folder = $report.output_folder
  endpoints = $report.endpoints
}
Update-RunIndex -baseDir $OutDir -entry $indexEntry

$latest = [ordered]@{
  updated_at = (Get-Date).ToString('o')
  run_id = $report.run_id
  jarvis_version_marker = $report.jarvis_version_marker
  output_folder = $report.output_folder
  report_file = (Join-Path $report.output_folder 'report.json')
  marker_file = (Join-Path $report.output_folder 'jarvis.version.marker.json')
}
Save-Json (Join-Path $OutDir "latest.json") $latest

$deletedRuns = Prune-OldRuns -baseDir $OutDir -keepRuns $KeepRuns
Rebuild-IndexFromExistingRuns -baseDir $OutDir
if ($deletedRuns.Count -gt 0) {
  Write-Host "[prod-collect] pruned runs: $($deletedRuns -join ', ')" -ForegroundColor Yellow
}

Write-Host "[prod-collect] done" -ForegroundColor Green
Write-Host "[prod-collect] report: $(Join-Path $outputFolder 'report.json')" -ForegroundColor Green

if ($shouldFail) {
  throw ("[prod-collect] run marked as FAIL ({0})" -f ($failureReasons -join ', '))
}
