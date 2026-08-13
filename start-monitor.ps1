param(
  [switch]$NoProxy
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectRoot

if (-not $NoProxy) {
  Start-Process -FilePath 'node.exe' -ArgumentList '.\proxy.js' -WorkingDirectory $projectRoot
  Start-Sleep -Milliseconds 500
}

& pwsh.exe -NoLogo -NoProfile -STA -ExecutionPolicy Bypass -File (Join-Path $projectRoot 'monitor.ps1')
