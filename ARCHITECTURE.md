# Unfold – Jellyfin Player – Architektur

Prinzip: **Der Player zeigt nur die Bibliothek. Abspielen macht mpv.** Kein eigener Video-Code, kein Transcoding.

## GUI (5 Spalten)

| # | Inhalt |
|---|--------|
| 1 | Bibliotheken, Design-Umschalter, unten Konto / Einstellungen |
| 2 | Inhalt der Bibliothek, alphabetisch |
| 3 | Poster, Titel, Jahr, Laufzeit, Beschreibung |
| 4 | Episoden nach Staffel mit ✓/○ (nur bei Serien) |
| 5 | Video-/Audio-/Untertitel-Spur, unten ▶ Abspielen |

Beim Start nur Spalte 1; Spalte 2 erscheint nach Klick auf eine Bibliothek, die übrigen nach Klick auf einen Eintrag. Breiten passen sich automatisch dem Inhalt an (gedeckelt in % der Fensterbreite); per Ziehen feste Breite, Doppelklick auf den Griff = wieder automatisch. Themes: terminal, nord, blueprint.

Tastatur: ←→ Spalte wechseln, ↑↓ auswählen, Buchstabe springt in der Liste (Spalte 2), Enter = Abspielen. `/` öffnet die Suche (alle Bibliotheken, Filme und Serien, Treffer nach Relevanz); Enter/↓ öffnet das erste Ergebnis, Esc schließt.

Buchstabenleiste (0-9, A–Z, bei Bedarf …) oben in Spalte 2: Klick filtert die Liste auf diesen Anfangsbuchstaben (Ä zählt zu A), erneuter Klick hebt den Filter auf. Gruppen ohne Einträge sind abgeblendet; bei der Suche ist die Leiste ausgeblendet.

Animationen (Motiv: Buch):
- Neue Spalte: ihr Inhalt klappt wie eine Seite um die linke Kante auf (`.col.unfolding`, mehrere nacheinander).
- mpv öffnen/verlassen (nur eingebettet): `Embed.snapshot()` liefert per Bildschirmabzug ein Bild des Fensters (`Api.snapshot`). `pageOut()`/`pageBack()` in `app.js` klappen damit die rechte Hälfte als Blatt um die Mitte. Zurück: das letzte Videobild (vor dem Beenden von mpv aufgenommen, sonst ist das Fenster schwarz; Rückfall: Bild vom letzten Fortschrittsreport) liegt am Anfang auf Blattrückseite und rechter Seite. Entfällt bei „Animationen reduzieren“.

## Technik: Python + pywebview

```
web/  (HTML/CSS/JS, wie im Mockup)  ──window.pywebview.api──►  main.py  Api (rpc → {ok,data|error})
                                                                 ├─ jellyfin.py  stdlib-HTTP-Client
                                                                 ├─ player.py    libmpv (python-mpv), eigenes mpv-Fenster
                                                                 └─ config.py    config.json + Keyring
```

- `web/mock.js` ersetzt das Backend im normalen Browser (Vorschau ohne Server).
- Plattformen: Windows (WebView2), Linux (GTK/WebKit oder Qt).
- Eingebettet (Windows): `embed.py` legt ein WinForms-Panel über die Weboberfläche, mpv rendert per `wid` hinein. Oben eine Leiste mit „← Zurück“ (beendet mpv, Themefarben, im Vollbild ausgeblendet); Esc beendet ebenfalls, `f` = Vollbild des App-Fensters, Fallback/Einstellung: eigenes mpv-Fenster. mpv legt das eingebettete Fenster deaktiviert an (WS_DISABLED): `enable_input()` aktiviert es und setzt den Fokus, sonst gehen weder Maus (OSC) noch Tasten. Linux: eigenes Fenster.
- libmpv: Windows liegt `lib/libmpv-2.dll` im Projekt (`python tools/fetch_libmpv.py`, braucht 7-Zip), Linux nutzt das System-libmpv (libmpv2 / mpv-libs). Position kommt direkt per Property-Observer, keine IPC-Pipe.

