//! Unfold – Jellyfin Player: a WebView2 window with the frontend from web/. The frontend calls
//! window.pywebview.api.<method>(...) (the name stays from the Python version and is shared with Android);
//! here that is a JS shim that posts {id, m, a} over IPC, every answer is {ok, data} or {ok: false, code|error}.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod config;
mod jellyfin;
mod mpv;
mod win;

use jellyfin::{AppError, Jellyfin, Res, TICKS, external_subs, minutes, normalize, streams, text};
use serde_json::{Value, json};
use std::borrow::Cow;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;
use tao::dpi::LogicalSize;
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy};
use tao::platform::windows::{IconExtWindows, WindowExtWindows};
use tao::window::{Fullscreen, Icon, WindowBuilder};
use wry::http::{Request, Response};
use wry::{WebContext, WebViewBuilder, WebViewExtWindows};

const TITLE: &str = "Unfold – Jellyfin Player";
const METHODS: &[&str] = &[
    "state", "set_lang", "login", "switch_account", "logout", "save_settings", "set_chrome", "toggle_fullscreen",
    "snapshot", "fit_window", "libraries", "items", "search", "detail", "tracks", "play",
];

enum Ev {
    Eval(String),
    ToggleFs,
    Snapshot(mpsc::Sender<Option<String>>), // image of the page (WebView2 renders it, UI thread only)
    ShowWeb(bool), // WebView2 is composited above the GDI-painted player panel: hide it while the panel is up
}

struct App {
    cfg: Mutex<Value>,
    jf: Mutex<Option<Jellyfin>>,
    fs: AtomicBool,                // fullscreen on/off
    bg: Mutex<Option<String>>,     // theme colour of the title bar
    playing: AtomicBool,           // one player at a time (e.g. Enter pressed twice while mpv starts)
    hwnd: isize,
    proxy: Mutex<EventLoopProxy<Ev>>,
    waiters: Mutex<HashMap<u64, mpsc::Sender<()>>>,
    next: AtomicU64,
}

fn arg_s(a: &[Value], i: usize) -> String {
    match a.get(i) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => String::new(),
        Some(v) => v.to_string(),
    }
}
fn arg_i(a: &[Value], i: usize) -> i64 {
    a.get(i).and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)).or_else(|| v.as_str()?.parse().ok())).unwrap_or(0)
}
fn seen(d: &Value) -> bool {
    d["UserData"]["Played"] == true
}
fn summary(i: &Value) -> Value {
    json!({"id": i["Id"], "name": i["Name"], "year": i.get("ProductionYear").cloned().unwrap_or(json!("")),
        "type": if i["Type"] == "Series" { "series" } else { "movie" }, "seen": seen(i)})
}

impl App {
    fn send(&self, ev: Ev) {
        let _ = self.proxy.lock().unwrap().send_event(ev);
    }
    fn eval(&self, js: String) {
        self.send(Ev::Eval(js));
    }

    /// Runs `promise_js` in the page and waits until the promise settles (max `timeout`).
    fn eval_wait(&self, promise_js: &str, timeout: Duration) {
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = mpsc::channel();
        self.waiters.lock().unwrap().insert(id, tx);
        self.eval(format!("window.__unfoldWait({id}, {promise_js})"));
        let _ = rx.recv_timeout(timeout);
        self.waiters.lock().unwrap().remove(&id);
    }

    /// Activate account i. Without a valid account or token jf stays empty (the frontend then shows the login).
    /// Every account has its own device_id so sign-ins on the same server do not sign each other out.
    fn connect(&self, cfg: &mut Value, i: i64) {
        let mut jf = self.jf.lock().unwrap();
        *jf = None;
        let Some(a) = cfg["accounts"].as_array().and_then(|v| v.get(usize::try_from(i).ok()?)).cloned() else { return };
        cfg["active"] = json!(i);
        cfg["server"] = a["server"].clone();
        cfg["user"] = a["user"].clone();
        if let Some(t) = config::get_token(&a) {
            *jf = Jellyfin::new(a["server"].as_str().unwrap_or(""), a["device_id"].as_str().unwrap_or(""), Some(t),
                a["user_id"].as_str().unwrap_or("")).ok();
        }
    }

