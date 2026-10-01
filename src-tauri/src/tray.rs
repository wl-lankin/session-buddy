//! Tray (Windows) / menu bar (macOS) icon: Open, Settings..., Quit.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter};

use crate::island::WINDOW_LABEL;

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings...", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit session-buddy", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &settings, &sep, &quit])?;

    let mut builder = TrayIconBuilder::with_id("session-buddy")
        .tooltip("session-buddy")
        .menu(&menu)
        .on_menu_event(|app: &AppHandle, event| match event.id.as_ref() {
            "quit" => app.exit(0),
            "settings" => crate::show_settings_window(app),
            "open" => {
                let _ = app.emit_to(WINDOW_LABEL, "tray", "open");
            }
            _ => {}
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}
