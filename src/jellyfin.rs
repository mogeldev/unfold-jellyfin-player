//! Minimal Jellyfin client. Auth header and playback reports modelled on JellyCon.
use serde_json::{Value, json};
use std::time::Duration;

pub const TICKS: f64 = 10_000_000.0; // Jellyfin ticks per second
const CLIENT: &str = "Unfold";
pub const VERSION: &str = "0.5";

/// Errors carry a code instead of text: the frontend translates it ('err_<code>' in web/locales/*.js).
#[derive(Debug)]
pub enum AppError {
    Code(&'static str, Value),
    Other(String),
}
pub type Res<T> = Result<T, AppError>;

impl AppError {
    pub fn code(c: &'static str) -> Self {
        AppError::Code(c, json!({}))
    }
}
impl From<String> for AppError {
    fn from(s: String) -> Self {
        AppError::Other(s)
    }
}

pub fn normalize(server: &str) -> Res<String> {
    let s = server.trim().trim_end_matches('/');
    if s.is_empty() {
        return Err(AppError::code("no_server"));
    }
    Ok(if s.contains("://") { s.to_string() } else { format!("http://{s}") })
}

/// Percent-encoding for query values (everything except unreserved characters).
pub fn enc(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn query(params: &[(&str, &str)]) -> String {
    params.iter().map(|(k, v)| format!("{k}={}", enc(v))).collect::<Vec<_>>().join("&")
}

#[derive(Clone)]
pub struct Jellyfin {
    pub server: String,
    pub device_id: String,
    pub token: Option<String>,
    pub user_id: String,
    agent: ureq::Agent,
}

impl Jellyfin {
    pub fn new(server: &str, device_id: &str, token: Option<String>, user_id: &str) -> Res<Self> {
        let agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(15)))
            .http_status_as_error(false)
            // native-tls = Windows certificate store, like urllib did (self-signed CAs installed by the user work)
            .tls_config(ureq::tls::TlsConfig::builder().provider(ureq::tls::TlsProvider::NativeTls).build())
            .build()
            .new_agent();
        Ok(Self { server: normalize(server)?, device_id: device_id.into(), token, user_id: user_id.into(), agent })
    }

