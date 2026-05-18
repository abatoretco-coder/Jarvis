param(
  [string]$HostIP = "192.168.1.38",
  [string]$Port = "8090",
  [string]$ApiKey = "",
  [string]$OutDir = ".\artifacts\prod-archive",
  [string]$ThreadId = "",
  [string]$Text = "",
  [string]$UserId = "archive-script"
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

function Parse-JsonSafe([string]$raw) {
  try {
    if (-not $raw) { return $null }
    return ($raw | ConvertFrom-Json)
  } catch {
    return $null
  }
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
  return 'unknown'
}

function Get-GitBranch() {
  try {
    $value = (git branch --show-current 2>$null)
    if ($value) { return $value.Trim() }
  } catch {}
  return 'unknown'
}

function Get-GitDescribe() {
  try {
    $value = (git describe --tags --always --dirty 2>$null)
    if ($value) { return $value.Trim() }
  } catch {}
  return 'unknown'
}

$resolvedApiKey = Resolve-ApiKey $ApiKey
if (-not $resolvedApiKey) {
  throw "API key missing. Provide -ApiKey or set API_KEY/API_KEYS in .env"
}

$baseUrl = "http://$HostIP`:$Port"
$headers = @{ 'X-API-Key' = $resolvedApiKey }

$outFolder = New-OutputFolder $OutDir
$runId = Split-Path $outFolder -Leaf

Write-Host "[archive] run_id=$runId" -ForegroundColor Cyan
Write-Host "[archive] out=$outFolder" -ForegroundColor Cyan

# 1) Health + stats + threads
$healthRaw = Invoke-RestMethod -Uri "$baseUrl/health" -Method Get -TimeoutSec 20
$healthRaw | ConvertTo-Json -Depth 20 | Set-Content -Path (Join-Path $outFolder 'health.json') -Encoding UTF8

$statsRaw = Invoke-RestMethod -Uri "$baseUrl/v1/stats" -Method Get -Headers $headers -TimeoutSec 20
$statsRaw | ConvertTo-Json -Depth 20 | Set-Content -Path (Join-Path $outFolder 'stats.json') -Encoding UTF8

$threadsRaw = Invoke-RestMethod -Uri "$baseUrl/v1/threads?limit=50" -Method Get -Headers $headers -TimeoutSec 25
$threadsRaw | ConvertTo-Json -Depth 20 | Set-Content -Path (Join-Path $outFolder 'threads.json') -Encoding UTF8

$selectedThreadId = $ThreadId
if (-not $selectedThreadId) {
  $selectedThreadId = [string]$threadsRaw.items[0].threadId
}

if (-not $selectedThreadId) {
  throw "No thread id available: provide -ThreadId or ensure /v1/threads returns items"
}

# 2) Optional ingest run for explicit user ask -> real software result + measured wall-clock
$ingestSummary = $null
if ($Text -and $Text.Trim().Length -gt 0) {
  $corr = "archive-$runId"
  $ingestBodyObj = [ordered]@{
    threadId = $selectedThreadId
    text = $Text
    correlation_id = $corr
    user_id = $UserId
  }

  $ingestBodyJson = $ingestBodyObj | ConvertTo-Json -Depth 20
  $ingestBodyJson | Set-Content -Path (Join-Path $outFolder 'ingest-request.json') -Encoding UTF8
  $ingestBodyBytes = [System.Text.Encoding]::UTF8.GetBytes($ingestBodyJson)

  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $ingestResp = Invoke-RestMethod -Uri "$baseUrl/v1/ingest" -Method Post -Headers $headers -ContentType 'application/json; charset=utf-8' -Body $ingestBodyBytes -TimeoutSec 90
  $sw.Stop()

  $ingestResp | ConvertTo-Json -Depth 20 | Set-Content -Path (Join-Path $outFolder 'ingest-response.json') -Encoding UTF8

  $ingestSummary = [ordered]@{
    text = $Text
    correlation_id = $corr
    elapsed_wall_ms = [int]$sw.ElapsedMilliseconds
    response_text = [string]$ingestResp.responseText
    response_thread_id = [string]$ingestResp.threadId
  }

  if ($ingestSummary.response_thread_id) {
    $selectedThreadId = $ingestSummary.response_thread_id
  }
}

# 3) Thread history snapshot
$historyUri = "$baseUrl/v1/threads/$selectedThreadId/history?limit=250"
$historyRaw = Invoke-RestMethod -Uri $historyUri -Method Get -Headers $headers -TimeoutSec 25
$historyRaw | ConvertTo-Json -Depth 30 | Set-Content -Path (Join-Path $outFolder "thread-history-$selectedThreadId.json") -Encoding UTF8

$userLatest = $null
$assistantLatest = $null
if ($historyRaw.items) {
  foreach ($msg in @($historyRaw.items)) {
    $role = [string]$msg.role
    if ($role -eq 'user' -and -not $userLatest) { $userLatest = $msg }
    if ($role -eq 'assistant' -and -not $assistantLatest) { $assistantLatest = $msg }
    if ($userLatest -and $assistantLatest) { break }
  }
}

$runSummary = [ordered]@{
  generated_at = (Get-Date).ToString('o')
  run_id = $runId
  base_url = $baseUrl
  selected_thread_id = $selectedThreadId
  jarvis_git = [ordered]@{
    commit = Get-GitCommitShort
    branch = Get-GitBranch
    describe = Get-GitDescribe
  }
  latest_exchange = [ordered]@{
    user_text = if ($userLatest) { [string]$userLatest.content } else { '' }
    assistant_text = if ($assistantLatest) { [string]$assistantLatest.content } else { '' }
  }
  ingest_probe = $ingestSummary
  archived_files = @(
    'health.json',
    'stats.json',
    'threads.json',
    "thread-history-$selectedThreadId.json"
  )
}

$summaryPath = Join-Path $outFolder 'summary.json'
$runSummary | ConvertTo-Json -Depth 30 | Set-Content -Path $summaryPath -Encoding UTF8

$latestPath = Join-Path $OutDir 'latest.json'
([ordered]@{
  run_id = $runId
  generated_at = (Get-Date).ToString('o')
  output_folder = $outFolder
  summary_file = $summaryPath
}) | ConvertTo-Json -Depth 10 | Set-Content -Path $latestPath -Encoding UTF8

Write-Host "[archive] done" -ForegroundColor Green
Write-Host "[archive] summary=$summaryPath" -ForegroundColor Green
