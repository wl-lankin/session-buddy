//! Installing session-buddy into ~/.claude/settings.json (preview, then write),
//! and keeping the relay binary in its fixed place.

use std::path::PathBuf;

use sb_core::claude_settings as cs;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::log;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallStatus {
    pub hooks_installed: bool,
    pub status_line_installed: bool,
    pub settings_path: String,
    pub relay_path: String,
    pub relay_ready: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallPreview {
    pub diff: String,
    pub settings_path: String,
    pub fingerprint: String,
}

fn settings_path() -> PathBuf {
    sb_common::claude_dir().join("settings.json")
}

fn relay_str() -> String {
    sb_common::relay_path().to_string_lossy().replace('\\', "/")
}

fn state_path() -> PathBuf {
    sb_common::config_dir().join("install.json")
}

fn saved_status_line() -> Option<Value> {
    let bytes = std::fs::read(state_path()).ok()?;
    let v: Value = serde_json::from_slice(&bytes).ok()?;
    v.get("savedStatusLine").filter(|x| !x.is_null()).cloned()
}

fn store_saved_status_line(v: Option<&Value>) -> Result<(), String> {
    let path = state_path();
    std::fs::create_dir_all(sb_common::config_dir())
        .and_then(|_| std::fs::write(&path, json!({"savedStatusLine": v}).to_string()))
        .map_err(|e| format!("cannot write {}: {e}", path.display()))
}

/// Installing points Claude Code at the relay, so it has to be in place first.
fn require_relay(install: bool) -> Result<(), String> {
    let relay = sb_common::relay_path();
    if install && !relay.is_file() {
        return Err(format!("The relay is missing at {}. Restart session-buddy so it can put it there, then install again.", relay.display()));
    }
    Ok(())
}

fn read_current() -> Result<(Vec<u8>, Value), String> {
    let bytes = match std::fs::read(settings_path()) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(format!("cannot read {}: {e}", settings_path().display())),
    };
    let value = cs::parse_settings(&bytes)?;
    Ok((bytes, value))
}

fn next(install: bool, current: &Value) -> (Value, Option<Value>) {
    if install {
        let out = cs::install(current, &relay_str());
        (out.settings, out.saved_status_line)
    } else {
        (cs::uninstall(current, saved_status_line().as_ref()), None)
    }
}

pub fn status() -> InstallStatus {
    let current = read_current().map(|(_, v)| v).unwrap_or_else(|_| json!({}));
    InstallStatus {
        hooks_installed: cs::hooks_installed(&current),
        status_line_installed: cs::status_line_installed(&current),
        settings_path: settings_path().to_string_lossy().to_string(),
        relay_path: sb_common::relay_path().to_string_lossy().to_string(),
        relay_ready: sb_common::relay_path().exists(),
    }
}

pub fn preview(install: bool) -> Result<InstallPreview, String> {
    require_relay(install)?;
    let (bytes, current) = read_current()?;
    let (after, _) = next(install, &current);
    Ok(InstallPreview {
        diff: cs::unified_diff(&cs::pretty(&current), &cs::pretty(&after)),
        settings_path: settings_path().to_string_lossy().to_string(),
        fingerprint: cs::fingerprint(&bytes),
    })
}

pub fn write(install: bool, fingerprint: &str) -> Result<String, String> {
    require_relay(install)?;
    let (_, current) = read_current()?;
    let (after, saved) = next(install, &current);
    // The user's own status line is saved before settings.json drops it; without it uninstall could not restore it.
    if let (true, Some(original)) = (install, saved.as_ref()) {
        store_saved_status_line(Some(original))?;
    }
    let backup = cs::write_atomic(&settings_path(), &after, fingerprint)?;
    if !install {
        if let Err(err) = store_saved_status_line(None) {
            log::line(err);
        }
    }
    log::line(format!("settings.json {} (backup {})", if install { "installed" } else { "uninstalled" }, backup.display()));
    Ok(backup.to_string_lossy().to_string())
}

/// Copies sb-relay to its fixed path on launch. Bundled: from the app resources.
/// `tauri dev`: from target/relay (`cargo build --profile relay -p sb-relay`).
pub fn ensure_relay(app: &AppHandle) {
    let dest = sb_common::relay_path();
    let Some(dir) = dest.parent() else { return };
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    let name = dest.file_name().unwrap_or_default().to_owned();
    let mut candidates = Vec::new();
    if let Ok(res) = app.path().resource_dir() {
        candidates.push(res.join(&name));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(d) = exe.parent() {
            candidates.push(d.join(&name));
            candidates.push(d.join("..").join("relay").join(&name));
        }
    }
    let Some(src) = candidates.into_iter().find(|p| p.is_file()) else {
        log::line("sb-relay not found next to the app; hooks will not reach the island");
        return;
    };
    let same = match (std::fs::metadata(&src), std::fs::metadata(&dest)) {
        (Ok(a), Ok(b)) => a.len() == b.len() && a.modified().ok() <= b.modified().ok(),
        _ => false,
    };
    if same {
        return;
    }
    match std::fs::copy(&src, &dest) {
        Ok(_) => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755));
            }
            log::line(format!("relay installed at {}", dest.display()));
        }
        // A hook can be running the old copy right now (Windows locks it); next launch retries.
        Err(err) => log::line(format!("relay copy failed: {err}")),
    }
}
