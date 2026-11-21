//! Win32 parts: window frame in the theme colour (DWM), fitting the window width, the panel that hosts the embedded
//! mpv over the web UI, and the screen grab for the page-turn animation.
use base64::Engine;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::*;
use webview2_com::Microsoft::Web::WebView2::Win32::{COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_JPEG, ICoreWebView2Controller};
use webview2_com::CapturePreviewCompletedHandler;
use windows_sys::w;
use windows_sys::Win32::Graphics::Dwm::DwmSetWindowAttribute;
use windows_sys::Win32::Graphics::Gdi::*;
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::core::BOOL;
use windows_sys::Win32::UI::HiDpi::GetDpiForWindow;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{EnableWindow, SetFocus};
use windows_sys::Win32::UI::WindowsAndMessaging::*;

const DWMWA_USE_IMMERSIVE_DARK_MODE: u32 = 20;
const DWMWA_WINDOW_CORNER_PREFERENCE: u32 = 33;
const DWMWA_BORDER_COLOR: u32 = 34;
const DWMWA_CAPTION_COLOR: u32 = 35;
const DWMWA_TEXT_COLOR: u32 = 36;

fn h(hwnd: isize) -> HWND {
    hwnd as HWND
}

/// "rgb(1, 2, 3)" / "rgba(…)" or "#rrggbb" -> (r, g, b)
pub fn rgb(s: &str) -> Option<(u8, u8, u8)> {
    let s = s.trim();
    if let Some(hex) = s.strip_prefix('#').filter(|x| x.len() == 6) {
        let n = u32::from_str_radix(hex, 16).ok()?;
        return Some(((n >> 16) as u8, (n >> 8) as u8, n as u8));
    }
    let inner = s.strip_prefix("rgba(").or_else(|| s.strip_prefix("rgb("))?;
    let mut it = inner.split([',', ' ', ')', '/']).filter(|x| !x.is_empty()).map(|x| x.parse::<u8>().ok());
    Some((it.next()??, it.next()??, it.next()??))
}

fn colorref((r, g, b): (u8, u8, u8)) -> u32 {
    r as u32 | (g as u32) << 8 | (b as u32) << 16 // COLORREF is 0x00BBGGRR
}

fn put(hwnd: isize, attr: u32, v: u32) {
    unsafe { DwmSetWindowAttribute(h(hwnd), attr, &v as *const u32 as _, 4) };
}

/// Title bar and border in bg, title text in `text` (same as bg = invisible). Older Windows ignores it.
pub fn set_chrome(hwnd: isize, bg: &str, text: &str) {
    let Some(c) = rgb(bg) else { return };
    put(hwnd, DWMWA_CAPTION_COLOR, colorref(c));
    put(hwnd, DWMWA_BORDER_COLOR, colorref(c));
    put(hwnd, DWMWA_TEXT_COLOR, colorref(rgb(text).unwrap_or(c)));
    let lum = 0.299 * c.0 as f64 + 0.587 * c.1 as f64 + 0.114 * c.2 as f64;
    put(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, (lum < 128.0) as u32); // light window buttons on a dark background
}

/// Fullscreen: square corners and no border (Windows 11 would round the corners). On exit: theme frame again.
pub fn set_fullscreen_frame(hwnd: isize, on: bool, bg: Option<&str>) {
    put(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, on as u32); // 1 = DONOTROUND, 0 = default
    if on {
        put(hwnd, DWMWA_BORDER_COLOR, 0xFFFFFFFE); // DWMWA_COLOR_NONE
    } else if let Some(bg) = bg {
        set_chrome(hwnd, bg, bg);
    }
}

static FIT: AtomicU64 = AtomicU64::new(0);