    fn need(&self) -> Res<Jellyfin> {
        self.jf.lock().unwrap().clone().ok_or(AppError::code("not_logged_in"))
    }

    fn save(&self, cfg: &Value) -> Res<()> {
        config::save(cfg).map_err(AppError::Other)
    }

    fn call(self: &Arc<Self>, m: &str, a: &[Value]) -> Res<Value> {
        Ok(match m {
            "state" => {
                let logged_in = self.jf.lock().unwrap().is_some();
                let c = self.cfg.lock().unwrap();
                let accounts: Vec<String> = c["accounts"].as_array().into_iter().flatten()
                    .map(|x| format!("{} @ {}", x["user"].as_str().unwrap_or(""), x["server"].as_str().unwrap_or(""))).collect();
                json!({"logged_in": logged_in, "server": c.get("server").cloned().unwrap_or(json!("")),
                    "user": c.get("user").cloned().unwrap_or(json!("")), "mpv_opts": c.get("mpv_opts").cloned().unwrap_or(json!("")),
                    "embed": c.get("embed").cloned().unwrap_or(json!(true)), "can_embed": true,
                    "lang": c.get("lang").cloned().unwrap_or(json!("")), "active": c.get("active").cloned().unwrap_or(json!(0)),
                    "accounts": accounts})
            }
            "set_lang" => {
                let mut c = self.cfg.lock().unwrap();
                c["lang"] = json!(arg_s(a, 0).chars().take(16).collect::<String>());
                self.save(&c)?;
                Value::Null
            }
            "login" => {
                // Sign in a new account and activate it; the same account (server + user) is only updated
                let (server, user, pw) = (normalize(&arg_s(a, 0))?, arg_s(a, 1), arg_s(a, 2));
                let (i, device_id) = {
                    let c = self.cfg.lock().unwrap();
                    let accs = c["accounts"].as_array().cloned().unwrap_or_default();
                    // Jellyfin user names ignore case
                    match accs.iter().position(|x| x["server"] == server.as_str() && x["user"].as_str().unwrap_or("").to_lowercase() == user.to_lowercase()) {
                        Some(i) => (i, accs[i]["device_id"].as_str().unwrap_or("").to_string()),
                        None => (accs.len(), uuid::Uuid::new_v4().simple().to_string()),
                    }
                };
                let mut jf = Jellyfin::new(&server, &device_id, None, "")?;
                jf.login(&user, &pw)?;
                let mut acc = json!({"server": jf.server, "user": user, "user_id": jf.user_id, "device_id": jf.device_id});
                config::set_token(&mut acc, jf.token.as_deref().unwrap_or(""));
                let mut c = self.cfg.lock().unwrap();
                let accs = c["accounts"].as_array_mut().unwrap();
                if i < accs.len() { accs[i] = acc } else { accs.push(acc) }
                self.connect(&mut c, i as i64);
                self.save(&c)?;
                Value::Null
            }
            "switch_account" => {
                let mut c = self.cfg.lock().unwrap();
                self.connect(&mut c, arg_i(a, 0));
                self.save(&c)?;
                Value::Null
            }
            "logout" => {
                // Sign out and remove the active account; a remaining one becomes active
                if let Some(jf) = self.jf.lock().unwrap().clone() {
                    jf.logout();
                }
                let mut c = self.cfg.lock().unwrap();
                let i = c["active"].as_i64().unwrap_or(0);
                let accs = c["accounts"].as_array_mut().unwrap();
                if (0..accs.len() as i64).contains(&i) {
                    config::clear_token(&mut accs.remove(i as usize));
                }
                self.connect(&mut c, 0);
                self.save(&c)?;
                Value::Null
            }
            "save_settings" => {
                let s = a.first().cloned().unwrap_or(json!({}));
                let mut c = self.cfg.lock().unwrap();
                c["mpv_opts"] = json!(s["mpv_opts"].as_str().unwrap_or("").trim());
                c["embed"] = json!(s["embed"].as_bool().unwrap_or(true));
                self.save(&c)?;
                Value::Null
            }
            "set_chrome" => {
                // Title bar and border in the theme background colour
                let bg = arg_s(a, 0);
                win::set_chrome(self.hwnd, &bg, &bg);
                if self.fs.load(Ordering::SeqCst) {
                    win::set_fullscreen_frame(self.hwnd, true, None); // theme change while fullscreen: keep the border off
                }
                *self.bg.lock().unwrap() = Some(bg);
                Value::Null
            }
            "toggle_fullscreen" => {
                self.send(Ev::ToggleFs);
                Value::Null
            }
            "snapshot" => {
                // image of the UI for the page turn
                let (tx, rx) = mpsc::channel();
                self.send(Ev::Snapshot(tx));
                json!(rx.recv_timeout(Duration::from_secs(3)).ok().flatten())
            }
            "fit_window" => {
                let (hwnd, px) = (self.hwnd, arg_i(a, 0) as i32);
                std::thread::spawn(move || win::fit_width(hwnd, px)); // the animation runs in the background
                Value::Null
            }
            "libraries" => json!(self.need()?.libraries()?.iter()
                .filter(|v| matches!(v["CollectionType"].as_str(), Some("movies" | "tvshows" | "homevideos") | None))
                .map(|v| json!({"id": v["Id"], "name": v["Name"]})).collect::<Vec<_>>()),
            "items" => json!(self.need()?.items(&arg_s(a, 0))?.iter().map(summary).collect::<Vec<_>>()),
            "search" => {
                // across all libraries (movies and series), sorted by relevance on the server
                let term = arg_s(a, 0).trim().to_string();
                if term.is_empty() { json!([]) } else { json!(self.need()?.search(&term)?.iter().map(summary).collect::<Vec<_>>()) }
            }
            "detail" => self.detail(&arg_s(a, 0))?,
            "tracks" => streams(&self.need()?.detail(&arg_s(a, 0))?).0, // one episode's tracks, loaded when it is selected
            "play" => {
                if self.playing.swap(true, Ordering::SeqCst) {
                    return Ok(json!({})); // already playing or starting: ignore
                }
                // the lock is released when mpv stops, or here if starting fails
                self.play(&arg_s(a, 0), arg_i(a, 1), arg_i(a, 2), arg_i(a, 3), a.get(4).cloned().unwrap_or(Value::Null))
                    .inspect_err(|_| self.playing.store(false, Ordering::SeqCst))?
            }
            _ => return Err(AppError::Other(format!("AttributeError: no method {m}"))),
        })
    }

