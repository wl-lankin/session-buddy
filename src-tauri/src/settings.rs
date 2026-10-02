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
    /// What happens when a session finishes: "card", "animation" or "off".
    pub finish_style: String,
    /// The finished card only shows for turns at least this long, seconds; shorter ones get the sound and a short emote.
    pub finish_min_seconds: f64,
    /// Buddy Chat: a headless Claude Code runs only while this is on.
    pub chat_enabled: bool,
    /// The chat process stops after this many idle minutes, 0 = never.
    pub chat_idle_minutes: u32,
    pub chat_model: String,
    /// Empty = look for the `claude` CLI in the usual places.
    pub chat_claude_path: String,
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
            finish_style: "card".into(),
            finish_min_seconds: 60.0,
            chat_enabled: false,
            chat_idle_minutes: 10,
            chat_model: "haiku".into(),
            chat_claude_path: String::new(),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn older_files_get_the_default_finish_style() {
        let s: Settings = serde_json::from_str(r#"{"soundEnabled": false}"#).unwrap();
        assert_eq!(s.finish_style, "card");
        assert_eq!(s.finish_min_seconds, 60.0);
        assert!(!s.sound_enabled);
        let v = serde_json::to_value(Settings { finish_style: "off".into(), ..Settings::default() }).unwrap();
        assert_eq!(v["finishStyle"], "off");
        assert_eq!(v["finishMinSeconds"], 60.0);
    }

    #[test]
    fn older_files_get_the_chat_defaults() {
        let s: Settings = serde_json::from_str(r#"{"soundEnabled": false}"#).unwrap();
        assert!(!s.chat_enabled);
        assert_eq!(s.chat_idle_minutes, 10);
        assert_eq!(s.chat_model, "haiku");
        assert_eq!(s.chat_claude_path, "");
        let v = serde_json::to_value(Settings::default()).unwrap();
        assert_eq!(v["chatEnabled"], false);
        assert_eq!(v["chatIdleMinutes"], 10);
        assert_eq!(v["chatClaudePath"], "");
    }
}
