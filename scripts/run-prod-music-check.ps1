param(
  [string]$HostIP = "192.168.1.38",
  [string]$Port = "8090"
)

$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

$apiKeyLine = Get-Content '.env' | Where-Object { $_ -match '^\s*API_KEY\s*=' } | Select-Object -First 1
if ($apiKeyLine) {
  $apiKey = ($apiKeyLine -split '=', 2)[1].Trim().Trim('"')
} else {
  $apiKeysLine = Get-Content '.env' | Where-Object { $_ -match '^\s*API_KEYS\s*=' } | Select-Object -First 1
  if (-not $apiKeysLine) { throw 'API_KEY/API_KEYS introuvable dans .env' }
  $apiKey = (($apiKeysLine -split '=', 2)[1].Trim().Trim('"') -split ',')[0].Trim()
}

$baseUrl = "http://$HostIP`:$Port"
$headers = @{ 'X-API-Key' = $apiKey; 'Content-Type' = 'application/json; charset=utf-8' }
$runId = [guid]::NewGuid().ToString('N').Substring(0, 8)

function Invoke-IngestCase {
  param(
    [string]$id,
    [hashtable]$payload,
    [string]$mustContain = '',
    [string]$mustNotContain = ''
  )

  $json = $payload | ConvertTo-Json -Depth 20
  try {
    $resp = Invoke-RestMethod -Method Post -Uri "$baseUrl/v1/ingest" -Headers $headers -Body ([System.Text.Encoding]::UTF8.GetBytes($json))
    $text = [string]$resp.responseText
    $ok = $true
    if ($mustContain -and -not $text.ToLowerInvariant().Contains($mustContain.ToLowerInvariant())) { $ok = $false }
    if ($mustNotContain -and $text.ToLowerInvariant().Contains($mustNotContain.ToLowerInvariant())) { $ok = $false }

    return [pscustomobject]@{
      id = $id
      ok = $ok
      threadId = $resp.threadId
      status = $resp.status
      responseText = $text
    }
  } catch {
    return [pscustomobject]@{
      id = $id
      ok = $false
      threadId = ''
      status = 'http_error'
      responseText = $_.Exception.Message
    }
  }
}

$cases = @(
  @{ id='music.explicit.list_devices'; mustContain='appareil'; mustNotContain=''; payload=@{ threadId="prod-music-$runId-1"; domain='spotify'; action='list_devices'; text='liste mes appareils spotify' } },
  @{ id='music.explicit.now_playing'; mustContain=''; mustNotContain='Action Spotify non support'; payload=@{ threadId="prod-music-$runId-2"; domain='spotify'; action='now_playing'; text='qu est ce qui joue' } },
  @{ id='music.explicit.search'; mustContain=''; mustNotContain='Action Spotify non support'; payload=@{ threadId="prod-music-$runId-3"; domain='spotify'; action='search'; text='cherche daft punk'; slots=@{ query='daft punk'; type='track' } } },
  @{ id='music.text.pause'; mustContain=''; mustNotContain='je ne peux pas'; payload=@{ threadId="prod-music-$runId-4"; text='mets en pause spotify' } },
  @{ id='music.text.play_generic'; mustContain=''; mustNotContain='je ne peux pas'; payload=@{ threadId="prod-music-$runId-5"; text='mets de la musique sur spotify' } },
  @{ id='music.text.volume'; mustContain=''; mustNotContain='manuellement sur votre appareil'; payload=@{ threadId="prod-music-$runId-6"; text='baisse le volume de 10' } }
)

$results = @()
foreach ($c in $cases) {
  $results += Invoke-IngestCase -id $c.id -payload $c.payload -mustContain $c.mustContain -mustNotContain $c.mustNotContain
}

$passed = ($results | Where-Object { $_.ok }).Count
$total = $results.Count
Write-Output ("MUSIC_PROD_SUMMARY {0}/{1} passed" -f $passed, $total)
$results | ConvertTo-Json -Depth 8
