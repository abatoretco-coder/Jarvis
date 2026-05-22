param(
  [string]$HostIP = "192.168.1.38",
  [string]$Port = "8090",
  [string]$OutDir = ".\artifacts\prod-music",
  [int]$TimeoutSec = 90
)

$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

function Resolve-ApiKey {
  $apiKeyLine = Get-Content '.env' | Where-Object { $_ -match '^\s*API_KEY\s*=' } | Select-Object -First 1
  if ($apiKeyLine) {
    return ($apiKeyLine -split '=', 2)[1].Trim().Trim('"')
  }

  $apiKeysLine = Get-Content '.env' | Where-Object { $_ -match '^\s*API_KEYS\s*=' } | Select-Object -First 1
  if ($apiKeysLine) {
    return (((($apiKeysLine -split '=', 2)[1]).Trim().Trim('"')) -split ',')[0].Trim()
  }

  throw 'API_KEY/API_KEYS not found in .env'
}

function New-OutputFolder([string]$basePath) {
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $rand = [Guid]::NewGuid().ToString('N').Substring(0, 8)
  $folder = Join-Path $basePath ("{0}-{1}" -f $stamp, $rand)
  New-Item -ItemType Directory -Path $folder -Force | Out-Null
  return $folder
}

function Invoke-JsonRequest {
  param(
    [string]$Uri,
    [hashtable]$Headers,
    [object]$Body,
    [int]$Timeout
  )

  $payload = $Body | ConvertTo-Json -Depth 20
  try {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
    $response = Invoke-RestMethod -Method Post -Uri $Uri -Headers $Headers -ContentType 'application/json; charset=utf-8' -Body $bytes -TimeoutSec $Timeout
    $sw.Stop()
    return [pscustomobject]@{ ok = $true; elapsedMs = [int]$sw.ElapsedMilliseconds; data = $response; error = $null }
  } catch {
    $msg = $_.Exception.Message
    $status = 0
    if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
      $status = [int]$_.Exception.Response.StatusCode
      try {
        $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
        $body2 = $reader.ReadToEnd()
        if ($body2) { $msg = $body2 }
      } catch {}
    }
    return [pscustomobject]@{ ok = $false; elapsedMs = 0; data = $null; error = "http_$status $msg" }
  }
}

function Normalize-CheckText([string]$value) {
  if (-not $value) { return '' }
  $normalized = $value.Normalize([Text.NormalizationForm]::FormD)
  $sb = New-Object System.Text.StringBuilder
  foreach ($ch in $normalized.ToCharArray()) {
    $cat = [Globalization.CharUnicodeInfo]::GetUnicodeCategory($ch)
    if ($cat -ne [Globalization.UnicodeCategory]::NonSpacingMark) {
      [void]$sb.Append($ch)
    }
  }
  return $sb.ToString().ToLowerInvariant()
}

$apiKey = Resolve-ApiKey
$baseUrl = "http://$HostIP`:$Port"
$headers = @{ 'X-API-Key' = $apiKey }
$outFolder = New-OutputFolder $OutDir
$runId = Split-Path $outFolder -Leaf

Write-Host "[music] run_id=$runId" -ForegroundColor Cyan
Write-Host "[music] target=$baseUrl" -ForegroundColor Cyan

$health = Invoke-RestMethod -Method Get -Uri "$baseUrl/health" -TimeoutSec 20
if (-not $health) { throw 'health endpoint did not return data' }

$tb = "music-$runId"

$globalForbidden = @(
  'action spotify non support',
  'out of scope',
  'je n ai pas pu joindre l agent home assistant',
  'je ne peux pas repondre correctement'
)

