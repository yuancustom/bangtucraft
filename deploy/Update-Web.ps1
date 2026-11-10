$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $projectRoot
try {
    # Only replace the web container. Reuse the existing execution host.
    & (Join-Path $PSScriptRoot 'Start-Agent.ps1')
    docker compose build web
    if ($LASTEXITCODE -ne 0) { throw 'Web image build failed; current container was left running.' }
    docker compose up -d --no-deps --no-build web
    if ($LASTEXITCODE -ne 0) { throw 'Web container update failed; Windows Agent was left running.' }
    docker compose ps
} finally {
    Pop-Location
}
