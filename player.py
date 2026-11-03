"""Wiedergabe über libmpv (python-mpv). Unter Windows liegt libmpv-2.dll in lib/ (siehe tools/fetch_libmpv.py),
unter Linux kommt libmpv aus dem Paketmanager (libmpv2 / mpv-libs). mpv öffnet ein eigenes Fenster."""
import os
import sys
import threading
import time
from pathlib import Path

from errors import AppError

BASE = Path(getattr(sys, "_MEIPASS", Path(__file__).parent))  # _MEIPASS: entpackter Ordner im PyInstaller-Build
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
    """Startet mpv und kehrt sofort zurück. on_progress(pos_s) etwa alle 10 s, on_stop(pos_s) beim Beenden.
    Mit wid rendert mpv in dieses Fenster (eingebettet), sonst in ein eigenes."""
    mpv = _import_mpv()
    opts = {"input_default_bindings": True, "input_vo_keyboard": True, "osc": True, "ytdl": False,
            "force_window": "yes", "force_media_title": title}
    if wid is not None:
        opts["wid"] = str(wid)
    # Bei externen Untertiteln wird die Spur erst nach dem Nachladen gesetzt (die Nummer kann auf eine externe zeigen)
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
            for u in sub_files:  # landen als Spuren nach den eingebetteten, in dieser Reihenfolge
                m.command("sub-add", u, "auto")
            if sid is not None:
                m.sid = sid

    if wid is not None:
        # eingebettet gibt es kein Fenster-X: Esc beendet und kehrt zur Bibliothek zurück (vorher letztes Bild festhalten)
        def _esc(state="d", *_a):
            if str(state)[:1] in ("d", "p"):
                if on_quit:
                    on_quit()
                m.command("quit")
        m.register_key_binding("ESC", _esc)
        if on_fullscreen:
            # Vollbild (Taste f, Knopf der Leiste, Doppelklick) betrifft sonst nur das mpv-Kindfenster:
            # Eigenschaft sofort zurücksetzen und stattdessen das ganze App-Fenster umschalten
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
            # nicht im mpv-Eventthread blockieren (HTTP)
            threading.Thread(target=on_progress, args=(state["pos"],), daemon=True).start()

    def wait():
        # libmpv bleibt nach Dateiende im Idle: auf Wiedergabeende ODER Fenster schließen (ShutdownError) warten
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