    fn detail(&self, id: &str) -> Res<Value> {
        let jf = self.need()?;
        let d = jf.detail(id)?;
        let mut base = json!({"id": d["Id"], "name": d["Name"], "year": d.get("ProductionYear").cloned().unwrap_or(json!("")),
            "ov": text(d["Overview"].as_str().unwrap_or("")), "poster": jf.poster_url(&d), "seen": seen(&d), "min": minutes(&d)});
        if d["Type"] != "Series" {
            base["type"] = json!("movie");
            base["st"] = streams(&d).0;
            return Ok(base);
        }
        let mut seasons: std::collections::BTreeMap<i64, Vec<Value>> = Default::default();
        for e in jf.episodes(id)? {
            seasons.entry(e["ParentIndexNumber"].as_i64().unwrap_or(0)).or_default().push(json!({
                "id": e["Id"], "n": e["IndexNumber"].as_i64().unwrap_or(0), "t": e["Name"], "min": minutes(&e), "seen": seen(&e)}));
        }
        base["type"] = json!("series");
        base["seasons"] = json!(seasons.into_iter().map(|(n, mut eps)| {
            eps.sort_by_key(|x| x["n"].as_i64());
            json!({"n": n, "eps": eps})
        }).collect::<Vec<_>>());
        Ok(base)
    }

