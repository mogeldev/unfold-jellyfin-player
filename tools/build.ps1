# Builds dist\Unfold (Unfold.exe + web\ + lib\libmpv-2.dll). Requires Rust (rustup) and lib\libmpv-2.dll (tools\fetch_libmpv.ps1)
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot)
if (-not (Test-Path lib\libmpv-2.dll)) { throw "lib\libmpv-2.dll missing: .\tools\fetch_libmpv.ps1" }
$cargo = (Get-Command cargo -ErrorAction SilentlyContinue).Source
if (-not $cargo) { $cargo = "$env:USERPROFILE\.cargo\bin\cargo.exe" }
& $cargo build --release
if ($LASTEXITCODE) { throw "cargo build failed" }
if (Test-Path dist\Unfold) { Remove-Item -Recurse -Force dist\Unfold }
New-Item -ItemType Directory dist\Unfold\lib | Out-Null
Copy-Item target\release\Unfold.exe dist\Unfold\
Copy-Item lib\libmpv-2.dll dist\Unfold\lib\
Copy-Item web dist\Unfold\web -Recurse
Copy-Item LICENSE dist\Unfold\LICENSE.txt
Write-Host "Done: dist\Unfold\Unfold.exe"
