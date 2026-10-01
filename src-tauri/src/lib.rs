//! session-buddy: shows and answers every running Claude Code session.

mod autostart;
mod install;
mod ipc;
mod island;
mod links;
mod log;
mod process;
mod settings;
mod tray;
mod usage_poll;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use sb_core::hub::Hub;
use sb_core::store::{Cue, Session};
use sb_core::usage::Usage;
use sb_core::{adopt, bootstrap, branch, now_ms};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

use install::{InstallPreview, InstallStatus};
use island::{Gate, WINDOW_LABEL};
use settings::Settings;

pub struct Shared {
    pub settings: Mutex<Settings>,
    pub gate: Arc<Gate>,
    pub hub: Arc<Hub>,
    pub usage: Mutex<Usage>,
}

static APP: OnceLock<AppHandle> = OnceLock::new();
static DIRTY: AtomicBool = AtomicBool::new(true);

pub fn mark_dirty() {
    DIRTY.store(true, Ordering::SeqCst);
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    sessions: Vec<Session>,
    usage: Usage,
    now: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootInfo {
    settings: Settings,
    version: String,
}

fn build_snapshot(shared: &Shared) -> Snapshot {
    let sessions = shared.hub.store.lock().unwrap().snapshot();
    let usage = shared.usage.lock().unwrap().clone();
    Snapshot { sessions, usage, now: now_ms() }
}

fn apply_store_limits(shared: &Shared) {
    let s = shared.settings.lock().unwrap().clone();
    let mut st = shared.hub.store.lock().unwrap();
    st.stale_after_ms = s.stale_minutes.max(1) as i64 * 60_000;
    st.remove_after_ms = s.remove_minutes.max(1) as i64 * 60_000;
}

#[tauri::command]
fn boot(shared: State<Shared>) -> BootInfo {
    BootInfo { settings: shared.settings.lock().unwrap().clone(), version: env!("CARGO_PKG_VERSION").to_string() }
}

#[tauri::command]
fn snapshot(shared: State<Shared>) -> Snapshot {
    build_snapshot(&shared)
}

#[tauri::command]
fn save_settings(app: AppHandle, shared: State<Shared>, settings: Settings) {
    let (screen_changed, autostart_changed, hotkey_changed) = {
        let mut current = shared.settings.lock().unwrap();
        let changed = (current.screen != settings.screen, current.autostart != settings.autostart, current.hotkey != settings.hotkey);
        *current = settings.clone();
        changed
    };
    if let Err(err) = settings::save(&settings) {
        log::line(format!("could not save settings: {err}"));
    }
    apply_store_limits(&shared);
    if autostart_changed {
        let manager = app.autolaunch();
        let result = if settings.autostart { manager.enable() } else { manager.disable() };
        if let Err(err) = result {
            log::line(format!("autostart: {err}"));
        }
    }
    if screen_changed {
        island::apply_geometry(&app, &settings.screen);
    }
    if hotkey_changed {
        register_hotkey(&app, &settings.hotkey);
    }
    mark_dirty();
    let _ = app.emit("settings-changed", settings);
}

#[tauri::command]
fn set_island_rect(shared: State<Shared>, x: f64, y: f64, width: f64, height: f64) {
    *shared.gate.rect.lock().unwrap() = island::IslandRect { x, y, w: width, h: height };
}

#[tauri::command]
fn focus_window(app: AppHandle, focused: bool) {
    if let Some(win) = island::window(&app) {
        island::set_activating(&win, focused);
    }
}

#[tauri::command]
fn reposition(app: AppHandle, shared: State<Shared>) {
    let pref = shared.settings.lock().unwrap().screen.clone();
    island::apply_geometry(&app, &pref);
}

/// Resizes the island window (logical pixels) and re-centres it at the top of its screen.
#[tauri::command]
fn set_panel_size(app: AppHandle, shared: State<Shared>, width: f64, height: f64) {
    island::set_panel(width, height);
    let pref = shared.settings.lock().unwrap().screen.clone();
    island::apply_geometry(&app, &pref);
}

#[tauri::command]
fn reset_panel_size(app: AppHandle, shared: State<Shared>) {
    island::set_panel(island::PANEL_W, island::PANEL_H);
    let pref = shared.settings.lock().unwrap().screen.clone();
    island::apply_geometry(&app, &pref);
}

#[tauri::command]
fn ack(shared: State<Shared>, request_id: String) {
    shared.hub.ack(&request_id);
}

#[tauri::command]
fn answer(shared: State<Shared>, request_id: String, answer: Value) -> Result<(), String> {
    log::line(format!("answer id={request_id}"));
    shared.hub.answer(&request_id, &answer)
}

#[tauri::command]
fn release(shared: State<Shared>, request_id: String) {
    log::line(format!("release id={request_id}"));
    shared.hub.release(&request_id);
}

#[tauri::command]
fn install_status() -> InstallStatus {
    install::status()
}

#[tauri::command]
fn install_preview(install: bool) -> Result<InstallPreview, String> {
    install::preview(install)
}

#[tauri::command]
fn install_write(install: bool, fingerprint: String) -> Result<String, String> {
    install::write(install, &fingerprint)
}

#[tauri::command]
fn open_settings_window(app: AppHandle) {
    show_settings_window(&app);
}

#[tauri::command]
fn log(message: String) {
    log::line(message);
}

#[tauri::command]
fn open_link(url: String) -> Result<(), String> {
    links::open(&url)
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

pub fn show_settings_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    if let Ok(w) = WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("settings.html".into()))
        .title("Session Buddy settings")
        .inner_size(600.0, 680.0)
        .resizable(true)
        .build()
    {
        no_browser_keys(&w);
    }
}

