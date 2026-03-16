$ErrorActionPreference = 'Stop'

function Get-EnvValue([string]$Path, [string]$Key) {
  if (-not (Test-Path $Path)) { return $null }
  $line = Get-Content -Path $Path | Where-Object { $_ -match "^\s*$([Regex]::Escape($Key))\s*=" } | Select-Object -First 1
  if (-not $line) { return $null }
  return (($line -split '=', 2)[1]).Trim()
}

$apiKey = Get-EnvValue '.env' 'API_KEY'
if (-not $apiKey) {
  $apiKeys = Get-EnvValue '.env' 'API_KEYS'
  if ($apiKeys) {
    $apiKey = (($apiKeys -split ',')[0]).Trim()
  }
}

$headers = @{}
if ($apiKey) { $headers['X-API-Key'] = $apiKey }

$base = 'http://192.168.1.38:8090'
$cases = @(
  @{ category = 'search'; text = 'cherche daft punk sur spotify'; expected = 'search' },
  @{ category = 'search'; text = 'trouve l album discovery sur spotify'; expected = 'search' },
  @{ category = 'search'; text = 'cherche des titres de kendrick lamar sur spotify'; expected = 'search' },
  @{ category = 'search'; text = 'recherche one more time sur spotify'; expected = 'search' },

  # Queue add is intentionally device-agnostic: we only validate action=queue_add.
  @{ category = 'queue'; text = 'ajoute n95 de kendrick a la file spotify'; expected = 'queue_add' },
  @{ category = 'queue'; text = 'mets blinding lights dans la file spotify'; expected = 'queue_add' },
  @{ category = 'queue'; text = 'ajoute ce morceau a la queue spotify'; expected = 'queue_add' },
  @{ category = 'queue'; text = 'ajoute le prochain titre a la file spotify'; expected = 'queue_add' },

  @{ category = 'device'; text = 'transfere spotify sur mon telephone'; expected = 'transfer' },
  @{ category = 'device'; text = 'transfere spotify sur pc jarvis'; expected = 'transfer' },
  @{ category = 'device'; text = 'transfere spotify dans le salon'; expected = 'transfer' },

  @{ category = 'playlist'; text = 'joue ma playlist focus sur spotify'; expected = 'search_and_play' },
  @{ category = 'playlist'; text = 'mets la playlist workout sur spotify'; expected = 'search_and_play' },
  @{ category = 'playlist'; text = 'ajoute one more time a ma playlist chill spotify'; expected = 'add_to_playlist' },
  @{ category = 'playlist'; text = 'ajoute cette musique a ma playlist favoris spotify'; expected = 'add_to_playlist' }
)

$results = @()
$idx = 0
foreach ($c in $cases) {
  $idx++
  $cid = ('nlverify-{0:D3}' -f $idx)
  $tid = "nlverify-thread-$idx"
  $body = @{
    threadId = $tid
    text = $c.text
    correlation_id = $cid
    user_id = 'tester'
  } | ConvertTo-Json -Depth 6

  try {
    $resp = Invoke-RestMethod -Uri "$base/v1/ingest" -Method Post -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 45
    $status = if ($resp.status) { [string]$resp.status } else { 'ok' }
    $planner = if ($resp.planner -and $resp.planner.source) { [string]$resp.planner.source } else { '' }
    $errorCode = if ($resp.error_code) { [string]$resp.error_code } else { '' }

    $results += [pscustomobject]@{
      idx = $idx
      cid = $cid
      category = $c.category
      text = $c.text
      expected = $c.expected
      app_status = $status
      planner = $planner
      error_code = $errorCode
      observed_action = ''
      ha_call_observed = $false
    }
  }
  catch {
    $results += [pscustomobject]@{
      idx = $idx
      cid = $cid
      category = $c.category
      text = $c.text
      expected = $c.expected
      app_status = 'http_error'
      planner = ''
      error_code = 'http_error'
      observed_action = ''
      ha_call_observed = $false
    }
  }

  Start-Sleep -Milliseconds 250
}

