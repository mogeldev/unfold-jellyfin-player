# Unfold – Jellyfin Player – Architecture

Principle: **the player only shows the library. mpv does the playing.** No video code of its own, no transcoding.

## GUI (5 columns)

| # | Content |
|---|---------|
| 1 | Libraries, fullscreen switch, theme menu, text size (− / + in steps of 10, 50–200 %, default 100 %), account / settings at the bottom |
| 2 | Library contents, alphabetical |
| 3 | Poster, title, year, runtime, description |
| 4 | Episodes by season with ✓/○ (series only) |
| 5 | Video / audio / subtitle track, ▶ Play at the bottom |

At start only column 1 is shown; column 2 appears after clicking a library, the others after clicking an entry. Widths adapt to the content automatically (capped); dragging sets a fixed width, double-clicking the handle makes it automatic again. The window width follows the visible columns (`chrome.fit_width`), the height stays as it is. Themes: terminal, nord, blueprint.

Keyboard: ←→ switch column, ↑↓ select, a letter jumps within the list (column 2), Enter = play, F11 = fullscreen. `/` opens the search (all libraries, movies and series, hits by relevance); Enter/↓ opens the first result, Esc closes.

Letter bar (0-9, A–Z, … if needed) at the top of column 2: a click filters the list to that initial (Ä counts as A), clicking again clears the filter. Groups without entries are dimmed; the bar is hidden while searching.

Animations (motif: book):
- New column: its content opens like a page around the left edge (`.col.unfolding`, several one after another). Choosing another entry unfolds columns 3–5 again; going back folds the removed columns shut (`foldAway()`).
- Opening/leaving mpv (embedded only): `Embed.snapshot()` returns a screen-grab image of the window (`Api.snapshot`). `pageOut()`/`pageBack()` in `app.js` turn the right half as a leaf around the middle. On the way back, the last video frame (grabbed before mpv quits, otherwise the window is black; fallback: the frame from the last progress report) lies on the back of the leaf and on the right side at the start. Skipped with "reduce motion".

## Tech: Python + pywebview

```
web/  (HTML/CSS/JS)  ──window.pywebview.api──►  main.py  Api (rpc → {ok,data|error})
                                                  ├─ jellyfin.py  stdlib HTTP client
                                                  ├─ player.py    libmpv (python-mpv), own mpv window
                                                  └─ config.py    config.json + keyring
```

- `web/mock.js` replaces the backend in a normal browser (preview without a server).
- Platforms: Windows (WebView2), Linux (GTK/WebKit or Qt).
- Embedded (Windows): `embed.py` puts a WinForms panel over the web UI and mpv renders into it via `wid`. A bar with "← Back" on top (quits mpv, theme colours, hidden in fullscreen); Esc quits as well, `f` = fullscreen of the app window; fallback/setting: own mpv window. mpv creates the embedded window disabled (WS_DISABLED): `enable_input()` enables it and sets the focus, otherwise neither mouse (OSC) nor keys work. Linux: own window.
- Fullscreen (library switch, F11, `f` while playing) toggles the app window; on Windows 11 `chrome.set_fullscreen_frame` removes the rounded corners and the border. Staying in or leaving fullscreen is carried over into the library; leaving it refits the window width to the columns.
- libmpv: on Windows `lib/libmpv-2.dll` lives in the project (`python tools/fetch_libmpv.py`, needs 7-Zip), Linux uses the system libmpv (libmpv2 / mpv-libs). The position comes straight from a property observer, no IPC pipe.

## Server communication (after JellyCon)

| Purpose | Call |
|---------|------|
| Header | `Authorization: MediaBrowser Client, Device, DeviceId, Version, Token` |
| Login | `POST /Users/AuthenticateByName {Username, Pw}` → `AccessToken`, `User.Id` |
| Libraries | `GET /UserViews?userId=` |
| Contents | `GET /Items?ParentId&Recursive&IncludeItemTypes=Movie,Series&SortBy=SortName` |
| Search | `GET /Items?searchTerm&Recursive&IncludeItemTypes=Movie,Series&Limit=100` |
| Details | `GET /Users/{uid}/Items/{id}` (incl. `MediaSources[0].MediaStreams`, `UserData`) |
| Episodes | `GET /Shows/{id}/Episodes?userId&IsMissing=false&IsVirtualUnAired=false&Fields=MediaSources,MediaStreams,Overview` |
| Poster | `/Items/{id}/Images/Primary?maxHeight&tag` (only if `ImageTags.Primary`) |
| Start | `POST /Items/{id}/PlaybackInfo` → `PlaySessionId` |
| Stream | `/Videos/{id}/stream?static=true&MediaSourceId&PlaySessionId&api_key` |
| Report | `POST /Sessions/Playing`, `/Playing/Progress` (every ~10 s), `/Playing/Stopped` with `PositionTicks`, `RunTimeTicks`, `PlaySessionId` |

"Watched" is set by the server from the Stopped report; afterwards the frontend reloads (`onPlaybackEnded`). Resume: `UserData.PlaybackPositionTicks` → `mpv --start`.

## Accounts
- Several accounts: `accounts` in the config (server, user, user_id, own `device_id`, token in the keyring per `user@server`), `active` = the active account. "Account" dialog: click an account to switch, "Add account", "Sign out" (removes the active account). Every account has its own device_id so sign-ins on the same server do not sign each other out. Old single-account configs are migrated on start.
- The password is never stored, only the token (keyring, otherwise the config file with 0600).

## Known limitations
- Subtitles: embedded ones first, then external text subtitles (srt/ass/vtt, loaded by mpv from the server via `/Videos/{id}/{source}/Subtitles/{index}/Stream.{fmt}`; mpv numbers them afterwards). External image subtitles (e.g. `.sup`) are not offered.
- Settings: free mpv options, e.g. `hwdec=auto fullscreen=yes`.
- mpv track number = position per type in Jellyfin's order.

## Run
```
pip install -r requirements.txt
python tools/fetch_libmpv.py   # Windows only
python main.py                 # JF_DEBUG=1 for dev tools
```
Requirements: Python 3.10+, on Windows run `python tools/fetch_libmpv.py` once.

## Languages (i18n)
- All texts live in `web/locales/<code>.js` (currently `en`, `de`); `web/i18n.js` provides `I18N.t(key, {vars})` with placeholders `{name}`, plurals via `key_one`/`key_other` (`t('seasons', {n})`) and a fallback to English.
- New language: create `locales/xx.js` following `en.js` (incl. `_name`) and include it in `web/index.html`. It shows up automatically in the login dialog and in the settings.
- Start: saved language (`lang` in the config), otherwise the system language, otherwise English. Switch in the login dialog or under settings.
- The backend translates nothing: errors are `AppError(code, **params)` and arrive as `err_<code>` in the frontend. The label of the back button is supplied by the frontend when playing.
- The last subtitle entry is always "Off" (text `subs_off`); titles and descriptions come untranslated from the server.
- Everything else in the repository (code, comments, docs, scripts) is English; only the app content is multilingual.
