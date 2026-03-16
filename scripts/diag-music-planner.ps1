$ErrorActionPreference='Stop'

function Get-EnvValue([string]$Path,[string]$Key){
  if(-not (Test-Path $Path)){ return $null }
  $line = Get-Content -Path $Path | Where-Object { $_ -match "^\s*$([Regex]::Escape($Key))\s*=" } | Select-Object -First 1
  if(-not $line){ return $null }
  return (($line -split '=',2)[1]).Trim()
}

$apiKey = Get-EnvValue '.env' 'API_KEY'
if(-not $apiKey){
  $apiKeys = Get-EnvValue '.env' 'API_KEYS'
  if($apiKeys){ $apiKey = (($apiKeys -split ',')[0]).Trim() }
}
$headers = @{}
if($apiKey){ $headers['X-API-Key'] = $apiKey }

$body = @{
  threadId='diag-music-planner-001'
  text='mets de la musique sur spotify dans le salon'
  correlation_id='diag-music-planner-001'
  user_id='tester'
} | ConvertTo-Json -Depth 8

$resp = Invoke-RestMethod -Uri 'http://192.168.1.38:8090/v1/ingest' -Method Post -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 30
Write-Output ('DIAG_INGEST_RESPONSE ' + ($resp | ConvertTo-Json -Depth 8 -Compress))

$ssh='C:\Windows\System32\OpenSSH\ssh.exe'
if(!(Test-Path $ssh)){ $ssh='ssh.exe' }
$remote = @'
set -euo pipefail
docker compose -f /opt/naas/stacks/home-assistant/docker-compose.prod.yml --profile vm400 logs --tail=220 jarvis
'@
$raw = ($remote | & $ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new "loic@192.168.1.38" "tr -d '\r' | bash -s")
$raw | Select-String -Pattern 'music_agent_planning_failed_fallback_to_home_assistant|music_agent_generated_invalid_spotify_payload|music_agent_provider_error|ingest_home_assistant_call_failed|openai' -CaseSensitive:$false | ForEach-Object { $_.Line }