/// Windows: WebView2's own reload, print, find, zoom and devtools keys are off (editing keys stay).
/// The page blocks the same keys too (src/core/nobrowser.ts), this also covers keys it never sees.
#[cfg(windows)]
fn no_browser_keys(w: &tauri::WebviewWindow) {
    let _ = w.with_webview(|wv| {
        use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
        use windows_core::Interface;
        // SAFETY: COM calls on the webview's own controller, run by tauri on the webview thread.
        unsafe {
            let Ok(core) = wv.controller().CoreWebView2() else { return };
            let Ok(settings) = core.Settings() else { return };
            if let Ok(s3) = settings.cast::<ICoreWebView2Settings3>() {
                let _ = s3.SetAreBrowserAcceleratorKeysEnabled(false);
            }
        }
    });
}

#[cfg(not(windows))]
fn no_browser_keys(_w: &tauri::WebviewWindow) {}

fn register_hotkey(app: &AppHandle, accelerator: &str) {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    if accelerator.trim().is_empty() {
        return;
    }
    let result = gs.on_shortcut(accelerator, |app, _shortcut, event| {
        if event.state == ShortcutState::Pressed {
            let _ = app.emit_to(WINDOW_LABEL, "hotkey", ());
        }
    });
    if let Err(err) = result {
        log::line(format!("hotkey {accelerator} could not be registered: {err}"));
    }
}

fn spawn_bootstrap(app: AppHandle) {
    tauri::async_runtime::spawn_blocking(move || {
        let shared = app.state::<Shared>();
        let (stale, remove) = {
            let st = shared.hub.store.lock().unwrap();
            (st.stale_after_ms, st.remove_after_ms)
        };
        let now = now_ms();
        let seeds = bootstrap::scan(&sb_common::claude_dir().join("projects"), now, stale + remove);
        let count = seeds.len();
        {
            let mut st = shared.hub.store.lock().unwrap();
            for seed in &seeds {
                st.seed(bootstrap::session_from_seed(seed, now, stale));
            }
        }
        log::line(format!("bootstrap: {count} recent session(s)"));
        mark_dirty();
        adopt_running(&app);
    });
}

/// Seeded sessions whose Claude Code process is running (matched by working
/// directory) become live. Blocking: lists the processes.
fn adopt_running(app: &AppHandle) {
    let shared = app.state::<Shared>();
    if !shared.hub.store.lock().unwrap().has_unclaimed_seeds() {
        return;
    }
    let procs = adopt::claude_processes(&process::list_processes());
    let held = {
        let mut st = shared.hub.store.lock().unwrap();
        if st.adopt(&procs, cfg!(windows), now_ms()) {
            mark_dirty();
        }
        st.count_held(&procs)
    };
    let result = (procs.len(), held);
    let mut last = LAST_SCAN.lock().unwrap();
    if *last != Some(result) {
        *last = Some(result);
        log::line(format!("process scan: {} claude processes, {} held", result.0, result.1));
    }
}