    fn play(self: &Arc<Self>, item_id: &str, v: i64, a: i64, s: i64, colors: Value) -> Res<Value> {
        let jf = self.need()?;
        let dto = jf.detail(item_id)?;
        let (st, ms_id) = streams(&dto);
        let psid = jf.playback_info(item_id)?["PlaySessionId"].as_str().unwrap_or("").to_string();
        let url = jf.stream_url(item_id, &ms_id, &psid);
        let resume = dto["UserData"]["PlaybackPositionTicks"].as_f64().unwrap_or(0.0) / TICKS;
        let runtime = dto["RunTimeTicks"].as_i64();
        // mpv counts per track type from 1, in the same order as Jellyfin
        let n = |k: &str| st[k].as_array().map_or(0, |x| x.len()) as i64;
        let vid = (n("v") > 0).then(|| (v + 1).to_string());
        let aid = (n("a") > 0).then(|| (a + 1).to_string());
        let sid = (n("s") > 1).then(|| if s == n("s") - 1 { "no".to_string() } else { (s + 1).to_string() });
        // External text subtitles come after the embedded ones and are loaded from the server by mpv
        let sub_files = external_subs(&dto).iter().map(|(i, f)| jf.subtitle_url(item_id, &ms_id, *i, f)).collect();
        let mut title = dto["Name"].as_str().unwrap_or("").to_string();
        if dto["Type"] == "Episode" {
            title = format!("{} S{}E{} {title}", dto["SeriesName"].as_str().unwrap_or(""),
                dto["ParentIndexNumber"].as_i64().unwrap_or(0), dto["IndexNumber"].as_i64().unwrap_or(0));
        }

        let slot: Arc<Mutex<Option<Arc<mpv::Player>>>> = Default::default();
        let frame: Arc<Mutex<Option<String>>> = Default::default();
        // Embedded (default); otherwise mpv plays in its own window
        let embed = self.cfg.lock().unwrap()["embed"].as_bool().unwrap_or(true);
        let wid = embed.then(|| {
            let (slot_back, slot_key) = (slot.clone(), slot.clone());
            // if the app is already fullscreen, the video starts fullscreen too (bar hidden)
            win::embed_show(colors["bg"].as_str(), colors["fg"].as_str(), colors["back"].as_str(), !self.fs.load(Ordering::SeqCst),
                Arc::new(move || if let Some(p) = slot_back.lock().unwrap().clone() { p.back() }),
                Arc::new(move |key: &str| if let Some(p) = slot_key.lock().unwrap().clone() { p.command(&["keypress", key]) }))
        }).flatten();
        if wid.is_some() {
            self.send(Ev::ShowWeb(false));
        }

        // Keep the video frame for the page turn back; after mpv quits the window would be black, so grab it before
        let grab = {
            let (app, frame, slot) = (self.clone(), frame.clone(), slot.clone());
            Arc::new(move || {
                let player = slot.lock().unwrap().clone();
                if let Some((w, h, stride, px)) = player.and_then(|p| p.screenshot())
                    && let Some(img) = win::frame_jpeg(app.hwnd, w, h, stride, &px)
                {
                    *frame.lock().unwrap() = Some(img);
                }
            })
        };
        // Back/Esc: grab the current frame and wait until the frontend has put it on the page (max 2 s);
        // only then mpv quits, so the page turn back starts with the frame already in place
        let before_quit = {
            let (app, frame, grab) = (self.clone(), frame.clone(), grab.clone());
            move || {
                grab();
                if let Some(img) = frame.lock().unwrap().clone() {
                    app.eval_wait(&format!("window.prepareBack({})", json!(img)), Duration::from_secs(2));
                }
            }
        };
        let progress = {
            let (jf, id, ms, ps, grab) = (jf.clone(), item_id.to_string(), ms_id.clone(), psid.clone(), grab.clone());
            move |pos: f64| {
                if runtime.is_some_and(|r| pos > r as f64 / TICKS - 20.0) {
                    grab(); // fallback when mpv ends by itself (end of file): only needed near the end
                }
                jf.report("Progress", &id, &ms, &ps, pos, runtime);
            }
        };
        let stopped = {
            let (app, jf, id, ms, ps, frame) = (self.clone(), jf.clone(), item_id.to_string(), ms_id.clone(), psid.clone(), frame.clone());
            move |pos: f64| {
                if wid.is_some() {
                    win::embed_hide(); // fullscreen stays as it currently is
                    app.send(Ev::ShowWeb(true));
                }
                app.playing.store(false, Ordering::SeqCst);
                jf.report("Stopped", &id, &ms, &ps, pos, runtime);
                let img = frame.lock().unwrap().clone();
                app.eval(format!("window.onPlaybackEnded && window.onPlaybackEnded({}, {})", json!(img), app.fs.load(Ordering::SeqCst)));
            }
        };
        let on_fs: Option<Box<dyn Fn() + Send>> = wid.map(|_| {
            let app = self.clone();
            Box::new(move || app.send(Ev::ToggleFs)) as Box<dyn Fn() + Send>
        });
        let launch = mpv::Launch {
            url, title, vid, aid, sid, start: resume, wid, sub_files,
            extra_opts: self.cfg.lock().unwrap()["mpv_opts"].as_str().unwrap_or("").to_string(),
        };
        let player = mpv::launch(launch, progress, stopped, on_fs, wid.map(|_| Box::new(before_quit) as Box<dyn Fn() + Send + Sync>))
            .inspect_err(|_| if wid.is_some() {
                win::embed_hide();
                self.send(Ev::ShowWeb(true));
            })?;
        if let Some(w) = wid {
            *slot.lock().unwrap() = Some(player);
            std::thread::spawn(move || win::enable_input(w));
        }
        jf.report("", item_id, &ms_id, &psid, resume, runtime); // only once mpv runs, else the server keeps a ghost session
        Ok(json!({}))
    }
}

