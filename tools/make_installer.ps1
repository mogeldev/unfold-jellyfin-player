# Baut erst die exe (tools\build.ps1), dann den Installer nach installer\out\Unfold-Setup-<Version>.exe
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot)
& "$PSScriptRoot\build.ps1"
$iscc = @("$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe", "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe") |
    Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) { throw "Inno Setup fehlt: winget install JRSoftware.InnoSetup" }
& $iscc installer\unfold.iss
if ($LASTEXITCODE) { throw "Inno Setup fehlgeschlagen" }
Get-ChildItem installer\out\*.exe | ForEach-Object { Write-Host "Fertig: $($_.FullName) ($([math]::Round($_.Length/1MB)) MB)" }
