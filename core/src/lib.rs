//! session-buddy's core: everything that can be tested without a window.

pub mod adopt;
pub mod bootstrap;
pub mod branch;
pub mod claude_settings;
pub mod hub;
pub mod steps;
pub mod store;
pub mod usage;

/// Milliseconds since the Unix epoch.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
