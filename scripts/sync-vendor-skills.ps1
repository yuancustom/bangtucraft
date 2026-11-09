# Copy bangtu skills from the unpacked installer into skills/vendor-bangtu (internal comparison only; ignored by git).
# Reads _extract only; never modifies it. Kept ASCII-only so Windows PowerShell 5.1 parses it.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root '_extract\app\resources\resources\skills'
$dst = Join-Path $root 'skills\vendor-bangtu'
if (-not (Test-Path $src)) { throw "Source not found: $src (unpack the installer first)." }
New-Item -ItemType Directory -Force $dst | Out-Null
Get-ChildItem -Directory $src | ForEach-Object {
  $target = Join-Path $dst $_.Name
  if (Test-Path $target) { Remove-Item -Recurse -Force $target }
  Copy-Item -Recurse $_.FullName $target
}
Write-Output ("Copied {0} skills to {1}" -f (Get-ChildItem -Directory $dst).Count, $dst)
