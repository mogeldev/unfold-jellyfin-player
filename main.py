"""Unfold – Jellyfin Player: pywebview-Fenster mit dem Frontend aus web/. Alle öffentlichen Api-Methoden sind per JS aufrufbar."""
import functools
import html
import json
import os
import re
import threading
from pathlib import Path

import webview

import chrome
import config
import player
from jellyfin import TICKS, Jellyfin, JellyfinError, external_subs, minutes, streams

WEB = player.BASE / "web"


def rpc(fn):
    """Antwort immer als {ok, data} bzw. {ok: False, error}, damit das Frontend einheitlich reagieren kann."""
    @functools.wraps(fn)
    def wrapper(self, *a):
        try:
            return {"ok": True, "data": fn(self, *a)}
        except JellyfinError as e:  # AppError: Code + Parameter, das Frontend übersetzt
            return {"ok": False, "code": e.code, "params": e.params, "error": e.code}
        except Exception as e:  # noqa: BLE001 - Fehler sollen in der UI landen, nicht das Fenster beenden
            return {"ok": False, "error": f"{type(e).__name__}: {e}"}
    return wrapper


def _text(s: str) -> str:
    """Jellyfin-Beschreibungen enthalten oft HTML (<br>, <i> …): in Klartext mit Zeilenumbrüchen wandeln."""
    s = re.sub(r"<br\s*/?>", "\n", s or "", flags=re.I)
    return html.unescape(re.sub(r"<[^>]+>", "", s)).strip()


