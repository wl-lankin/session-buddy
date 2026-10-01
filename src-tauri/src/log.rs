//! Plain text log next to the app's data. Stays on this machine.

use std::io::Write;

const MAX_BYTES: u64 = 5 * 1024 * 1024;

pub fn line(message: impl AsRef<str>) {
    let path = sb_common::log_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if std::fs::metadata(&path).map(|m| m.len() > MAX_BYTES).unwrap_or(false) {
        let _ = std::fs::rename(&path, path.with_extension("log.1"));
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{} {}", chrono::Local::now().format("%Y-%m-%d %H:%M:%S"), message.as_ref());
    }
}
