# Unfold – Jellyfin Player

A lean desktop player for [Jellyfin](https://jellyfin.org). It only shows your library; playback is done by an embedded mpv (libmpv). No video code of its own, no transcoding.

- 5 columns: libraries → content → details → episodes → tracks / play
- Search (`/`), A–Z letter bar, full keyboard control
- Themes: terminal, nord, blueprint
- Languages: English, German, French, Spanish, Portuguese (Portugal and Brazil), Chinese (Simplified and Traditional). Translations are welcome: copy `web/locales/en.js`, translate the values and add a `<script>` line in `web/index.html`
- Watched state and progress are reported back to the server; playback resumes where you left off
- Book-style page-turn animations when opening columns and when starting or leaving playback

Windows 10/11 is the main platform (written in Rust, WebView2, mpv embedded in the window); Android is experimental.

## Download

From [Releases](https://github.com/mogeldev/unfold-jellyfin-player/releases/latest):
- `Unfold-Setup-<version>.exe`: Windows 10/11 (64-bit) installer (per user, no admin rights)
- `Unfold-<version>-portable.zip`: unzip anywhere and start `Unfold\Unfold.exe`; settings are kept in `%APPDATA%\unfold`
- `Unfold-<version>-android-<abi>.apk`: Android 7+ (experimental); most phones need `arm64-v8a`, older ones `armeabi-v7a`

## Run from source

```
winget install Rustlang.Rustup   # plus Visual Studio Build Tools (C++ and Windows SDK)
.\tools\fetch_libmpv.ps1         # once, needs 7-Zip
cargo run                        # JF_DEBUG=1 for dev tools
```

## Build the installer and the portable zip (Windows)

```
winget install JRSoftware.InnoSetup
.\tools\make_installer.ps1      # installer\out\Unfold-Setup-<version>.exe + Unfold-<version>-portable.zip
```

## Android (experimental)

The same UI in a WebView; on a phone every column fills the screen (tap to move on, swipe or Back to go back). Playback is done by [unfold-mpv](https://github.com/mogeldev/unfold-mpv) (an mpvKt fork), built into the app as a git submodule: the chosen tracks, resume, touch controls and the player's own settings (Settings → Player settings).

```
git submodule update --init     # android/mpvkt
cd android
./gradlew assembleRelease       # needs the Android SDK (ANDROID_HOME); one APK per ABI in app/build/outputs/apk/release/
```

## More

Design, server calls and known limitations: [ARCHITECTURE.md](ARCHITECTURE.md).
The password is never stored, only the token (Windows Credential Manager, otherwise the config file).
