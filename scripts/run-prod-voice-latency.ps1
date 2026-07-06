param(
  [string]$HostIP = "192.168.1.38",
  [string]$Port = "8090",
  [string]$OutDir = ".\artifacts\prod-voice-latency",
  [int]$Iterations = 5,
  [int]$TimeoutSec = 90,
  [string[]]$Texts = @(
    "quelle heure est il",
    "resume ma journee",
    "allume la lumiere du salon"
  ),
  [switch]$SkipTts
)

$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

function Get-EnvValue([string]$path, [string]$key) {
  if (-not (Test-Path $path)) { return $null }
  $line = Get-Content $path | Where-Object { $_ -match "^\s*$key\s*=" } | Select-Object -First 1
  if (-not $line) { return $null }
  return ($line -split '=', 2)[1].Trim().Trim('"')
}

function Resolve-ApiKey {
  $single = Get-EnvValue '.env' 'API_KEY'
  if ($single) { return $single }
  $many = Get-EnvValue '.env' 'API_KEYS'
  if ($many) { return (($many -split ',')[0]).Trim() }
  throw 'API_KEY/API_KEYS not found in .env'
}

function New-OutputFolder([string]$basePath) {
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $folder = Join-Path $basePath $stamp
  New-Item -ItemType Directory -Path $folder -Force | Out-Null
  return $folder
}

function Invoke-JsonPost {
  param(
    [string]$Uri,
    [hashtable]$Headers,
    [object]$Body,
    [int]$Timeout
  )

  $json = $Body | ConvertTo-Json -Depth 20
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    $response = Invoke-RestMethod -Method Post -Uri $Uri -Headers $Headers -ContentType 'application/json; charset=utf-8' -Body $bytes -TimeoutSec $Timeout
    $sw.Stop()
    return [pscustomobject]@{ ok=$true; elapsedMs=[int]$sw.ElapsedMilliseconds; data=$response; error=$null }
  } catch {
    $sw.Stop()
    return [pscustomobject]@{ ok=$false; elapsedMs=[int]$sw.ElapsedMilliseconds; data=$null; error=$_.Exception.Message }
  }
}

function Invoke-TtsPost {
  param(
    [string]$Uri,
    [hashtable]$Headers,
    [object]$Body,
    [int]$Timeout
  )

  $json = $Body | ConvertTo-Json -Depth 20
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $tmp = New-TemporaryFile
  try {
    Invoke-WebRequest -Method Post -Uri $Uri -Headers $Headers -ContentType 'application/json; charset=utf-8' -Body $bytes -TimeoutSec $Timeout -OutFile $tmp.FullName | Out-Null
    $sw.Stop()
    $byteCount = (Get-Item $tmp.FullName).Length
    return [pscustomobject]@{ ok=$true; elapsedMs=[int]$sw.ElapsedMilliseconds; bytes=$byteCount; error=$null }
  } catch {
    $sw.Stop()
    return [pscustomobject]@{ ok=$false; elapsedMs=[int]$sw.ElapsedMilliseconds; bytes=0; error=$_.Exception.Message }
  } finally {
    Remove-Item -LiteralPath $tmp.FullName -Force -ErrorAction SilentlyContinue
  }
}

function Get-Percentile([int[]]$values, [double]$p) {
  if (-not $values -or $values.Count -eq 0) { return 0 }
  $sorted = @($values | Sort-Object)
  $index = [Math]::Ceiling(($p / 100.0) * $sorted.Count) - 1
  $index = [Math]::Max(0, [Math]::Min($sorted.Count - 1, $index))
  return [int]$sorted[$index]
}

$apiKey = Resolve-ApiKey
$baseUrl = "http://$HostIP`:$Port"
$headers = @{ 'X-API-Key' = $apiKey }
$outFolder = New-OutputFolder $OutDir
$results = New-Object System.Collections.Generic.List[object]

Write-Host "[voice-latency] target=$baseUrl" -ForegroundColor Cyan
Write-Host "[voice-latency] out=$outFolder" -ForegroundColor Cyan

$health = Invoke-RestMethod -Method Get -Uri "$baseUrl/health" -Headers $headers -TimeoutSec 20
if (-not $health) { throw 'health endpoint did not return data' }

