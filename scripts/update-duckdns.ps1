param(
  [string]$Domain = 'jarvis-abato'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security

if ($Domain -notmatch '^[a-z0-9-]{1,63}$') {
  throw 'DuckDNS domain must contain only lowercase letters, digits and hyphens.'
}

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$secretPath = Join-Path $repositoryRoot 'runtime\pc-preprod\secrets\duckdns-token.dpapi'
if (-not (Test-Path -LiteralPath $secretPath -PathType Leaf)) {
  throw 'Protected DuckDNS credential is missing.'
}

$encrypted = [Convert]::FromBase64String([IO.File]::ReadAllText($secretPath, [Text.Encoding]::UTF8))
$plain = [Security.Cryptography.ProtectedData]::Unprotect(
  $encrypted,
  $null,
  [Security.Cryptography.DataProtectionScope]::CurrentUser
)

try {
  $token = [Text.Encoding]::UTF8.GetString($plain)
  if ($token -notmatch '^[A-Za-z0-9_-]{24,}$') { throw 'Protected DuckDNS credential is invalid.' }
  $encodedDomain = [Uri]::EscapeDataString($Domain)
  $encodedToken = [Uri]::EscapeDataString($token)
  try {
    $response = Invoke-RestMethod `
      -Uri "https://www.duckdns.org/update?domains=$encodedDomain&token=$encodedToken&ip=" `
      -Method Get `
      -TimeoutSec 20
  } catch {
    throw 'DuckDNS update request failed.'
  }
  if ([string]$response -ne 'OK') { throw 'DuckDNS rejected the update.' }
  Write-Output "$Domain.duckdns.org is synchronized."
} finally {
  $token = $null
  [Array]::Clear($plain, 0, $plain.Length)
}
