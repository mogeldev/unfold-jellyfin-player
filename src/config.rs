//! Settings and tokens. Config file: %APPDATA%\unfold\config.json. Tokens go to the Windows Credential Manager,
//! in the same places Python's keyring used (service "unfold", user "user@server"), so 0.4 sign-ins carry over.
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::Mutex;
use windows_sys::Win32::Security::Credentials::*;

const SERVICE: &str = "unfold";
static LOCK: Mutex<()> = Mutex::new(()); // JS calls arrive on several threads

pub fn dir() -> PathBuf {
    let d = PathBuf::from(std::env::var_os("APPDATA").unwrap_or_else(|| ".".into())).join("unfold");
    let _ = std::fs::create_dir_all(&d);
    d
}

fn file() -> PathBuf {
    dir().join("config.json")
}

pub fn load() -> Value {
    match std::fs::read_to_string(file()) {
        Err(_) => json!({}),
        Ok(s) => match serde_json::from_str::<Value>(&s) {
            Ok(v) if v.is_object() => v,
            _ => {
                // broken file: keep it for inspection instead of overwriting it with an empty config
                let _ = std::fs::rename(file(), file().with_extension("json.bad"));
                json!({})
            }
        },
    }
}

/// Write to a temp file and swap it in, so a crash never leaves a half-written config.
pub fn save(cfg: &Value) -> Result<(), String> {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let tmp = file().with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(cfg).unwrap()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, file()).map_err(|e| e.to_string())
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}

/// (UserName, password) of a generic credential.
fn cred_read(target: &str) -> Option<(String, String)> {
    unsafe {
        let mut p: *mut CREDENTIALW = std::ptr::null_mut();
        if CredReadW(wide(target).as_ptr(), CRED_TYPE_GENERIC, 0, &mut p) == 0 {
            return None;
        }
        let c = &*p;
        let blob = std::slice::from_raw_parts(c.CredentialBlob as *const u16, c.CredentialBlobSize as usize / 2);
        let mut n = 0;
        while !c.UserName.is_null() && *c.UserName.add(n) != 0 {
            n += 1;
        }
        let user = String::from_utf16_lossy(std::slice::from_raw_parts(c.UserName, n));
        let pw = String::from_utf16_lossy(blob); // keyring stores the password as UTF-16LE
        CredFree(p as _);
        Some((user, pw))
    }
}

fn cred_write(target: &str, user: &str, pw: &str) -> bool {
    let (mut t, mut u) = (wide(target), wide(user));
    let mut blob: Vec<u16> = pw.encode_utf16().collect();
    let c = CREDENTIALW {
        Type: CRED_TYPE_GENERIC,
        TargetName: t.as_mut_ptr(),
        CredentialBlobSize: (blob.len() * 2) as u32,
        CredentialBlob: blob.as_mut_ptr() as *mut u8,
        Persist: CRED_PERSIST_ENTERPRISE,
        UserName: u.as_mut_ptr(),
        ..unsafe { std::mem::zeroed() }
    };
    unsafe { CredWriteW(&c, 0) != 0 }
}

fn key(acc: &Value) -> Option<String> {
    Some(format!("{}@{}", acc["user"].as_str()?, acc["server"].as_str()?))
}

/// Store the token in the Credential Manager; on error fall back to the config file.
pub fn set_token(acc: &mut Value, token: &str) {
    if let Some(k) = key(acc)
        && cred_write(&format!("{k}@{SERVICE}"), &k, token)
    {
        acc.as_object_mut().unwrap().remove("token");
        return;
    }
    acc["token"] = json!(token);
}

pub fn get_token(acc: &Value) -> Option<String> {
    if let Some(k) = key(acc) {
        // keyring keeps the newest entry under the bare service name and older ones under "<user>@<service>"
        if let Some((_, pw)) = cred_read(&format!("{k}@{SERVICE}")) {
            return Some(pw);
        }
        if let Some((_, pw)) = cred_read(SERVICE).filter(|(u, _)| *u == k) {
            return Some(pw);
        }
    }
    acc["token"].as_str().map(String::from)
}

pub fn clear_token(acc: &mut Value) {
    if let Some(k) = key(acc) {
        unsafe { CredDeleteW(wide(&format!("{k}@{SERVICE}")).as_ptr(), CRED_TYPE_GENERIC, 0) };
        if cred_read(SERVICE).is_some_and(|(u, _)| u == k) {
            unsafe { CredDeleteW(wide(SERVICE).as_ptr(), CRED_TYPE_GENERIC, 0) };
        }
    }
    if let Some(o) = acc.as_object_mut() {
        o.remove("token");
    }
}
