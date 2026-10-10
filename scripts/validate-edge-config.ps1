$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$caddyfiles = @(
  (Join-Path $repositoryRoot 'ops/edge/Caddyfile.pc-preprod'),
  (Join-Path $repositoryRoot 'ops/edge/Caddyfile.pc-edge')
)
$publicEdgeCaddyfile = $caddyfiles[1]
$publicEdgeConfig = Get-Content -LiteralPath $publicEdgeCaddyfile -Raw
if ($publicEdgeConfig -match '(?m)^\s*@identity\s+path\s+/realms/\*') {
  throw 'The public edge must not expose every Keycloak realm'
}
foreach ($requiredFragment in @('/realms/jarvis', 'Strict-Transport-Security')) {
  if (-not $publicEdgeConfig.Contains($requiredFragment)) {
    throw "Public edge security directive is missing: $requiredFragment"
  }
}

$realmPath = Join-Path $repositoryRoot 'ops/pc/keycloak/realm-jarvis.json'
$realm = Get-Content -LiteralPath $realmPath -Raw | ConvertFrom-Json
foreach ($clientId in @('jarvis-desktop', 'jarvis-android', 'jarvis-web')) {
  $client = @($realm.clients | Where-Object { $_.clientId -eq $clientId })
  if ($client.Count -ne 1 -or $client[0].attributes.'pkce.code.challenge.method' -ne 'S256') {
    throw "OIDC public client must require PKCE S256: $clientId"
  }
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw 'Docker is required to validate the pinned Caddy configuration'
}

foreach ($caddyfile in $caddyfiles) {
  if (-not (Test-Path -LiteralPath $caddyfile)) {
    throw "Caddyfile is missing: $caddyfile"
  }
  $mount = "type=bind,source=$caddyfile,target=/etc/caddy/Caddyfile,readonly"
  & docker run --rm `
    --env 'PUBLIC_BASE_URL=https://jarvis.example.test' `
    --env 'CADDY_SITE_ADDRESS=https://jarvis.example.test' `
    --env 'CADDY_TLS_MODE=internal' `
    --env 'EDGE_PROXY_SECRET=validation-only-edge-secret-32-characters' `
    --mount $mount `
    'caddy:2.11.7-alpine' `
    caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
  if ($LASTEXITCODE -ne 0) {
    throw "Caddy validation failed for $caddyfile with exit code $LASTEXITCODE"
  }
}