class Api:
    # Attribute mit _ sind für JS unsichtbar
    def __init__(self):
        self._cfg = config.load()
        self._window = None
        self._embed = None
        self._jf = None
        token = config.get_token(self._cfg)
        if token and self._cfg.get("server") and self._cfg.get("user_id"):
            self._jf = Jellyfin(self._cfg["server"], self._cfg["device_id"], token, self._cfg["user_id"])

    def _need(self) -> Jellyfin:
        if not self._jf:
            raise JellyfinError("not_logged_in")
        return self._jf

    @rpc
    def state(self):
        return {"logged_in": bool(self._jf), "server": self._cfg.get("server", ""),
                "user": self._cfg.get("user", ""), "mpv_opts": self._cfg.get("mpv_opts", ""),
                "embed": self._cfg.get("embed", True), "can_embed": self._embed is not None,
                "lang": self._cfg.get("lang", "")}

    @rpc
    def set_lang(self, lang):
        self._cfg["lang"] = str(lang)[:5]
        config.save(self._cfg)

    @rpc
    def login(self, server, user, password):
        jf = Jellyfin(server, self._cfg["device_id"])
        jf.login(user, password)
        self._cfg.update(server=jf.server, user=user, user_id=jf.user_id)
        config.set_token(self._cfg, jf.token)
        config.save(self._cfg)
        self._jf = jf

    @rpc
    def logout(self):
        if self._jf:
            self._jf.logout()
        config.clear_token(self._cfg)
        self._cfg.pop("user_id", None)
        config.save(self._cfg)
        self._jf = None

    @rpc
    def save_settings(self, s):
        self._cfg["mpv_opts"] = (s.get("mpv_opts") or "").strip()
        self._cfg["embed"] = bool(s.get("embed", True))
        config.save(self._cfg)

    @rpc
    def set_chrome(self, bg):
        """Titelleiste und Rahmen in der Hintergrundfarbe des Themes (nur Windows)."""
        if self._embed:
            hwnd = self._embed._ui(lambda: int(self._window.native.Handle.ToInt64()))
            chrome.set_chrome(hwnd, bg, bg)

    @rpc
    def snapshot(self):
        """Bild der Oberfläche für den Seitenumschlag; None ohne Einbettung."""
        return self._embed.snapshot() if self._embed else None

    @rpc
    def fit_window(self, inner_px):
        """Fensterbreite an die sichtbaren Spalten anpassen (Animation läuft im Hintergrund-Thread)."""
        if self._embed:
            hwnd = self._embed._ui(lambda: int(self._window.native.Handle.ToInt64()))
            threading.Thread(target=chrome.fit_width, args=(hwnd, inner_px), daemon=True).start()

    @rpc
    def libraries(self):
        return [{"id": v["Id"], "name": v["Name"]} for v in self._need().libraries()
                if v.get("CollectionType") in ("movies", "tvshows", "homevideos", None)]

    @staticmethod
    def _summary(i):
        return {"id": i["Id"], "name": i["Name"], "year": i.get("ProductionYear", ""),
                "type": "series" if i["Type"] == "Series" else "movie",
                "seen": bool((i.get("UserData") or {}).get("Played"))}

    @rpc
    def items(self, lib_id):
        return [self._summary(i) for i in self._need().items(lib_id)]

    @rpc
    def search(self, term):
        """Suche über alle Bibliotheken (Filme und Serien), serverseitig nach Relevanz sortiert."""
        term = (term or "").strip()
        return [self._summary(i) for i in self._need().search(term)] if term else []

    @rpc
    def detail(self, item_id):
        jf = self._need()
        d = jf.detail(item_id)
        base = {"id": d["Id"], "name": d["Name"], "year": d.get("ProductionYear", ""), "ov": _text(d.get("Overview", "")),
                "poster": jf.poster_url(d), "seen": bool((d.get("UserData") or {}).get("Played")), "min": minutes(d)}
        if d["Type"] != "Series":
            return {**base, "type": "movie", "st": streams(d)[0]}
        seasons = {}
        for e in jf.episodes(item_id):
            n = e.get("ParentIndexNumber") or 0
            seasons.setdefault(n, []).append({
                "id": e["Id"], "n": e.get("IndexNumber") or 0, "t": e["Name"], "min": minutes(e),
                "seen": bool((e.get("UserData") or {}).get("Played")), "st": streams(e)[0]})
        return {**base, "type": "series",
                "seasons": [{"n": n, "eps": sorted(eps, key=lambda x: x["n"])} for n, eps in sorted(seasons.items())]}

    @rpc
    def play(self, item_id, v, a, s, colors=None):
        jf = self._need()
        dto = jf.detail(item_id)
        st, ms_id = streams(dto)
        info = jf.playback_info(item_id)
        psid = info["PlaySessionId"]
        url = jf.stream_url(item_id, ms_id, psid)
        resume = ((dto.get("UserData") or {}).get("PlaybackPositionTicks") or 0) / TICKS
        runtime = dto.get("RunTimeTicks")
        # mpv zählt je Spurtyp ab 1, in derselben Reihenfolge wie Jellyfin
        vid = v + 1 if st["v"] else None
        aid = a + 1 if st["a"] else None
        has_subs = len(st["s"]) > 1
        sid = None if not has_subs else ("no" if s == len(st["s"]) - 1 else s + 1)
        # Externe Textuntertitel stehen in der Liste hinter den eingebetteten und werden von mpv vom Server nachgeladen
        sub_files = [jf.subtitle_url(item_id, ms_id, e["index"], e["fmt"]) for e in external_subs(dto)]
        title = dto["Name"]
        if dto["Type"] == "Episode":
            title = f"{dto.get('SeriesName', '')} S{dto.get('ParentIndexNumber', 0)}E{dto.get('IndexNumber', 0)} {title}"

        jf.report("", item_id, ms_id, psid, resume, runtime)

        # Eingebettet (Windows, Standard); schlägt das fehl, spielt mpv im eigenen Fenster
        wid = None
        if self._embed and self._cfg.get("embed", True):
            try:
                wid = self._embed.show((colors or {}).get("bg"), (colors or {}).get("fg"), (colors or {}).get("back"))
            except Exception:  # noqa: BLE001
                wid = None
        fullscreen = {"on": False}

        def toggle_fullscreen():
            fullscreen["on"] = not fullscreen["on"]
            self._window.toggle_fullscreen()
            self._embed.set_bar(not fullscreen["on"])

        frame = {"img": None}

        def grab():
            """Videobild für den Seitenumschlag zurück; nach dem Beenden von mpv wäre das Fenster schwarz, daher vorher."""
            if wid is not None:
                try:
                    frame["img"] = self._embed.snapshot() or frame["img"]
                except Exception:  # noqa: BLE001
                    pass

        def progress(pos):
            grab()  # Rückfall, wenn mpv von selbst endet (Dateiende)
            jf.report("Progress", item_id, ms_id, psid, pos, runtime)

        def stopped(pos):
            if wid is not None:
                if fullscreen["on"]:
                    toggle_fullscreen()
                self._embed.hide()
            jf.report("Stopped", item_id, ms_id, psid, pos, runtime)
            if self._window:
                self._window.evaluate_js(f"window.onPlaybackEnded && window.onPlaybackEnded({json.dumps(frame['img'])})")

        try:
            m = player.launch(url, title, vid, aid, sid, resume, self._cfg.get("mpv_opts", ""),
                              progress, stopped,
                              wid=wid, on_fullscreen=toggle_fullscreen, sub_files=sub_files, on_quit=grab)
            if wid is not None:
                self._embed.on_back = lambda: (grab(), m.command("quit"))
                threading.Thread(target=self._embed.enable_input, args=(wid,), daemon=True).start()
        except Exception:
            if wid is not None:
                self._embed.hide()
            raise
        return {}


def main():
    api = Api()
    api._window = window = webview.create_window("Unfold – Jellyfin Player", str(WEB / "index.html"), js_api=api,
                                        width=420, height=780, min_size=(360, 480), background_color="#0b0f0b")
    if os.name == "nt":
        from embed import Embed
        api._embed = Embed(window)
        window.events.shown += lambda: api._embed.set_icon(player.BASE / "assets" / "icon.ico")
    webview.start(debug=bool(os.environ.get("JF_DEBUG")))


if __name__ == "__main__":
    main()
