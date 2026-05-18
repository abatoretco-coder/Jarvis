param(
  [string]$HostIP = "192.168.1.38",
  [string]$Port = "8090",
  [string]$User = "loic",
  [string]$ApiKey = "",
  [string]$OutDir = ".\artifacts\prod-routing",
  [string]$ThreadId = "",
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
  $folder = Join-Path $basePath $stamp
  New-Item -ItemType Directory -Path $folder -Force | Out-Null
  return $folder
}

function Save-Json([string]$path, $obj) {
  $json = $obj | ConvertTo-Json -Depth 20
  Set-Content -Path $path -Value $json -Encoding UTF8
}

function Save-Text([string]$path, [string]$text) {
  Set-Content -Path $path -Value $text -Encoding UTF8
}

function Invoke-JarvisGet([string]$url, [hashtable]$headers) {
  try {
    $resp = Invoke-RestMethod -Uri $url -Method Get -Headers $headers -TimeoutSec 30
    return @{ ok = $true; data = $resp }
  } catch {
    return @{ ok = $false; error = $_.Exception.Message }
  }
}

function Invoke-JarvisPost([string]$url, [hashtable]$headers, $bodyObj) {
  try {
    $body = $bodyObj | ConvertTo-Json -Depth 20
    $resp = Invoke-RestMethod -Uri $url -Method Post -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 45
    return @{ ok = $true; data = $resp; body = $bodyObj }
  } catch {
    return @{ ok = $false; error = $_.Exception.Message; body = $bodyObj }
  }
}

if (-not $PSBoundParameters.ContainsKey('RunProbes')) {
  $RunProbes = $true
}

$resolvedApiKey = Resolve-ApiKey $ApiKey
$headers = @{}
if ($resolvedApiKey) { $headers['X-API-Key'] = $resolvedApiKey }

$baseUrl = "http://$HostIP`:$Port"
$outputFolder = New-OutputFolder $OutDir

Write-Host "[prod-collect] output: $outputFolder" -ForegroundColor Cyan
Write-Host "[prod-collect] target: $baseUrl" -ForegroundColor Cyan
Write-Host "[prod-collect] api key: $([bool]$resolvedApiKey)" -ForegroundColor Cyan

$report = [ordered]@{
  generated_at = (Get-Date).ToString("o")
  base_url = $baseUrl
  api_key_present = [bool]$resolvedApiKey
  probes_enabled = [bool]$RunProbes
  endpoints = @{}
  probes = @()
  latest_thread_id = $null
  output_folder = $outputFolder
}

$health = Invoke-JarvisGet "$baseUrl/health" $headers
$report.endpoints.health = if ($health.ok) { "ok" } else { "error" }
if ($health.ok) { Save-Json (Join-Path $outputFolder "health.json") $health.data } else { Save-Text (Join-Path $outputFolder "health.error.txt") $health.error }

$stats = Invoke-JarvisGet "$baseUrl/v1/stats" $headers
$report.endpoints.stats = if ($stats.ok) { "ok" } else { "error" }
if ($stats.ok) { Save-Json (Join-Path $outputFolder "stats.json") $stats.data } else { Save-Text (Join-Path $outputFolder "stats.error.txt") $stats.error }

$threads = Invoke-JarvisGet "$baseUrl/v1/threads?limit=20" $headers
$report.endpoints.threads = if ($threads.ok) { "ok" } else { "error" }
if ($threads.ok) {
  Save-Json (Join-Path $outputFolder "threads.json") $threads.data

  $threadItems = @()
  if ($threads.data -and $threads.data.items) { $threadItems = @($threads.data.items) }
  if (-not $ThreadId -and $threadItems.Count -gt 0) {
    $ThreadId = [string]$threadItems[0].threadId
  }
} else {
  Save-Text (Join-Path $outputFolder "threads.error.txt") $threads.error
}

if ($ThreadId) {
  $history = Invoke-JarvisGet "$baseUrl/v1/threads/$ThreadId/history?limit=50" $headers
  $report.latest_thread_id = $ThreadId
  $report.endpoints.thread_history = if ($history.ok) { "ok" } else { "error" }
  if ($history.ok) {
    Save-Json (Join-Path $outputFolder "thread-history-$ThreadId.json") $history.data
  } else {
    Save-Text (Join-Path $outputFolder "thread-history-$ThreadId.error.txt") $history.error
  }
}

if ($RunProbes) {
  $probeThread = if ($ThreadId) { $ThreadId } else { "prod-routing-probe-$(Get-Date -Format 'yyyyMMddHHmmss')" }

  $probeTexts = @(
    "c est vrai qu il n y a pas de pluie aujourd hui",
    "c est quoi la temperature max aujourd hui et la temperature maximum de la semaine",
    "lis mes mails puis ajoute une tache et donne la meteo"
  )

  $idx = 1
  foreach ($probeText in $probeTexts) {
    $payload = @{
      threadId = $probeThread
      text = $probeText
      clientContext = @{ channel = "desktop" }
      correlation_id = "prod-routing-probe-$idx"
      user_id = "prod-analyzer"
    }

    $probe = Invoke-JarvisPost "$baseUrl/v1/ingest" $headers $payload
    $record = [ordered]@{
      index = $idx
      text = $probeText
      ok = [bool]$probe.ok
      output_file = "probe-$idx.json"
    }

    if ($probe.ok) {
      Save-Json (Join-Path $outputFolder "probe-$idx.json") $probe.data
    } else {
      Save-Text (Join-Path $outputFolder "probe-$idx.error.txt") $probe.error
      $record.error = $probe.error
    }

    $report.probes += $record
    $idx += 1
  }
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

    $focus = $allLogs | Select-String -Pattern 'semantic_router_|ingest_complete|mail_followup_|spotify_deterministic_gate_|ha_agent_router_|multi_intent' -CaseSensitive:$false
    $focusLines = $focus | ForEach-Object { $_.Line }
    Save-Text (Join-Path $outputFolder "jarvis.logs.focus.log") ($focusLines -join [Environment]::NewLine)
    $report.endpoints.ssh_logs = "ok"
  } catch {
    $report.endpoints.ssh_logs = "error"
    Save-Text (Join-Path $outputFolder "jarvis.logs.error.txt") $_.Exception.Message
  }
}

Save-Json (Join-Path $outputFolder "report.json") $report

Write-Host "[prod-collect] done" -ForegroundColor Green
Write-Host "[prod-collect] report: $(Join-Path $outputFolder 'report.json')" -ForegroundColor Green
