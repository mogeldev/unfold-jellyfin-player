"""Unfold – Jellyfin Player: pywebview window with the frontend from web/. All public Api methods are callable from JS."""
import functools
import html
import json
import os
import re
import threading
import uuid
from pathlib import Path

import webview

import chrome
import config
import player
from jellyfin import TICKS, Jellyfin, JellyfinError, external_subs, minutes, normalize, streams

WEB = player.BASE / "web"


def rpc(fn):
    """Always answer as {ok, data} or {ok: False, error} so the frontend can react uniformly."""
    @functools.wraps(fn)
    def wrapper(self, *a):
        try:
            return {"ok": True, "data": fn(self, *a)}
        except JellyfinError as e:  # AppError: code + params, the frontend translates
            return {"ok": False, "code": e.code, "params": e.params, "error": e.code}
        except Exception as e:  # noqa: BLE001 - errors should end up in the UI, not close the window
            return {"ok": False, "error": f"{type(e).__name__}: {e}"}
    return wrapper


def _text(s: str) -> str:
    """Jellyfin descriptions often contain HTML (<br>, <i> …): convert to plain text with line breaks."""
    s = re.sub(r"<br\s*/?>", "\n", s or "", flags=re.I)
    return html.unescape(re.sub(r"<[^>]+>", "", s)).strip()


