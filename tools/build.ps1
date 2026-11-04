# Builds dist\Unfold\Unfold.exe (Windows). Requires lib\libmpv-2.dll (python tools/fetch_libmpv.py)
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot)
$local = "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe"
$py = if (Test-Path $local) { $local } else { "python" }  # "python" may be the Store placeholder, so try the real path first
if (-not (Test-Path lib\libmpv-2.dll)) { throw "lib\libmpv-2.dll missing: python tools/fetch_libmpv.py" }
& $py -m pip install -q pyinstaller -r requirements.txt
if ($LASTEXITCODE) { throw "pip failed" }
& $py -m PyInstaller --noconfirm --clean --windowed --name Unfold `
    --icon assets\icon.ico --add-data "assets;assets" --add-data "web;web" --add-binary "lib\libmpv-2.dll;lib" `
    --hidden-import keyring.backends.Windows `
    main.py
if ($LASTEXITCODE) { throw "PyInstaller failed" }
Write-Host "Done: dist\Unfold\Unfold.exe"