$cases = @(
  @{ id='explicit.list_devices'; kind='explicit_core'; payload=@{ threadId="$tb-1"; domain='spotify'; action='list_devices'; text='liste mes appareils spotify' }; expectAny=@('appareil'); forbid=@(); allowedStatuses=@('success') },
  @{ id='explicit.now_playing'; kind='explicit_core'; payload=@{ threadId="$tb-2"; domain='spotify'; action='now_playing'; text='qu est ce qui joue' }; expectAny=@('en cours','rien en cours'); forbid=@(); allowedStatuses=@('success','error') },
  @{ id='explicit.pause'; kind='explicit_core'; payload=@{ threadId="$tb-3"; domain='spotify'; action='pause'; text='pause spotify' }; expectAny=@('pause','rien ne joue actuellement'); forbid=@(); allowedStatuses=@('success','error') },
  @{ id='explicit.play'; kind='explicit_core'; payload=@{ threadId="$tb-4"; domain='spotify'; action='play'; text='reprends spotify'; slots=@{ device='alias:pc' } }; expectAny=@('lecture reprise','spotify n est pas ouvert','impossible de relancer'); forbid=@(); allowedStatuses=@('success','error') },
  @{ id='explicit.next'; kind='explicit_core'; payload=@{ threadId="$tb-5"; domain='spotify'; action='next'; text='piste suivante' }; expectAny=@('piste suivante','impossible de passer'); forbid=@(); allowedStatuses=@('success','error') },
  @{ id='explicit.previous'; kind='explicit_core'; payload=@{ threadId="$tb-6"; domain='spotify'; action='previous'; text='piste precedente' }; expectAny=@('piste precedente','impossible de revenir'); forbid=@(); allowedStatuses=@('success','error') },
  @{ id='explicit.volume_set'; kind='explicit_core'; payload=@{ threadId="$tb-7"; domain='spotify'; action='volume_set'; text='volume a 30 sur le pc'; slots=@{ volume_percent=30; device='alias:pc' } }; expectAny=@('volume'); forbid=@('manuellement sur votre appareil'); allowedStatuses=@('success','error','need_clarification') },
  @{ id='explicit.transfer'; kind='explicit_core'; payload=@{ threadId="$tb-8"; domain='spotify'; action='transfer'; text='transfere sur mon telephone'; slots=@{ device='alias:phone'; play=$true } }; expectAny=@('lecture transferee','spotify n est pas ouvert'); forbid=@(); allowedStatuses=@('success','error') },

  @{ id='explicit.search.track'; kind='explicit_search'; payload=@{ threadId="$tb-9"; domain='spotify'; action='search'; text='cherche daft punk'; slots=@{ query='daft punk'; type='track' } }; expectAny=@('resultat'); forbid=@(); allowedStatuses=@('success') },
  @{ id='explicit.search.artist'; kind='explicit_search'; payload=@{ threadId="$tb-10"; domain='spotify'; action='search'; text='cherche artiste queen'; slots=@{ query='queen'; type='artist' } }; expectAny=@('resultat'); forbid=@(); allowedStatuses=@('success') },
  @{ id='explicit.search_and_play'; kind='explicit_search'; payload=@{ threadId="$tb-11"; domain='spotify'; action='search_and_play'; text='joue daft punk'; slots=@{ query='daft punk'; type='track'; device='alias:pc' } }; expectAny=@('lecture','impossible de lancer','spotify n est pas ouvert'); forbid=@(); allowedStatuses=@('success','error','need_clarification') },
  @{ id='explicit.queue_add'; kind='explicit_search'; payload=@{ threadId="$tb-12"; domain='spotify'; action='queue_add'; text='ajoute around the world a la file'; slots=@{ query='around the world'; type='track' } }; expectAny=@('file','impossible d ajouter'); forbid=@(); allowedStatuses=@('success','error','need_clarification') },

  @{ id='text.pause'; kind='text_natural'; payload=@{ threadId="$tb-13"; text='mets en pause spotify' }; expectAny=@('pause','rien ne joue actuellement'); forbid=@(); allowedStatuses=@('success','error','need_clarification','') },
  @{ id='text.play'; kind='text_natural'; payload=@{ threadId="$tb-14"; text='reprends la musique sur spotify' }; expectAny=@('lecture','impossible de lancer','spotify n est pas ouvert'); forbid=@(); allowedStatuses=@('success','error','need_clarification','') },
  @{ id='text.next'; kind='text_natural'; payload=@{ threadId="$tb-15"; text='mets la suivante' }; expectAny=@('piste suivante','impossible de passer'); forbid=@(); allowedStatuses=@('success','error','need_clarification','') },
  @{ id='text.previous'; kind='text_natural'; payload=@{ threadId="$tb-16"; text='reviens a la chanson precedente' }; expectAny=@('piste precedente','impossible de revenir'); forbid=@(); allowedStatuses=@('success','error','need_clarification','') },
  @{ id='text.volume'; kind='text_natural'; payload=@{ threadId="$tb-17"; text='baisse le volume de 10 sur le pc' }; expectAny=@('volume','sur quel appareil'); forbid=@('manuellement sur votre appareil'); allowedStatuses=@('success','error','need_clarification','') },
  @{ id='text.devices'; kind='text_natural'; payload=@{ threadId="$tb-18"; text='quels appareils spotify sont dispo' }; expectAny=@('appareil'); forbid=@(); allowedStatuses=@('success','error','need_clarification','') },

  @{ id='stt.pause'; kind='text_noisy'; payload=@{ threadId="$tb-19"; text='paus la musik spoti' }; expectAny=@('pause','rien ne joue actuellement'); forbid=@(); allowedStatuses=@('success','error','need_clarification','') },
  @{ id='stt.play'; kind='text_noisy'; payload=@{ threadId="$tb-20"; text='relans la musik sur pc' }; expectAny=@('lecture','impossible de lancer','spotify n est pas ouvert'); forbid=@(); allowedStatuses=@('success','error','need_clarification','') },
  @{ id='stt.next'; kind='text_noisy'; payload=@{ threadId="$tb-21"; text='titre suivan pliz' }; expectAny=@('piste suivante','impossible de passer'); forbid=@(); allowedStatuses=@('success','error','need_clarification','') },
  @{ id='stt.search_play'; kind='text_noisy'; payload=@{ threadId="$tb-22"; text='met du daft pank' }; expectAny=@('lecture','resultat','impossible de lancer'); forbid=@(); allowedStatuses=@('success','error','need_clarification','') },
  @{ id='stt.volume'; kind='text_noisy'; payload=@{ threadId="$tb-23"; text='baiss le volum 20' }; expectAny=@('volume','sur quel appareil','rien ne joue en ce moment'); forbid=@('manuellement sur votre appareil'); allowedStatuses=@('success','error','need_clarification','') },
  @{ id='stt.transfer'; kind='text_noisy'; payload=@{ threadId="$tb-24"; text='met sur mon tel' }; expectAny=@('lecture transferee','spotify n est pas ouvert','sur quel appareil'); forbid=@(); allowedStatuses=@('success','error','need_clarification','') }
)

