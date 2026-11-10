$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $projectRoot 'data'
New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
$entry = Join-Path $projectRoot 'scripts/start-windows.mjs'
$pidFile = Join-Path $runtimeDir 'windows-agent.pid'
$existingAgent = $null
if (Test-Path -LiteralPath $pidFile) {
    $savedAgentId = [int](Get-Content -LiteralPath $pidFile)
    $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $savedAgentId" -ErrorAction SilentlyContinue
    if ($candidate -and $candidate.CommandLine -like ('*"' + $entry + '"*')) { $existingAgent = $candidate }
}
if ($existingAgent) {
    # Reuse the execution host during web updates; never stop its tasks.
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        $listener = Get-NetTCPConnection -State Listen -LocalPort 8787 -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($listener) {
            $ancestorId = $listener.OwningProcess
            $owned = $false
            for ($depth = 0; $depth -lt 10 -and $ancestorId; $depth++) {
                if ($ancestorId -eq $existingAgent.ProcessId) { $owned = $true; break }
                $ancestor = Get-CimInstance Win32_Process -Filter "ProcessId = $ancestorId" -ErrorAction SilentlyContinue
                $ancestorId = if ($ancestor) { $ancestor.ParentProcessId } else { 0 }
            }
            if (-not $owned) { throw 'Port 8787 belongs to a different process; existing Agent was left running.' }
            $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/health' -TimeoutSec 10
            if ($health.status -eq 'ok') {
                Write-Output ('Reusing Windows Agent PID: ' + $existingAgent.ProcessId + '; running tasks preserved.')
                return
            }
        }
        Start-Sleep -Seconds 1
    }
    throw 'Existing Windows Agent is not ready; it was left running to preserve tasks.'
}
if (Get-NetTCPConnection -State Listen -LocalPort 8787 -ErrorAction SilentlyContinue) {
    throw 'Port 8787 is occupied by an unverified process. No process was stopped.'
}
$nodeExe = (Get-Command node -ErrorAction Stop).Source
$agentProcess = Start-Process -FilePath $nodeExe -ArgumentList @('"' + $entry + '"') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeDir 'windows-agent.stdout.log') -RedirectStandardError (Join-Path $runtimeDir 'windows-agent.stderr.log') -PassThru
$agentProcess.Id | Set-Content -Encoding Ascii -LiteralPath $pidFile
Write-Output ('BangtuCraft Windows Agent PID: ' + $agentProcess.Id)
