//! Auto-update through the Tauri updater: a check now and then, a notice on the island, and an
//! install only when the user clicks (download, signature check, install, restart).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::island::WINDOW_LABEL;
use crate::{chat, log, Shared};

const FIRST_CHECK_AFTER: Duration = Duration::from_secs(30);
const CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);
const TICK: Duration = Duration::from_secs(15);
const PROGRESS_EVERY: Duration = Duration::from_millis(250);
const MAX_NOTES: usize = 1000;
const MAX_ERROR: usize = 160;

#[derive(Default)]
pub struct Updates {
    /// The update the last check found, installed by `update_install`.
    pending: Mutex<Option<Update>>,
    last_check: Mutex<Option<Instant>>,
    /// The version the island was last told about, so the six-hourly check does not repeat it.
    announced: Mutex<Option<String>>,
    installing: AtomicBool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Available {
    version: String,
    current_version: String,
    notes: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
    available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    current_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    notes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Clone, Serialize)]
struct Progress {
    downloaded: u64,
    total: Option<u64>,
}

fn current_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// True only for a strictly higher version, so a downgrade or the same version never installs.
fn is_newer(current: &str, candidate: &str) -> bool {
    match (semver::Version::parse(current), semver::Version::parse(candidate)) {
        (Ok(c), Ok(n)) => n > c,
        _ => false,
    }
}

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max.saturating_sub(3)).collect();
    out.push_str("...");
    out
}

fn clip_notes(notes: Option<&str>) -> Option<String> {
    let notes = notes?.trim();
    (!notes.is_empty()).then(|| clip(notes, MAX_NOTES))
}

/// One short line: the first line of the error, clipped.
fn short_error(err: &dyn std::fmt::Display) -> String {
    clip(err.to_string().lines().next().unwrap_or("update failed").trim(), MAX_ERROR)
}

/// The automatic check: on, past the start delay, and not within the interval of the last check.
fn auto_check_due(enabled: bool, since_start: Duration, since_last: Option<Duration>) -> bool {
    enabled && since_start >= FIRST_CHECK_AFTER && since_last.is_none_or(|d| d >= CHECK_EVERY)
}

fn emit<S: Serialize + Clone>(app: &AppHandle, event: &str, payload: S) {
    let _ = app.emit_to(WINDOW_LABEL, event, payload);
}

fn emit_error(app: &AppHandle, message: &str) {
    emit(app, "update-error", serde_json::json!({ "message": message }));
}

/// Asks the manifest and remembers the found update. Ok(None): nothing newer.
async fn find(app: &AppHandle) -> Result<Option<Update>, String> {
    let state = app.state::<Updates>();
    *state.last_check.lock().unwrap() = Some(Instant::now());
    let exit_app = app.clone();
    let updater = app
        .updater_builder()
        .on_before_exit(move || chat::stop(&exit_app))
        .build()
        .map_err(|e| short_error(&e))?;
    let found = updater.check().await.map_err(|e| short_error(&e))?.filter(|u| is_newer(&u.current_version, &u.version));
    *state.pending.lock().unwrap() = found.clone();
    Ok(found)
}

fn announce(app: &AppHandle, update: &Update) {
    *app.state::<Updates>().announced.lock().unwrap() = Some(update.version.clone());
    let info = Available { version: update.version.clone(), current_version: update.current_version.clone(), notes: clip_notes(update.body.as_deref()) };
    emit(app, "update-available", info);
}

fn is_new_announcement(announced: Option<&str>, found: &str) -> bool {
    announced != Some(found)
}

async fn background_check(app: &AppHandle) {
    match find(app).await {
        Ok(Some(update)) => {
            let seen = app.state::<Updates>().announced.lock().unwrap().clone();
            if is_new_announcement(seen.as_deref(), &update.version) {
                log::line(format!("update {} is available", update.version));
                announce(app, &update);
            }
        }
        Ok(None) => {}
        Err(err) => log::line(format!("update check: {err}")),
    }
}

/// A user-driven check: every outcome is reported to the island.
async fn manual_check(app: &AppHandle) -> CheckResult {
    let current = current_version();
    match find(app).await {
        Ok(Some(update)) => {
            announce(app, &update);
            CheckResult { available: true, version: Some(update.version.clone()), current_version: current, notes: clip_notes(update.body.as_deref()), error: None }
        }
        Ok(None) => {
            emit(app, "update-none", ());
            CheckResult { available: false, version: None, current_version: current, notes: None, error: None }
        }
        Err(err) => {
            log::line(format!("update check: {err}"));
            emit_error(app, &err);
            CheckResult { available: false, version: None, current_version: current, notes: None, error: Some(err) }
        }
    }
}

pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let started = Instant::now();
        let mut every = tokio::time::interval(TICK);
        loop {
            every.tick().await;
            let enabled = app.state::<Shared>().settings.lock().unwrap().update_check;
            let since_last = app.state::<Updates>().last_check.lock().unwrap().map(|t| t.elapsed());
            if auto_check_due(enabled, started.elapsed(), since_last) {
                background_check(&app).await;
            }
        }
    });
}

/// The tray item: opens the island, then reports the result of a manual check.
pub fn check_from_tray(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        emit(&app, "tray", "open");
        manual_check(&app).await;
    });
}

#[tauri::command]
pub async fn update_check(app: AppHandle) -> CheckResult {
    manual_check(&app).await
}

struct InstallGuard<'a>(&'a AtomicBool);

impl Drop for InstallGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<(), String> {
    let state = app.state::<Updates>();
    if state.installing.swap(true, Ordering::SeqCst) {
        return Err("An update is already being installed".into());
    }
    let _guard = InstallGuard(&state.installing);
    match install(&app).await {
        Ok(()) => Ok(()),
        Err(err) => {
            log::line(format!("update install: {err}"));
            emit_error(&app, &err);
            Err(err)
        }
    }
}

async fn install(app: &AppHandle) -> Result<(), String> {
    let pending = app.state::<Updates>().pending.lock().unwrap().clone();
    let update = match pending {
        Some(update) => update,
        None => find(app).await?.ok_or("No newer version found")?,
    };
    if !is_newer(&update.current_version, &update.version) {
        return Err("The update is not newer than this version".into());
    }
    log::line(format!("installing update {}", update.version));

    let mut downloaded = 0u64;
    let mut last_emit: Option<Instant> = None;
    let progress_app = app.clone();
    let bytes = update
        .download(
            move |chunk, total| {
                downloaded += chunk as u64;
                if last_emit.is_none_or(|t| t.elapsed() >= PROGRESS_EVERY) {
                    last_emit = Some(Instant::now());
                    emit(&progress_app, "update-progress", Progress { downloaded, total });
                }
            },
            || {},
        )
        .await
        .map_err(|e| short_error(&e))?;
    emit(app, "update-progress", Progress { downloaded: bytes.len() as u64, total: Some(bytes.len() as u64) });
    emit(app, "update-ready", ());

    // On Windows this launches the installer and exits the process.
    tauri::async_runtime::spawn_blocking(move || update.install(bytes)).await.map_err(|e| short_error(&e))?.map_err(|e| short_error(&e))?;
    chat::stop(app);
    app.restart()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_strictly_higher_version_counts() {
        assert!(is_newer("1.0.10", "1.0.11"));
        assert!(is_newer("1.0.10", "1.1.0"));
        assert!(is_newer("1.0.9", "1.0.10"));
        assert!(!is_newer("1.0.10", "1.0.10"));
        assert!(!is_newer("1.0.10", "1.0.9"));
        assert!(!is_newer("1.0.10", "0.9.99"));
        assert!(is_newer("1.0.10-beta.1", "1.0.10"));
        assert!(!is_newer("1.0.10", "not a version"));
        assert!(!is_newer("", "1.0.0"));
    }

    #[test]
    fn notes_are_trimmed_and_clipped() {
        assert_eq!(clip_notes(None), None);
        assert_eq!(clip_notes(Some("  \n ")), None);
        assert_eq!(clip_notes(Some(" fixes ")).as_deref(), Some("fixes"));
        let long = "ä".repeat(1500);
        let clipped = clip_notes(Some(&long)).unwrap();
        assert_eq!(clipped.chars().count(), MAX_NOTES);
        assert!(clipped.ends_with("..."));
        let exact = "x".repeat(MAX_NOTES);
        assert_eq!(clip_notes(Some(&exact)).unwrap(), exact);
    }

    #[test]
    fn errors_are_one_short_line() {
        assert_eq!(short_error(&"a\nb"), "a");
        assert_eq!(short_error(&"x".repeat(500)).chars().count(), MAX_ERROR);
    }

    #[test]
    fn a_version_is_announced_once_per_run() {
        assert!(is_new_announcement(None, "1.0.11"));
        assert!(!is_new_announcement(Some("1.0.11"), "1.0.11"));
        assert!(is_new_announcement(Some("1.0.11"), "1.0.12"));
    }

    #[test]
    fn schedule_waits_then_checks_every_six_hours() {
        let s = Duration::from_secs;
        assert!(!auto_check_due(true, s(5), None));
        assert!(auto_check_due(true, s(30), None));
        assert!(!auto_check_due(false, s(100), None));
        assert!(!auto_check_due(true, s(1000), Some(s(60))));
        assert!(!auto_check_due(true, s(1000), Some(CHECK_EVERY - s(1))));
        assert!(auto_check_due(true, s(1000), Some(CHECK_EVERY)));
    }
}
