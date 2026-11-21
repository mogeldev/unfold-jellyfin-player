//! Playback via libmpv: lib\libmpv-2.dll next to the exe (tools\fetch_libmpv.ps1), loaded at runtime.
use crate::jellyfin::AppError;
use libloading::Library;
use std::ffi::{CStr, CString, c_char, c_int, c_void};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

type Ctx = *mut c_void;
#[repr(C)]
struct Event {
    id: c_int,
    error: c_int,
    reply: u64,
    data: *mut c_void,
}
#[repr(C)]
struct EventProperty {
    name: *const c_char,
    format: c_int,
    data: *mut c_void,
}
#[repr(C)]
struct ClientMessage {
    num_args: c_int,
    args: *const *const c_char,
}
#[repr(C)]
struct Node {
    u: u64, // union: string / flag / int64 / double / list / byte array
    format: c_int,
}
#[repr(C)]
struct NodeList {
    num: c_int,
    values: *mut Node,
    keys: *mut *mut c_char,
}
#[repr(C)]
struct ByteArray {
    data: *mut c_void,
    size: usize,
}
const NODE_STRING: c_int = 1;
const NODE_INT64: c_int = 4;
const NODE_ARRAY: c_int = 7;
const NODE_MAP: c_int = 8;
const NODE_BYTES: c_int = 9;
const SHUTDOWN: c_int = 1;
const END_FILE: c_int = 7;
const FILE_LOADED: c_int = 8;
const CLIENT_MESSAGE: c_int = 16;
const PROPERTY_CHANGE: c_int = 22;
const FMT_FLAG: c_int = 3;
const FMT_DOUBLE: c_int = 5;

struct Lib {
    create: unsafe extern "C" fn() -> Ctx,
    initialize: unsafe extern "C" fn(Ctx) -> c_int,
    set_option_string: unsafe extern "C" fn(Ctx, *const c_char, *const c_char) -> c_int,
    set_property_string: unsafe extern "C" fn(Ctx, *const c_char, *const c_char) -> c_int,
    command: unsafe extern "C" fn(Ctx, *const *const c_char) -> c_int,
    command_node: unsafe extern "C" fn(Ctx, *mut Node, *mut Node) -> c_int,
    free_node_contents: unsafe extern "C" fn(*mut Node),
    observe_property: unsafe extern "C" fn(Ctx, u64, *const c_char, c_int) -> c_int,
    wait_event: unsafe extern "C" fn(Ctx, f64) -> *mut Event,
    terminate_destroy: unsafe extern "C" fn(Ctx),
    _lib: Library,
}

fn lib() -> Result<&'static Lib, AppError> {
    static LIB: OnceLock<Option<Lib>> = OnceLock::new();
    LIB.get_or_init(|| unsafe {
        // lib\ next to the exe (installed), else the first one above it (cargo run from the repository)
        let exe = std::env::current_exe().ok()?;
        let dll = exe.ancestors().skip(1).map(|d| d.join("lib").join("libmpv-2.dll")).find(|p| p.is_file())?;
        let l = Library::new(&dll).ok()?;
        macro_rules! f {
            ($n:literal) => {
                *l.get(concat!($n, "\0").as_bytes()).ok()?
            };
        }
        Some(Lib {
            create: f!("mpv_create"),
            initialize: f!("mpv_initialize"),
            set_option_string: f!("mpv_set_option_string"),
            set_property_string: f!("mpv_set_property_string"),
            command: f!("mpv_command"),
            command_node: f!("mpv_command_node"),
            free_node_contents: f!("mpv_free_node_contents"),
            observe_property: f!("mpv_observe_property"),
            wait_event: f!("mpv_wait_event"),
            terminate_destroy: f!("mpv_terminate_destroy"),
            _lib: l,
        })
    })
    .as_ref()
    .ok_or(AppError::code("libmpv"))
}

fn cs(s: &str) -> CString {
    CString::new(s.replace('\0', "")).unwrap()
}

/// 'hwdec=auto --fullscreen=yes' -> [("hwdec","auto"), ("fullscreen","yes")]
pub fn parse_opts(text: &str) -> Vec<(String, String)> {
    text.split_whitespace()
        .filter_map(|t| t.split_once('='))
        .filter(|(k, _)| !k.trim_start_matches('-').is_empty())
        .map(|(k, v)| (k.trim_start_matches('-').to_string(), v.to_string()))
        .collect()
}

