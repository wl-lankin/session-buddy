//! Paths and names shared by the app and the relay. Both sides must agree on
//! them byte for byte, so they live in exactly one place.

use std::path::PathBuf;

#[cfg(windows)]
mod win_user;

pub const APP_DIR: &str = "session-buddy";

fn env_dir(var: &str) -> Option<PathBuf> {
    std::env::var_os(var).filter(|v| !v.is_empty()).map(PathBuf::from)
}

pub fn home() -> PathBuf {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    env_dir(var).unwrap_or_else(|| PathBuf::from("."))
}

/// `~/.claude`, or `CLAUDE_CONFIG_DIR` when Claude Code is pointed elsewhere.
pub fn claude_dir() -> PathBuf {
    env_dir("CLAUDE_CONFIG_DIR").unwrap_or_else(|| home().join(".claude"))
}

/// %APPDATA%\session-buddy | ~/Library/Application Support/session-buddy | ~/.config/session-buddy
pub fn config_dir() -> PathBuf {
    #[cfg(windows)]
    let base = env_dir("APPDATA").unwrap_or_else(|| home().join("AppData").join("Roaming"));
    #[cfg(target_os = "macos")]
    let base = home().join("Library").join("Application Support");
    #[cfg(all(unix, not(target_os = "macos")))]
    let base = env_dir("XDG_CONFIG_HOME").unwrap_or_else(|| home().join(".config"));
    base.join(APP_DIR)
}

/// Where the relay binary lives: %LOCALAPPDATA%\session-buddy on Windows, the config dir elsewhere.
pub fn local_dir() -> PathBuf {
    #[cfg(windows)]
    {
        env_dir("LOCALAPPDATA")
            .unwrap_or_else(|| home().join("AppData").join("Local"))
            .join(APP_DIR)
    }
    #[cfg(not(windows))]
    {
        config_dir()
    }
}

pub fn relay_path() -> PathBuf {
    let name = if cfg!(windows) { "sb-relay.exe" } else { "sb-relay" };
    local_dir().join("bin").join(name)
}

pub fn log_path() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        home().join("Library").join("Logs").join("session-buddy.log")
    }
    #[cfg(not(target_os = "macos"))]
    {
        local_dir().join("session-buddy.log")
    }
}

/// Distinguishes OS users sharing one machine: the SID on Windows, the user name elsewhere.
pub fn user_key() -> String {
    #[cfg(windows)]
    if let Some(sid) = win_user::current_user_sid() {
        return sid;
    }
    std::env::var(if cfg!(windows) { "USERNAME" } else { "USER" }).unwrap_or_else(|_| "user".into())
}

#[cfg(windows)]
pub fn pipe_name(key: &str) -> String {
    format!(r"\\.\pipe\session-buddy-{key}")
}

#[cfg(unix)]
pub fn socket_path() -> PathBuf {
    config_dir().join("sb.sock")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_dir_ends_with_app_dir() {
        assert!(config_dir().ends_with(APP_DIR));
    }

    #[test]
    fn relay_lives_in_bin() {
        let p = relay_path();
        assert_eq!(p.parent().unwrap().file_name().unwrap(), "bin");
        let name = p.file_name().unwrap().to_string_lossy().to_string();
        assert_eq!(name, if cfg!(windows) { "sb-relay.exe" } else { "sb-relay" });
    }

    #[test]
    fn claude_dir_respects_override() {
        std::env::set_var("CLAUDE_CONFIG_DIR", "/tmp/xyz-claude");
        assert_eq!(claude_dir(), PathBuf::from("/tmp/xyz-claude"));
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        assert!(claude_dir().ends_with(".claude"));
    }

    #[test]
    fn user_key_is_not_empty() {
        assert!(!user_key().is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn pipe_name_is_per_user() {
        assert_eq!(pipe_name("S-1-5-21-1"), r"\\.\pipe\session-buddy-S-1-5-21-1");
    }

    #[cfg(unix)]
    #[test]
    fn socket_is_in_config_dir() {
        assert_eq!(socket_path(), config_dir().join("sb.sock"));
        // macOS limits AF_UNIX paths to 104 bytes.
        assert!(socket_path().to_string_lossy().len() < 104);
    }
}