/// Smoothly resize the window so the client area is inner_px (physical pixels) wide. Stays inside the monitor
/// work area (moves left if there is no room); maximized/fullscreen windows are left alone. Blocks ~0.5 s.
pub fn fit_width(hwnd: isize, inner_px: i32) {
    let token = FIT.fetch_add(1, Ordering::SeqCst) + 1;
    unsafe {
        let (mut r, mut c): (RECT, RECT) = std::mem::zeroed();
        let mut mi: MONITORINFO = std::mem::zeroed();
        GetWindowRect(h(hwnd), &mut r);
        GetClientRect(h(hwnd), &mut c);
        mi.cbSize = size_of::<MONITORINFO>() as u32;
        GetMonitorInfoW(MonitorFromWindow(h(hwnd), MONITOR_DEFAULTTONEAREST), &mut mi);
        let (mon, work) = (mi.rcMonitor, mi.rcWork);
        if IsZoomed(h(hwnd)) != 0 || IsIconic(h(hwnd)) != 0
            || (r.left <= mon.left && r.right >= mon.right && r.top <= mon.top && r.bottom >= mon.bottom) {
            return;
        }
        let (w0, hgt, x0) = (r.right - r.left, r.bottom - r.top, r.left);
        let target = (inner_px + (w0 - (c.right - c.left))).min(work.right - work.left); // frame = window - client
        let x1 = work.left.max(x0.min(work.right - target));
        if target == w0 && x1 == x0 {
            return;
        }
        let t0 = Instant::now();
        while FIT.load(Ordering::SeqCst) == token {
            // a newer fit replaces this one
            let p = (t0.elapsed().as_secs_f64() / 0.5).min(1.0);
            let e = 1.0 - (1.0 - p).powi(3);
            let lerp = |a: i32, b: i32| a + ((b - a) as f64 * e) as i32;
            SetWindowPos(h(hwnd), std::ptr::null_mut(), lerp(x0, x1), r.top, lerp(w0, target), hgt, SWP_NOZORDER | SWP_NOACTIVATE);
            if p >= 1.0 {
                break;
            }
            std::thread::sleep(Duration::from_millis(12));
        }
    }
}

/// Image of the page (WebView2 renders it itself, no screen grab) as a JPEG data URL for the page turn.
/// Must run on the UI thread; the result arrives on `tx` once WebView2 is done.
pub fn capture_page(ctrl: &ICoreWebView2Controller, tx: std::sync::mpsc::Sender<Option<String>>) {
    use windows::Win32::System::Com::{IStream, STREAM_SEEK_SET};
    use windows::Win32::UI::Shell::SHCreateMemStream;
    let started = (|| unsafe {
        let stream: IStream = SHCreateMemStream(None).ok_or_else(windows::core::Error::from_thread)?;
        let (s2, tx2) = (stream.clone(), tx.clone());
        let handler = CapturePreviewCompletedHandler::create(Box::new(move |r| {
            let jpg = r.ok().and_then(|_| {
                s2.Seek(0, STREAM_SEEK_SET, None).ok()?;
                let (mut out, mut buf) = (Vec::new(), vec![0u8; 1 << 16]);
                loop {
                    let mut n = 0u32;
                    s2.Read(buf.as_mut_ptr() as _, buf.len() as u32, Some(&mut n)).ok().ok()?;
                    if n == 0 {
                        break Some(out);
                    }
                    out.extend_from_slice(&buf[..n as usize]);
                }
            });
            let _ = tx2.send(jpg.map(|b| format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(b))));
            Ok(())
        }));
        ctrl.CoreWebView2()?.CapturePreview(COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_JPEG, &stream, &handler)
    })();
    if started.is_err() {
        let _ = tx.send(None);
    }
}

