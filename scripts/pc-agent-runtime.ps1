param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet('install', 'start', 'stop', 'status')]
  [string]$Command
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$agentScript = Join-Path $repositoryRoot 'ops\pc-agent\server.mjs'
$runtimeRoot = Join-Path $repositoryRoot 'runtime\pc-preprod'
$pidPath = Join-Path $runtimeRoot 'pc-agent.pid'
$stdoutPath = Join-Path $runtimeRoot 'pc-agent.stdout.log'
$stderrPath = Join-Path $runtimeRoot 'pc-agent.stderr.log'
$secretPath = Join-Path $runtimeRoot 'secrets\pc-agent-api-key.dpapi'
$edgeEnvPath = Join-Path $repositoryRoot 'ops\edge\pc-edge.env'
$startupPath = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\Jarvis PC Agent.cmd'

function Read-ProtectedSecret([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw 'PC agent secret is missing.' }
  $encrypted = [Convert]::FromBase64String([IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8))
  $plainBytes = [Security.Cryptography.ProtectedData]::Unprotect($encrypted, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  try { return [Text.Encoding]::UTF8.GetString($plainBytes) } finally { [Array]::Clear($plainBytes, 0, $plainBytes.Length) }
}

function Read-PublicBaseUrl {
  foreach ($line in [IO.File]::ReadAllLines($edgeEnvPath, [Text.Encoding]::UTF8)) {
    if ($line.StartsWith('PUBLIC_BASE_URL=')) { return $line.Substring('PUBLIC_BASE_URL='.Length).TrimEnd('/') }
  }
  throw 'PUBLIC_BASE_URL is missing from the edge configuration.'
}

function Get-AgentProcess {
  if (-not (Test-Path -LiteralPath $pidPath -PathType Leaf)) { return $null }
  $agentPid = 0
  if (-not [int]::TryParse([IO.File]::ReadAllText($pidPath).Trim(), [ref]$agentPid)) { return $null }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$agentPid" -ErrorAction SilentlyContinue
  if (-not $process -or -not $process.CommandLine -or $process.CommandLine.IndexOf($agentScript, [StringComparison]::OrdinalIgnoreCase) -lt 0) { return $null }
  return $process
}

function Stop-Agent {
  $process = Get-AgentProcess
  if ($process) { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
}

function Start-Agent {
  Stop-Agent
  New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
  $token = Read-ProtectedSecret $secretPath
  if ($token.Length -lt 32) { throw 'PC agent secret is invalid.' }
  $node = (Get-Command node.exe -ErrorAction Stop).Source
  $previousBaseUrl = $env:JARVIS_PC_AGENT_BASE_URL
  $previousToken = $env:JARVIS_PC_AGENT_API_KEY
  try {
    $env:JARVIS_PC_AGENT_BASE_URL = Read-PublicBaseUrl
    $env:JARVIS_PC_AGENT_API_KEY = $token
    $process = Start-Process -FilePath $node -ArgumentList @("`"$agentScript`"") -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
    [IO.File]::WriteAllText($pidPath, [string]$process.Id, [Text.UTF8Encoding]::new($false))
  } finally {
    if ($null -eq $previousBaseUrl) { Remove-Item Env:JARVIS_PC_AGENT_BASE_URL -ErrorAction SilentlyContinue } else { $env:JARVIS_PC_AGENT_BASE_URL = $previousBaseUrl }
    if ($null -eq $previousToken) { Remove-Item Env:JARVIS_PC_AGENT_API_KEY -ErrorAction SilentlyContinue } else { $env:JARVIS_PC_AGENT_API_KEY = $previousToken }
  }
}

switch ($Command) {
  'install' {
    $escapedScript = $PSCommandPath.Replace('"', '""')
    $content = "@echo off`r`npowershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$escapedScript`" start`r`n"
    [IO.File]::WriteAllText($startupPath, $content, [Text.UTF8Encoding]::new($false))
    Start-Agent
    Write-Host 'Jarvis PC agent installed for the current user.' -ForegroundColor Green
  }
  'start' { Start-Agent; Write-Host 'Jarvis PC agent started.' -ForegroundColor Green }
  'stop' { Stop-Agent; Write-Host 'Jarvis PC agent stopped.' -ForegroundColor Green }
  'status' {
    $process = Get-AgentProcess
    if ($process) { Write-Host "Jarvis PC agent running (PID $($process.ProcessId))." -ForegroundColor Green }
    else { Write-Host 'Jarvis PC agent is stopped.' -ForegroundColor Yellow; exit 1 }
  }
}