for ($i = 1; $i -le $Iterations; $i++) {
  foreach ($text in $Texts) {
    $turnId = "prod-voice-{0}-{1}" -f (Get-Date -Format "yyyyMMddHHmmssfff"), ([Guid]::NewGuid().ToString('N').Substring(0, 8))
    $threadId = "prod-voice-latency-$turnId"
    $turnHeaders = $headers.Clone()
    $turnHeaders['X-Voice-Turn-Id'] = $turnId

    $ingestBody = @{
      threadId = $threadId
      text = $text
      clientContext = @{
        language = "fr"
        channel = "voice"
        deviceType = "android"
        transport = "prod-latency-script"
        supportsProgressiveResponse = "true"
      }
    }

    Write-Host "[voice-latency] turn=$turnId ingest '$text'" -ForegroundColor DarkCyan
    $ingest = Invoke-JsonPost -Uri "$baseUrl/v1/ingest" -Headers $turnHeaders -Body $ingestBody -Timeout $TimeoutSec
    $reply = if ($ingest.ok -and $ingest.data.responseText) { [string]$ingest.data.responseText } else { "" }
    $tts = [pscustomobject]@{ ok=$true; elapsedMs=0; bytes=0; error=$null }

    if (-not $SkipTts -and $reply.Trim()) {
      $tts = Invoke-TtsPost -Uri "$baseUrl/v1/tts" -Headers $turnHeaders -Body @{ text=$reply; language="fr" } -Timeout $TimeoutSec
    }

    $row = [pscustomobject]@{
      turnId = $turnId
      text = $text
      ingestOk = $ingest.ok
      ingestMs = $ingest.elapsedMs
      ttsOk = $tts.ok
      ttsMs = $tts.elapsedMs
      totalMs = $ingest.elapsedMs + $tts.elapsedMs
      ttsBytes = $tts.bytes
      responseChars = $reply.Length
      responseText = $reply
      error = if ($ingest.error) { $ingest.error } elseif ($tts.error) { $tts.error } else { $null }
    }
    $results.Add($row) | Out-Null
    $row | ConvertTo-Json -Depth 8 | Out-File -FilePath (Join-Path $outFolder "$turnId.json") -Encoding utf8
    Write-Host ("[voice-latency] turn={0} ingest={1}ms tts={2}ms total={3}ms ok={4}/{5}" -f $turnId, $row.ingestMs, $row.ttsMs, $row.totalMs, $row.ingestOk, $row.ttsOk)
  }
}

$csvPath = Join-Path $outFolder "results.csv"
$jsonPath = Join-Path $outFolder "results.json"
$summaryPath = Join-Path $outFolder "summary.json"
$results | Export-Csv -NoTypeInformation -Encoding utf8 -Path $csvPath
$results | ConvertTo-Json -Depth 8 | Out-File -Encoding utf8 -FilePath $jsonPath

$okRows = @($results | Where-Object { $_.ingestOk -and ($SkipTts -or $_.ttsOk) })
$summary = [pscustomobject]@{
  target = $baseUrl
  count = $results.Count
  ok = $okRows.Count
  ingest = @{
    p50 = Get-Percentile @($okRows | ForEach-Object { [int]$_.ingestMs }) 50
    p95 = Get-Percentile @($okRows | ForEach-Object { [int]$_.ingestMs }) 95
    max = Get-Percentile @($okRows | ForEach-Object { [int]$_.ingestMs }) 100
  }
  tts = @{
    p50 = Get-Percentile @($okRows | ForEach-Object { [int]$_.ttsMs }) 50
    p95 = Get-Percentile @($okRows | ForEach-Object { [int]$_.ttsMs }) 95
    max = Get-Percentile @($okRows | ForEach-Object { [int]$_.ttsMs }) 100
  }
  total = @{
    p50 = Get-Percentile @($okRows | ForEach-Object { [int]$_.totalMs }) 50
    p95 = Get-Percentile @($okRows | ForEach-Object { [int]$_.totalMs }) 95
    max = Get-Percentile @($okRows | ForEach-Object { [int]$_.totalMs }) 100
  }
}

$summary | ConvertTo-Json -Depth 8 | Out-File -Encoding utf8 -FilePath $summaryPath
Write-Host "[voice-latency] summary:" -ForegroundColor Cyan
$summary | ConvertTo-Json -Depth 8
