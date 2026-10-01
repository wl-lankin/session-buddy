//! Adding and removing session-buddy's entries in ~/.claude/settings.json.
//! Only entries whose command contains MARKER are ever touched.

use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

pub const MARKER: &str = "sb-relay";

/// Every event the island reacts to, with the hook timeout written to settings.json.
pub const HOOK_EVENTS: &[(&str, u64)] = &[
    ("SessionStart", 10),
    ("SessionEnd", 10),
    ("UserPromptSubmit", 10),
    ("PreToolUse", 600),
    ("PostToolUse", 10),
    ("PostToolUseFailure", 10),
    ("PermissionRequest", 120),
    ("Notification", 10),
    ("Stop", 600),
    ("StopFailure", 10),
    ("SubagentStart", 10),
    ("SubagentStop", 10),
];

pub struct Installed {
    pub settings: Value,
    /// The user's own statusLine, when this install replaced it. None when there
    /// was none, or when ours was already in place (keep the saved one then).
    pub saved_status_line: Option<Value>,
}

fn command_is_ours(v: &Value) -> bool {
    v.get("command").and_then(Value::as_str).map(|c| c.contains(MARKER)).unwrap_or(false)
}

fn entry_is_ours(entry: &Value) -> bool {
    entry
        .get("hooks")
        .and_then(Value::as_array)
        .map(|hooks| hooks.iter().any(command_is_ours))
        .unwrap_or(false)
}

/// Removes only our inner hooks; an entry is dropped only when nothing else is left in it.
fn strip_ours(list: &[Value]) -> Vec<Value> {
    let mut kept = Vec::new();
    for entry in list {
        let Some(inner) = entry.get("hooks").and_then(Value::as_array) else {
            kept.push(entry.clone());
            continue;
        };
        let rest: Vec<Value> = inner.iter().filter(|h| !command_is_ours(h)).cloned().collect();
        if rest.len() == inner.len() {
            kept.push(entry.clone());
        } else if !rest.is_empty() {
            let mut e = entry.clone();
            if let Some(obj) = e.as_object_mut() {
                obj.insert("hooks".into(), Value::Array(rest));
            }
            kept.push(e);
        }
    }
    kept
}

fn hook_command(relay: &str, event: &str) -> String {
    format!("\"{relay}\" hook {event}")
}

pub fn status_line_command(relay: &str, original: Option<&Value>) -> String {
    match original.and_then(|o| o.get("command")).and_then(Value::as_str).map(str::trim).filter(|c| !c.is_empty()) {
        Some(cmd) if cmd.contains(['&', '|', ';']) => format!("\"{relay}\" statusline | ({cmd})"),
        Some(cmd) => format!("\"{relay}\" statusline | {cmd}"),
        None => format!("\"{relay}\" statusline --quiet"),
    }
}

pub fn install(existing: &Value, relay: &str) -> Installed {
    let mut root = existing.as_object().cloned().unwrap_or_default();
    let mut hooks = root.get("hooks").and_then(Value::as_object).cloned().unwrap_or_else(Map::new);
    for (event, timeout) in HOOK_EVENTS {
        let existing_list = hooks.get(*event).and_then(Value::as_array).cloned().unwrap_or_default();
        let mut list = strip_ours(&existing_list);
        list.push(json!({"hooks": [{"type": "command", "command": hook_command(relay, event), "timeout": timeout}]}));
        hooks.insert((*event).to_string(), Value::Array(list));
    }
    root.insert("hooks".into(), Value::Object(hooks));

    let current = root.get("statusLine").cloned();
    let saved_status_line = match &current {
        Some(sl) if command_is_ours(sl) => None,
        other => other.clone(),
    };
    let original = match &current {
        Some(sl) if command_is_ours(sl) => None,
        other => other.as_ref(),
    };
    if !current.as_ref().map(command_is_ours).unwrap_or(false) {
        let mut sl = Map::new();
        sl.insert("type".into(), json!("command"));
        sl.insert("command".into(), json!(status_line_command(relay, original)));
        if let Some(padding) = original.and_then(|o| o.get("padding")) {
            sl.insert("padding".into(), padding.clone());
        }
        root.insert("statusLine".into(), Value::Object(sl));
    }
    Installed { settings: Value::Object(root), saved_status_line }
}

