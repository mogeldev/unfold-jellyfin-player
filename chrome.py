"""Window frame in the theme colour (Windows 11, DWM): title bar and border blend into the UI.
Older Windows versions ignore the DWM attributes and keep the normal frame."""
import ctypes
import os
import re
from ctypes import wintypes

DWMWA_USE_IMMERSIVE_DARK_MODE, DWMWA_BORDER_COLOR, DWMWA_CAPTION_COLOR, DWMWA_TEXT_COLOR = 20, 34, 35, 36
DWMWA_WINDOW_CORNER_PREFERENCE = 33


class _RECT(ctypes.Structure):
    _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long), ("right", ctypes.c_long), ("bottom", ctypes.c_long)]


class _MONITORINFO(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.DWORD), ("rcMonitor", _RECT), ("rcWork", _RECT), ("dwFlags", wintypes.DWORD)]


_fit_token = 0


def fit_width(hwnd: int, inner_px: int, ms: int = 500) -> None:
    """Smoothly resize the window so the client area is inner_px (physical pixels) wide.
    Stays inside the monitor work area (moves left if there is no room on the right); maximized/fullscreen windows are left alone."""
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
    target = min(int(inner_px) + (w0 - (c.right - c.left)), work.right - work.left)  # frame width = window - client
    x1 = max(work.left, min(x0, work.right - target))
    if target == w0 and x1 == x0:
        return
    t0 = time.time()
    while token == _fit_token:  # a newer fit replaces this one
        p = min(1.0, (time.time() - t0) * 1000 / ms)
        e = 1 - (1 - p) ** 3
        u.SetWindowPos(h, None, int(x0 + (x1 - x0) * e), r.top, int(w0 + (target - w0) * e), hgt, 0x0004 | 0x0010)
        if p >= 1:
            break
        time.sleep(0.012)


def _rgb(s):
    m = re.match(r"rgba?\((\d+)[ ,]+(\d+)[ ,]+(\d+)", s or "")
    return tuple(int(x) for x in m.groups()) if m else None


def _put(hwnd: int, attr: int, value: int) -> None:
    v = ctypes.c_int(value)
    ctypes.windll.dwmapi.DwmSetWindowAttribute(wintypes.HWND(hwnd), attr, ctypes.byref(v), 4)


def set_chrome(hwnd: int, bg: str, text: str | None = None) -> None:
    """Colour title bar/border with bg; title text in `text` (same as bg = invisible). Colours as 'rgb(r, g, b)'."""
    if os.name != "nt":
        return
    r = _rgb(bg)
    if not r:
        return
    ref = lambda c: c[0] | (c[1] << 8) | (c[2] << 16)  # noqa: E731 - COLORREF is 0x00BBGGRR
    _put(hwnd, DWMWA_CAPTION_COLOR, ref(r))
    _put(hwnd, DWMWA_BORDER_COLOR, ref(r))
    _put(hwnd, DWMWA_TEXT_COLOR, ref(_rgb(text) or r))
    luminance = 0.299 * r[0] + 0.587 * r[1] + 0.114 * r[2]
    _put(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, 1 if luminance < 128 else 0)  # light window buttons on a dark background


def set_fullscreen_frame(hwnd: int, on: bool, bg: str | None = None) -> None:
    """Fullscreen: square corners and no border (Windows 11 would round the corners and show the desktop behind them).
    pywebview tries this itself, but with a call that has no effect. On exit: rounded corners and theme colour again."""
    if os.name != "nt":
        return
    _put(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, 1 if on else 0)  # 1 = DONOTROUND, 0 = default
    if on:
        _put(hwnd, DWMWA_BORDER_COLOR, 0xFFFFFFFE)  # DWMWA_COLOR_NONE
    elif bg:
        set_chrome(hwnd, bg, bg)