fn rpc(r: Res<Value>) -> Value {
    match r {
        Ok(d) => json!({"ok": true, "data": d}),
        Err(AppError::Code(c, p)) => json!({"ok": false, "code": c, "params": p, "error": c}),
        Err(AppError::Other(e)) => json!({"ok": false, "error": e}),
    }
}

/// web/ next to the exe (installed), else the first web/ above it (cargo run from the repository).
fn web_dir() -> PathBuf {
    let exe = std::env::current_exe().unwrap_or_default();
    exe.ancestors().skip(1).map(|d| d.join("web")).find(|d| d.join("index.html").is_file()).unwrap_or_else(|| "web".into())
}

fn serve(root: &std::path::Path, req: Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let path = req.uri().path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    let mime = match path.rsplit('.').next() {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        _ => "application/octet-stream",
    };
    let body = (!path.split('/').any(|p| p == ".." || p.contains('\\'))).then(|| std::fs::read(root.join(path)).ok()).flatten();
    match body {
        Some(b) => Response::builder().header("Content-Type", mime).body(Cow::Owned(b)).unwrap(),
        None => Response::builder().status(404).body(Cow::Borrowed(&[][..])).unwrap(),
    }
}

fn main() {
    let event_loop = EventLoopBuilder::<Ev>::with_user_event().build();
    let window = WindowBuilder::new()
        .with_title(TITLE)
        .with_inner_size(LogicalSize::new(420.0, 780.0))
        .with_min_inner_size(LogicalSize::new(360.0, 480.0))
        .with_window_icon(Icon::from_resource(1, None).ok())
        .build(&event_loop)
        .expect("window");
    let hwnd = window.hwnd();
    win::embed_init(hwnd);

    let mut cfg = config::load();
    if !cfg["accounts"].is_array() {
        cfg["accounts"] = json!([]);
    }
    // config from before 0.2 (one account): convert it once
    if cfg["accounts"].as_array().unwrap().is_empty() && cfg["user_id"].is_string() {
        let o = cfg.as_object_mut().unwrap();
        let mut old = json!({"device_id": uuid::Uuid::new_v4().simple().to_string()});
        for k in ["server", "user", "user_id", "device_id", "token"] {
            if let Some(v) = o.remove(k) {
                old[k] = v;
            }
        }
        cfg["accounts"] = json!([old]);
        let _ = config::save(&cfg);
    }
    let app = Arc::new(App {
        cfg: Mutex::new(json!({})), jf: Mutex::new(None), fs: AtomicBool::new(false), bg: Mutex::new(None),
        playing: AtomicBool::new(false), hwnd, proxy: Mutex::new(event_loop.create_proxy()),
        waiters: Mutex::new(HashMap::new()), next: AtomicU64::new(1),
    });
    let active = cfg["active"].as_i64().unwrap_or(0);
    app.connect(&mut cfg, active);
    *app.cfg.lock().unwrap() = cfg;

    let shim = format!(r#"(() => {{
  const pending = {{}}; let n = 0;
  window.__unfoldResolve = (id, r) => {{ const p = pending[id]; delete pending[id]; if (p) p(r); }};
  window.__unfoldWait = (id, p) => Promise.resolve(p).catch(() => {{}}).finally(() => window.ipc.postMessage(JSON.stringify({{ done: id }})));
  const api = {{}};
  for (const m of {methods}) api[m] = (...a) => new Promise(res => {{ const id = ++n; pending[id] = res; window.ipc.postMessage(JSON.stringify({{ id, m, a }})); }});
  window.pywebview = {{ api }};
}})();"#, methods = json!(METHODS));

    let root = web_dir();
    let data = std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("unfold").join("WebView2"));
    let mut ctx = WebContext::new(data);
    let ipc_app = app.clone();
    let webview = WebViewBuilder::new_with_web_context(&mut ctx)
        .with_background_color((11, 15, 11, 255))
        .with_devtools(std::env::var_os("JF_DEBUG").is_some())
        .with_initialization_script(shim)
        .with_custom_protocol("unfold".into(), move |_id, req| serve(&root, req))
        .with_ipc_handler(move |req| {
            let Ok(msg) = serde_json::from_str::<Value>(req.body()) else { return };
            if let Some(done) = msg["done"].as_u64() {
                if let Some(tx) = ipc_app.waiters.lock().unwrap().remove(&done) {
                    let _ = tx.send(());
                }
                return;
            }
            let app = ipc_app.clone();
            std::thread::spawn(move || {
                let (id, m) = (msg["id"].as_u64().unwrap_or(0), msg["m"].as_str().unwrap_or(""));
                let a = msg["a"].as_array().cloned().unwrap_or_default();
                // errors end up in the UI, never close the window
                let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| app.call(m, &a)))
                    .unwrap_or_else(|_| Err(AppError::Other(format!("panic in {m}"))));
                app.eval(format!("window.__unfoldResolve({id}, {})", rpc(r)));
            });
        })
        .with_url("http://unfold.localhost/index.html")
        .build(&window)
        .expect("webview");

    event_loop.run(move |event, _, flow| {
        *flow = ControlFlow::Wait;
        match event {
            Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => *flow = ControlFlow::Exit,
            Event::WindowEvent { event: WindowEvent::Resized(_), .. } => win::embed_layout(),
            Event::UserEvent(Ev::Eval(js)) => {
                let _ = webview.evaluate_script(&js);
            }
            Event::UserEvent(Ev::Snapshot(tx)) => win::capture_page(&webview.controller(), tx),
            Event::UserEvent(Ev::ShowWeb(on)) => {
                let _ = webview.set_visible(on);
                // the hidden page would keep the keyboard focus: the player panel takes it (keys go on to mpv), or give it back
                if on { let _ = webview.focus(); } else { win::embed_focus(); }
            }
            Event::UserEvent(Ev::ToggleFs) => {
                // fullscreen of the app window (library and playback); the bar of the embedded player follows it
                let on = !app.fs.load(Ordering::SeqCst);
                window.set_fullscreen(on.then_some(Fullscreen::Borderless(None)));
                app.fs.store(on, Ordering::SeqCst);
                win::set_fullscreen_frame(hwnd, on, app.bg.lock().unwrap().as_deref());
                win::embed_set_bar(!on);
                if !on {
                    // width is not adjusted while fullscreen: refit to the columns after leaving it
                    let a = app.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_millis(600));
                        a.eval("window.refit && window.refit()".into());
                    });
                }
            }
            _ => {}
        }
    });
}
