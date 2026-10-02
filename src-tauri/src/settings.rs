//! Preferences, plain JSON in the config dir. No secret ever lands here.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::projects;

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
    /// "claude" or "ollama".
    pub chat_provider: String,
    /// Claude alias (haiku, sonnet, opus) or a full model id.
    pub chat_model: String,
    pub chat_ollama_model: String,
    pub chat_ollama_url: String,
    /// Empty = look for the `claude` CLI in the usual places.
    pub chat_claude_path: String,
    /// "web" (web tools) or "control" (the session tools, no web).
    pub chat_mode: String,
    /// Folders the chat may start sessions in (existing directories, canonical, at most 20).
    pub chat_project_roots: Vec<String>,
    /// Background sessions running at once, 1 to 6.
    pub chat_max_workers: u32,
    /// Where started sessions run: "background", later "terminal", "iterm", "warp", "wt".
    pub chat_session_host: String,
    /// A plan from plan mode can be rejected with feedback on the island; off keeps it read-only.
    pub plan_from_island: bool,
}

pub const MAX_WORKERS: u32 = 6;
const HOSTS: [&str; 5] = ["background", "terminal", "iterm", "warp", "wt"];

impl Settings {
    /// Brings values a hand-edited file or an old front end may carry back into range. No file access.
    pub fn clamp(&mut self) {
        self.chat_max_workers = self.chat_max_workers.clamp(1, MAX_WORKERS);
        if !matches!(self.chat_mode.as_str(), "web" | "control") {
            self.chat_mode = "web".into();
        }
        if !HOSTS.contains(&self.chat_session_host.as_str()) {
            self.chat_session_host = "background".into();
        }
    }

    /// `clamp`, and the project roots reduced to existing directories (canonical, at most 20).
    pub fn normalize(&mut self) {
        self.clamp();
        self.chat_project_roots = projects::normalize_roots(&self.chat_project_roots);
    }
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
            chat_provider: "claude".into(),
            chat_model: "haiku".into(),
            chat_ollama_model: String::new(),
            chat_ollama_url: "http://localhost:11434".into(),
            chat_claude_path: String::new(),
            chat_mode: "web".into(),
            chat_project_roots: Vec::new(),
            chat_max_workers: 3,
            chat_session_host: "background".into(),
            plan_from_island: true,
        }
    }
}

fn path() -> PathBuf {
    sb_common::config_dir().join("settings.json")
}

pub fn load() -> Settings {
    let mut settings: Settings = std::fs::read(path()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    settings.clamp();
    settings
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
        assert_eq!(s.chat_provider, "claude");
        assert_eq!(s.chat_ollama_model, "");
        assert_eq!(s.chat_ollama_url, "http://localhost:11434");
        let v = serde_json::to_value(Settings::default()).unwrap();
        assert_eq!(v["chatEnabled"], false);
        assert_eq!(v["chatIdleMinutes"], 10);
        assert_eq!(v["chatClaudePath"], "");
        assert_eq!(v["chatProvider"], "claude");
        assert_eq!(v["chatOllamaModel"], "");
        assert_eq!(v["chatOllamaUrl"], "http://localhost:11434");
    }

    #[test]
    fn older_files_get_the_control_defaults() {
        let s: Settings = serde_json::from_str(r#"{"chatEnabled": true}"#).unwrap();
        assert_eq!(s.chat_mode, "web");
        assert!(s.chat_project_roots.is_empty());
        assert_eq!(s.chat_max_workers, 3);
        assert_eq!(s.chat_session_host, "background");
        let v = serde_json::to_value(Settings::default()).unwrap();
        assert_eq!(v["chatMode"], "web");
        assert_eq!(v["chatProjectRoots"], serde_json::json!([]));
        assert_eq!(v["chatMaxWorkers"], 3);
        assert_eq!(v["chatSessionHost"], "background");
    }

    #[test]
    fn older_files_get_plan_from_island_on() {
        let s: Settings = serde_json::from_str(r#"{"soundEnabled": false}"#).unwrap();
        assert!(s.plan_from_island);
        let off: Settings = serde_json::from_str(r#"{"planFromIsland": false}"#).unwrap();
        assert!(!off.plan_from_island);
        assert_eq!(serde_json::to_value(Settings::default()).unwrap()["planFromIsland"], true);
        assert_eq!(serde_json::to_value(off).unwrap()["planFromIsland"], false);
    }

    #[test]
    fn clamp_fixes_out_of_range_values() {
        let mut s = Settings { chat_max_workers: 0, chat_mode: "both".into(), chat_session_host: "rm -rf".into(), ..Settings::default() };
        s.clamp();
        assert_eq!((s.chat_max_workers, s.chat_mode.as_str(), s.chat_session_host.as_str()), (1, "web", "background"));
        s.chat_max_workers = 99;
        s.chat_mode = "control".into();
        s.chat_session_host = "iterm".into();
        s.clamp();
        assert_eq!((s.chat_max_workers, s.chat_mode.as_str(), s.chat_session_host.as_str()), (6, "control", "iterm"));
    }

    #[test]
    fn normalize_keeps_existing_folders_only() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = Settings {
            chat_project_roots: vec![dir.path().to_string_lossy().into_owned(), dir.path().join("missing").to_string_lossy().into_owned(), dir.path().to_string_lossy().into_owned()],
            ..Settings::default()
        };
        s.normalize();
        assert_eq!(s.chat_project_roots.len(), 1);
        assert!(std::path::Path::new(&s.chat_project_roots[0]).is_dir());
    }
}
