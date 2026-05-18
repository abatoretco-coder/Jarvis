param(
  [string]$OutDir = ".\artifacts\prod-routing",
  [string]$RunId = "",
  [string]$OutputFile = ""
)

$ErrorActionPreference = "Stop"

function Parse-JsonSafe([string]$raw) {
  try {
    if (-not $raw) { return $null }
    return ($raw | ConvertFrom-Json)
  } catch {
    return $null
  }
}

$targetRunId = $RunId
if (-not $targetRunId) {
  $latestPath = Join-Path $OutDir 'latest.json'
  if (-not (Test-Path $latestPath)) {
    throw "latest.json not found: $latestPath"
  }
  $latest = Parse-JsonSafe (Get-Content -Path $latestPath -Raw)
  if (-not $latest -or -not $latest.run_id) {
    throw "Invalid latest.json (run_id missing)"
  }
  $targetRunId = [string]$latest.run_id
}

$runDir = Join-Path $OutDir $targetRunId
$focusLogPath = Join-Path $runDir 'jarvis.logs.focus.log'
$reportPath = Join-Path $runDir 'report.json'

if (-not (Test-Path $focusLogPath)) {
  throw "Focus log not found: $focusLogPath"
}
if (-not (Test-Path $reportPath)) {
  throw "report.json not found: $reportPath"
}

$focusLines = Get-Content -Path $focusLogPath
$report = Parse-JsonSafe (Get-Content -Path $reportPath -Raw)

$routerStartCount = @($focusLines | Select-String -Pattern 'ha_agent_router_start').Count
$routerDoneCount = @($focusLines | Select-String -Pattern 'ha_agent_router_done').Count
$routerAbortCount = @($focusLines | Select-String -Pattern 'ha_agent_router_failed_fallback_general').Count
$routingTraceCount = @($focusLines | Select-String -Pattern 'ingest_routing_trace').Count
$weatherLockAppliedCount = @($focusLines | Select-String -Pattern '"local_weather_search_removed":true').Count

$ingestElapsedMs = @()
foreach ($line in $focusLines) {
  if ($line -match '"elapsed_ms":(\d+)') {
    $ingestElapsedMs += [int]$Matches[1]
  }
}

$p95 = 0
if ($ingestElapsedMs.Count -gt 0) {
  $sorted = $ingestElapsedMs | Sort-Object
  $idx = [int][Math]::Floor($sorted.Count * 0.95)
  if ($idx -ge $sorted.Count) { $idx = $sorted.Count - 1 }
  $p95 = [int]$sorted[$idx]
}

$summary = [ordered]@{
  generated_at = (Get-Date).ToString('o')
  run_id = $targetRunId
  report_output_folder = [string]$report.output_folder
  probes_enabled = [bool]$report.probes_enabled
  counts = [ordered]@{
    router_start = $routerStartCount
    router_done = $routerDoneCount
    router_abort = $routerAbortCount
    routing_trace = $routingTraceCount
    weather_lock_applied = $weatherLockAppliedCount
  }
  ingest_elapsed_p95_ms_from_focus_log = $p95
  risk_flags = @(
    if ($routerAbortCount -gt 0) { 'router_timeouts_present' }
    if ($weatherLockAppliedCount -eq 0) { 'no_weather_lock_applied' }
    if ($routingTraceCount -eq 0) { 'routing_trace_missing' }
  )
}

$json = $summary | ConvertTo-Json -Depth 20
if ($OutputFile -and $OutputFile.Trim().Length -gt 0) {
  Set-Content -Path $OutputFile -Value $json -Encoding UTF8
  Write-Host "[routing-evidence] output: $OutputFile" -ForegroundColor Green
} else {
  Write-Output $json
}