$sshScript = @'
set -euo pipefail
docker compose -f /opt/naas/stacks/home-assistant/docker-compose.prod.yml --profile vm400 logs --tail=1200 jarvis
'@

$logRaw = ($sshScript | & "C:\Windows\System32\OpenSSH\ssh.exe" -o BatchMode=yes -o StrictHostKeyChecking=accept-new "loic@192.168.1.38" "tr -d '\r' | bash -s")
$logLines = $logRaw -split "`n"
$actionByCid = @{}
$haCallByCid = @{}

foreach ($line in $logLines) {
  if ($line -notmatch 'nlverify-\d{3}') { continue }
  $cidMatch = [regex]::Match($line, '"correlation_id":"(?<cid>nlverify-\d{3})"')
  if (-not $cidMatch.Success) { continue }
  $cid = $cidMatch.Groups['cid'].Value

  if ($line -match 'ingest_home_assistant_conversation_start') {
    $haCallByCid[$cid] = $true
  }

  $actionMatch = [regex]::Match($line, '"action":"(?<action>[^"]+)"')
  if ($actionMatch.Success) {
    $action = $actionMatch.Groups['action'].Value

    if ($line -match 'ingest_spotify_capability_done') {
      $actionByCid[$cid] = $action
    }
    elseif (-not $actionByCid.ContainsKey($cid)) {
      $actionByCid[$cid] = $action
    }
  }
}

foreach ($r in $results) {
  if ($actionByCid.ContainsKey($r.cid)) {
    $r.observed_action = $actionByCid[$r.cid]
  }
  if ($haCallByCid.ContainsKey($r.cid)) {
    $r.ha_call_observed = $true
  }
}

[int]$match = ($results | Where-Object { $_.observed_action -eq $_.expected -and $_.observed_action -ne '' }).Count
[int]$wrong = ($results | Where-Object { $_.observed_action -ne '' -and $_.observed_action -ne $_.expected }).Count
[int]$none = ($results | Where-Object { $_.observed_action -eq '' }).Count
[int]$plannerUnavailable = ($results | Where-Object { $_.error_code -eq 'music_planner_unavailable' }).Count
[int]$haObserved = ($results | Where-Object { $_.ha_call_observed }).Count

Write-Output ("AGENT_NL_VERIFY_SUMMARY total={0} expected_match={1} wrong_action={2} no_action_observed={3} planner_unavailable={4} ha_call_observed={5}" -f $results.Count, $match, $wrong, $none, $plannerUnavailable, $haObserved)
$results |
  Group-Object category |
  ForEach-Object {
    [int]$catTotal = $_.Count
    [int]$catMatch = ($_.Group | Where-Object { $_.observed_action -eq $_.expected -and $_.observed_action -ne '' }).Count
    [int]$catWrong = ($_.Group | Where-Object { $_.observed_action -ne '' -and $_.observed_action -ne $_.expected }).Count
    [int]$catNone = ($_.Group | Where-Object { $_.observed_action -eq '' }).Count
    Write-Output ("AGENT_NL_VERIFY_CATEGORY category={0} total={1} expected_match={2} wrong_action={3} no_action_observed={4}" -f $_.Name, $catTotal, $catMatch, $catWrong, $catNone)
  }
$results | ForEach-Object {
  Write-Output ("AGENT_NL_VERIFY_CASE idx={0} cid={1} category={2} expected={3} observed={4} app_status={5} planner={6} error_code={7} ha_call_observed={8} text={9}" -f $_.idx, $_.cid, $_.category, $_.expected, $_.observed_action, $_.app_status, $_.planner, $_.error_code, $_.ha_call_observed, $_.text)
}

$failed = $results | Where-Object { $_.observed_action -ne $_.expected -or $_.ha_call_observed }
if ($failed.Count -gt 0) {
  exit 1
}
