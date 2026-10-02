//! Turns the raw hook JSON from stdin into the line we forward to the app,
//! keeping the untouched original for building the answer later.

use serde_json::Value;

use crate::output::{wait_kind, WaitKind};

const MAX_FIELD_LEN: usize = 2_000;
/// ExitPlanMode's plan is shown on the island, so it may be longer than other fields.
const MAX_PLAN_LEN: usize = 8_000;
/// A command's output is only shown by its end ("Tests: 48 passed"): keep that much of each stream.
const MAX_OUTPUT_TAIL: usize = 1_500;

pub struct Prepared {
    pub line: String,
    pub original: Value,
    pub wait: Option<WaitKind>,
}

pub fn prepare(
    raw: &[u8],
    arg_event: &str,
    cwd: &str,
    term_program: &str,
    plan_wait: bool,
    claude_pid: impl FnOnce() -> Option<u32>,
) -> Option<Prepared> {
    let bytes = raw.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(raw);
    if bytes.is_empty() {
        return None;
    }
    let mut original: Value = serde_json::from_slice(bytes).ok()?;
    let map = original.as_object_mut()?;

    let has_event = map
        .get("hook_event_name")
        .and_then(Value::as_str)
        .map(|s| !s.is_empty())
        .unwrap_or(false);
    if !has_event {
        map.insert("hook_event_name".into(), Value::String(arg_event.to_string()));
    }
    let cwd_missing = map.get("cwd").and_then(Value::as_str).map(str::is_empty).unwrap_or(true);
    if cwd_missing && !cwd.is_empty() {
        map.insert("cwd".into(), Value::String(cwd.to_string()));
    }

    let wait = wait_kind(&original, plan_wait);

    let mut fwd = original.clone();
    let fmap = fwd.as_object_mut()?;
    fmap.remove("transcript_path");
    // Agents need their id and description; commands only the end of their output.
    match fmap.get("tool_name").and_then(Value::as_str) {
        Some("Agent") | Some("Task") => {}
        Some("Bash") | Some("PowerShell") => {
            if let Some(resp) = fmap.remove("tool_response") {
                fmap.insert("tool_response".into(), output_tails(&resp));
            }
        }
        _ => {
            fmap.remove("tool_response");
        }
    }
    fmap.insert("term_program".into(), Value::String(term_program.to_string()));
    fmap.insert("sb_kind".into(), Value::String("hook".into()));
    fmap.insert(
        "sb_wait".into(),
        wait.map(|k| Value::String(k.as_str().into())).unwrap_or(Value::Null),
    );
    // Every event carries the Claude Code pid: the per-hop lookup is cheap, and a
    // session seen only through tool events still gets dropped when its process ends.
    if let Some(pid) = claude_pid() {
        fmap.insert("sb_claude_pid".into(), Value::from(pid));
    }
    let plan = if fwd.get("tool_name").and_then(Value::as_str) == Some("ExitPlanMode") {
        fwd.pointer_mut("/tool_input/plan").map(Value::take)
    } else {
        None
    };
    truncate_strings(&mut fwd);
    if let (Some(Value::String(p)), Some(input)) = (plan, fwd.get_mut("tool_input").and_then(Value::as_object_mut)) {
        input.insert("plan".into(), Value::String(cap(p, MAX_PLAN_LEN)));
    }

    let mut line = fwd.to_string();
    line.push('\n');
    Some(Prepared { line, original, wait })
}

/// The end of each output stream; truncate_strings would keep the start instead.
fn output_tails(resp: &Value) -> Value {
    let tail = |s: &str| {
        let n = s.chars().count();
        if n <= MAX_OUTPUT_TAIL {
            return s.to_string();
        }
        let cut: String = s.chars().skip(n - MAX_OUTPUT_TAIL).collect();
        format!("\u{2026}{cut}")
    };
    match resp {
        Value::String(s) => Value::String(tail(s)),
        Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for key in ["stdout", "stderr"] {
                if let Some(s) = map.get(key).and_then(Value::as_str) {
                    out.insert(key.into(), Value::String(tail(s)));
                }
            }
            Value::Object(out)
        }
        _ => Value::Null,
    }
}

fn cap(s: String, max: usize) -> String {
    if s.chars().count() <= max {
        return s;
    }
    let cut: String = s.chars().take(max).collect();
    cut + "\u{2026}"
}