    fn auth(&self) -> String {
        let h = format!(r#"MediaBrowser Client="{CLIENT}", Device="Desktop", DeviceId="{}", Version="{VERSION}""#, self.device_id);
        match &self.token {
            Some(t) => format!(r#"{h}, Token="{t}""#),
            None => h,
        }
    }

    fn req(&self, method: &str, path: &str, params: &[(&str, &str)], body: Option<Value>) -> Res<Value> {
        let mut url = format!("{}{path}", self.server);
        if !params.is_empty() {
            url = format!("{url}?{}", query(params));
        }
        let data = body.map(|b| b.to_string().into_bytes()).unwrap_or_default();
        let req = ureq::http::Request::builder()
            .method(method)
            .uri(&url)
            .header("Authorization", self.auth())
            .header("Content-Type", "application/json")
            .header("Accept", "application/json")
            .body(data)
            .map_err(|e| AppError::Other(e.to_string()))?;
        let mut r = self.agent.run(req).map_err(|e| AppError::Code("unreachable", json!({"reason": e.to_string()})))?;
        let status = r.status().as_u16();
        if status == 401 {
            return Err(AppError::code("auth"));
        }
        if status >= 400 {
            return Err(AppError::Code("server_error", json!({"code": status})));
        }
        let raw = r
            .body_mut()
            .with_config()
            .limit(256 * 1024 * 1024) // big libraries: the default 10 MB limit is too small
            .read_to_string()
            .map_err(|e| AppError::Code("unreachable", json!({"reason": e.to_string()})))?;
        if raw.is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(&raw).map_err(|e| AppError::Other(format!("JSONDecodeError: {e}")))
    }

    fn items_of(v: Value) -> Vec<Value> {
        match v.get("Items") {
            Some(Value::Array(a)) => a.clone(),
            _ => vec![],
        }
    }

    // ---- Account ----
    pub fn login(&mut self, user: &str, password: &str) -> Res<()> {
        let r = self.req("POST", "/Users/AuthenticateByName", &[], Some(json!({"Username": user, "Pw": password})))?;
        self.token = r["AccessToken"].as_str().map(String::from);
        self.user_id = r["User"]["Id"].as_str().unwrap_or_default().to_string();
        Ok(())
    }

    pub fn logout(&self) {
        let _ = self.req("POST", "/Sessions/Logout", &[], None);
    }

    // ---- Library ----
    pub fn libraries(&self) -> Res<Vec<Value>> {
        Ok(Self::items_of(self.req("GET", "/UserViews", &[("userId", &self.user_id)], None)?))
    }

    pub fn items(&self, parent_id: &str) -> Res<Vec<Value>> {
        Ok(Self::items_of(self.req("GET", "/Items", &[
            ("userId", &self.user_id), ("ParentId", parent_id), ("Recursive", "true"),
            ("IncludeItemTypes", "Movie,Series"), ("SortBy", "SortName"), ("SortOrder", "Ascending"),
            ("Fields", "ProductionYear")], None)?))
    }

    pub fn search(&self, term: &str) -> Res<Vec<Value>> {
        Ok(Self::items_of(self.req("GET", "/Items", &[
            ("userId", &self.user_id), ("searchTerm", term), ("Recursive", "true"),
            ("IncludeItemTypes", "Movie,Series"), ("Limit", "100"), ("Fields", "ProductionYear")], None)?))
    }

    pub fn detail(&self, item_id: &str) -> Res<Value> {
        self.req("GET", &format!("/Users/{}/Items/{}", self.user_id, enc(item_id)), &[], None)
    }

    pub fn episodes(&self, series_id: &str) -> Res<Vec<Value>> {
        Ok(Self::items_of(self.req("GET", &format!("/Shows/{}/Episodes", enc(series_id)), &[
            ("userId", &self.user_id), ("IsMissing", "false"), ("IsVirtualUnAired", "false")], None)?))
    }

    pub fn poster_url(&self, item: &Value) -> Option<String> {
        let tag = item["ImageTags"]["Primary"].as_str()?;
        Some(format!("{}/Items/{}/Images/Primary?maxHeight=500&tag={tag}&api_key={}",
            self.server, item["Id"].as_str()?, self.token.as_deref().unwrap_or("")))
    }

    // ---- Playback ----
    /// PlaySessionId and MediaSources (direct play is allowed, mpv plays almost anything).
    pub fn playback_info(&self, item_id: &str) -> Res<Value> {
        self.req("POST", &format!("/Items/{}/PlaybackInfo", enc(item_id)), &[("UserId", &self.user_id)],
            Some(json!({"UserId": self.user_id})))
    }

    pub fn stream_url(&self, item_id: &str, ms_id: &str, psid: &str) -> String {
        format!("{}/Videos/{}/stream?{}", self.server, enc(item_id), query(&[
            ("static", "true"), ("MediaSourceId", ms_id), ("PlaySessionId", psid),
            ("DeviceId", &self.device_id), ("api_key", self.token.as_deref().unwrap_or(""))]))
    }

    pub fn subtitle_url(&self, item_id: &str, ms_id: &str, index: i64, fmt: &str) -> String {
        format!("{}/Videos/{}/{}/Subtitles/{index}/Stream.{fmt}?api_key={}",
            self.server, enc(item_id), enc(ms_id), self.token.as_deref().unwrap_or(""))
    }

    /// kind: "" (start), "Progress" or "Stopped". Reporting must never disturb playback, so errors are dropped.
    pub fn report(&self, kind: &str, item_id: &str, ms_id: &str, psid: &str, pos_s: f64, runtime: Option<i64>) {
        let mut body = json!({"ItemId": item_id, "MediaSourceId": ms_id, "PlaySessionId": psid,
            "PositionTicks": (pos_s * TICKS) as i64, "PlayMethod": "DirectStream", "CanSeek": true, "IsPaused": false});
        if let Some(rt) = runtime.filter(|r| *r > 0) {
            body["RunTimeTicks"] = json!(rt);
        }
        let path = if kind.is_empty() { "/Sessions/Playing".to_string() } else { format!("/Sessions/Playing/{kind}") };
        let _ = self.req("POST", &path, &[], Some(body));
    }
}

// External subtitles: text only (the server can convert them); codec -> format of the stream URL
fn sub_format(s: &Value) -> Option<&'static str> {
    match s["Codec"].as_str().unwrap_or("").to_lowercase().as_str() {
        "srt" | "subrip" => Some("srt"),
        "ass" | "ssa" => Some("ass"),
        "vtt" | "webvtt" => Some("vtt"),
        _ => None,
    }
}

fn media_streams(dto: &Value) -> Vec<Value> {
    let src = &dto["MediaSources"][0]["MediaStreams"];
    let s = if src.is_array() { src } else { &dto["MediaStreams"] };
    s.as_array().cloned().unwrap_or_default()
}

/// External text subtitles in order: (Jellyfin stream index, "srt"|"ass"|"vtt").
pub fn external_subs(dto: &Value) -> Vec<(i64, &'static str)> {
    media_streams(dto)
        .iter()
        .filter(|s| s["Type"] == "Subtitle" && s["IsExternal"] == true)
        .filter_map(|s| Some((s["Index"].as_i64()?, sub_format(s)?)))
        .collect()
}

/// Track names per type and the MediaSourceId. Subtitles: embedded ones first (mpv order), then the
/// external ones (loaded by mpv afterwards); "Off" is always the last subtitle entry.
pub fn streams(dto: &Value) -> (Value, String) {
    let (mut v, mut a, mut s, mut ext) = (vec![], vec![], vec![], vec![]);
    for st in media_streams(dto) {
        let name = ["DisplayTitle", "Title", "Language"]
            .iter()
            .find_map(|k| st[*k].as_str().filter(|x| !x.is_empty()))
            .unwrap_or("?")
            .to_string();
        match st["Type"].as_str() {
            Some("Video") => v.push(name),
            Some("Audio") => a.push(name),
            Some("Subtitle") if st["IsExternal"] != true => s.push(name),
            Some("Subtitle") if sub_format(&st).is_some() => ext.push(name), // same selection and order as external_subs()
            _ => {}
        }
    }
    s.extend(ext);
    s.push("Off".into()); // the frontend shows its own translation (subs_off)
    let ms_id = dto["MediaSources"][0]["Id"].as_str().or(dto["Id"].as_str()).unwrap_or_default().to_string();
    (json!({"v": v, "a": a, "s": s}), ms_id)
}

pub fn minutes(dto: &Value) -> i64 {
    (dto["RunTimeTicks"].as_f64().unwrap_or(0.0) / TICKS / 60.0).round() as i64
}

/// Jellyfin descriptions often contain HTML (<br>, <i> …): plain text with line breaks.
pub fn text(s: &str) -> String {
    let (mut out, mut rest) = (String::new(), s);
    while let Some(i) = rest.find('<') {
        out.push_str(&rest[..i]);
        let Some(j) = rest[i..].find('>') else {
            rest = &rest[i..];
            break;
        };
        let tag = rest[i + 1..i + j].trim().to_lowercase();
        if tag == "br" || tag.starts_with("br ") || tag.starts_with("br/") {
            out.push('\n');
        }
        rest = &rest[i + j + 1..];
    }
    out.push_str(rest);
    html_escape::decode_html_entities(&out).trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helpers() {
        assert_eq!(text("a<br>b <i>c</i> &amp; d<BR/>"), "a\nb c & d");
        assert_eq!(normalize(" host:8096/ ").unwrap(), "http://host:8096");
        assert!(normalize("  ").is_err());
        assert_eq!(enc("a b/ä"), "a%20b%2F%C3%A4");
        let dto = json!({"Id": "x", "MediaSources": [{"Id": "m", "MediaStreams": [
            {"Type": "Video", "DisplayTitle": "1080p"},
            {"Type": "Subtitle", "IsExternal": true, "Codec": "subrip", "Index": 5, "Language": "de"},
            {"Type": "Subtitle", "IsExternal": true, "Codec": "pgssub", "Index": 6},
            {"Type": "Subtitle", "Title": "en"}]}]});
        let (st, ms) = streams(&dto);
        assert_eq!(ms, "m");
        assert_eq!(st, json!({"v": ["1080p"], "a": [], "s": ["en", "de", "Off"]}));
        assert_eq!(external_subs(&dto), vec![(5, "srt")]);
    }
}
