//! Preferences, plain JSON in the config dir. No secret ever lands here.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub sound_enabled: bool,
    pub sound_volume: f64,
    /// Expanded -> compact after the mouse leaves, seconds.
    pub auto_close_interval: f64,
    /// Compact -> strip after the mouse leaves, seconds.
    pub compact_interval: f64,
    pub stale_minutes: u32,
    pub remove_minutes: u32,
    /// "primary" or "cursor".
    pub screen: String,
    pub autostart: bool,
    pub hotkey: String,
    /// Play a sound when a session crosses 90 % context.
    pub context_sound: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            sound_enabled: true,
            sound_volume: 0.12,
            auto_close_interval: 15.0,
            compact_interval: 6.0,
            stale_minutes: 10,
            remove_minutes: 120,
            screen: "primary".into(),
            autostart: false,
            hotkey: "Ctrl+Alt+Space".into(),
            context_sound: true,
        }
    }
}

fn path() -> PathBuf {
    sb_common::config_dir().join("settings.json")
}

pub fn load() -> Settings {
    std::fs::read(path()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

pub fn save(settings: &Settings) -> std::io::Result<()> {
    std::fs::create_dir_all(sb_common::config_dir())?;
    let json = serde_json::to_vec_pretty(settings).map_err(std::io::Error::other)?;
    std::fs::write(path(), json)
}
