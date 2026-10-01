//! Keeps `Shared.usage` current: status-line rate limits when fresh, otherwise
//! Claude Code's own usage endpoint with Claude Code's own login token.

use std::time::Duration;

use sb_core::now_ms;
use sb_core::usage::{self, Account, Plan, UsageSource};
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::{log, Shared};

const ENDPOINT: &str = "https://api.anthropic.com/api/oauth/usage";

fn read_account() -> Option<Account> {
    let path = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(|d| std::path::PathBuf::from(d).join(".claude.json"))
        .unwrap_or_else(|| sb_common::home().join(".claude.json"));
    let bytes = std::fs::read(path).ok()?;
    usage::parse_account(&serde_json::from_slice::<Value>(&bytes).ok()?)
}

/// Read fresh on every fetch and never stored, so `/login` to another account is picked up.
fn read_token() -> Option<String> {
    if let Ok(bytes) = std::fs::read(sb_common::claude_dir().join(".credentials.json")) {
        if let Some(t) = serde_json::from_slice::<Value>(&bytes).ok().and_then(|v| usage::token_from_credentials(&v)) {
            return Some(t);
        }
    }
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("security")
            .args(["find-generic-password", "-s", "Claude Code-credentials", "-w"])
            .output()
            .ok()?;
        if out.status.success() {
            let v: Value = serde_json::from_slice(&out.stdout).ok()?;
            return usage::token_from_credentials(&v);
        }
    }
    None
}

async fn fetch(client: &reqwest::Client) -> Result<Value, String> {
    // File reads and (on macOS) the Keychain prompt block: keep them off the async workers.
    let token = tokio::task::spawn_blocking(read_token).await.ok().flatten().ok_or_else(|| "Not logged in to Claude Code".to_string())?;
    let resp = client
        .get(ENDPOINT)
        .bearer_auth(token)
        .header("Accept", "application/json")
        .header("anthropic-beta", "oauth-2025-04-20")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("usage endpoint returned {}", resp.status().as_u16()));
    }
    resp.json::<Value>().await.map_err(|e| e.to_string())
}

pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let client = match reqwest::Client::builder().timeout(Duration::from_secs(10)).build() {
            Ok(c) => c,
            Err(err) => {
                log::line(format!("usage client: {err}"));
                return;
            }
        };
        let mut last_fetch = i64::MIN / 2;
        let mut last_source = UsageSource::None;
        loop {
            let now = now_ms();
            let shared = app.state::<Shared>();
            let rate_limits = shared.hub.store.lock().unwrap().rate_limits.clone();
            let account = tokio::task::spawn_blocking(read_account).await.ok().flatten();
            match usage::decide(rate_limits.as_ref(), last_fetch, now) {
                Plan::UseStatusline(v, at) => usage::apply_statusline(&mut shared.usage.lock().unwrap(), &v, at),
                Plan::Fetch => {
                    last_fetch = now;
                    let result = fetch(&client).await;
                    let mut u = shared.usage.lock().unwrap();
                    match result {
                        Ok(v) => usage::apply_oauth(&mut u, &v, now),
                        Err(e) => usage::apply_error(&mut u, e),
                    }
                }
                Plan::Keep => {}
            }
            let source = {
                let mut u = shared.usage.lock().unwrap();
                u.account = account;
                u.source
            };
            if source != last_source {
                log::line(format!("usage source {source:?}"));
                last_source = source;
            }
            crate::mark_dirty();
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
    });
}
