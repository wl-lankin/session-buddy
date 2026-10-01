//! Start-up entry upkeep. The plugin names the entry after the product name, which
//! was "session-buddy" before the rename and is "Session Buddy" now. On start-up the
//! current entry is rewritten (when autostart is on) and an old "session-buddy" entry
//! that starts this app is removed, so the app never starts twice.

use tauri::AppHandle;
use tauri_plugin_autostart::ManagerExt;

pub const LEGACY_NAME: &str = "session-buddy";

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
            Ok(()) => {
                enabled_ok = true;
                #[cfg(target_os = "macos")]
                associate_bundle(app);
            }
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

/// The plugin leaves the LaunchAgent's AssociatedBundleIdentifiers empty, so Login Items in
/// System Settings shows the bare binary ("session-buddy", exec icon) instead of the app.
/// `None` when the plist already names a bundle or has no empty list to fill.
#[cfg(any(target_os = "macos", test))]
pub fn with_bundle_id(plist: &str, identifier: &str) -> Option<String> {
    const KEY: &str = "<key>AssociatedBundleIdentifiers</key>";
    const EMPTY: &str = "<array></array>";
    let after_key = plist.find(KEY)? + KEY.len();
    let rest = &plist[after_key..];
    let start = after_key + (rest.len() - rest.trim_start().len());
    if !plist[start..].starts_with(EMPTY) {
        return None;
    }
    Some(format!("{}<array><string>{identifier}</string></array>{}", &plist[..start], &plist[start + EMPTY.len()..]))
}

#[cfg(target_os = "macos")]
fn associate_bundle(app: &AppHandle) {
    let Some(home) = std::env::var_os("HOME") else { return };
    let name = &app.package_info().name;
    let plist = std::path::PathBuf::from(home).join("Library").join("LaunchAgents").join(format!("{name}.plist"));
    let Ok(text) = std::fs::read_to_string(&plist) else { return };
    if let Some(fixed) = with_bundle_id(&text, &app.config().identifier) {
        if let Err(err) = std::fs::write(&plist, fixed) {
            crate::log::line(format!("autostart: could not name the app in the LaunchAgent: {err}"));
        }
    }
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
    fn names_the_bundle_in_an_empty_identifier_list_only() {
        let plist = "<dict>\n  <key>Label</key>\n  <string>Session Buddy</string>\n  <key>AssociatedBundleIdentifiers</key>\n  <array></array>\n  <key>RunAtLoad</key>\n  <true/>\n</dict>";
        let fixed = with_bundle_id(plist, "de.wlankin.sessionbuddy").unwrap();
        assert!(fixed.contains("<key>AssociatedBundleIdentifiers</key>\n  <array><string>de.wlankin.sessionbuddy</string></array>\n  <key>RunAtLoad</key>"));
        assert!(with_bundle_id(&fixed, "de.wlankin.sessionbuddy").is_none(), "already named: left alone");
        assert!(with_bundle_id("<dict></dict>", "x").is_none());
    }

    #[test]
    fn the_old_entry_stays_when_the_new_one_could_not_be_written() {
        assert!(should_remove_legacy(false, false), "autostart off: always removed");
        assert!(should_remove_legacy(true, true));
        assert!(!should_remove_legacy(true, false));
    }
}
