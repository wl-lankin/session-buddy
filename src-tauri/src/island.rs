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

static LAST_MONITOR: Mutex<Option<(i32, i32, u64)>> = Mutex::new(None);

/// The notch of the screen the island is on, logical pixels; `None` without one.
static NOTCH: Mutex<Option<Notch>> = Mutex::new(None);

/// A MacBook notch: the island's window starts at the top of the screen and the
/// front end draws a black neck of this size above the island, so it grows out of the notch.
#[derive(Clone, Copy, PartialEq, Serialize)]
pub struct Notch {
    /// Height of the notch (and the menu bar beside it).
    pub top: f64,
    pub width: f64,
}

#[derive(Clone, Copy, Serialize)]
struct NotchPayload {
    top: f64,
    width: f64,
}

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
/// macOS keeps windows below the menu bar, so use the work area there; with a notch
/// the window starts at the top of the screen and the island hangs below the notch.
fn top_edge(m: &Monitor, notch: Option<Notch>) -> (i32, i32, u32, u32) {
    #[cfg(target_os = "macos")]
    {
        let wa = m.work_area();
        match notch {
            Some(_) => {
                let p = m.position();
                let bottom = wa.position.y + wa.size.height as i32;
                (wa.position.x, p.y, wa.size.width, (bottom - p.y).max(0) as u32)
            }
            None => (wa.position.x, wa.position.y, wa.size.width, wa.size.height),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = notch;
        let p = m.position();
        (p.x, p.y, m.size().width, m.size().height)
    }
}

pub fn apply_geometry(app: &AppHandle, pref: &str) {
    let Some(win) = window(app) else { return };
    let Some(m) = target_monitor(app, pref) else { return };
    let scale = m.scale_factor();
    #[cfg(target_os = "macos")]
    let notch = macos::notch(&m);
    #[cfg(not(target_os = "macos"))]
    let notch: Option<Notch> = None;
    *NOTCH.lock().unwrap() = notch;
    let (x0, y0, width, height) = top_edge(&m, notch);
    let (lw, lh) = *PANEL.lock().unwrap();
    // With a notch the window also covers the menu bar strip above the island.
    let lh = lh + notch.map_or(0.0, |n| n.top);
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
    // Over the menu bar, or the notch strip would hide behind it.
    #[cfg(target_os = "macos")]
    macos::set_above_menu_bar(&win, notch.is_some());
    let payload = notch.map_or(NotchPayload { top: 0.0, width: 0.0 }, |n| NotchPayload { top: n.top, width: n.width });
    let _ = win.emit_to(WINDOW_LABEL, "notch", payload);
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

/// Clicking the island must never steal focus from the terminal.
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
            #[cfg(target_os = "macos")]
            if ticks.is_multiple_of(15) && NOTCH.lock().unwrap().is_some() {
                macos::set_above_menu_bar(&win, true);
            }
            let Ok(origin) = win.outer_position() else { continue };
            let scale = win.scale_factor().unwrap_or(1.0);
            let Ok(c) = app.cursor_position() else { continue };
            let x = (c.x - origin.x as f64) / scale;
            // Island coordinates: the front end draws below the notch strip.
            let y = (c.y - origin.y as f64) / scale - NOTCH.lock().unwrap().map_or(0.0, |n| n.top);
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

#[cfg(target_os = "macos")]
mod macos {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use objc2_foundation::{NSEdgeInsets, NSRect};
    use tauri::{Monitor, WebviewWindow};

    use super::Notch;

    /// NSMainMenuWindowLevel is 24; the island goes just above it.
    const ABOVE_MENU_BAR: isize = 26;
    /// NSFloatingWindowLevel, what `set_always_on_top` uses.
    const FLOATING: isize = 3;

    /// The notch of the NSScreen that matches `m`, from its safe area (macOS 12+).
    pub fn notch(m: &Monitor) -> Option<Notch> {
        let scale = m.scale_factor();
        // SAFETY: read-only NSScreen getters on objects AppKit keeps alive for the call.
        unsafe {
            let screens: *mut AnyObject = msg_send![class!(NSScreen), screens];
            if screens.is_null() {
                return None;
            }
            let count: usize = msg_send![screens, count];
            for i in 0..count {
                let screen: *mut AnyObject = msg_send![screens, objectAtIndex: i];
                let frame: NSRect = msg_send![screen, frame];
                // Tauri's monitor origin is top-left in physical pixels, AppKit's bottom-left in points: match on x and width.
                let same_x = ((frame.origin.x * scale).round() as i32 - m.position().x).abs() <= 1;
                let same_w = ((frame.size.width * scale).round() as i64 - m.size().width as i64).abs() <= 1;
                if !(same_x && same_w) {
                    continue;
                }
                let responds: bool = msg_send![screen, respondsToSelector: objc2::sel!(safeAreaInsets)];
                if !responds {
                    return None;
                }
                let insets: NSEdgeInsets = msg_send![screen, safeAreaInsets];
                if insets.top <= 0.0 {
                    return None;
                }
                let left: NSRect = msg_send![screen, auxiliaryTopLeftArea];
                let right: NSRect = msg_send![screen, auxiliaryTopRightArea];
                let width = frame.size.width - left.size.width - right.size.width;
                return (width > 0.0).then_some(Notch { top: insets.top, width });
            }
            None
        }
    }

    pub fn set_above_menu_bar(win: &WebviewWindow, above: bool) {
        let Ok(ns) = win.ns_window() else { return };
        let ns = ns as usize;
        // AppKit wants window changes on the main thread.
        let _ = win.run_on_main_thread(move || {
            // SAFETY: our own NSWindow, which lives as long as the app.
            unsafe { pin(ns as *mut AnyObject, above) }
        });
    }

    /// Level and top edge, changed only when they drifted: tao resets the level when it
    /// shows the window, and AppKit pushes a window over the menu bar down below it.
    unsafe fn pin(ns: *mut AnyObject, above: bool) {
        let level = if above { ABOVE_MENU_BAR } else { FLOATING };
        let current: isize = msg_send![ns, level];
        if current != level {
            let _: () = msg_send![ns, setLevel: level];
        }
        if !above {
            return;
        }
        let screen: *mut AnyObject = msg_send![ns, screen];
        if screen.is_null() {
            return;
        }
        let sf: NSRect = msg_send![screen, frame];
        let mut f: NSRect = msg_send![ns, frame];
        let top = sf.origin.y + sf.size.height - f.size.height;
        if (f.origin.y - top).abs() >= 0.5 {
            f.origin.y = top;
            let _: () = msg_send![ns, setFrame: f, display: true];
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
