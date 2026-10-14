[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('install', 'start', 'status', 'test')]
  [string]$Command = 'start',
  [ValidateRange(10, 600)]
  [int]$DockerReadyTimeoutSeconds = 180
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$workspaceRoot = Split-Path $repositoryRoot -Parent
$dockerStarter = Join-Path $workspaceRoot 'Home assistant\scripts\start-jarvis-docker.ps1'
$httpsRuntime = Join-Path $PSScriptRoot 'https-runtime.ps1'
$agentRuntime = Join-Path $PSScriptRoot 'pc-agent-runtime.ps1'
$runtimeRoot = Join-Path $repositoryRoot 'runtime\pc-preprod'
$logPath = Join-Path $runtimeRoot 'startup-runtime.log'
$startupDirectory = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
$startupPath = Join-Path $startupDirectory 'Jarvis Runtime.cmd'
$legacyDockerShortcut = Join-Path $startupDirectory 'Jarvis Docker Runtime.lnk'
$legacyAgentStartup = Join-Path $startupDirectory 'Jarvis PC Agent.cmd'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$mutex = [Threading.Mutex]::new($false, 'Local\JarvisPublicRuntimeStartup')
$ownsMutex = $false

function Write-StartupLog([string]$Message) {
  New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
  $line = '{0:o} {1}' -f [DateTime]::Now, $Message
  [IO.File]::AppendAllText($logPath, "$line`r`n", [Text.UTF8Encoding]::new($false))
  Write-Output $line
}

function Invoke-Logged([scriptblock]$Operation) {
  try {
    & $Operation *>&1 | ForEach-Object {
      Write-StartupLog ([string]$_)
    }
    if (-not $?) {
      throw 'A runtime startup operation returned a failure.'
    }
  } catch {
    Write-StartupLog ("Runtime operation failed: {0}" -f $_.Exception.Message)
    throw
  }
}

function Install-StartupRuntime {
  New-Item -ItemType Directory -Path $startupDirectory -Force | Out-Null
  $backupRoot = Join-Path $env:LOCALAPPDATA 'Jarvis\startup-backups'
  $backupPath = Join-Path $backupRoot ([DateTime]::Now.ToString('yyyyMMdd-HHmmss'))
  New-Item -ItemType Directory -Path $backupPath -Force | Out-Null

  $dockerRunValue = $null
  try {
    $dockerRunValue = Get-ItemPropertyValue -LiteralPath $runKey -Name 'Docker Desktop' -ErrorAction Stop
  } catch [System.Management.Automation.ItemNotFoundException] {
    $dockerRunValue = $null
  } catch [System.Management.Automation.PSArgumentException] {
    $dockerRunValue = $null
  }
  if ($null -ne $dockerRunValue) {
    [IO.File]::WriteAllText((Join-Path $backupPath 'Docker Desktop.run.txt'), [string]$dockerRunValue, [Text.UTF8Encoding]::new($false))
    Remove-ItemProperty -LiteralPath $runKey -Name 'Docker Desktop'
  }

  foreach ($legacyPath in @($legacyDockerShortcut, $legacyAgentStartup, $startupPath)) {
    if (Test-Path -LiteralPath $legacyPath -PathType Leaf) {
      Move-Item -LiteralPath $legacyPath -Destination (Join-Path $backupPath (Split-Path $legacyPath -Leaf))
    }
  }

  $escapedScript = $PSCommandPath.Replace('"', '""')
  $content = "@echo off`r`npowershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$escapedScript`" start`r`n"
  [IO.File]::WriteAllText($startupPath, $content, [Text.UTF8Encoding]::new($false))
  Write-StartupLog "Installed the single Jarvis startup entry. Previous entries were saved to $backupPath"
}

function Start-PublicRuntime {
  try {
    try {
      $ownsMutex = $script:mutex.WaitOne(0)
    } catch [Threading.AbandonedMutexException] {
      $ownsMutex = $true
    }
    $script:ownsMutex = $ownsMutex
    if (-not $ownsMutex) {
      Write-StartupLog 'Another Jarvis startup is already running; this invocation will exit.'
      return
    }

    Write-StartupLog 'Starting the Jarvis public runtime.'
    Invoke-Logged { & $dockerStarter -ReadyTimeoutSeconds $DockerReadyTimeoutSeconds }
    Invoke-Logged { & $httpsRuntime start -Mode public -NoBuild }
    Invoke-Logged { & $httpsRuntime test -Mode public }
    Write-StartupLog 'Jarvis public runtime is ready.'
  } catch {
    Write-StartupLog ("Jarvis startup failed: {0}" -f $_.Exception.Message)
    throw
  } finally {
    if ($script:ownsMutex) {
      $script:mutex.ReleaseMutex()
      $script:ownsMutex = $false
    }
  }
}

try {
  foreach ($requiredPath in @($dockerStarter, $httpsRuntime, $agentRuntime)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
      throw "Required runtime script not found: $requiredPath"
    }
  }

  switch ($Command) {
    'install' { Install-StartupRuntime }
    'start' { Start-PublicRuntime }
    'status' {
      Invoke-Logged { docker --context desktop-linux info --format 'Docker {{.ServerVersion}}' }
      if ($LASTEXITCODE -ne 0) { throw 'Docker Desktop is not ready.' }
      Invoke-Logged { & $httpsRuntime status -Mode public }
      Invoke-Logged { & $agentRuntime status }
    }
    'test' {
      Invoke-Logged { & $httpsRuntime test -Mode public }
      Invoke-Logged { & $agentRuntime status }
    }
  }
} finally {
  if ($ownsMutex) {
    $mutex.ReleaseMutex()
  }
  $mutex.Dispose()
}
