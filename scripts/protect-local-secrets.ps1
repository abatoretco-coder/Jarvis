param(
  [string[]]$AdditionalPath = @(),
  [switch]$OnlyAdditionalPath
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$currentUserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$administratorsSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')

$defaultTargets = @(
  (Join-Path $repositoryRoot '.env.pc'),
  (Join-Path $repositoryRoot 'ops\pc\env\pc-preprod-full.env'),
  (Join-Path $repositoryRoot 'ops\edge\pc-edge.env'),
  (Join-Path $repositoryRoot 'runtime\pc-preprod\data'),
  (Join-Path $repositoryRoot 'runtime\pc-preprod\secrets'),
  (Join-Path $repositoryRoot 'runtime\pc-preprod\identity')
)
$targets = @($(if ($OnlyAdditionalPath) { @() } else { $defaultTargets }) + $AdditionalPath)

foreach ($target in $targets | Select-Object -Unique) {
  if (-not (Test-Path -LiteralPath $target)) { continue }

  $item = Get-Item -LiteralPath $target -Force
  $acl = Get-Acl -LiteralPath $item.FullName
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.Access)) {
    [void]$acl.RemoveAccessRuleSpecific($rule)
  }

  $inheritance = if ($item.PSIsContainer) {
    [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
  } else {
    [Security.AccessControl.InheritanceFlags]::None
  }
  $propagation = [Security.AccessControl.PropagationFlags]::None
  foreach ($sid in @($currentUserSid, $systemSid, $administratorsSid)) {
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
      $sid,
      [Security.AccessControl.FileSystemRights]::FullControl,
      $inheritance,
      $propagation,
      [Security.AccessControl.AccessControlType]::Allow
    )
    [void]$acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $item.FullName -AclObject $acl
  Write-Host "Protected: $($item.FullName)"
}
