param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet('configure', 'start', 'stop', 'status', 'test')]
  [string]$Command,
  [ValidateSet('rehearsal', 'public')]
  [string]$Mode = 'rehearsal',
  [string]$PublicBaseUrl = '',
  [switch]$NoBuild,
  [switch]$ForceRecreate
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$baseCompose = Join-Path $repositoryRoot 'compose.pc.yaml'
$edgeCompose = Join-Path $repositoryRoot 'compose.edge.yaml'
$runtimeEnv = Join-Path $repositoryRoot 'ops\pc\env\pc-preprod-full.env'
$edgeEnv = Join-Path $repositoryRoot 'ops\edge\pc-edge.env'
$secretsRoot = Join-Path $repositoryRoot 'runtime\pc-preprod\secrets'
$edgeSecretPath = Join-Path $secretsRoot 'edge-proxy-secret.dpapi'
$identitySecretPath = Join-Path $secretsRoot 'keycloak-bootstrap-admin.dpapi'
$pcAgentSecretPath = Join-Path $secretsRoot 'pc-agent-api-key.dpapi'
$oauthSource = Join-Path $repositoryRoot '.env.pc'
$oauthEnvironmentKeys = @(
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'MICROSOFT_TENANT_ID',
  'MICROSOFT_CLIENT_ID',
  'MICROSOFT_CLIENT_SECRET',
  'SPOTIFY_WEBAPI_CLIENT_ID',
  'SPOTIFY_WEBAPI_CLIENT_SECRET'
)
$originalOAuthEnvironment = @{}
foreach ($key in $oauthEnvironmentKeys) {
  $value = [Environment]::GetEnvironmentVariable($key, 'Process')
  if ($null -ne $value) { $originalOAuthEnvironment[$key] = $value }
}

function New-RandomSecret([int]$Bytes = 48) {
  $buffer = [byte[]]::new($Bytes)
  $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $generator.GetBytes($buffer)
    return [Convert]::ToBase64String($buffer).TrimEnd('=').Replace('+', '-').Replace('/', '_')
  } finally {
    $generator.Dispose()
    [Array]::Clear($buffer, 0, $buffer.Length)
  }
}

