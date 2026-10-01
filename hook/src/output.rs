//! What the relay prints for Claude Code once a human answered on the island.
//! Anything unexpected prints nothing: silence hands the question back to the
//! terminal, which is always safe.

use serde_json::{json, Value};
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WaitKind {
    Permission,
    Question,
    Reply,
}

impl WaitKind {
    pub fn as_str(self) -> &'static str {
        match self {
            WaitKind::Permission => "permission",
            WaitKind::Question => "question",
            WaitKind::Reply => "reply",
        }
    }

    /// A little longer than the app's own deadline, so the app always decides first.
    pub fn budget(self) -> Duration {
        match self {
            WaitKind::Permission => Duration::from_secs(112),
            WaitKind::Question | WaitKind::Reply => Duration::from_secs(545),
        }
    }
}

/// The three cases where a human can answer from the island. Everything else is fire-and-forget.
pub fn wait_kind(payload: &Value) -> Option<WaitKind> {
    match payload.get("hook_event_name")?.as_str()? {
        // Claude Code ignores a hook "allow" for ExitPlanMode and shows its own plan dialog anyway.
        "PermissionRequest" if payload.get("tool_name").and_then(Value::as_str) == Some("ExitPlanMode") => None,
        "PermissionRequest" => Some(WaitKind::Permission),
        "PreToolUse" if payload.get("tool_name").and_then(Value::as_str) == Some("AskUserQuestion") => {
            Some(WaitKind::Question)
        }
        "Stop" => {
            if payload.get("stop_hook_active").and_then(Value::as_bool).unwrap_or(false) {
                return None;
            }
            let msg = payload.get("last_assistant_message")?.as_str()?;
            let trimmed = msg.trim_end_matches(|c: char| c.is_whitespace() || "*_`)\"'".contains(c));
            trimmed.ends_with('?').then_some(WaitKind::Reply)
        }
        _ => None,
    }
}

/// Claude Code's documented hook output for each kind, or None to stay silent.
pub fn hook_output(kind: WaitKind, original: &Value, answer: &Value) -> Option<String> {
    match kind {
        WaitKind::Permission => {
            let decision = match answer.get("behavior")?.as_str()? {
                "allow" => json!({"behavior": "allow"}),
                "deny" => json!({"behavior": "deny", "message": "Denied from session-buddy"}),
                _ => return None,
            };
            Some(
                json!({"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": decision}})
                    .to_string(),
            )
        }
        WaitKind::Question => {
            let answers = answer.get("answers")?.as_object()?;
            if answers.is_empty() || !answers.values().all(Value::is_string) {
                return None;
            }
            let mut input = original.get("tool_input")?.clone();
            input.as_object_mut()?.insert("answers".into(), Value::Object(answers.clone()));
            Some(
                json!({"hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "allow",
                    "updatedInput": input
                }})
                .to_string(),
            )
        }
        WaitKind::Reply => {
            let text = answer.get("reply")?.as_str()?.trim();
            if text.is_empty() {
                return None;
            }
            Some(json!({"decision": "block", "reason": text}).to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(s: &str) -> Value {
        serde_json::from_str(s).unwrap()
    }

    #[test]
    fn classifies_blocking_events() {
        assert_eq!(wait_kind(&json!({"hook_event_name":"PermissionRequest"})), Some(WaitKind::Permission));
        assert_eq!(
            wait_kind(&json!({"hook_event_name":"PreToolUse","tool_name":"AskUserQuestion"})),
            Some(WaitKind::Question)
        );
        assert_eq!(wait_kind(&json!({"hook_event_name":"PreToolUse","tool_name":"Bash"})), None);
        assert_eq!(
            wait_kind(&json!({"hook_event_name":"Stop","stop_hook_active":false,"last_assistant_message":"Shall I push it?"})),
            Some(WaitKind::Reply)
        );
        // Markdown and whitespace after the question mark still count.
        assert_eq!(
            wait_kind(&json!({"hook_event_name":"Stop","last_assistant_message":"**Want me to continue?**\n\n"})),
            Some(WaitKind::Reply)
        );
        assert_eq!(
            wait_kind(&json!({"hook_event_name":"Stop","stop_hook_active":true,"last_assistant_message":"Again?"})),
            None
        );
        assert_eq!(wait_kind(&json!({"hook_event_name":"Stop","last_assistant_message":"Done."})), None);
        assert_eq!(wait_kind(&json!({"hook_event_name":"Stop"})), None);
        assert_eq!(wait_kind(&json!({"hook_event_name":"SessionStart"})), None);
    }

    #[test]
    fn exit_plan_mode_never_blocks() {
        // Claude Code ignores a hook "allow" for ExitPlanMode and keeps its own plan dialog.
        assert_eq!(wait_kind(&json!({"hook_event_name":"PermissionRequest","tool_name":"ExitPlanMode"})), None);
        assert_eq!(
            wait_kind(&json!({"hook_event_name":"PermissionRequest","tool_name":"Bash"})),
            Some(WaitKind::Permission)
        );
    }

    #[test]
    fn budgets_exceed_app_deadlines() {
        assert_eq!(WaitKind::Permission.budget(), Duration::from_secs(112));
        assert_eq!(WaitKind::Question.budget(), Duration::from_secs(545));
        assert_eq!(WaitKind::Reply.budget(), Duration::from_secs(545));
    }

    #[test]
    fn permission_allow_and_deny() {
        let allow = hook_output(WaitKind::Permission, &json!({}), &json!({"behavior":"allow"})).unwrap();
        assert_eq!(
            parse(&allow),
            json!({"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}})
        );
        let deny = hook_output(WaitKind::Permission, &json!({}), &json!({"behavior":"deny"})).unwrap();
        assert_eq!(
            parse(&deny),
            json!({"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied from session-buddy"}}})
        );
        assert!(hook_output(WaitKind::Permission, &json!({}), &json!({"behavior":"maybe"})).is_none());
    }

    #[test]
    fn question_answers_go_into_updated_input() {
        let original = json!({"tool_name":"AskUserQuestion","tool_input":{"questions":[{"question":"Pick a color?","header":"Color","options":[{"label":"Red"},{"label":"Blue"}],"multiSelect":false}]}});
        let out = hook_output(WaitKind::Question, &original, &json!({"answers":{"Pick a color?":"Blue"}})).unwrap();
        assert_eq!(
            parse(&out),
            json!({"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{
                "questions":[{"question":"Pick a color?","header":"Color","options":[{"label":"Red"},{"label":"Blue"}],"multiSelect":false}],
                "answers":{"Pick a color?":"Blue"}}}})
        );
    }

    #[test]
    fn question_rejects_empty_or_non_string_answers() {
        let original = json!({"tool_input":{"questions":[]}});
        assert!(hook_output(WaitKind::Question, &original, &json!({"answers":{}})).is_none());
        assert!(hook_output(WaitKind::Question, &original, &json!({"answers":{"Q?":["a","b"]}})).is_none());
        assert!(hook_output(WaitKind::Question, &json!({}), &json!({"answers":{"Q?":"a"}})).is_none());
    }

    #[test]
    fn reply_blocks_stop_with_reason() {
        let out = hook_output(WaitKind::Reply, &json!({}), &json!({"reply":"  yes, push it  "})).unwrap();
        assert_eq!(parse(&out), json!({"decision":"block","reason":"yes, push it"}));
        assert!(hook_output(WaitKind::Reply, &json!({}), &json!({"reply":"   "})).is_none());
    }
}