pub fn uninstall(existing: &Value, saved: Option<&Value>) -> Value {
    let mut root = existing.as_object().cloned().unwrap_or_default();
    if let Some(hooks) = root.get("hooks").and_then(Value::as_object).cloned() {
        let mut out = Map::new();
        for (event, value) in hooks {
            match value.as_array() {
                Some(list) => {
                    let kept = strip_ours(list);
                    if !kept.is_empty() {
                        out.insert(event, Value::Array(kept));
                    }
                }
                None => {
                    out.insert(event, value);
                }
            }
        }
        if out.is_empty() {
            root.shift_remove("hooks");
        } else {
            root.insert("hooks".into(), Value::Object(out));
        }
    }
    if root.get("statusLine").map(command_is_ours).unwrap_or(false) {
        match saved {
            Some(original) => {
                root.insert("statusLine".into(), original.clone());
            }
            None => {
                root.shift_remove("statusLine");
            }
        }
    }
    Value::Object(root)
}

pub fn hooks_installed(v: &Value) -> bool {
    v.get("hooks")
        .and_then(Value::as_object)
        .map(|h| h.values().filter_map(Value::as_array).flatten().any(entry_is_ours))
        .unwrap_or(false)
}

pub fn status_line_installed(v: &Value) -> bool {
    v.get("statusLine").map(command_is_ours).unwrap_or(false)
}

pub fn parse_settings(bytes: &[u8]) -> Result<Value, String> {
    let b = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    if b.iter().all(|c| c.is_ascii_whitespace()) {
        return Ok(json!({}));
    }
    let v: Value = serde_json::from_slice(b)
        .map_err(|e| format!("settings.json is not valid JSON ({e}). Nothing was changed."))?;
    if !v.is_object() {
        return Err("settings.json is not a JSON object. Nothing was changed.".into());
    }
    Ok(v)
}

pub fn pretty(v: &Value) -> String {
    serde_json::to_string_pretty(v).unwrap_or_default()
}

/// FNV-1a: only answers "is this still the file I showed the user?".
pub fn fingerprint(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
    format!("{hash:016x}")
}

pub fn write_atomic(path: &Path, next: &Value, expected_fingerprint: &str) -> Result<PathBuf, String> {
    let dir = path.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let current = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(format!("cannot read {}: {e}", path.display())),
    };
    if fingerprint(&current) != expected_fingerprint {
        return Err(format!("{} changed since the preview. Nothing was written. Review the new diff.", path.display()));
    }
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let mut backup = path.with_file_name(format!("{name}.bak-{stamp}"));
    if !current.is_empty() || path.exists() {
        let mut n = 1u32;
        let mut file = loop {
            match std::fs::OpenOptions::new().write(true).create_new(true).open(&backup) {
                Ok(f) => break f,
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    n += 1;
                    backup = path.with_file_name(format!("{name}.bak-{stamp}-{n}"));
                }
                Err(e) => return Err(format!("backup failed: {e}")),
            }
        };
        std::io::Write::write_all(&mut file, &current).map_err(|e| format!("backup failed: {e}"))?;
    }
    let mut text = pretty(next);
    text.push('\n');
    let temp = path.with_file_name(format!("{name}.sb-{}", std::process::id()));
    std::fs::write(&temp, text.as_bytes()).map_err(|e| format!("write failed: {e}"))?;
    if let Err(err) = std::fs::rename(&temp, path) {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("write failed: {err}"));
    }
    Ok(backup)
}