pub struct Player {
    ctx: Mutex<usize>, // 0 once destroyed: commands after the end are ignored
    quitting: AtomicBool,
    on_quit: Option<Box<dyn Fn() + Send + Sync>>,
}

impl Player {
    pub fn command(&self, args: &[&str]) {
        let ctx = self.ctx.lock().unwrap();
        if *ctx != 0 {
            let c: Vec<CString> = args.iter().map(|a| cs(a)).collect();
            let mut p: Vec<*const c_char> = c.iter().map(|a| a.as_ptr()).collect();
            p.push(std::ptr::null());
            if let Ok(l) = lib() {
                unsafe { (l.command)(*ctx as Ctx, p.as_ptr()) };
            }
        }
    }

    /// What the mpv window shows right now (video, letterbox, OSD): (width, height, bytes per row, BGRA pixels).
    pub fn screenshot(&self) -> Option<(usize, usize, usize, Vec<u8>)> {
        let ctx = self.ctx.lock().unwrap();
        if *ctx == 0 {
            return None;
        }
        let l = lib().ok()?;
        let words = [cs("screenshot-raw"), cs("window")];
        let mut args: Vec<Node> = words.iter().map(|c| Node { u: c.as_ptr() as u64, format: NODE_STRING }).collect();
        let mut list = NodeList { num: 2, values: args.as_mut_ptr(), keys: std::ptr::null_mut() };
        let mut cmd = Node { u: &mut list as *mut NodeList as u64, format: NODE_ARRAY };
        let mut res = Node { u: 0, format: 0 };
        unsafe {
            if (l.command_node)(*ctx as Ctx, &mut cmd, &mut res) < 0 {
                return None;
            }
            let out = (|| {
                if res.format != NODE_MAP {
                    return None;
                }
                let m = &*(res.u as *const NodeList);
                let (mut w, mut h, mut stride, mut data) = (0usize, 0usize, 0usize, None);
                for i in 0..m.num as usize {
                    let (k, v) = (CStr::from_ptr(*m.keys.add(i)).to_bytes(), &*m.values.add(i));
                    match (k, v.format) {
                        (b"w", NODE_INT64) => w = v.u as usize,
                        (b"h", NODE_INT64) => h = v.u as usize,
                        (b"stride", NODE_INT64) => stride = v.u as usize,
                        (b"data", NODE_BYTES) => {
                            let b = &*(v.u as *const ByteArray);
                            data = Some(std::slice::from_raw_parts(b.data as *const u8, b.size).to_vec());
                        }
                        _ => {}
                    }
                }
                Some((w, h, stride, data?))
            })();
            (l.free_node_contents)(&mut res);
            out
        }
    }

    /// Back/Esc: on_quit (grab the last frame, wait for the frontend) may take a moment, so it runs off the
    /// mpv event thread, once; then mpv quits.
    pub fn back(self: &Arc<Self>) {
        if self.quitting.swap(true, Ordering::SeqCst) {
            return;
        }
        let me = self.clone();
        std::thread::spawn(move || {
            if let Some(f) = &me.on_quit {
                f();
            }
            me.command(&["quit"]);
        });
    }
}

pub struct Launch {
    pub url: String,
    pub title: String,
    pub vid: Option<String>,
    pub aid: Option<String>,
    pub sid: Option<String>,
    pub start: f64,
    pub extra_opts: String,
    pub wid: Option<isize>,
    pub sub_files: Vec<String>,
}