/// Video frame from mpv (BGRA, `stride` bytes per row, window area below the bar) placed into an image of the
/// whole client area (bar colour above, black elsewhere) as a JPEG data URL, so it fits the page turn like the page image.
pub fn frame_jpeg(hwnd: isize, w: usize, ht: usize, stride: usize, px: &[u8]) -> Option<String> {
    let mut c: RECT = unsafe { std::mem::zeroed() };
    unsafe { GetClientRect(h(hwnd), &mut c) };
    let (cw, ch) = (c.right as usize, c.bottom as usize);
    if cw == 0 || ch == 0 || cw > 65535 || ch > 65535 || w == 0 || ht == 0 || px.len() < stride * (ht - 1) + w * 4 {
        return None;
    }
    let top = ch.saturating_sub(ht);
    let mut img = vec![0u8; cw * ch * 4];
    if top > 0 {
        unsafe {
            let g = EMBED.lock().unwrap();
            let e = g.as_ref()?;
            let dc = CreateCompatibleDC(std::ptr::null_mut());
            let mut bi: BITMAPINFO = std::mem::zeroed();
            bi.bmiHeader = BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32, biWidth: cw as i32, biHeight: -(top as i32), // top-down rows
                biPlanes: 1, biBitCount: 32, biCompression: BI_RGB, ..std::mem::zeroed()
            };
            let mut bits: *mut std::ffi::c_void = std::ptr::null_mut();
            let bmp = CreateDIBSection(dc, &bi, DIB_RGB_COLORS, &mut bits, std::ptr::null_mut(), 0);
            let old = SelectObject(dc, bmp);
            paint_bar(dc, h(e.host), RECT { left: 0, top: 0, right: cw as i32, bottom: top as i32 }, e);
            img[..cw * top * 4].copy_from_slice(std::slice::from_raw_parts(bits as *const u8, cw * top * 4));
            SelectObject(dc, old);
            DeleteObject(bmp);
            DeleteDC(dc);
        }
    }
    for y in 0..ht.min(ch - top) {
        let n = w.min(cw) * 4;
        img[((top + y) * cw) * 4..][..n].copy_from_slice(&px[y * stride..][..n]);
    }
    let mut out = Vec::new();
    jpeg_encoder::Encoder::new(&mut out, 85).encode(&img, cw as u16, ch as u16, jpeg_encoder::ColorType::Bgra).ok()?;
    Some(format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(out)))
}

