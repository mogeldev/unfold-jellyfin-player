# Downloads libmpv-2.dll (Windows x64) from the current shinchiro/mpv-winbuild-cmake release into lib\.
# Needs 7-Zip (7z.exe on PATH or in Program Files) because the archive uses the BCJ2 filter.
$ErrorActionPreference = "Stop"
$lib = Join-Path (Split-Path $PSScriptRoot) "lib"
$7z = (Get-Command 7z -ErrorAction SilentlyContinue).Source
if (-not $7z) { $7z = @("$env:ProgramFiles\7-Zip\7z.exe", "${env:ProgramFiles(x86)}\7-Zip\7z.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1 }
if (-not $7z) { throw "7-Zip not found (winget install 7zip.7zip)" }
$rel = Invoke-RestMethod "https://api.github.com/repos/shinchiro/mpv-winbuild-cmake/releases/latest" -Headers @{ "User-Agent" = "unfold" }
$asset = $rel.assets | Where-Object { $_.name -match '^mpv-dev-x86_64-\d.*\.7z$' } | Select-Object -First 1
Write-Host "Downloading $($asset.name) ($([math]::Round($asset.size / 1MB)) MB)"
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("unfold-mpv-" + [guid]::NewGuid())
New-Item -ItemType Directory $tmp | Out-Null
try {
    $arc = Join-Path $tmp $asset.name
    Invoke-WebRequest $asset.browser_download_url -OutFile $arc
    & $7z x -y "-o$tmp" $arc libmpv-2.dll -r | Out-Null
    if ($LASTEXITCODE) { throw "7-Zip failed" }
    $dll = Get-ChildItem $tmp -Recurse -Filter libmpv-2.dll | Select-Object -First 1
    New-Item -ItemType Directory -Force $lib | Out-Null
    Copy-Item $dll.FullName (Join-Path $lib "libmpv-2.dll") -Force
} finally { Remove-Item -Recurse -Force $tmp }
Write-Host "OK -> $lib\libmpv-2.dll"