$results = @()

foreach ($c in $cases) {
  Write-Host "[music] $($c.id)..." -NoNewline
  $resp = Invoke-JsonRequest -Uri "$baseUrl/v1/ingest" -Headers $headers -Body $c.payload -Timeout $TimeoutSec

  $reply = ''
  $status = ''
  if ($resp.ok -and $resp.data) {
    $reply = [string]$resp.data.responseText
    $status = [string]$resp.data.status
  }

  $textLower = Normalize-CheckText $reply
  $statusLower = Normalize-CheckText $status
  $ok = $resp.ok -and $reply.Trim().Length -gt 0

  if ($c.allowedStatuses -and $c.allowedStatuses.Count -gt 0) {
    $allowed = $false
    foreach ($allowedStatus in $c.allowedStatuses) {
      if ((Normalize-CheckText $allowedStatus) -eq $statusLower) {
        $allowed = $true
        break
      }
    }
    if (-not $allowed) { $ok = $false }
  }

  $forbidden = @($globalForbidden + $c.forbid)
  foreach ($needle in $forbidden) {
    if ($needle -and $textLower.Contains($needle.ToLowerInvariant())) {
      $ok = $false
    }
  }

  if ($c.expectAny.Count -gt 0) {
    $containsAny = $false
    foreach ($needle in $c.expectAny) {
      if ($needle -and $textLower.Contains($needle.ToLowerInvariant())) {
        $containsAny = $true
        break
      }
    }
    if (-not $containsAny) { $ok = $false }
  }

  $icon = if ($ok) { 'OK' } else { 'FAIL' }
  $color = if ($ok) { 'Green' } else { 'Red' }
  Write-Host " $icon ($($resp.elapsedMs)ms)" -ForegroundColor $color

  $results += [pscustomobject]@{
    id = $c.id
    kind = $c.kind
    ok = $ok
    elapsedMs = $resp.elapsedMs
    status = $status
    responseText = $reply
    error = $resp.error
  }
}