/// mpv creates its embedded window disabled (WS_DISABLED), so neither mouse (OSC) nor keys arrive.
/// Enables it and gives it focus; waits up to 4 s until mpv has created the child window.
pub fn enable_input(wid: isize) {
    unsafe extern "system" fn first(hw: HWND, out: LPARAM) -> BOOL {
        unsafe { *(out as *mut HWND) = hw };
        0
    }
    let end = Instant::now() + Duration::from_secs(4);
    while Instant::now() < end {
        let mut kid: HWND = std::ptr::null_mut();
        unsafe {
            EnumChildWindows(h(wid), Some(first), &mut kid as *mut HWND as LPARAM);
            if !kid.is_null() {
                EnableWindow(kid, 1);
                return;
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

// ---- Embedded player: a panel over the web UI, a slim bar with a back button on top, the video area below ----

struct Embed {
    parent: isize,
    host: isize,
    video: isize,
    bg: u32,
    fg: u32,
    label: Vec<u16>,
    bar: bool,
    on_back: Option<Arc<dyn Fn() + Send + Sync>>,
    on_key: Option<Arc<dyn Fn(&str) + Send + Sync>>,
}
static EMBED: Mutex<Option<Embed>> = Mutex::new(None);

fn scale(hwnd: HWND, px: i32) -> i32 {
    px * unsafe { GetDpiForWindow(hwnd) } as i32 / 96
}

/// The bar with the back label into r (used for the window and for the frame of the page turn).
unsafe fn paint_bar(dc: HDC, hw: HWND, mut r: RECT, e: &Embed) {
    unsafe {
        let brush = CreateSolidBrush(e.bg);
        FillRect(dc, &r, brush);
        DeleteObject(brush);
        let font = CreateFontW(-scale(hw, 12), 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 5, 0, w!("Segoe UI"));
        let old = SelectObject(dc, font);
        SetTextColor(dc, e.fg);
        SetBkMode(dc, TRANSPARENT as i32);
        r.right = scale(hw, 130);
        DrawTextW(dc, e.label.as_ptr(), -1, &mut r, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
        SelectObject(dc, old);
        DeleteObject(font);
    }
}

unsafe extern "system" fn host_proc(hw: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    let (bar_h, btn_w) = (scale(hw, 34), scale(hw, 130));
    let on_btn = |x: i32, y: i32| x < btn_w && y < bar_h;
    unsafe {
        match msg {
            WM_ERASEBKGND => 1,
            WM_PAINT => {
                let mut ps: PAINTSTRUCT = std::mem::zeroed();
                let dc = BeginPaint(hw, &mut ps);
                if let Some(e) = EMBED.lock().unwrap().as_ref() {
                    let mut r: RECT = std::mem::zeroed();
                    GetClientRect(hw, &mut r);
                    r.bottom = bar_h;
                    paint_bar(dc, hw, r, e);
                }
                EndPaint(hw, &ps);
                0
            }
            WM_SETCURSOR => {
                let mut p = POINT { x: 0, y: 0 };
                GetCursorPos(&mut p);
                ScreenToClient(hw, &mut p);
                if on_btn(p.x, p.y) && EMBED.lock().unwrap().as_ref().is_some_and(|e| e.bar) {
                    SetCursor(LoadCursorW(std::ptr::null_mut(), IDC_HAND));
                    return 1;
                }
                DefWindowProcW(hw, msg, wp, lp)
            }
            // Until the user clicks into the video, mpv's window has no keyboard focus (it lives in another input
            // queue): the panel holds it and passes keys on, so Esc, space and the arrows work from the start
            WM_KEYDOWN | WM_CHAR => {
                let key = match (msg, wp as u32) {
                    (WM_KEYDOWN, 0x1B) => Some("ESC".to_string()),
                    (WM_KEYDOWN, 0x0D) => Some("ENTER".into()),
                    (WM_KEYDOWN, 0x25) => Some("LEFT".into()),
                    (WM_KEYDOWN, 0x26) => Some("UP".into()),
                    (WM_KEYDOWN, 0x27) => Some("RIGHT".into()),
                    (WM_KEYDOWN, 0x28) => Some("DOWN".into()),
                    (WM_CHAR, 0x20) => Some("SPACE".into()),
                    (WM_CHAR, c) if c > 0x20 => char::from_u32(c).map(String::from),
                    _ => None,
                };
                let cb = EMBED.lock().unwrap().as_ref().and_then(|e| e.on_key.clone());
                if let (Some(k), Some(f)) = (key, cb) {
                    f(&k);
                }
                0
            }
            WM_LBUTTONUP => {
                let (x, y) = ((lp & 0xFFFF) as i16 as i32, ((lp >> 16) & 0xFFFF) as i16 as i32);
                let cb = EMBED.lock().unwrap().as_ref().filter(|e| e.bar).and_then(|e| e.on_back.clone());
                if let (true, Some(f)) = (on_btn(x, y), cb) {
                    std::thread::spawn(move || f());
                }
                0
            }
            _ => DefWindowProcW(hw, msg, wp, lp),
        }
    }
}

/// Creates the (hidden) panel; must run on the UI thread, which then handles its messages.
pub fn embed_init(parent: isize) {
    unsafe {
        let inst = GetModuleHandleW(std::ptr::null());
        let mut wc: WNDCLASSW = std::mem::zeroed();
        wc.lpfnWndProc = Some(host_proc);
        wc.hInstance = inst;
        wc.hCursor = LoadCursorW(std::ptr::null_mut(), IDC_ARROW);
        wc.lpszClassName = w!("UnfoldHost");
        RegisterClassW(&wc);
        wc.lpfnWndProc = Some(DefWindowProcW);
        wc.hbrBackground = GetStockObject(BLACK_BRUSH) as HBRUSH;
        wc.lpszClassName = w!("UnfoldVideo");
        RegisterClassW(&wc);
        let host = CreateWindowExW(0, w!("UnfoldHost"), std::ptr::null(), WS_CHILD | WS_CLIPCHILDREN,
            0, 0, 0, 0, h(parent), std::ptr::null_mut(), inst, std::ptr::null());
        let video = CreateWindowExW(0, w!("UnfoldVideo"), std::ptr::null(), WS_CHILD | WS_VISIBLE,
            0, 0, 0, 0, host, std::ptr::null_mut(), inst, std::ptr::null());
        *EMBED.lock().unwrap() = Some(Embed {
            parent, host: host as isize, video: video as isize, bg: colorref((11, 15, 11)), fg: colorref((182, 242, 182)),
            label: "←  Back".encode_utf16().chain(Some(0)).collect(), bar: true, on_back: None, on_key: None,
        });
    }
}

/// Panel over the whole client area (bar hidden in fullscreen); call on every resize of the main window.
pub fn embed_layout() {
    let Some((parent, host, video, bar)) = EMBED.lock().unwrap().as_ref().map(|e| (e.parent, e.host, e.video, e.bar)) else { return };
    unsafe {
        let mut c: RECT = std::mem::zeroed();
        GetClientRect(h(parent), &mut c);
        let bar_h = if bar { scale(h(host), 34) } else { 0 };
        SetWindowPos(h(host), HWND_TOP, 0, 0, c.right, c.bottom, SWP_NOACTIVATE);
        SetWindowPos(h(video), std::ptr::null_mut(), 0, bar_h, c.right, c.bottom - bar_h, SWP_NOZORDER | SWP_NOACTIVATE);
        InvalidateRect(h(host), std::ptr::null(), 0);
    }
}

/// Show the panel (bar colours and label come from the frontend) and return the HWND of the video area.
pub fn embed_show(bg: Option<&str>, fg: Option<&str>, back: Option<&str>, bar: bool, on_back: Arc<dyn Fn() + Send + Sync>,
    on_key: Arc<dyn Fn(&str) + Send + Sync>) -> Option<isize> {
    let (host, video) = {
        let mut g = EMBED.lock().unwrap();
        let e = g.as_mut()?;
        e.bg = colorref(bg.and_then(rgb).unwrap_or((11, 15, 11)));
        e.fg = colorref(fg.and_then(rgb).unwrap_or((182, 242, 182)));
        if let Some(b) = back {
            e.label = b.encode_utf16().chain(Some(0)).collect();
        }
        e.bar = bar;
        e.on_back = Some(on_back);
        e.on_key = Some(on_key);
        (e.host, e.video)
    };
    embed_layout();
    unsafe { ShowWindow(h(host), SW_SHOW) };
    Some(video)
}

/// Hide the bar (fullscreen) or show it again.
pub fn embed_set_bar(visible: bool) {
    if let Some(e) = EMBED.lock().unwrap().as_mut() {
        e.bar = visible;
    }
    embed_layout();
}

/// Keyboard focus to the player panel (UI thread only); see WM_KEYDOWN in host_proc.
pub fn embed_focus() {
    let host = EMBED.lock().unwrap().as_ref().map(|e| e.host);
    if let Some(host) = host {
        unsafe { SetFocus(h(host)) };
    }
}

pub fn embed_hide() {
    let host = EMBED.lock().unwrap().as_mut().map(|e| {
        e.on_back = None;
        e.on_key = None;
        e.host
    });
    if let Some(host) = host {
        unsafe { ShowWindow(h(host), SW_HIDE) };
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn colors() {
        assert_eq!(super::rgb("rgb(11, 15, 11)"), Some((11, 15, 11)));
        assert_eq!(super::rgb("rgba(1,2,3,0.5)"), Some((1, 2, 3)));
        assert_eq!(super::rgb("#b6f2b6"), Some((182, 242, 182)));
        assert_eq!(super::rgb("red"), None);
    }
}