class Api:
    # attributes starting with _ are invisible to JS
    def __init__(self):
        self._cfg = config.load()
        self._window = None
        self._embed = None
        self._fs, self._bg = False, None  # fullscreen on/off, theme colour of the title bar
        self._jf = None
        self._play_lock = threading.Lock()  # one player at a time (e.g. Enter pressed twice while mpv starts)
        accs = self._cfg.setdefault("accounts", [])
        if not accs and self._cfg.get("user_id"):  # config from before 0.2 (one account): convert it once
            old = {k: self._cfg.pop(k) for k in ("server", "user", "user_id", "device_id", "token") if k in self._cfg}
            accs.append({"device_id": uuid.uuid4().hex, **old})
            config.save(self._cfg)
        self._connect(self._cfg.get("active", 0))

    def _connect(self, i: int) -> None:
        """Activate account i. Without a valid account or token _jf stays empty (the frontend then shows the login).
        Every account has its own device_id so sign-ins on the same server do not sign each other out."""
        accs = self._cfg["accounts"]
        self._jf = None
        if not 0 <= i < len(accs):
            return
        a = accs[i]
        self._cfg.update(active=i, server=a["server"], user=a["user"])
        token = config.get_token(a)
        if token:
            self._jf = Jellyfin(a["server"], a["device_id"], token, a["user_id"])

    def _need(self) -> Jellyfin:
        if not self._jf:
            raise JellyfinError("not_logged_in")
        return self._jf

    @rpc
    def state(self):
        return {"logged_in": bool(self._jf), "server": self._cfg.get("server", ""),
                "user": self._cfg.get("user", ""), "mpv_opts": self._cfg.get("mpv_opts", ""),
                "embed": self._cfg.get("embed", True), "can_embed": self._embed is not None,
                "lang": self._cfg.get("lang", ""), "active": self._cfg.get("active", 0),
                "accounts": [f"{a['user']} @ {a['server']}" for a in self._cfg["accounts"]]}

    @rpc
    def set_lang(self, lang):
        self._cfg["lang"] = str(lang)[:16]
        config.save(self._cfg)

    @rpc
    def login(self, server, user, password):
        """Sign in a new account and activate it; the same account (server + user) is only updated."""
        accs = self._cfg["accounts"]
        same = lambda a: a["server"] == normalize(server) and a["user"].lower() == user.lower()  # noqa: E731 - Jellyfin user names ignore case
        i = next((n for n, a in enumerate(accs) if same(a)), len(accs))
        jf = Jellyfin(server, accs[i]["device_id"] if i < len(accs) else uuid.uuid4().hex)
        jf.login(user, password)
        acc = {"server": jf.server, "user": user, "user_id": jf.user_id, "device_id": jf.device_id}
        config.set_token(acc, jf.token)
        accs[i:i + 1] = [acc]
        self._connect(i)
        config.save(self._cfg)

    @rpc
    def switch_account(self, i):
        self._connect(int(i))
        config.save(self._cfg)

    @rpc
    def logout(self):
        """Sign out and remove the active account; a remaining one becomes active."""
        accs, i = self._cfg["accounts"], self._cfg.get("active", 0)
        if self._jf:
            self._jf.logout()
        if 0 <= i < len(accs):
            config.clear_token(accs.pop(i))
        self._connect(0)
        config.save(self._cfg)

    @rpc
    def save_settings(self, s):
        self._cfg["mpv_opts"] = (s.get("mpv_opts") or "").strip()
        self._cfg["embed"] = bool(s.get("embed", True))
        config.save(self._cfg)

    @rpc
    def set_chrome(self, bg):
        """Title bar and border in the theme background colour (Windows only)."""
        self._bg = bg
        if self._embed:
            hwnd = self._embed._ui(lambda: int(self._window.native.Handle.ToInt64()))
            chrome.set_chrome(hwnd, bg, bg)
            if self._fs:  # theme change while fullscreen: keep the border off
                chrome.set_fullscreen_frame(hwnd, True)

    def _toggle_fs(self):
        self._window.toggle_fullscreen()
        self._fs = not self._fs
        if self._embed:
            hwnd = self._embed._ui(lambda: int(self._window.native.Handle.ToInt64()))
            chrome.set_fullscreen_frame(hwnd, self._fs, self._bg)
        if not self._fs:  # width is not adjusted while fullscreen: refit to the columns after leaving it
            threading.Timer(0.6, lambda: self._window.evaluate_js("window.refit && window.refit()")).start()

    @rpc
    def toggle_fullscreen(self):
        """Fullscreen of the app window (library and playback)."""
        self._toggle_fs()

    @rpc
    def snapshot(self):
        """Image of the UI for the page turn; None without embedding."""
        return self._embed.snapshot() if self._embed else None

    @rpc
    def fit_window(self, inner_px):
        """Fit the window width to the visible columns (the animation runs in a background thread)."""
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
        """Search across all libraries (movies and series), sorted by relevance on the server."""
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
                "seen": bool((e.get("UserData") or {}).get("Played"))})  # tracks: tracks() for the selected episode
        return {**base, "type": "series",
                "seasons": [{"n": n, "eps": sorted(eps, key=lambda x: x["n"])} for n, eps in sorted(seasons.items())]}

    @rpc
    def tracks(self, item_id):
        """Track names of one episode (loaded when it is selected, so long series stay fast)."""
        return streams(self._need().detail(item_id))[0]

    @rpc
    def play(self, item_id, v, a, s, colors=None):
        if not self._play_lock.acquire(blocking=False):  # already playing or starting: ignore
            return {}
        try:
            return self._play(item_id, v, a, s, colors)
        except BaseException:
            self._play_lock.release()
            raise

    def _play(self, item_id, v, a, s, colors):
        """Starts mpv; the play lock is released in stopped() (or by play() if this raises before mpv runs)."""
        jf = self._need()
        dto = jf.detail(item_id)
        st, ms_id = streams(dto)
        info = jf.playback_info(item_id)
        psid = info["PlaySessionId"]
        url = jf.stream_url(item_id, ms_id, psid)
        resume = ((dto.get("UserData") or {}).get("PlaybackPositionTicks") or 0) / TICKS
        runtime = dto.get("RunTimeTicks")
        # mpv counts per track type from 1, in the same order as Jellyfin
        vid = v + 1 if st["v"] else None
        aid = a + 1 if st["a"] else None
        has_subs = len(st["s"]) > 1
        sid = None if not has_subs else ("no" if s == len(st["s"]) - 1 else s + 1)
        # External text subtitles come after the embedded ones in the list and are loaded from the server by mpv
        sub_files = [jf.subtitle_url(item_id, ms_id, e["index"], e["fmt"]) for e in external_subs(dto)]
        title = dto["Name"]
        if dto["Type"] == "Episode":
            title = f"{dto.get('SeriesName', '')} S{dto.get('ParentIndexNumber', 0)}E{dto.get('IndexNumber', 0)} {title}"

        # Embedded (Windows, default); if that fails, mpv plays in its own window
        wid = None
        if self._embed and self._cfg.get("embed", True):
            try:
                wid = self._embed.show((colors or {}).get("bg"), (colors or {}).get("fg"), (colors or {}).get("back"))
            except Exception:  # noqa: BLE001
                wid = None
        start_fs = self._fs  # if the app is already fullscreen, the video starts fullscreen too (bar hidden)

        def toggle_fullscreen():
            self._toggle_fs()
            self._embed.set_bar(not self._fs)

        if wid is not None and start_fs:
            self._embed.set_bar(False)

        frame = {"img": None}

        def grab():
            """Keep the video frame for the page turn back; after mpv quits the window would be black, so grab it before."""
            if wid is not None:
                try:
                    frame["img"] = self._embed.snapshot() or frame["img"]
                except Exception:  # noqa: BLE001
                    pass

        def before_quit():
            """Back/Esc: grab the current frame and wait until the frontend has put it on the page (max 2 s);
            only then mpv quits, so the page turn back starts with the frame already in place."""
            grab()
            if frame["img"] and self._window:
                ready = threading.Event()
                try:
                    self._window.evaluate_js(f"window.prepareBack({json.dumps(frame['img'])})", lambda _r: ready.set())
                    ready.wait(2)
                except Exception:  # noqa: BLE001 - never block quitting
                    pass

        def progress(pos):
            if runtime and pos > runtime / TICKS - 20:
                grab()  # fallback when mpv ends by itself (end of file): only needed near the end
            jf.report("Progress", item_id, ms_id, psid, pos, runtime)

        def stopped(pos):
            if wid is not None:
                self._embed.hide()  # fullscreen stays as it currently is
            self._play_lock.release()
            jf.report("Stopped", item_id, ms_id, psid, pos, runtime)
            if self._window:
                self._window.evaluate_js(f"window.onPlaybackEnded && window.onPlaybackEnded({json.dumps(frame['img'])}, {json.dumps(self._fs)})")

        try:
            m = player.launch(url, title, vid, aid, sid, resume, self._cfg.get("mpv_opts", ""),
                              progress, stopped,
                              wid=wid, on_fullscreen=toggle_fullscreen, sub_files=sub_files, on_quit=before_quit)
            if wid is not None:
                self._embed.on_back = lambda: (before_quit(), m.command("quit"))
                threading.Thread(target=self._embed.enable_input, args=(wid,), daemon=True).start()
        except Exception:
            if wid is not None:
                self._embed.hide()
            raise
        jf.report("", item_id, ms_id, psid, resume, runtime)  # only once mpv runs, else the server keeps a ghost session
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