## Server-Kommunikation (nach JellyCon)

| Zweck | Aufruf |
|-------|--------|
| Header | `Authorization: MediaBrowser Client, Device, DeviceId, Version, Token` |
| Login | `POST /Users/AuthenticateByName {Username, Pw}` → `AccessToken`, `User.Id` |
| Bibliotheken | `GET /UserViews?userId=` |
| Inhalt | `GET /Items?ParentId&Recursive&IncludeItemTypes=Movie,Series&SortBy=SortName` |
| Suche | `GET /Items?searchTerm&Recursive&IncludeItemTypes=Movie,Series&Limit=100` |
| Details | `GET /Users/{uid}/Items/{id}` (inkl. `MediaSources[0].MediaStreams`, `UserData`) |
| Episoden | `GET /Shows/{id}/Episodes?userId&IsMissing=false&IsVirtualUnAired=false&Fields=MediaSources,MediaStreams,Overview` |
| Poster | `/Items/{id}/Images/Primary?maxHeight&tag` (nur wenn `ImageTags.Primary`) |
| Start | `POST /Items/{id}/PlaybackInfo` → `PlaySessionId` |
| Stream | `/Videos/{id}/stream?static=true&MediaSourceId&PlaySessionId&api_key` |
| Report | `POST /Sessions/Playing`, `/Playing/Progress` (alle ~10 s), `/Playing/Stopped` mit `PositionTicks`, `RunTimeTicks`, `PlaySessionId` |

„Gesehen“ setzt der Server aus dem Stopped-Report; danach lädt das Frontend neu (`onPlaybackEnded`). Resume: `UserData.PlaybackPositionTicks` → `mpv --start`.

## Bekannte Einschränkungen
- Untertitel: erst die eingebetteten, dann externe Textuntertitel (srt/ass/vtt, vom Server per `/Videos/{id}/{source}/Subtitles/{index}/Stream.{fmt}` nachgeladen, mpv nummeriert sie danach). Externe Bild-Untertitel (z. B. `.sup`) werden nicht angeboten.
- Einstellungen: freie mpv-Optionen, z. B. `hwdec=auto fullscreen=yes`.
- mpv-Spurnummer = Position je Typ in Jellyfins Reihenfolge.
- Passwort wird nie gespeichert, nur das Token (Keyring, sonst Config-Datei mit 0600).

## Start
```
pip install -r requirements.txt
python tools/fetch_libmpv.py   # nur Windows
python main.py        # JF_DEBUG=1 für Dev-Tools
```
Voraussetzung: Python 3.10+, unter Windows einmalig `python tools/fetch_libmpv.py`.




## Sprachen (i18n)
- Alle Texte stehen in `web/locales/<code>.js` (aktuell `en`, `de`); `web/i18n.js` liefert `I18N.t(key, {vars})` mit Platzhaltern `{name}`, Mehrzahl über `key_one`/`key_other` (`t('seasons', {n})`) und Rückfall auf Englisch.
- Neue Sprache: `locales/xx.js` nach dem Muster von `en.js` anlegen (inkl. `_name`) und in `web/index.html` einbinden. Sie erscheint automatisch im Anmeldedialog und in den Einstellungen.
- Start: gespeicherte Sprache (`lang` in der Config), sonst Systemsprache, sonst Englisch. Wechsel im Anmeldedialog oder unter Einstellungen.
- Das Backend übersetzt nichts: Fehler sind `AppError(code, **params)` und kommen als `err_<code>` im Frontend an. Die Beschriftung des Zurück-Buttons liefert das Frontend beim Abspielen mit.
- Der letzte Untertitel-Eintrag ist immer „Aus“ (Text `subs_off`), Titel und Beschreibungen kommen unübersetzt vom Server.