/// The last process scan's (claude processes, held by a session): logged only when it changes.
static LAST_SCAN: Mutex<Option<(usize, usize)>> = Mutex::new(None);

fn spawn_loops(app: AppHandle) {
    let emitter = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut every = tokio::time::interval(Duration::from_millis(33));
        loop {
            every.tick().await;
            if DIRTY.swap(false, Ordering::SeqCst) {
                let snap = build_snapshot(&emitter.state::<Shared>());
                let _ = emitter.emit_to(WINDOW_LABEL, "sessions", snap);
            }
        }
    });
    let adopter = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut every = tokio::time::interval(Duration::from_secs(30));
        every.tick().await; // the first scan runs right after the bootstrap
        loop {
            every.tick().await;
            let app = adopter.clone();
            let _ = tauri::async_runtime::spawn_blocking(move || adopt_running(&app)).await;
        }
    });
    tauri::async_runtime::spawn(async move {
        let mut every = tokio::time::interval(Duration::from_secs(5));
        loop {
            every.tick().await;
            let now = now_ms();
            let todo = {
                let shared = app.state::<Shared>();
                let mut st = shared.hub.store.lock().unwrap();
                let removed = st.remove_dead(process::pid_alive);
                if st.tick(now) || removed {
                    mark_dirty();
                }
                (st.sessions_needing_branch(now, 30_000), st.sessions_needing_toplevel())
            };
            let (todo, roots) = todo;
            for (id, cwd) in roots {
                let app = app.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let found = branch::toplevel(&cwd);
                    if app.state::<Shared>().hub.store.lock().unwrap().set_toplevel(&id, found) {
                        mark_dirty();
                    }
                });
            }
            for (id, cwd) in todo {
                let app = app.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let found = branch::lookup(&cwd);
                    if app.state::<Shared>().hub.store.lock().unwrap().set_branch(&id, found) {
                        mark_dirty();
                    }
                });
            }
        }
    });
}

pub fn run() {
    let settings = settings::load();
    let hub = Hub::new(|cues: Vec<Cue>| {
        mark_dirty();
        if !cues.is_empty() {
            if let Some(app) = APP.get() {
                let _ = app.emit_to(WINDOW_LABEL, "cues", cues);
            }
        }
    });
    let hotkey = settings.hotkey.clone();
    let shared = Shared {
        settings: Mutex::new(settings),
        gate: Arc::new(Gate::new()),
        hub,
        usage: Mutex::new(Usage::default()),
    };
    apply_store_limits(&shared);

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let _ = app.emit_to(WINDOW_LABEL, "tray", "open");
        }))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(shared)
        .invoke_handler(tauri::generate_handler![
            boot, snapshot, save_settings, set_island_rect, focus_window, reposition, set_panel_size, reset_panel_size, ack, answer, release,
            install_status, install_preview, install_write, open_settings_window, log, open_link, quit_app
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            let _ = APP.set(handle.clone());
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            log::line(format!("session-buddy {} starting", env!("CARGO_PKG_VERSION")));
            install::ensure_relay(&handle);
            let shared = handle.state::<Shared>();
            if let Some(win) = island::window(&handle) {
                island::prepare(&win);
                no_browser_keys(&win);
            }
            let (screen, autostart_on) = {
                let s = shared.settings.lock().unwrap();
                (s.screen.clone(), s.autostart)
            };
            autostart::refresh(&handle, autostart_on);
            island::apply_geometry(&handle, &screen);
            island::spawn_cursor_poll(handle.clone(), shared.gate.clone());
            ipc::start(shared.hub.clone());
            spawn_bootstrap(handle.clone());
            spawn_loops(handle.clone());
            usage_poll::spawn(handle.clone());
            tray::build(&handle)?;
            register_hotkey(&handle, &hotkey);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running session-buddy");
}
