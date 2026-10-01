//! The island window: a transparent panel at the top centre of the screen,
//! 960x440 by default and larger while the island is enlarged or wide. Outside
//! the island shape it lets clicks through; a 30 Hz cursor feed drives Mochi's
//! eyes and the hover logic.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Monitor, PhysicalPosition, PhysicalSize, WebviewWindow};

/// The default panel. Keep in sync with src/core/layout.ts and tauri.conf.json.
pub const PANEL_W: f64 = 960.0;
pub const PANEL_H: f64 = 440.0;

/// The panel size the front end asked for, logical pixels (see `set_panel_size`).
static PANEL: Mutex<(f64, f64)> = Mutex::new((PANEL_W, PANEL_H));

/// The monitor (position and scale) the window was last placed on.
static LAST_MONITOR: Mutex<Option<(i32, i32, u64)>> = Mutex::new(None);

/// Never smaller than the default panel; non-finite input keeps the default.
pub fn panel_request(width: f64, height: f64) -> (f64, f64) {
    let pick = |v: f64, min: f64| if v.is_finite() { v.max(min) } else { min };
    (pick(width, PANEL_W), pick(height, PANEL_H))
}

pub fn set_panel(width: f64, height: f64) {
    *PANEL.lock().unwrap() = panel_request(width, height);
}
pub const WINDOW_LABEL: &str = "island";

/// Same margin as the front end (src/island/island.ts HIT_MARGIN).
const HIT_MARGIN: f64 = 14.0;

#[derive(Clone, Copy, Serialize)]
pub struct CursorPayload {
    x: f64,
    y: f64,
}

#[derive(Clone, Copy, Default, PartialEq)]
pub struct IslandRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

pub struct Gate {
    pub rect: Mutex<IslandRect>,
    ignoring: AtomicBool,
}

impl Gate {
    pub fn new() -> Self {
        Self { rect: Mutex::new(IslandRect::default()), ignoring: AtomicBool::new(false) }
    }
}

pub fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(WINDOW_LABEL)
}

fn monitor_contains(m: &Monitor, x: f64, y: f64) -> bool {
    let p = m.position();
    let s = m.size();
    x >= p.x as f64 && x < p.x as f64 + s.width as f64 && y >= p.y as f64 && y < p.y as f64 + s.height as f64
}

fn target_monitor(app: &AppHandle, pref: &str) -> Option<Monitor> {
    if pref == "cursor" {
        if let Ok(c) = app.cursor_position() {
            if let Ok(list) = app.available_monitors() {
                if let Some(m) = list.into_iter().find(|m| monitor_contains(m, c.x, c.y)) {
                    return Some(m);
                }
            }
        }
    }
    app.primary_monitor().ok().flatten().or_else(|| app.available_monitors().ok()?.into_iter().next())
}

/// (x, y, width, height) of the area the island hangs from, in physical pixels.
/// macOS keeps windows below the menu bar, so use the work area there.
fn top_edge(m: &Monitor) -> (i32, i32, u32, u32) {
    #[cfg(target_os = "macos")]
    {
        let wa = m.work_area();
        (wa.position.x, wa.position.y, wa.size.width, wa.size.height)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let p = m.position();
        (p.x, p.y, m.size().width, m.size().height)
    }
}

pub fn apply_geometry(app: &AppHandle, pref: &str) {
    let Some(win) = window(app) else { return };
    let Some(m) = target_monitor(app, pref) else { return };
    let scale = m.scale_factor();
    let (x0, y0, width, height) = top_edge(&m);
    let (lw, lh) = *PANEL.lock().unwrap();
    // The panel never reaches past the screen (or the macOS work area).
    let pw = ((lw * scale).round() as u32).min(width);
    let ph = ((lh * scale).round() as u32).min(height);
    let x = x0 + (width as i32 - pw as i32) / 2;
    let key = (m.position().x, m.position().y, scale.to_bits());
    let moved_monitor = LAST_MONITOR.lock().unwrap().replace(key) != Some(key);
    // One move+resize, so a growing or shrinking panel stays centred instead of jumping sideways.
    #[cfg(windows)]
    {
        if !win32::move_resize(&win, x, y0, pw, ph) {
            let _ = win.set_position(PhysicalPosition::new(x, y0));
            let _ = win.set_size(PhysicalSize::new(pw, ph));
        }
    }
    #[cfg(not(windows))]
    {
        let _ = win.set_position(PhysicalPosition::new(x, y0));
        let _ = win.set_size(PhysicalSize::new(pw, ph));
    }
    // Moving across displays can rescale the window: re-assert the size then only.
    if moved_monitor {
        let _ = win.set_size(PhysicalSize::new(pw, ph));
    }
    let _ = win.set_always_on_top(true);
}

fn screen_key(app: &AppHandle) -> Option<(i32, i32, u32, u32, u64)> {
    let pref = app
        .try_state::<crate::Shared>()
        .map(|s| s.settings.lock().unwrap().screen.clone())
        .unwrap_or_else(|| "primary".into());
    let m = target_monitor(app, &pref)?;
    let p = m.position();
    let s = m.size();
    Some((p.x, p.y, s.width, s.height, m.scale_factor().to_bits()))
}

