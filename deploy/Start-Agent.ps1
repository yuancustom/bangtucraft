$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $projectRoot 'data'
New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
if (Get-NetTCPConnection -State Listen -LocalPort 8787 -ErrorAction SilentlyContinue) {
    throw 'Port 8787 is occupied. Stop the previous Agent before starting BangtuCraft.'
}
$nodeExe = (Get-Command node -ErrorAction Stop).Source
$entry = Join-Path $projectRoot 'scripts/start-windows.mjs'
$agentProcess = Start-Process -FilePath $nodeExe -ArgumentList @('"' + $entry + '"') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeDir 'windows-agent.stdout.log') -RedirectStandardError (Join-Path $runtimeDir 'windows-agent.stderr.log') -PassThru
$agentProcess.Id | Set-Content -Encoding Ascii -LiteralPath (Join-Path $runtimeDir 'windows-agent.pid')
Write-Output ('BangtuCraft Windows Agent PID: ' + $agentProcess.Id)
