"""Embeds mpv in the app window (Windows only): a WinForms panel covers the web UI during playback
(a slim bar with a back button on top, the video area below); its handle is passed to mpv as `wid`.
pywebview calls come from worker threads, so everything goes through Invoke on the UI thread."""
import re
import threading


def enable_input(wid: int, timeout: float = 4.0) -> bool:
    """mpv creates its embedded window disabled (WS_DISABLED), so neither mouse (OSC) nor keys arrive.
    Enables it and gives it focus. Waits briefly until mpv has created the child window."""
    import ctypes
    import time
    from ctypes import wintypes
    u = ctypes.windll.user32
    cb_t = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
    end = time.time() + timeout
    while time.time() < end:
        kids = []
        u.EnumChildWindows(wid, cb_t(lambda h, _l: kids.append(h) or True), 0)
        if kids:
            k = kids[0]
            u.EnableWindow(k, True)
            me = ctypes.windll.kernel32.GetCurrentThreadId()
            there = u.GetWindowThreadProcessId(k, None)
            u.AttachThreadInput(me, there, True)  # SetFocus only works within the own input queue
            u.SetFocus(k)
            u.AttachThreadInput(me, there, False)
            return True
        time.sleep(0.1)
    return False


def _color(s: str | None, default: tuple):
    """'rgb(1, 2, 3)' or '#rrggbb' -> System.Drawing.Color"""
    from System.Drawing import Color
    rgb = default
    if s:
        m = re.match(r"rgba?\((\d+)[ ,]+(\d+)[ ,]+(\d+)", s)
        if m:
            rgb = tuple(int(x) for x in m.groups())
        elif re.fullmatch(r"#[0-9a-fA-F]{6}", s):
            rgb = tuple(int(s[i:i + 2], 16) for i in (1, 3, 5))
    return Color.FromArgb(*rgb)


class Embed:
    enable_input = staticmethod(enable_input)

    def __init__(self, window):
        self._w = window
        self._host = None
        self._video = None
        self._bar = None
        self._btn = None
        self.on_back = None  # set by main.py for each playback (quits mpv)

    def _ui(self, fn):
        from System import Action
        out = []
        self._w.native.Invoke(Action(lambda: out.append(fn())))
        return out[0] if out else None

    def _build(self):
        from System import EventHandler
        from System.Drawing import Color
        from System.Windows.Forms import Button, Cursors, DockStyle, FlatStyle, Panel
        host = Panel()
        host.Dock = DockStyle.Fill
        video = Panel()
        video.Dock = DockStyle.Fill
        video.BackColor = Color.Black
        bar = Panel()
        bar.Dock = DockStyle.Top
        bar.Height = 34
        btn = Button()
        btn.Text = "←  Back"
        btn.Dock = DockStyle.Left
        btn.Width = 130
        btn.FlatStyle = FlatStyle.Flat
        btn.FlatAppearance.BorderSize = 0
        btn.Cursor = Cursors.Hand
        btn.Click += EventHandler(lambda _s, _e: self.on_back and threading.Thread(target=self.on_back, daemon=True).start())
        bar.Controls.Add(btn)
        host.Controls.Add(video)  # Fill first, then Top: this docks the bar first
        host.Controls.Add(bar)
        video.BringToFront()
        self._w.native.Controls.Add(host)
        self._host, self._video, self._bar, self._btn = host, video, bar, btn

    def show(self, bg: str | None = None, fg: str | None = None, back: str | None = None) -> int:
        """Show the panel (bar colours and label come from the frontend) and return the HWND of the video area."""
        def f():
            if self._host is None:
                self._build()
            if back:
                self._btn.Text = back
            self._bar.BackColor = _color(bg, (11, 15, 11))
            self._btn.BackColor = self._bar.BackColor
            self._btn.ForeColor = _color(fg, (182, 242, 182))
            self._bar.Visible = True
            self._host.Visible = True
            self._host.BringToFront()
            return int(self._video.Handle.ToInt64())
        return self._ui(f)

    def snapshot(self) -> str | None:
        """Image of the window contents (incl. WebView) as a data URL: template for the page turn in the frontend.
        None if the window is not in the foreground (the screen grab would include other windows)."""
        def f():
            import ctypes
            from System import Convert
            from System.Drawing import Bitmap, Graphics, Point
            from System.Drawing.Imaging import ImageFormat
            from System.IO import MemoryStream
            n = self._w.native
            if ctypes.windll.user32.GetForegroundWindow() != n.Handle.ToInt64():
                return None
            size = n.ClientSize
            bmp = Bitmap(size.Width, size.Height)
            g = Graphics.FromImage(bmp)
            g.CopyFromScreen(n.PointToScreen(Point(0, 0)), Point(0, 0), size)
            g.Dispose()
            ms = MemoryStream()
            bmp.Save(ms, ImageFormat.Jpeg)  # JPEG: much faster and smaller than PNG, good enough for the page turn
            bmp.Dispose()
            return "data:image/jpeg;base64," + Convert.ToBase64String(ms.ToArray())
        return self._ui(f)

    def set_icon(self, path) -> None:
        """Set the window icon (title bar); as an exe it comes from the program file, started via python it would be the Python icon."""
        def f():
            from System.Drawing import Icon
            self._w.native.Icon = Icon(str(path))
        self._ui(f)

    def set_bar(self, visible: bool) -> None:
        """Hide the bar (fullscreen) or show it again."""
        if self._bar is not None:
            self._ui(lambda: setattr(self._bar, "Visible", visible))

    def hide(self) -> None:
        if self._host is not None:
            self._ui(lambda: setattr(self._host, "Visible", False))
