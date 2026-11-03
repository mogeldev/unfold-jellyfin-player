# Baut dist\Unfold\Unfold.exe (Windows). Voraussetzung: lib\libmpv-2.dll (python tools/fetch_libmpv.py)
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot)
$local = "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe"
$py = if (Test-Path $local) { $local } else { "python" }  # "python" kann der Store-Platzhalter sein, daher zuerst der echte Pfad
if (-not (Test-Path lib\libmpv-2.dll)) { throw "lib\libmpv-2.dll fehlt: python tools/fetch_libmpv.py" }
& $py -m pip install -q pyinstaller -r requirements.txt
if ($LASTEXITCODE) { throw "pip fehlgeschlagen" }
& $py -m PyInstaller --noconfirm --clean --windowed --name Unfold `
    --icon assets\icon.ico --add-data "assets;assets" --add-data "web;web" --add-binary "lib\libmpv-2.dll;lib" `
    --hidden-import keyring.backends.Windows `
    main.py
if ($LASTEXITCODE) { throw "PyInstaller fehlgeschlagen" }
Write-Host "Fertig: dist\Unfold\Unfold.exe"
