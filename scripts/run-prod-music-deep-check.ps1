$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

$line = Get-Content '.env' | Where-Object { $_ -match '^\s*API_KEY\s*=' } | Select-Object -First 1
if ($line) {
  $k = ($line -split '=',2)[1].Trim().Trim('"')
} else {
  $l2 = Get-Content '.env' | Where-Object { $_ -match '^\s*API_KEYS\s*=' } | Select-Object -First 1
  $k = ((($l2 -split '=',2)[1].Trim().Trim('"')) -split ',')[0].Trim()
}

$h = @{ 'X-API-Key' = $k; 'Content-Type' = 'application/json; charset=utf-8' }
$u = 'http://192.168.1.38:8090/v1/ingest'

$p1 = @{ threadId='prod-music-deep-1'; domain='spotify'; action='transfer'; text='transfere sur mon telephone'; slots=@{ device='alias:phone'; play=$true } } | ConvertTo-Json -Depth 20
$r1 = Invoke-RestMethod -Method Post -Uri $u -Headers $h -Body ([System.Text.Encoding]::UTF8.GetBytes($p1))

$p2 = @{ threadId='prod-music-deep-2'; domain='spotify'; action='play'; text='reprends la musique sur le pc'; slots=@{ device='alias:pc' } } | ConvertTo-Json -Depth 20
$r2 = Invoke-RestMethod -Method Post -Uri $u -Headers $h -Body ([System.Text.Encoding]::UTF8.GetBytes($p2))

$p3 = @{ threadId='prod-music-deep-3'; domain='spotify'; action='volume_set'; text='mets le volume a 30 sur le pc'; slots=@{ volume_percent=30; device='alias:pc' } } | ConvertTo-Json -Depth 20
$r3 = Invoke-RestMethod -Method Post -Uri $u -Headers $h -Body ([System.Text.Encoding]::UTF8.GetBytes($p3))

@(
  [pscustomobject]@{id='music.explicit.transfer.phone'; status=$r1.status; responseText=$r1.responseText},
  [pscustomobject]@{id='music.explicit.play.pc'; status=$r2.status; responseText=$r2.responseText},
  [pscustomobject]@{id='music.explicit.volume_set.pc'; status=$r3.status; responseText=$r3.responseText}
) | ConvertTo-Json -Depth 10
