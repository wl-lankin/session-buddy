//! Start-up entry upkeep. tauri-plugin-autostart names the entry after the
//! product name (`package_info().name`): the Windows Run value and the macOS
//! LaunchAgent were "session-buddy" before the rename and are "Session Buddy"
//! now. On start-up the current entry is written again (when autostart is on)
//! and an old "session-buddy" entry that starts this app is removed, so the app
//! never starts twice and turning autostart off really turns it off.

use tauri::AppHandle;
use tauri_plugin_autostart::ManagerExt;

/// The entry name the plugin used before the product name changed.
pub const LEGACY_NAME: &str = "session-buddy";

/// True when a start-up command (Run value or plist text) launches Session Buddy.
pub fn launches_us(command: &str) -> bool {
    let lower = command.to_ascii_lowercase();
    lower.contains("session-buddy") || lower.contains("session buddy")
}

/// The old entry goes when autostart is off, or once the new entry was written; if writing the
/// new one failed, the old one is the only thing that still starts the app, so it stays.
pub fn should_remove_legacy(autostart: bool, enabled_ok: bool) -> bool {
    !autostart || enabled_ok
}

pub fn refresh(app: &AppHandle, autostart: bool) {
    let mut enabled_ok = false;
    if autostart {
        match app.autolaunch().enable() {
            Ok(()) => enabled_ok = true,
            Err(err) => crate::log::line(format!("autostart: {err}")),
        }
    }
    if !should_remove_legacy(autostart, enabled_ok) {
        return;
    }
    match remove_legacy() {
        Ok(true) => crate::log::line(format!("autostart: removed the old \"{LEGACY_NAME}\" entry")),
        Ok(false) => {}
        Err(err) => crate::log::line(format!("autostart: could not remove the old entry: {err}")),
    }
}

#[cfg(windows)]
fn remove_legacy() -> Result<bool, String> {
    use windows_registry::CURRENT_USER;
    const RUN: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    const APPROVED: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
    let Ok(run) = CURRENT_USER.options().read().write().open(RUN) else { return Ok(false) };
    let Ok(command) = run.get_string(LEGACY_NAME) else { return Ok(false) };
    if !launches_us(&command) {
        return Ok(false);
    }
    run.remove_value(LEGACY_NAME).map_err(|e| e.to_string())?;
    // Task Manager's enabled/disabled flag for the same name; absent is fine.
    if let Ok(approved) = CURRENT_USER.options().read().write().open(APPROVED) {
        let _ = approved.remove_value(LEGACY_NAME);
    }
    Ok(true)
}

#[cfg(target_os = "macos")]
fn remove_legacy() -> Result<bool, String> {
    let Some(home) = std::env::var_os("HOME") else { return Ok(false) };
    let plist = std::path::PathBuf::from(home).join("Library").join("LaunchAgents").join(format!("{LEGACY_NAME}.plist"));
    let Ok(text) = std::fs::read_to_string(&plist) else { return Ok(false) };
    if !launches_us(&text) {
        return Ok(false);
    }
    std::fs::remove_file(&plist).map_err(|e| e.to_string())?;
    Ok(true)
}

#[cfg(not(any(windows, target_os = "macos")))]
fn remove_legacy() -> Result<bool, String> {
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_our_start_up_commands_only() {
        assert!(launches_us(r"C:\Users\alex\AppData\Local\session-buddy\session-buddy.exe "));
        assert!(launches_us(r#""C:\Program Files\Session Buddy\Session Buddy.exe""#));
        assert!(launches_us("<string>/Applications/Session Buddy.app/Contents/MacOS/session-buddy</string>"));
        assert!(!launches_us(r"C:\Program Files\Other\other.exe --minimized"));
    }

    #[test]
    fn the_old_entry_stays_when_the_new_one_could_not_be_written() {
        assert!(should_remove_legacy(false, false), "autostart off: always removed");
        assert!(should_remove_legacy(true, true));
        assert!(!should_remove_legacy(true, false));
    }
}
