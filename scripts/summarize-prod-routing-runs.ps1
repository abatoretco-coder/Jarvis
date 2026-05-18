param(
  [string]$OutDir = ".\artifacts\prod-routing",
  [int]$MaxRuns = 20,
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

function Get-RunDirectories([string]$baseDir) {
  if (-not (Test-Path $baseDir)) { return @() }
  return @(Get-ChildItem -Path $baseDir -Directory | Where-Object { $_.Name -match '^\d{8}-\d{6}(-[0-9a-f]{8})?$' } | Sort-Object Name -Descending)
}

$runs = Get-RunDirectories $OutDir | Select-Object -First $MaxRuns
$items = @()

foreach ($run in $runs) {
  $reportPath = Join-Path $run.FullName 'report.json'
  if (-not (Test-Path $reportPath)) { continue }

  $report = Parse-JsonSafe (Get-Content -Path $reportPath -Raw)
  if (-not $report) { continue }

  $kpis = $null
  if ($report.analysis -and $report.analysis.kpis) {
    $kpis = $report.analysis.kpis
  }

  $outcome = ''
  if ($report.analysis) {
    $outcome = [string]$report.analysis.outcome
  }
  if (-not $outcome) { $outcome = 'unknown' }

  $confidenceScore = $null
  if ($report.analysis -and $report.analysis.confidence -and $null -ne $report.analysis.confidence.score) {
    $confidenceScore = [int]$report.analysis.confidence.score
  }

  $endpointsFailedCount = 0
  $probesOk = 0
  $probesFailed = 0
  $criticalProbesFailed = 0
  $successRatePct = 0
  $retryRatePct = 0

  if ($kpis) {
    $endpointsFailedCount = [int]$kpis.endpoints_failed_count
    $probesOk = [int]$kpis.probes_ok
    $probesFailed = [int]$kpis.probes_failed
    $criticalProbesFailed = [int]$kpis.critical_probes_failed
    $successRatePct = [double]$kpis.success_rate_pct
    $retryRatePct = [double]$kpis.retry_rate_pct
  }

  $items += [ordered]@{
    run_id = [string]$report.run_id
    generated_at = [string]$report.generated_at
    jarvis_version_marker = [string]$report.jarvis_version_marker
    test_profile_version = [string]$report.test_profile_version
    outcome = $outcome
    confidence_score = $confidenceScore
    endpoints_failed_count = $endpointsFailedCount
    probes_ok = $probesOk
    probes_failed = $probesFailed
    critical_probes_failed = $criticalProbesFailed
    success_rate_pct = $successRatePct
    retry_rate_pct = $retryRatePct
  }
}

$total = $items.Count
$passed = @($items | Where-Object { $_.outcome -eq 'pass' }).Count
$failed = @($items | Where-Object { $_.outcome -eq 'fail' }).Count
$unknown = @($items | Where-Object { $_.outcome -eq 'unknown' }).Count
$avgConfidence = 0.0
if ($total -gt 0) {
  $confidenceValues = @($items | Where-Object { $null -ne $_.confidence_score } | ForEach-Object { [double](($_)['confidence_score']) })
  if ($confidenceValues.Count -gt 0) {
  $sum = 0.0
  foreach ($val in $confidenceValues) { $sum += $val }
  $avgConfidence = [Math]::Round(($sum / $confidenceValues.Count), 2)
  }
}

$summary = [ordered]@{
  generated_at = (Get-Date).ToString('o')
  out_dir = $OutDir
  max_runs = $MaxRuns
  total_runs = $total
  runs_pass = $passed
  runs_fail = $failed
  runs_unknown = $unknown
  avg_confidence_score = $avgConfidence
  runs = $items
}

$json = $summary | ConvertTo-Json -Depth 20
if ($OutputFile -and $OutputFile.Trim().Length -gt 0) {
  Set-Content -Path $OutputFile -Value $json -Encoding UTF8
  Write-Host "[prod-summary] output: $OutputFile" -ForegroundColor Green
} else {
  Write-Output $json
}
