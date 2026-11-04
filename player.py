"""Playback via libmpv (python-mpv). On Windows libmpv-2.dll lives in lib/ (see tools/fetch_libmpv.py),
on Linux libmpv comes from the package manager (libmpv2 / mpv-libs). mpv opens its own window."""
import os
import sys
import threading
import time
from pathlib import Path

from errors import AppError

BASE = Path(getattr(sys, "_MEIPASS", Path(__file__).parent))  # _MEIPASS: unpacked folder in the PyInstaller build
LIB = BASE / "lib"
if os.name == "nt" and LIB.is_dir():
    os.add_dll_directory(str(LIB))
    os.environ["PATH"] = str(LIB) + os.pathsep + os.environ.get("PATH", "")


def _import_mpv():
    try:
        import mpv
        return mpv
    except (ImportError, OSError) as e:
        raise AppError("libmpv") from e


def parse_opts(text: str) -> dict:
    """'hwdec=auto fullscreen=yes' -> {'hwdec': 'auto', 'fullscreen': 'yes'}"""
    out = {}
    for tok in (text or "").split():
        k, sep, v = tok.partition("=")
        if sep and k:
            out[k.lstrip("-").replace("-", "_")] = v
    return out


def launch(url: str, title: str, vid: int | None, aid: int | None, sid: int | str | None,
           start: float, extra_opts: str, on_progress, on_stop, wid: int | None = None, on_fullscreen=None,
           sub_files: list[str] | None = None, on_quit=None) -> None:
    """Starts mpv and returns immediately. on_progress(pos_s) about every 10 s, on_stop(pos_s) on exit.
    With wid mpv renders into that window (embedded), otherwise into its own."""
    mpv = _import_mpv()
    opts = {"input_default_bindings": True, "input_vo_keyboard": True, "osc": True, "ytdl": False,
            "force_window": "yes", "force_media_title": title}
    if wid is not None:
        opts["wid"] = str(wid)
    # With external subtitles the track is set only after loading (the number may point to an external one)
    for k, v in (("vid", vid), ("aid", aid), ("sid", None if sub_files else sid)):
        if v is not None:
            opts[k] = v
    if start > 5:
        opts["start"] = int(start)
    opts.update(parse_opts(extra_opts))
    m = mpv.MPV(**opts)

    if sub_files:
        @m.event_callback("file-loaded")
        def _loaded(_event):
            for u in sub_files:  # they become tracks after the embedded ones, in this order
                m.command("sub-add", u, "auto")
            if sid is not None:
                m.sid = sid

    if wid is not None:
        # embedded there is no window X: Esc quits and returns to the library. on_quit (grab the last frame,
        # wait for the frontend) may take a moment: run it off the mpv event thread, once.
        quitting = []

        def _quit():
            if on_quit:
                on_quit()
            m.command("quit")

        def _esc(state="d", *_a):
            if str(state)[:1] in ("d", "p") and not quitting:
                quitting.append(1)
                threading.Thread(target=_quit, daemon=True).start()
        m.register_key_binding("ESC", _esc)
        if on_fullscreen:
            # Fullscreen (key f, bar button, double click) would only affect the mpv child window:
            # reset the property at once and toggle the whole app window instead
            @m.property_observer("fullscreen")
            def _fs(_name, value):
                if value:
                    m.fullscreen = False
                    on_fullscreen()

    state = {"pos": 0.0, "last": time.time()}

    @m.property_observer("time-pos")
    def _pos(_name, value):
        if value is None:
            return
        state["pos"] = float(value)
        if time.time() - state["last"] >= 10:
            state["last"] = time.time()
            # do not block the mpv event thread (HTTP)
            threading.Thread(target=on_progress, args=(state["pos"],), daemon=True).start()

    def wait():
        # libmpv stays idle after the end of file: wait for end of playback OR window close (ShutdownError)
        try:
            m.wait_for_playback()
        except mpv.ShutdownError:
            pass
        pos = state["pos"]
        try:
            m.terminate()
        except Exception:  # noqa: BLE001
            pass
        on_stop(pos)

    m.play(url)
    threading.Thread(target=wait, daemon=True).start()
    return m
