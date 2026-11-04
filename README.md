# Unfold – Jellyfin Player

A lean desktop player for [Jellyfin](https://jellyfin.org). It only shows your library; playback is done by an embedded mpv (libmpv). No video code of its own, no transcoding.

- 5 columns: libraries → content → details → episodes → tracks / play
- Search (`/`), A–Z letter bar, full keyboard control
- Themes: terminal, nord, blueprint
- Languages: English, German
- Watched state and progress are reported back to the server; playback resumes where you left off
- Book-style page-turn animations when opening columns and when starting or leaving playback

Windows is the main platform (WebView2, mpv embedded in the window). Linux runs with a separate mpv window but is untested.

## Download (Windows 10/11, 64-bit)

From [Releases](https://github.com/mogeldev/unfold-jellyfin-player/releases/latest):
- `Unfold-Setup-<version>.exe`: installer (per user, no admin rights)
- `Unfold-<version>-portable.zip`: unzip anywhere and start `Unfold\Unfold.exe`; settings are kept in `%APPDATA%\unfold`

## Run from source

```
pip install -r requirements.txt
python tools/fetch_libmpv.py    # Windows only, needs 7-Zip
python main.py                  # JF_DEBUG=1 for dev tools
```

Python 3.10+. On Linux you need `libmpv2` / `mpv-libs` from your package manager.

## Build the installer and the portable zip (Windows)

```
winget install JRSoftware.InnoSetup
.\tools\make_installer.ps1      # installer\out\Unfold-Setup-<version>.exe + Unfold-<version>-portable.zip
```

## More

Design, server calls and known limitations: [ARCHITECTURE.md](ARCHITECTURE.md).
The password is never stored, only the token (keyring, otherwise the config file).
