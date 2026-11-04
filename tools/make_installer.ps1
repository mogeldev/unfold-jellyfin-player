# Builds the exe first (tools\build.ps1), then into installer\out: Unfold-Setup-<version>.exe and Unfold-<version>-portable.zip
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot)
& "$PSScriptRoot\build.ps1"
Copy-Item LICENSE dist\Unfold\LICENSE.txt
$iscc = @("$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe", "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe") |
    Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) { throw "Inno Setup missing: winget install JRSoftware.InnoSetup" }
& $iscc installer\unfold.iss
if ($LASTEXITCODE) { throw "Inno Setup failed" }
# Portable: the same folder as a zip (settings still live in %APPDATA%\unfold)
$ver = [regex]::Match((Get-Content installer\unfold.iss -Raw), '#define AppVersion "([^"]+)"').Groups[1].Value
Compress-Archive -Path dist\Unfold -DestinationPath "installer\out\Unfold-$ver-portable.zip" -Force
Get-ChildItem installer\out\*.exe, installer\out\*.zip | ForEach-Object { Write-Host "Done: $($_.FullName) ($([math]::Round($_.Length/1MB)) MB)" }