/// Clicking the island must never steal focus from Warp.
pub fn prepare(win: &WebviewWindow) {
    #[cfg(windows)]
    win32::make_non_activating(win);
    #[cfg(target_os = "macos")]
    {
        let _ = win.set_focusable(false);
        let _ = win.set_visible_on_all_workspaces(true);
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    let _ = win;
}

/// Lets the window take keyboard focus (hotkey, reply box) and gives it back.
pub fn set_activating(win: &WebviewWindow, on: bool) {
    #[cfg(windows)]
    win32::set_activating(win, on);
    #[cfg(target_os = "macos")]
    {
        let _ = win.set_focusable(on);
    }
    if on {
        let _ = win.set_focus();
    }
}

pub fn spawn_cursor_poll(app: AppHandle, gate: Arc<Gate>) {
    std::thread::spawn(move || {
        let mut last = (f64::MIN, f64::MIN);
        let mut last_rect = IslandRect::default();
        let mut last_screen = None;
        let mut ticks: u32 = 0;
        loop {
            std::thread::sleep(Duration::from_millis(33));
            ticks = ticks.wrapping_add(1);
            if ticks.is_multiple_of(15) {
                let now = screen_key(&app);
                if now.is_some() && now != last_screen {
                    if last_screen.is_some() {
                        crate::log::line("display layout changed, repositioning");
                        let _ = app.emit_to(WINDOW_LABEL, "screen-changed", ());
                    }
                    last_screen = now;
                }
            }
            let Some(win) = window(&app) else { continue };
            let Ok(origin) = win.outer_position() else { continue };
            let scale = win.scale_factor().unwrap_or(1.0);
            let Ok(c) = app.cursor_position() else { continue };
            let x = (c.x - origin.x as f64) / scale;
            let y = (c.y - origin.y as f64) / scale;
            // The island can grow under a resting cursor: re-check when either moves.
            let r = *gate.rect.lock().unwrap();
            let moved = (x - last.0).abs() >= 1.0 || (y - last.1).abs() >= 1.0;
            if !moved && r == last_rect {
                continue;
            }
            last = (x, y);
            last_rect = r;
            let on_island = r.w > 0.0
                && x >= r.x - HIT_MARGIN
                && x <= r.x + r.w + HIT_MARGIN
                && y >= r.y - HIT_MARGIN
                && y <= r.y + r.h + HIT_MARGIN;
            if gate.ignoring.load(Ordering::Relaxed) == on_island {
                gate.ignoring.store(!on_island, Ordering::Relaxed);
                let _ = win.set_ignore_cursor_events(!on_island);
            }
            if moved {
                let _ = win.emit("cursor", CursorPayload { x, y });
            }
        }
    });
}

#[cfg(windows)]
mod win32 {
    use tauri::WebviewWindow;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, GWL_EXSTYLE, SWP_NOACTIVATE, SWP_NOZORDER, WS_EX_NOACTIVATE,
        WS_EX_TOOLWINDOW,
    };

    fn hwnd_of(win: &WebviewWindow) -> Option<HWND> {
        let raw = win.hwnd().ok()?.0 as isize;
        if raw == 0 {
            return None;
        }
        Some(HWND(raw as *mut _))
    }

    /// WS_EX_NOACTIVATE keeps clicks from stealing focus; WS_EX_TOOLWINDOW keeps the island out of Alt-Tab.
    pub fn make_non_activating(win: &WebviewWindow) {
        let Some(hwnd) = hwnd_of(win) else { return };
        unsafe {
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex | WS_EX_NOACTIVATE.0 as isize | WS_EX_TOOLWINDOW.0 as isize);
        }
    }

    /// Position and size in one SetWindowPos (physical pixels). False when it could not be applied.
    pub fn move_resize(win: &WebviewWindow, x: i32, y: i32, w: u32, h: u32) -> bool {
        let Some(hwnd) = hwnd_of(win) else { return false };
        let (Ok(w), Ok(h)) = (i32::try_from(w), i32::try_from(h)) else { return false };
        // SAFETY: plain window call on our own window handle.
        unsafe { SetWindowPos(hwnd, None, x, y, w, h, SWP_NOZORDER | SWP_NOACTIVATE) }.is_ok()
    }

    pub fn set_activating(win: &WebviewWindow, activating: bool) {
        let Some(hwnd) = hwnd_of(win) else { return };
        unsafe {
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            let want = if activating { ex & !(WS_EX_NOACTIVATE.0 as isize) } else { ex | WS_EX_NOACTIVATE.0 as isize };
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, want);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_panel_is_never_smaller_than_the_default() {
        assert_eq!(panel_request(1200.0, 700.0), (1200.0, 700.0));
        assert_eq!(panel_request(300.0, 100.0), (PANEL_W, PANEL_H));
        assert_eq!(panel_request(f64::NAN, f64::INFINITY), (PANEL_W, PANEL_H));
    }
}