function Save-ProtectedSecret([string]$Path, [string]$Value) {
  New-Item -ItemType Directory -Path $secretsRoot -Force | Out-Null
  $plainBytes = [Text.Encoding]::UTF8.GetBytes($Value)
  try {
    $encrypted = [Security.Cryptography.ProtectedData]::Protect(
      $plainBytes,
      $null,
      [Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    [IO.File]::WriteAllText($Path, [Convert]::ToBase64String($encrypted), [Text.UTF8Encoding]::new($false))
  } finally {
    [Array]::Clear($plainBytes, 0, $plainBytes.Length)
  }
}

function Read-ProtectedSecret([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
  $encrypted = [Convert]::FromBase64String([IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8))
  $plainBytes = [Security.Cryptography.ProtectedData]::Unprotect(
    $encrypted,
    $null,
    [Security.Cryptography.DataProtectionScope]::CurrentUser
  )
  try {
    return [Text.Encoding]::UTF8.GetString($plainBytes)
  } finally {
    [Array]::Clear($plainBytes, 0, $plainBytes.Length)
  }
}

function Assert-PublicOrigin([string]$Value, [bool]$RequirePublicName) {
  try { $uri = [Uri]$Value } catch { throw 'PublicBaseUrl must be a valid HTTPS origin.' }
  if ($uri.Scheme -ne 'https' -or $uri.UserInfo -or $uri.AbsolutePath -ne '/' -or $uri.Query -or $uri.Fragment) {
    throw 'PublicBaseUrl must be an HTTPS origin without credentials, path, query or fragment.'
  }
  if ($RequirePublicName) {
    $hostname = $uri.DnsSafeHost.ToLowerInvariant()
    $blocked = $hostname -eq 'localhost' -or $hostname.EndsWith('.localhost') -or
      $hostname.EndsWith('.local') -or $hostname.EndsWith('.internal') -or
      $hostname.EndsWith('.home.arpa') -or $hostname -match '^\d{1,3}(\.\d{1,3}){3}$'
    if ($blocked) { throw 'Public mode requires a real public DNS hostname, not a local name or IP address.' }
    if (-not $uri.IsDefaultPort) { throw 'Public mode requires standard HTTPS on port 443.' }
  }
}

function Read-EdgeConfiguration() {
  if (-not (Test-Path -LiteralPath $edgeEnv -PathType Leaf)) {
    throw "HTTPS is not configured. Run: .\scripts\https-runtime.ps1 configure -Mode rehearsal"
  }
  $values = @{}
  foreach ($line in [IO.File]::ReadAllLines($edgeEnv, [Text.Encoding]::UTF8)) {
    if (-not $line -or $line.StartsWith('#')) { continue }
    $pair = $line.Split('=', 2)
    if ($pair.Count -eq 2) { $values[$pair[0]] = $pair[1] }
  }
  foreach ($required in @('PUBLIC_BASE_URL', 'CADDY_SITE_ADDRESS', 'CADDY_TLS_MODE', 'JARVIS_EDGE_BIND_HOST', 'JARVIS_EDGE_HTTP_PORT', 'JARVIS_EDGE_HTTPS_PORT', 'HSTS_MAX_AGE_SECONDS')) {
    if (-not $values.ContainsKey($required) -or [string]::IsNullOrWhiteSpace($values[$required])) {
      throw "HTTPS configuration is missing $required."
    }
  }
  return $values
}

function Import-OAuthEnvironment() {
  if (Test-Path -LiteralPath $oauthSource -PathType Leaf) {
    $allowed = @{}
    foreach ($key in $oauthEnvironmentKeys) { $allowed[$key] = $true }
    foreach ($line in [IO.File]::ReadAllLines($oauthSource, [Text.Encoding]::UTF8)) {
      if (-not $line -or $line.StartsWith('#')) { continue }
      $pair = $line.Split('=', 2)
      if ($pair.Count -ne 2 -or -not $allowed.ContainsKey($pair[0])) { continue }
      if ([string]::IsNullOrWhiteSpace($pair[1])) { continue }
      $existing = [Environment]::GetEnvironmentVariable($pair[0], 'Process')
      if ([string]::IsNullOrWhiteSpace($existing)) {
        [Environment]::SetEnvironmentVariable($pair[0], $pair[1], 'Process')
      }
    }
  }
  foreach ($pair in @(
    @('GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'),
    @('MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET'),
    @('SPOTIFY_WEBAPI_CLIENT_ID', 'SPOTIFY_WEBAPI_CLIENT_SECRET')
  )) {
    $hasClient = -not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($pair[0], 'Process'))
    $hasSecret = -not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($pair[1], 'Process'))
    if ($hasClient -ne $hasSecret) {
      throw "OAuth configuration must define both $($pair[0]) and $($pair[1])."
    }
  }
}

function Import-RuntimeEnvironment() {
  $values = Read-EdgeConfiguration
  foreach ($entry in $values.GetEnumerator()) {
    [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process')
  }
  $edgeSecret = Read-ProtectedSecret $edgeSecretPath
  if ($edgeSecret.Length -lt 32) { throw 'The protected edge secret is missing or invalid.' }
  $identitySecret = Read-ProtectedSecret $identitySecretPath
  if ($identitySecret.Length -lt 32) { throw 'The protected Keycloak bootstrap secret is missing or invalid.' }
  if (-not (Test-Path -LiteralPath $pcAgentSecretPath -PathType Leaf)) {
    Save-ProtectedSecret $pcAgentSecretPath (New-RandomSecret)
  }
  $pcAgentSecret = Read-ProtectedSecret $pcAgentSecretPath
  if ($pcAgentSecret.Length -lt 32) { throw 'The protected PC agent secret is missing or invalid.' }
  $runtimeValues = @{}
  foreach ($line in [IO.File]::ReadAllLines($runtimeEnv, [Text.Encoding]::UTF8)) {
    if (-not $line -or $line.StartsWith('#')) { continue }
    $pair = $line.Split('=', 2)
    if ($pair.Count -eq 2) { $runtimeValues[$pair[0]] = $pair[1] }
  }
  $services = @()
  if ($runtimeValues.ContainsKey('SERVICE_API_KEYS_JSON') -and $runtimeValues.SERVICE_API_KEYS_JSON) {
    $parsedServices = $runtimeValues.SERVICE_API_KEYS_JSON | ConvertFrom-Json
    # Windows PowerShell 5.1 can preserve a JSON array as one pipeline object.
    # Enumerate it explicitly to avoid serializing it later as { value, Count }.
    if ($parsedServices -is [Array]) {
      $services = @($parsedServices.GetEnumerator())
    } else {
      $services = @($parsedServices)
    }
  }
  # Native Desktop authenticates with OIDC. Do not keep its retired static key
  # in the Internet-facing runtime.
  $services = @($services | Where-Object { $_.id -notin @('pc-agent', 'desktop-local') }) + @(
    [pscustomobject]@{ id = 'pc-agent'; token = $pcAgentSecret; permissions = @('music') }
  )
  $env:EDGE_PROXY_SECRET = $edgeSecret
  $env:KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD = $identitySecret
  # ConvertTo-Json enumerates pipeline input and emits one JSON document per
  # credential. Keep the array as a single value so the container receives a
  # valid credential array even when more than one service is configured.
  $env:SERVICE_API_KEYS_JSON = ConvertTo-Json -InputObject $services -Compress -Depth 5
  $env:JARVIS_ENV_FILE = $runtimeEnv
  Import-OAuthEnvironment
  return $values
}

function Invoke-EdgeCompose([string[]]$Arguments) {
  & docker compose --file $baseCompose --file $edgeCompose --profile pc-preprod-full @Arguments
  if ($LASTEXITCODE -ne 0) { throw "docker compose failed with exit code $LASTEXITCODE" }
}

function Invoke-HttpProbe([string]$Url, [bool]$AllowInternalCertificate = $false) {
  $arguments = @('--silent', '--show-error', '--fail', '--max-time', '15')
  if ($AllowInternalCertificate) { $arguments += '--insecure' }
  $arguments += $Url
  $result = & curl.exe @arguments
  if ($LASTEXITCODE -ne 0) { throw "HTTPS probe failed: $Url" }
  return $result
}

Push-Location $repositoryRoot
try {
  switch ($Command) {
    'configure' {
      if ($Mode -eq 'rehearsal') {
        $origin = 'https://jarvis.localhost:8443'
        $lines = @(
          "PUBLIC_BASE_URL=$origin",
          'CADDY_SITE_ADDRESS=https://jarvis.localhost',
          'CADDY_TLS_MODE=internal',
          'JARVIS_EDGE_BIND_HOST=127.0.0.1',
          'JARVIS_EDGE_HTTP_PORT=18080',
          'JARVIS_EDGE_HTTPS_PORT=8443',
          'HSTS_MAX_AGE_SECONDS=300'
        )
      } else {
        Assert-PublicOrigin $PublicBaseUrl $true
        $origin = $PublicBaseUrl.TrimEnd('/')
        $lines = @(
          "PUBLIC_BASE_URL=$origin",
          "CADDY_SITE_ADDRESS=$origin",
          'CADDY_TLS_MODE=force_automate',
          'JARVIS_EDGE_BIND_HOST=0.0.0.0',
          'JARVIS_EDGE_HTTP_PORT=80',
          'JARVIS_EDGE_HTTPS_PORT=443',
          'HSTS_MAX_AGE_SECONDS=31536000'
        )
      }
      New-Item -ItemType Directory -Path (Split-Path -Parent $edgeEnv) -Force | Out-Null
      [IO.File]::WriteAllLines($edgeEnv, $lines, [Text.UTF8Encoding]::new($false))
      if (-not (Test-Path -LiteralPath $edgeSecretPath -PathType Leaf)) {
        Save-ProtectedSecret $edgeSecretPath (New-RandomSecret)
      }
      if (-not (Test-Path -LiteralPath $pcAgentSecretPath -PathType Leaf)) {
        Save-ProtectedSecret $pcAgentSecretPath (New-RandomSecret)
      }
      Write-Host "HTTPS $Mode configured for $origin" -ForegroundColor Green
    }
    'start' {
      $configuration = Import-RuntimeEnvironment
      Assert-PublicOrigin $configuration.PUBLIC_BASE_URL ($configuration.CADDY_TLS_MODE -ne 'internal')
      $upArguments = @('up', '--detach', '--wait')
      if ($NoBuild) { $upArguments += '--no-build' } else { $upArguments += '--build' }
      if ($ForceRecreate) { $upArguments += '--force-recreate' }
      Invoke-EdgeCompose $upArguments
      # The Caddyfile is bind-mounted, so always recreate only the small edge
      # container to guarantee that configuration edits are loaded.
      Invoke-EdgeCompose @('up', '--detach', '--force-recreate', '--wait', 'edge')
      & (Join-Path $PSScriptRoot 'pc-agent-runtime.ps1') start
      Write-Host "Jarvis HTTPS started at $($configuration.PUBLIC_BASE_URL)" -ForegroundColor Green
    }
    'stop' {
      Import-RuntimeEnvironment | Out-Null
      Invoke-EdgeCompose @('down', '--remove-orphans')
    }
    'status' {
      Import-RuntimeEnvironment | Out-Null
      Invoke-EdgeCompose @('ps')
    }
    'test' {
      $configuration = Import-RuntimeEnvironment
      $internalCertificate = $configuration.CADDY_TLS_MODE -eq 'internal'
      $ready = Invoke-HttpProbe "$($configuration.PUBLIC_BASE_URL)/ready" $internalCertificate
      $discovery = Invoke-HttpProbe "$($configuration.PUBLIC_BASE_URL)/realms/jarvis/.well-known/openid-configuration" $internalCertificate | ConvertFrom-Json
      if ($ready -notmatch '"status"\s*:\s*"ready"') { throw 'Jarvis readiness response is invalid.' }
      if ($discovery.issuer -ne "$($configuration.PUBLIC_BASE_URL)/realms/jarvis") { throw 'OIDC issuer does not match the public HTTPS origin.' }
      $directStatus = & curl.exe --silent --output NUL --write-out '%{http_code}' --max-time 10 http://127.0.0.1:8090/ready
      if ($directStatus -ne '403') { throw "Direct Jarvis origin was expected to reject with 403, got $directStatus." }
      Write-Host 'HTTPS, OIDC discovery and origin isolation checks passed.' -ForegroundColor Green
    }
  }
} finally {
  Remove-Item Env:EDGE_PROXY_SECRET -ErrorAction SilentlyContinue
  Remove-Item Env:KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:SERVICE_API_KEYS_JSON -ErrorAction SilentlyContinue
  foreach ($key in $oauthEnvironmentKeys) {
    if ($originalOAuthEnvironment.ContainsKey($key)) {
      [Environment]::SetEnvironmentVariable($key, $originalOAuthEnvironment[$key], 'Process')
    } else {
      Remove-Item "Env:$key" -ErrorAction SilentlyContinue
    }
  }
  Pop-Location
}