/// Caps every string. A single Write can carry a whole file.
pub fn truncate_strings(value: &mut Value) {
    match value {
        Value::String(s) => *s = cap(std::mem::take(s), MAX_FIELD_LEN),
        Value::Array(items) => items.iter_mut().for_each(truncate_strings),
        Value::Object(map) => map.values_mut().for_each(truncate_strings),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn no_pid() -> Option<u32> {
        None
    }

    fn fwd(p: &Prepared) -> Value {
        assert!(p.line.ends_with('\n'));
        serde_json::from_str(p.line.trim_end()).unwrap()
    }

    #[test]
    fn strips_bom_and_fills_event_cwd_and_terminal() {
        let mut raw = vec![0xEF, 0xBB, 0xBF];
        raw.extend_from_slice(br#"{"session_id":"s1","transcript_path":"x"}"#);
        let p = prepare(&raw, "SessionStart", "C:/work", "WarpTerminal", false, no_pid).unwrap();
        let v = fwd(&p);
        assert_eq!(v["hook_event_name"], "SessionStart");
        assert_eq!(v["cwd"], "C:/work");
        assert_eq!(v["term_program"], "WarpTerminal");
        assert_eq!(v["sb_kind"], "hook");
        assert!(v["sb_wait"].is_null());
        assert!(v.get("transcript_path").is_none());
        assert!(p.wait.is_none());
    }

    #[test]
    fn keeps_tool_response_only_for_agents_and_command_output() {
        let raw = br#"{"hook_event_name":"PostToolUse","tool_name":"Read","tool_response":{"file":{"content":"secret"}}}"#;
        assert!(fwd(&prepare(raw, "", "", "", false, no_pid).unwrap()).get("tool_response").is_none());
        let raw = br#"{"hook_event_name":"PostToolUse","tool_name":"Agent","tool_response":{"agentId":"a1","description":"d"}}"#;
        assert_eq!(fwd(&prepare(raw, "", "", "", false, no_pid).unwrap())["tool_response"]["agentId"], "a1");
        let raw = br#"{"hook_event_name":"PostToolUse","tool_name":"Bash","tool_response":{"stdout":"ok","stderr":"","interrupted":false}}"#;
        assert_eq!(fwd(&prepare(raw, "", "", "", false, no_pid).unwrap())["tool_response"], json!({"stdout": "ok", "stderr": ""}));
    }

    #[test]
    fn command_output_keeps_its_end() {
        let out = format!("{}END", "x".repeat(5_000));
        let raw = json!({"hook_event_name": "PostToolUse", "tool_name": "Bash", "tool_response": {"stdout": out}}).to_string();
        let stdout = fwd(&prepare(raw.as_bytes(), "", "", "", false, no_pid).unwrap())["tool_response"]["stdout"].as_str().unwrap().to_string();
        assert!(stdout.ends_with("END"));
        assert_eq!(stdout.chars().count(), MAX_OUTPUT_TAIL + 1);
    }

    #[test]
    fn marks_waits_and_keeps_untruncated_original() {
        let long = "x".repeat(5_000);
        let raw = serde_json::to_vec(&json!({
            "hook_event_name":"PreToolUse","tool_name":"AskUserQuestion",
            "tool_input":{"questions":[{"question": long}]}
        })).unwrap();
        let p = prepare(&raw, "", "", "", false, no_pid).unwrap();
        assert_eq!(p.wait, Some(WaitKind::Question));
        assert_eq!(fwd(&p)["sb_wait"], "question");
        let forwarded = fwd(&p)["tool_input"]["questions"][0]["question"].as_str().unwrap().to_string();
        assert!(forwarded.chars().count() <= MAX_FIELD_LEN + 1);
        assert_eq!(p.original["tool_input"]["questions"][0]["question"].as_str().unwrap().len(), 5_000);
    }

    #[test]
    fn exit_plan_mode_keeps_a_longer_plan() {
        let raw = serde_json::to_vec(&json!({
            "hook_event_name":"PreToolUse","tool_name":"ExitPlanMode",
            "tool_input":{"plan": "p".repeat(10_000), "other": "o".repeat(5_000)}
        })).unwrap();
        let v = fwd(&prepare(&raw, "", "", "", false, no_pid).unwrap());
        assert_eq!(v["tool_input"]["plan"].as_str().unwrap().chars().count(), MAX_PLAN_LEN + 1);
        assert_eq!(v["tool_input"]["other"].as_str().unwrap().chars().count(), MAX_FIELD_LEN + 1);
        let raw = serde_json::to_vec(&json!({"hook_event_name":"PreToolUse","tool_name":"Write","tool_input":{"plan": "p".repeat(5_000)}})).unwrap();
        let v = fwd(&prepare(&raw, "", "", "", false, no_pid).unwrap());
        assert_eq!(v["tool_input"]["plan"].as_str().unwrap().chars().count(), MAX_FIELD_LEN + 1, "only ExitPlanMode");
    }

    #[test]
    fn a_plan_is_marked_for_waiting_only_with_the_setting() {
        let raw = br#"{"hook_event_name":"PermissionRequest","tool_name":"ExitPlanMode","tool_input":{"plan":"p"}}"#;
        let off = prepare(raw, "", "", "", false, no_pid).unwrap();
        assert_eq!((off.wait, fwd(&off)["sb_wait"].is_null()), (None, true));
        let on = prepare(raw, "", "", "", true, no_pid).unwrap();
        assert_eq!(on.wait, Some(WaitKind::Permission));
        assert_eq!(fwd(&on)["sb_wait"], "permission");
    }

    #[test]
    fn rejects_garbage() {
        assert!(prepare(b"", "Stop", "", "", false, no_pid).is_none());
        assert!(prepare(b"not json", "Stop", "", "", false, no_pid).is_none());
        assert!(prepare(b"[1,2]", "Stop", "", "", false, no_pid).is_none());
    }

    #[test]
    fn claude_pid_on_every_event() {
        for event in ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "SubagentStop", "Notification", "Stop"] {
            let p = prepare(br#"{"session_id":"s1"}"#, event, "", "", false, || Some(4242)).unwrap();
            assert_eq!(fwd(&p)["sb_claude_pid"], 4242, "{event}");
        }
        let p = prepare(br#"{"session_id":"s1"}"#, "PreToolUse", "", "", false, no_pid).unwrap();
        assert!(fwd(&p).get("sb_claude_pid").is_none(), "no pid, no field");
    }

    #[test]
    fn truncates_on_char_boundary() {
        let mut v = json!({"a": "\u{e9}".repeat(3_000)});
        truncate_strings(&mut v);
        let s = v["a"].as_str().unwrap();
        assert!(s.ends_with('\u{2026}'));
        assert_eq!(s.chars().count(), MAX_FIELD_LEN + 1);
    }
}
