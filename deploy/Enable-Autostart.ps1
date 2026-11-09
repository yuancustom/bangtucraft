$ErrorActionPreference = 'Stop'
$entry = Join-Path $PSScriptRoot 'Start-Agent.ps1'
$shellExe = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
$action = New-ScheduledTaskAction -Execute $shellExe -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $entry + '"')
$trigger = New-ScheduledTaskTrigger -AtLogOn -User ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'BangBangTuTu-Agent' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'BangtuCraft Windows Agent and local search worker' -Force | Out-Null
Write-Output 'Registered logon startup: BangBangTuTu-Agent'
