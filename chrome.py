"""Fensterrahmen im Farbton des Themes (Windows 11, DWM): Titelleiste und Rahmen verschmelzen mit der Oberfläche.
Auf älteren Windows-Versionen ignoriert DWM die Attribute, dann bleibt der normale Rahmen."""
import ctypes
import os
import re
from ctypes import wintypes

DWMWA_USE_IMMERSIVE_DARK_MODE, DWMWA_BORDER_COLOR, DWMWA_CAPTION_COLOR, DWMWA_TEXT_COLOR = 20, 34, 35, 36


class _RECT(ctypes.Structure):
    _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long), ("right", ctypes.c_long), ("bottom", ctypes.c_long)]


class _MONITORINFO(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.DWORD), ("rcMonitor", _RECT), ("rcWork", _RECT), ("dwFlags", wintypes.DWORD)]


_fit_token = 0


def fit_width(hwnd: int, inner_px: int, ms: int = 500) -> None:
    """Fensterbreite sanft so ändern, dass der Inhaltsbereich inner_px (physische Pixel) breit ist.
    Bleibt im Arbeitsbereich des Monitors (rückt nach links, wenn rechts der Platz fehlt); Maximiert/Vollbild bleibt unberührt."""
    global _fit_token
    if os.name != "nt":
        return
    import time
    _fit_token += 1
    token = _fit_token
    u = ctypes.windll.user32
    h = wintypes.HWND(hwnd)
    r, c, mi = _RECT(), _RECT(), _MONITORINFO()
    u.GetWindowRect(h, ctypes.byref(r))
    u.GetClientRect(h, ctypes.byref(c))
    mi.cbSize = ctypes.sizeof(mi)
    u.GetMonitorInfoW(u.MonitorFromWindow(h, 2), ctypes.byref(mi))
    mon, work = mi.rcMonitor, mi.rcWork
    if u.IsZoomed(h) or u.IsIconic(h) or (r.left <= mon.left and r.right >= mon.right and r.top <= mon.top and r.bottom >= mon.bottom):
        return
    w0, hgt, x0 = r.right - r.left, r.bottom - r.top, r.left
    target = min(int(inner_px) + (w0 - (c.right - c.left)), work.right - work.left)  # Rahmenbreite = Fenster - Client
    x1 = max(work.left, min(x0, work.right - target))
    if target == w0 and x1 == x0:
        return
    t0 = time.time()
    while token == _fit_token:  # eine neuere Anpassung löst diese ab
        p = min(1.0, (time.time() - t0) * 1000 / ms)
        e = 1 - (1 - p) ** 3
        u.SetWindowPos(h, None, int(x0 + (x1 - x0) * e), r.top, int(w0 + (target - w0) * e), hgt, 0x0004 | 0x0010)
        if p >= 1:
            break
        time.sleep(0.012)


def _rgb(s):
    m = re.match(r"rgba?\((\d+)[ ,]+(\d+)[ ,]+(\d+)", s or "")
    return tuple(int(x) for x in m.groups()) if m else None


def set_chrome(hwnd: int, bg: str, text: str | None = None) -> None:
    """Titelleiste/Rahmen in bg einfärben; Titeltext in `text` (gleich bg = unsichtbar). Farben als 'rgb(r, g, b)'."""
    if os.name != "nt":
        return
    r = _rgb(bg)
    if not r:
        return
    dwm = ctypes.windll.dwmapi

    def put(attr, value):
        v = ctypes.c_int(value)
        dwm.DwmSetWindowAttribute(wintypes.HWND(hwnd), attr, ctypes.byref(v), 4)

    ref = lambda c: c[0] | (c[1] << 8) | (c[2] << 16)  # noqa: E731 - COLORREF ist 0x00BBGGRR
    put(DWMWA_CAPTION_COLOR, ref(r))
    put(DWMWA_BORDER_COLOR, ref(r))
    put(DWMWA_TEXT_COLOR, ref(_rgb(text) or r))
    luminance = 0.299 * r[0] + 0.587 * r[1] + 0.114 * r[2]
    put(DWMWA_USE_IMMERSIVE_DARK_MODE, 1 if luminance < 128 else 0)  # Fensterknöpfe hell auf dunklem Grund