/// settings.json is short, so a plain O(n*m) LCS is the simplest honest diff.
pub fn unified_diff(before: &str, after: &str) -> String {
    let a: Vec<&str> = before.lines().collect();
    let b: Vec<&str> = after.lines().collect();
    let (n, m) = (a.len(), b.len());

    let mut lcs = vec![vec![0usize; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            lcs[i][j] = if a[i] == b[j] {
                lcs[i + 1][j + 1] + 1
            } else {
                lcs[i + 1][j].max(lcs[i][j + 1])
            };
        }
    }

    let mut out: Vec<String> = Vec::new();
    let (mut i, mut j) = (0usize, 0usize);
    while i < n && j < m {
        if a[i] == b[j] {
            out.push(format!("  {}", a[i]));
            i += 1;
            j += 1;
        } else if lcs[i + 1][j] >= lcs[i][j + 1] {
            out.push(format!("- {}", a[i]));
            i += 1;
        } else {
            out.push(format!("+ {}", b[j]));
            j += 1;
        }
    }
    while i < n {
        out.push(format!("- {}", a[i]));
        i += 1;
    }
    while j < m {
        out.push(format!("+ {}", b[j]));
        j += 1;
    }

    // Keep three lines of context around each change so the panel stays readable.
    let changed: Vec<usize> = out
        .iter()
        .enumerate()
        .filter(|(_, l)| l.starts_with('+') || l.starts_with('-'))
        .map(|(i, _)| i)
        .collect();
    if changed.is_empty() {
        return "No change.".into();
    }
    let mut keep = vec![false; out.len()];
    for idx in changed {
        let lo = idx.saturating_sub(3);
        let hi = (idx + 4).min(out.len());
        keep[lo..hi].fill(true);
    }
    let mut result = String::new();
    let mut gap = false;
    for (idx, line) in out.iter().enumerate() {
        if keep[idx] {
            result.push_str(line);
            result.push('\n');
            gap = false;
        } else if !gap {
            result.push_str("  …\n");
            gap = true;
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    const RELAY: &str = "C:/Users/w/AppData/Local/session-buddy/bin/sb-relay.exe";

    fn user_settings() -> Value {
        json!({
            "model": "opus",
            "hooks": {
                "PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "my-guard.sh"}]}],
                "Stop": [{"hooks": [{"type": "command", "command": "\"C:/x/coucou-hook.exe\" Stop"}]}]
            },
            "statusLine": {"type": "command", "command": "python ~/.claude/statusline.py", "padding": 0},
            "permissions": {"allow": ["Bash(ls:*)"]}
        })
    }

    #[test]
    fn install_adds_hooks_and_keeps_user_entries() {
        let out = install(&user_settings(), RELAY);
        let hooks = &out.settings["hooks"];
        assert_eq!(hooks["PreToolUse"].as_array().unwrap().len(), 2);
        assert_eq!(hooks["PreToolUse"][0]["hooks"][0]["command"], "my-guard.sh");
        assert_eq!(hooks["PreToolUse"][1]["hooks"][0]["command"], format!("\"{RELAY}\" hook PreToolUse"));
        assert_eq!(hooks["PreToolUse"][1]["hooks"][0]["timeout"], 600);
        assert_eq!(hooks["PermissionRequest"][0]["hooks"][0]["timeout"], 120);
        assert_eq!(hooks["Stop"][0]["hooks"][0]["command"], "\"C:/x/coucou-hook.exe\" Stop", "foreign hooks untouched");
        for (event, _) in HOOK_EVENTS {
            assert!(hooks[*event].as_array().unwrap().iter().any(|e| e.to_string().contains(MARKER)), "{event}");
        }
        assert!(hooks_installed(&out.settings));
        assert!(!hooks_installed(&user_settings()));
    }

    #[test]
    fn install_wraps_the_existing_status_line() {
        let out = install(&user_settings(), RELAY);
        assert_eq!(out.settings["statusLine"]["command"], format!("\"{RELAY}\" statusline | python ~/.claude/statusline.py"));
        assert_eq!(out.settings["statusLine"]["padding"], 0);
        assert_eq!(out.saved_status_line, Some(user_settings()["statusLine"].clone()));
        assert!(status_line_installed(&out.settings));
    }

    #[test]
    fn install_without_status_line_uses_quiet_mode() {
        let out = install(&json!({}), RELAY);
        assert_eq!(out.settings["statusLine"], json!({"type": "command", "command": format!("\"{RELAY}\" statusline --quiet")}));
        assert!(out.saved_status_line.is_none());
    }

    #[test]
    fn install_is_idempotent() {
        let once = install(&user_settings(), RELAY);
        let twice = install(&once.settings, RELAY);
        assert_eq!(pretty(&once.settings), pretty(&twice.settings));
        assert!(twice.saved_status_line.is_none(), "must not overwrite the saved original with our own wrapper");
    }

    #[test]
    fn round_trip_restores_original() {
        let original = user_settings();
        let installed = install(&original, RELAY);
        let back = uninstall(&installed.settings, installed.saved_status_line.as_ref());
        assert_eq!(pretty(&back), pretty(&original));
    }

    #[test]
    fn round_trip_without_status_line_or_hooks() {
        let original = json!({"model": "sonnet"});
        let installed = install(&original, RELAY);
        let back = uninstall(&installed.settings, None);
        assert_eq!(pretty(&back), pretty(&original));
    }

    #[test]
    fn status_line_with_operators_is_grouped() {
        let orig = json!({"type": "command", "command": "cd ~ && node sl.js"});
        assert_eq!(status_line_command(RELAY, Some(&orig)), format!("\"{RELAY}\" statusline | (cd ~ && node sl.js)"));
        assert_eq!(status_line_command(RELAY, None), format!("\"{RELAY}\" statusline --quiet"));
    }

    #[test]
    fn parse_rejects_non_objects_and_accepts_empty() {
        assert_eq!(parse_settings(b"").unwrap(), json!({}));
        assert_eq!(parse_settings(b"  \n").unwrap(), json!({}));
        assert_eq!(parse_settings(b"\xEF\xBB\xBF{\"a\":1}").unwrap(), json!({"a": 1}));
        assert!(parse_settings(b"[1]").is_err());
        assert!(parse_settings(b"{nope").is_err());
    }

    #[test]
    fn diff_shows_added_lines() {
        let d = unified_diff("{\n  \"a\": 1\n}", "{\n  \"a\": 1,\n  \"b\": 2\n}");
        assert!(d.contains("+   \"b\": 2"), "{d}");
    }

    #[test]
    fn write_atomic_backs_up_and_checks_fingerprint() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, b"{\"a\":1}").unwrap();
        let fp = fingerprint(b"{\"a\":1}");
        assert!(write_atomic(&path, &json!({"b": 2}), "stale-fingerprint").is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"a\":1}", "nothing written on mismatch");
        let backup = write_atomic(&path, &json!({"b": 2}), &fp).unwrap();
        assert_eq!(std::fs::read_to_string(&backup).unwrap(), "{\"a\":1}");
        assert!(backup.file_name().unwrap().to_string_lossy().starts_with("settings.json.bak-"));
        assert_eq!(parse_settings(&std::fs::read(&path).unwrap()).unwrap(), json!({"b": 2}));
    }

    #[test]
    fn install_and_uninstall_keep_foreign_sibling_hooks() {
        let foreign = json!({"type": "command", "command": "my-guard.sh"});
        let ours = json!({"type": "command", "command": "\"x/sb-relay.exe\" hook PreToolUse"});
        let original = json!({"hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [foreign.clone(), ours]}]}});
        assert!(hooks_installed(&original));
        let installed = install(&original, RELAY);
        let list = installed.settings["hooks"]["PreToolUse"].as_array().unwrap();
        assert_eq!(list[0], json!({"matcher": "Bash", "hooks": [foreign.clone()]}));
        let back = uninstall(&installed.settings, installed.saved_status_line.as_ref());
        assert_eq!(back["hooks"]["PreToolUse"], json!([{"matcher": "Bash", "hooks": [foreign.clone()]}]));
        let clean = json!({"hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [foreign]}]}});
        let rt = uninstall(&install(&clean, RELAY).settings, None);
        assert_eq!(pretty(&rt), pretty(&clean));
    }

    #[test]
    fn two_writes_in_one_second_keep_both_backups() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, b"{\"a\":1}").unwrap();
        let b1 = write_atomic(&path, &json!({"b": 2}), &fingerprint(b"{\"a\":1}")).unwrap();
        let now = std::fs::read(&path).unwrap();
        let b2 = write_atomic(&path, &json!({"c": 3}), &fingerprint(&now)).unwrap();
        assert_ne!(b1, b2);
        assert_eq!(std::fs::read_to_string(&b1).unwrap(), "{\"a\":1}");
        assert_eq!(std::fs::read(&b2).unwrap(), now);
    }

    #[test]
    fn failed_write_leaves_original_intact() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, b"{\"a\":1}").unwrap();
        let blocker = dir.path().join(format!("settings.json.sb-{}", std::process::id()));
        std::fs::create_dir(&blocker).unwrap();
        assert!(write_atomic(&path, &json!({"b": 2}), &fingerprint(b"{\"a\":1}")).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"a\":1}");
    }

    #[test]
    fn write_atomic_creates_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("settings.json");
        write_atomic(&path, &json!({"x": 1}), &fingerprint(b"")).unwrap();
        assert!(path.exists());
    }
}
