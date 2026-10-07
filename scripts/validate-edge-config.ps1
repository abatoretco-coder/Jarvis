$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$caddyfile = Join-Path $repositoryRoot 'ops/edge/Caddyfile.pc-preprod'
if (-not (Test-Path -LiteralPath $caddyfile)) {
  throw 'Caddyfile.pc-preprod is missing'
}
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw 'Docker is required to validate the pinned Caddy configuration'
}

$mount = "type=bind,source=$caddyfile,target=/etc/caddy/Caddyfile,readonly"
& docker run --rm `
  --env 'EDGE_PROXY_SECRET=validation-only-edge-secret-32-characters' `
  --mount $mount `
  'caddy:2.11.6-alpine' `
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
if ($LASTEXITCODE -ne 0) {
  throw "Caddy validation failed with exit code $LASTEXITCODE"
}
