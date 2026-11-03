# Unfold – Jellyfin Player

Schlanker Desktop-Player für [Jellyfin](https://jellyfin.org). Er zeigt nur die Bibliothek, abgespielt wird mit eingebettetem mpv (libmpv). Kein eigener Video-Code, kein Transcoding.

- 5 Spalten: Bibliotheken → Inhalt → Details → Episoden → Spuren/Abspielen
- Suche (`/`), Buchstabenleiste A–Z, Tastatursteuerung
- Themes: terminal, nord, blueprint
- Sprachen: Englisch, Deutsch
- Gesehen-Status und Fortschritt werden zum Server zurückgemeldet, Wiedergabe setzt fort
- Buch-Animationen beim Öffnen von Spalten und beim Start/Ende der Wiedergabe

Windows ist die Hauptplattform (WebView2, mpv im Fenster). Linux läuft mit eigenem mpv-Fenster, ist aber ungetestet.

## Starten

```
pip install -r requirements.txt
python tools/fetch_libmpv.py    # nur Windows, braucht 7-Zip
python main.py                  # JF_DEBUG=1 für Dev-Tools
```

Python 3.10+. Unter Linux wird `libmpv2` bzw. `mpv-libs` aus dem Paketmanager gebraucht.

## Installer bauen (Windows)

```
winget install JRSoftware.InnoSetup
.\tools\make_installer.ps1      # dist\Unfold\Unfold.exe + installer\out\Unfold-Setup-<Version>.exe
```

## Mehr

Aufbau, Server-Aufrufe und bekannte Einschränkungen: [ARCHITECTURE.md](ARCHITECTURE.md).
Das Passwort wird nie gespeichert, nur das Token (Keyring, sonst Config-Datei).
