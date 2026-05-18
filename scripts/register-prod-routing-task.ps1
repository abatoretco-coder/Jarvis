param(
  [string]$TaskName = "Jarvis-Prod-Routing-Collect",
  [string]$Schedule = "Daily",
  [string]$Time = "03:30",
  [string]$JarvisDir = "D:\NAS\All VM\Jarvis",
  [int]$KeepRuns = 14
)

$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $JarvisDir "scripts\collect-prod-routing-data.ps1"
if (-not (Test-Path $scriptPath)) {
  throw "Collector script not found: $scriptPath"
}

$command = "Set-Location '$JarvisDir'; .\\scripts\\collect-prod-routing-data.ps1 -RunProbes:`$true -KeepRuns $KeepRuns"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -Command \"$command\""

if ($Schedule -eq "Daily") {
  $trigger = New-ScheduledTaskTrigger -Daily -At $Time
} elseif ($Schedule -eq "Weekly") {
  $trigger = New-ScheduledTaskTrigger -Weekly -At $Time -DaysOfWeek Monday
} else {
  throw "Unsupported schedule '$Schedule'. Use Daily or Weekly."
}

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null

Write-Host "[prod-task] registered: $TaskName ($Schedule at $Time)" -ForegroundColor Green
