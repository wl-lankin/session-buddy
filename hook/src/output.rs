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
    /// The app answers at once, with the user's queued messages or nothing.
    Message,
}

impl WaitKind {
    pub fn as_str(self) -> &'static str {
        match self {
            WaitKind::Permission => "permission",
            WaitKind::Question => "question",
            WaitKind::Reply => "reply",
            WaitKind::Message => "message",
        }
    }

    /// A little longer than the app's own deadline, so the app always decides first.
    /// A message answer is not worth delaying Claude Code for: the same short give-up as the connect.
    pub fn budget(self) -> Duration {
        match self {
            WaitKind::Message => Duration::from_millis(100),
            WaitKind::Permission => Duration::from_secs(112),
            WaitKind::Question | WaitKind::Reply => Duration::from_secs(545),
        }
    }
}

/// The cases where the app answers: a human on the island (permission, question, reply), or at once
/// with a queued message (tool events and Stop of the main session). Everything else is fire-and-forget.
pub fn wait_kind(payload: &Value) -> Option<WaitKind> {
    let event = payload.get("hook_event_name")?.as_str()?;
    human_wait(event, payload).or_else(|| message_wait(event, payload))
}

/// A subagent's events never carry the user's message: it is for the main session.
fn message_wait(event: &str, payload: &Value) -> Option<WaitKind> {
    let main = payload.get("agent_id").and_then(Value::as_str).is_none_or(str::is_empty);
    (main && matches!(event, "PreToolUse" | "PostToolUse" | "Stop")).then_some(WaitKind::Message)
}

fn human_wait(event: &str, payload: &Value) -> Option<WaitKind> {
    match event {
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
                "deny" => json!({"behavior": "deny", "message": "Denied from Session Buddy"}),
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
        WaitKind::Message => {
            let texts: Vec<&str> = answer
                .get("messages")?
                .as_array()?
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|t| !t.is_empty())
                .collect();
            if texts.is_empty() {
                return None;
            }
            let body = texts.join("\n\n");
            match original.get("hook_event_name")?.as_str()? {
                // Context only: no permission decision, so what the user allowed or denied is untouched.
                event @ ("PreToolUse" | "PostToolUse") => Some(
                    json!({"hookSpecificOutput": {
                        "hookEventName": event,
                        "additionalContext": format!("Message from the user, sent through Session Buddy while you were working: {body}")
                    }})
                    .to_string(),
                ),
                "Stop" => Some(
                    json!({"decision": "block", "reason": format!("The user sent this message through Session Buddy: {body}")}).to_string(),
                ),
                _ => None,
            }
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
        assert_eq!(wait_kind(&json!({"hook_event_name":"PreToolUse","tool_name":"Bash"})), Some(WaitKind::Message));
        assert_eq!(
            wait_kind(&json!({"hook_event_name":"Stop","stop_hook_active":false,"last_assistant_message":"Shall I push it?"})),
            Some(WaitKind::Reply)
        );
        // Markdown and whitespace after the question mark still count.
        assert_eq!(
            wait_kind(&json!({"hook_event_name":"Stop","last_assistant_message":"**Want me to continue?**\n\n"})),
            Some(WaitKind::Reply)
        );
        // A Stop that is no question, or follows an earlier block, can still carry a queued message.
        assert_eq!(
            wait_kind(&json!({"hook_event_name":"Stop","stop_hook_active":true,"last_assistant_message":"Again?"})),
            Some(WaitKind::Message)
        );
        assert_eq!(wait_kind(&json!({"hook_event_name":"Stop","last_assistant_message":"Done."})), Some(WaitKind::Message));
        assert_eq!(wait_kind(&json!({"hook_event_name":"Stop"})), Some(WaitKind::Message));
        assert_eq!(wait_kind(&json!({"hook_event_name":"PostToolUse","tool_name":"Read"})), Some(WaitKind::Message));
        for event in ["SessionStart", "UserPromptSubmit", "Notification", "SubagentStop", "PostToolUseFailure"] {
            assert_eq!(wait_kind(&json!({"hook_event_name": event})), None, "{event}");
        }
    }

    #[test]
    fn a_subagent_event_never_waits_for_a_message() {
        for event in ["PreToolUse", "PostToolUse", "Stop"] {
            assert_eq!(wait_kind(&json!({"hook_event_name": event, "agent_id": "a1", "tool_name": "Read"})), None, "{event}");
        }
        // ...but its permission request and its question still reach the user.
        assert_eq!(
            wait_kind(&json!({"hook_event_name":"PermissionRequest","agent_id":"a1","tool_name":"Bash"})),
            Some(WaitKind::Permission)
        );
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
        assert_eq!(WaitKind::Message.budget(), Duration::from_millis(100));
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
            json!({"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied from Session Buddy"}}})
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

    fn messages(texts: &[&str]) -> Value {
        json!({"messages": texts})
    }

    #[test]
    fn pre_and_post_tool_use_get_additional_context_and_no_decision() {
        for event in ["PreToolUse", "PostToolUse"] {
            let original = json!({"hook_event_name": event, "tool_name": "Bash"});
            let out = hook_output(WaitKind::Message, &original, &messages(&["use tabs"])).unwrap();
            assert_eq!(
                parse(&out),
                json!({"hookSpecificOutput":{"hookEventName": event, "additionalContext":
                    "Message from the user, sent through Session Buddy while you were working: use tabs"}})
            );
            assert!(parse(&out)["hookSpecificOutput"].get("permissionDecision").is_none());
        }
    }

    #[test]
    fn stop_blocks_with_the_wrapped_message() {
        let original = json!({"hook_event_name": "Stop"});
        let out = hook_output(WaitKind::Message, &original, &messages(&["one more thing"])).unwrap();
        assert_eq!(
            parse(&out),
            json!({"decision":"block","reason":"The user sent this message through Session Buddy: one more thing"})
        );
    }

    #[test]
    fn several_messages_join_with_a_blank_line() {
        let original = json!({"hook_event_name": "PreToolUse"});
        let out = parse(&hook_output(WaitKind::Message, &original, &messages(&["first", "  second\nline  "])).unwrap());
        assert!(out["hookSpecificOutput"]["additionalContext"].as_str().unwrap().ends_with(": first\n\nsecond\nline"));
    }

    #[test]
    fn no_message_prints_nothing() {
        let original = json!({"hook_event_name": "PreToolUse"});
        assert!(hook_output(WaitKind::Message, &original, &messages(&[])).is_none());
        assert!(hook_output(WaitKind::Message, &original, &messages(&["  "])).is_none());
        assert!(hook_output(WaitKind::Message, &original, &json!({})).is_none());
        assert!(hook_output(WaitKind::Message, &json!({"hook_event_name": "Notification"}), &messages(&["x"])).is_none());
        assert!(hook_output(WaitKind::Message, &json!({}), &messages(&["x"])).is_none());
    }
}