/// Starts mpv and returns at once. on_progress(pos_s) about every 10 s, on_stop(pos_s) on exit.
/// With wid mpv renders into that window (embedded), otherwise into its own.
pub fn launch(
    p: Launch,
    on_progress: impl Fn(f64) + Send + Sync + 'static,
    on_stop: impl FnOnce(f64) + Send + 'static,
    on_fullscreen: Option<Box<dyn Fn() + Send>>,
    on_quit: Option<Box<dyn Fn() + Send + Sync>>,
) -> Result<Arc<Player>, AppError> {
    let l = lib()?;
    let ctx = unsafe { (l.create)() };
    if ctx.is_null() {
        return Err(AppError::code("libmpv"));
    }
    let mut opts: Vec<(String, String)> = [
        ("input-default-bindings", "yes"), ("input-vo-keyboard", "yes"), ("osc", "yes"), ("ytdl", "no"),
        ("force-window", "yes"),
    ]
    .iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect();
    opts.push(("force-media-title".into(), p.title.clone()));
    if let Some(w) = p.wid {
        opts.push(("wid".into(), w.to_string()));
    }
    // With external subtitles the track is set only after loading (the number may point to an external one)
    let sid_now = if p.sub_files.is_empty() { p.sid.clone() } else { None };
    for (k, v) in [("vid", &p.vid), ("aid", &p.aid), ("sid", &sid_now)] {
        if let Some(v) = v {
            opts.push((k.into(), v.clone()));
        }
    }
    if p.start > 5.0 {
        opts.push(("start".into(), (p.start as i64).to_string()));
    }
    opts.extend(parse_opts(&p.extra_opts));
    unsafe {
        for (k, v) in &opts {
            (l.set_option_string)(ctx, cs(k).as_ptr(), cs(v).as_ptr()); // unknown user options are ignored, like before
        }
        if (l.initialize)(ctx) < 0 {
            (l.terminate_destroy)(ctx);
            return Err(AppError::code("libmpv"));
        }
        (l.observe_property)(ctx, 1, c"time-pos".as_ptr(), FMT_DOUBLE);
    }
    let embedded = p.wid.is_some();
    let player = Arc::new(Player { ctx: Mutex::new(ctx as usize), quitting: AtomicBool::new(false), on_quit });
    if embedded {
        // embedded there is no window X: Esc quits and returns to the library
        player.command(&["keybind", "ESC", "script-message unfold-back"]);
        if on_fullscreen.is_some() {
            unsafe { (l.observe_property)(ctx, 2, c"fullscreen".as_ptr(), FMT_FLAG) };
        }
    }
    player.command(&["loadfile", &p.url]);

    let pl = player.clone();
    let on_progress = Arc::new(on_progress);
    let ctx_n = ctx as usize; // raw pointers are not Send; libmpv handles may be used from any thread
    std::thread::spawn(move || {
        let ctx = ctx_n as Ctx;
        let (mut pos, mut last) = (0.0f64, Instant::now());
        loop {
            let ev = unsafe { &*(l.wait_event)(ctx, -1.0) };
            match ev.id {
                SHUTDOWN | END_FILE => break,
                FILE_LOADED => {
                    for u in &p.sub_files {
                        pl.command(&["sub-add", u, "auto"]); // they become tracks after the embedded ones, in this order
                    }
                    if let (false, Some(sid)) = (p.sub_files.is_empty(), &p.sid) {
                        unsafe { (l.set_property_string)(ctx, c"sid".as_ptr(), cs(sid).as_ptr()) };
                    }
                }
                CLIENT_MESSAGE => unsafe {
                    let m = &*(ev.data as *const ClientMessage);
                    if m.num_args > 0 && CStr::from_ptr(*m.args).to_bytes() == b"unfold-back" {
                        pl.back();
                    }
                },
                PROPERTY_CHANGE => unsafe {
                    let pr = &*(ev.data as *const EventProperty);
                    if pr.data.is_null() {
                        continue;
                    }
                    if ev.reply == 1 && pr.format == FMT_DOUBLE {
                        pos = *(pr.data as *const f64);
                        if last.elapsed().as_secs() >= 10 {
                            last = Instant::now();
                            let f = on_progress.clone();
                            std::thread::spawn(move || f(pos)); // do not block the mpv event thread (HTTP)
                        }
                    } else if ev.reply == 2 && pr.format == FMT_FLAG && *(pr.data as *const c_int) != 0 {
                        // Fullscreen (key f, OSC button, double click) would only affect the mpv child window:
                        // reset it at once and toggle the whole app window instead
                        (l.set_property_string)(ctx, c"fullscreen".as_ptr(), c"no".as_ptr());
                        if let Some(f) = &on_fullscreen {
                            f();
                        }
                    }
                },
                _ => {}
            }
        }
        *pl.ctx.lock().unwrap() = 0;
        unsafe { (l.terminate_destroy)(ctx) };
        on_stop(pos);
    });
    Ok(player)
}

#[cfg(test)]
mod tests {
    #[test]
    fn opts() {
        assert_eq!(super::parse_opts("hwdec=auto --sub-font-size=40 junk =x"),
            vec![("hwdec".into(), "auto".into()), ("sub-font-size".into(), "40".into())]);
    }
}