$grouped = $results | Group-Object kind
$byKind = foreach ($g in $grouped) {
  $total = $g.Count
  $passed = ($g.Group | Where-Object { $_.ok }).Count
  [pscustomobject]@{
    kind = $g.Name
    total = $total
    passed = $passed
    failed = $total - $passed
    passRate = [math]::Round((100.0 * $passed / [math]::Max(1, $total)), 1)
  }
}

$totalAll = $results.Count
$passedAll = ($results | Where-Object { $_.ok }).Count
$failedAll = $totalAll - $passedAll

$report = [ordered]@{
  generatedAt = (Get-Date).ToString('o')
  runId = $runId
  baseUrl = $baseUrl
  totals = [ordered]@{ total = $totalAll; passed = $passedAll; failed = $failedAll; passRate = [math]::Round((100.0 * $passedAll / [math]::Max(1, $totalAll)), 1) }
  byKind = $byKind
  failures = @($results | Where-Object { -not $_.ok })
  results = $results
}

$jsonPath = Join-Path $outFolder 'music-report.json'
$report | ConvertTo-Json -Depth 20 | Set-Content -Path $jsonPath -Encoding UTF8

$mdPath = Join-Path $outFolder 'music-report.md'
$lines = New-Object System.Collections.Generic.List[string]
$lines.Add('# Production Music Reliability Report')
$lines.Add('')
$lines.Add("- Run: $runId")
$lines.Add("- Target: $baseUrl")
$lines.Add("- Total: $totalAll")
$lines.Add("- Passed: $passedAll")
$lines.Add("- Failed: $failedAll")
$lines.Add("- Pass rate: $([math]::Round((100.0 * $passedAll / [math]::Max(1, $totalAll)), 1))%")
$lines.Add('')
$lines.Add('## By Kind')
foreach ($k in $byKind) {
  $lines.Add("- $($k.kind): $($k.passed)/$($k.total) ($($k.passRate)%)")
}
$lines.Add('')
$lines.Add('## Failures')
$fails = @($results | Where-Object { -not $_.ok })
if ($fails.Count -eq 0) {
  $lines.Add('- none')
} else {
  foreach ($f in $fails) {
    $snippet = if ($f.responseText) { $f.responseText.Substring(0, [math]::Min(220, $f.responseText.Length)) } else { $f.error }
    $lines.Add("- $($f.id) [$($f.kind)] status=$($f.status)")
    $lines.Add("  Response: $snippet")
  }
}
$lines | Set-Content -Path $mdPath -Encoding UTF8

Write-Host ''
Write-Host "[music] TOTAL $passedAll/$totalAll passed ($([math]::Round((100.0 * $passedAll / [math]::Max(1, $totalAll)), 1))%)" -ForegroundColor Cyan
Write-Host "[music] json=$jsonPath" -ForegroundColor Green
Write-Host "[music] md=$mdPath" -ForegroundColor Green
