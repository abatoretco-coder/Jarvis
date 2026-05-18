param(
  [string]$OutDir = ".\artifacts\prod-routing",
  [double]$MaxSuccessRateDropPct = 10.0,
  [int]$MaxEndpointFailuresIncrease = 0,
  [int]$MaxCriticalProbeFailures = 0
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

$indexPath = Join-Path $OutDir 'index.json'
if (-not (Test-Path $indexPath)) {
  throw "index.json not found: $indexPath"
}

$index = Parse-JsonSafe (Get-Content -Path $indexPath -Raw)
if (-not $index -or -not $index.items -or @($index.items).Count -lt 2) {
  throw "At least two runs are required in index.json to check regressions"
}

$current = @($index.items)[0]
$previous = @($index.items)[1]

$currentReportPath = Join-Path $current.output_folder 'report.json'
$previousReportPath = Join-Path $previous.output_folder 'report.json'

if (-not (Test-Path $currentReportPath)) { throw "Current report not found: $currentReportPath" }
if (-not (Test-Path $previousReportPath)) { throw "Previous report not found: $previousReportPath" }

$currentReport = Parse-JsonSafe (Get-Content -Path $currentReportPath -Raw)
$previousReport = Parse-JsonSafe (Get-Content -Path $previousReportPath -Raw)
if (-not $currentReport -or -not $previousReport) {
  throw "Unable to parse one of the reports"
}

$currentKpis = $currentReport.analysis.kpis
$previousKpis = $previousReport.analysis.kpis

$successRateDrop = [double]$previousKpis.success_rate_pct - [double]$currentKpis.success_rate_pct
$endpointsIncrease = [int]$currentKpis.endpoints_failed_count - [int]$previousKpis.endpoints_failed_count
$currentCriticalFailed = [int]$currentKpis.critical_probes_failed
$currentTotalProbes = [int]$currentKpis.total_probes
$previousTotalProbes = [int]$previousKpis.total_probes
$successRateComparable = ($currentTotalProbes -gt 0 -and $previousTotalProbes -gt 0)

$violations = @()
if ($successRateComparable -and $successRateDrop -gt $MaxSuccessRateDropPct) {
  $violations += "success_rate_drop_pct=$successRateDrop"
}
if ($endpointsIncrease -gt $MaxEndpointFailuresIncrease) {
  $violations += "endpoints_failed_increase=$endpointsIncrease"
}
if ($currentCriticalFailed -gt $MaxCriticalProbeFailures) {
  $violations += "critical_probes_failed=$currentCriticalFailed"
}

$result = [ordered]@{
  generated_at = (Get-Date).ToString('o')
  current_run_id = [string]$current.run_id
  previous_run_id = [string]$previous.run_id
  success_rate_drop_pct = [Math]::Round($successRateDrop, 2)
  success_rate_comparable = $successRateComparable
  endpoints_failed_increase = $endpointsIncrease
  critical_probes_failed = $currentCriticalFailed
  thresholds = [ordered]@{
    max_success_rate_drop_pct = $MaxSuccessRateDropPct
    max_endpoint_failures_increase = $MaxEndpointFailuresIncrease
    max_critical_probe_failures = $MaxCriticalProbeFailures
  }
  violations = $violations
  ok = ($violations.Count -eq 0)
}

$resultJson = $result | ConvertTo-Json -Depth 20
Write-Output $resultJson

if ($violations.Count -gt 0) {
  throw ("Regression guard failed: {0}" -f ($violations -join ', '))
}
