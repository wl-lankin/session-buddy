//! `sb-relay mcp`: a stdio MCP server (JSON-RPC 2.0, one message per line) that gives the chat its
//! session tools. Every tool call is forwarded to the app over the per-user pipe or socket; the app
//! decides and confirms, this side only translates. It never hangs Claude Code: every wait is bounded.

use std::io::{BufRead, Write};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

use crate::transport;

const SUPPORTED: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];
const FALLBACK_VERSION: &str = "2024-11-05";
/// Reads answer at once; an action waits for the person at the island (the app gives up after 110 s).
const READ_BUDGET: Duration = Duration::from_secs(15);
const ACTION_BUDGET: Duration = Duration::from_secs(125);

pub struct Reply {
    pub text: String,
    pub is_error: bool,
}

impl Reply {
    fn error(text: impl Into<String>) -> Self {
        Self { text: text.into(), is_error: true }
    }
}

struct Tool {
    name: &'static str,
    description: &'static str,
    schema: fn() -> Value,
    action: bool,
}

fn no_args() -> Value {
    json!({"type": "object", "properties": {}, "additionalProperties": false})
}

fn string(description: &str) -> Value {
    json!({"type": "string", "description": description})
}

fn get_session_schema() -> Value {
    json!({"type": "object", "properties": {"id": string("Session id from list_sessions")}, "required": ["id"], "additionalProperties": false})
}

fn start_schema() -> Value {
    json!({"type": "object", "properties": {
        "project": string("Project folder name from list_projects, or a path inside an allowed folder"),
        "model": {"type": "string", "enum": ["haiku", "sonnet", "opus"], "description": "Claude model for the session"},
        "prompt": string("What the session should do, at most 4000 characters"),
        "host": string("Where it runs; only \"background\" is available"),
    }, "required": ["project", "model", "prompt"], "additionalProperties": false})
}

fn send_schema() -> Value {
    json!({"type": "object", "properties": {
        "session_id": string("Id of a background session started by Session Buddy"),
        "text": string("The prompt, at most 4000 characters"),
    }, "required": ["session_id", "text"], "additionalProperties": false})
}

fn stop_schema() -> Value {
    json!({"type": "object", "properties": {"session_id": string("Id of a background session started by Session Buddy")}, "required": ["session_id"], "additionalProperties": false})
}

fn approve_schema() -> Value {
    json!({"type": "object", "properties": {
        "tool_name": {"type": "string"},
        "input": {"type": "object"},
        "tool_use_id": {"type": "string"},
    }, "required": ["tool_name", "input"], "additionalProperties": true})
}

const TOOLS: [Tool; 7] = [
    Tool { name: "list_sessions", description: "List the user's Claude Code sessions: id, project, branch, status, model, whether Session Buddy manages it, last prompt and any open request.", schema: no_args, action: false },
    Tool { name: "get_session", description: "One session in detail: the above plus its last steps and, for background sessions, their recent output.", schema: get_session_schema, action: false },
    Tool { name: "list_projects", description: "The project folders the user allows sessions in: name and path.", schema: no_args, action: false },
    Tool { name: "start_session", description: "Start a background Claude Code session in a project folder. The user confirms in the island first.", schema: start_schema, action: true },
    Tool { name: "send_prompt", description: "Send a prompt to a background session that Session Buddy started. The user confirms first.", schema: send_schema, action: true },
    Tool { name: "stop_session", description: "Stop a background session that Session Buddy started. The user confirms first.", schema: stop_schema, action: true },
    Tool { name: "approve", description: "Internal: Claude Code's permission prompt for the action tools. Never call this yourself.", schema: approve_schema, action: true },
];

fn result(id: &Value, value: Value) -> String {
    json!({"jsonrpc": "2.0", "id": id, "result": value}).to_string()
}

fn failure(id: &Value, code: i64, message: &str) -> String {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}}).to_string()
}

fn negotiated(params: &Value) -> &'static str {
    let asked = params.get("protocolVersion").and_then(Value::as_str);
    SUPPORTED.iter().copied().find(|v| Some(*v) == asked).unwrap_or(FALLBACK_VERSION)
}

fn tool_list() -> Value {
    let tools: Vec<Value> = TOOLS.iter().map(|t| json!({"name": t.name, "description": t.description, "inputSchema": (t.schema)()})).collect();
    json!({"tools": tools})
}

/// Handles one line. `call` forwards a tool call to the app. Returns the response line, or None for notifications.
pub fn handle(line: &str, call: &dyn Fn(&str, &Value) -> Reply) -> Option<String> {
    let Ok(msg) = serde_json::from_str::<Value>(line) else {
        return Some(failure(&Value::Null, -32700, "Parse error"));
    };
    let Some(method) = msg.get("method").and_then(Value::as_str) else {
        // A response to something we never asked needs no answer; anything else is not a request.
        let is_response = msg.get("result").is_some() || msg.get("error").is_some();
        return (!is_response).then(|| failure(&Value::Null, -32600, "Invalid request"));
    };
    let id = msg.get("id").cloned()?;
    let params = msg.get("params").cloned().unwrap_or(Value::Null);
    Some(match method {
        "initialize" => result(
            &id,
            json!({
                "protocolVersion": negotiated(&params),
                "capabilities": {"tools": {"listChanged": false}},
                "serverInfo": {"name": "session-buddy", "version": env!("CARGO_PKG_VERSION")},
            }),
        ),
        "ping" => result(&id, json!({})),
        "tools/list" => result(&id, tool_list()),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or_default();
            if !TOOLS.iter().any(|t| t.name == name) {
                return Some(failure(&id, -32602, "Unknown tool"));
            }
            let args = params.get("arguments").filter(|a| a.is_object()).cloned().unwrap_or_else(|| json!({}));
            let reply = call(name, &args);
            result(&id, json!({"content": [{"type": "text", "text": reply.text}], "isError": reply.is_error}))
        }
        _ => failure(&id, -32601, "Method not found"),
    })
}

fn budget_of(tool: &str) -> Duration {
    if TOOLS.iter().any(|t| t.name == tool && t.action) {
        ACTION_BUDGET
    } else {
        READ_BUDGET
    }
}

/// Forwards to the app: one request line out, one `{"ok": bool, "text": string}` line back.
fn forward(tool: &str, args: &Value) -> Reply {
    let line = format!("{}\n", json!({"sb_kind": "mcp", "tool": tool, "args": args}));
    match transport::request(&line, budget_of(tool)) {
        Err(message) => Reply::error(message),
        Ok(answer) => match serde_json::from_str::<Value>(&answer) {
            Ok(v) => Reply { text: v.get("text").and_then(Value::as_str).unwrap_or_default().to_string(), is_error: v.get("ok").and_then(Value::as_bool) != Some(true) },
            Err(_) => Reply::error("Session Buddy sent an answer this tool does not understand"),
        },
    }
}

/// Serves stdin until it closes. A tool call may wait for a person, so each runs on its own thread
/// and `ping` and the other requests stay answerable meanwhile.
pub fn serve() {
    let out = Arc::new(Mutex::new(std::io::stdout()));
    for line in std::io::stdin().lock().lines().map_while(Result::ok) {
        if line.trim().is_empty() {
            continue;
        }
        let out = out.clone();
        std::thread::spawn(move || {
            if let Some(reply) = handle(&line, &forward) {
                let mut out = out.lock().unwrap();
                let _ = writeln!(out, "{reply}");
                let _ = out.flush();
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(text: &str) -> Reply {
        Reply { text: text.into(), is_error: false }
    }

    fn run(line: &str) -> Value {
        let call = |tool: &str, args: &Value| ok(&format!("{tool} {args}"));
        serde_json::from_str(&handle(line, &call).expect("a response")).unwrap()
    }

    #[test]
    fn initialize_echoes_a_supported_version() {
        for v in SUPPORTED {
            let r = run(&format!(r#"{{"jsonrpc":"2.0","id":1,"method":"initialize","params":{{"protocolVersion":"{v}"}}}}"#));
            assert_eq!(r["result"]["protocolVersion"], v);
            assert_eq!(r["id"], 1);
            assert!(r["result"]["capabilities"]["tools"].is_object());
        }
    }

    #[test]
    fn initialize_falls_back_for_an_unknown_or_missing_version() {
        let r = run(r#"{"jsonrpc":"2.0","id":"a","method":"initialize","params":{"protocolVersion":"2099-01-01"}}"#);
        assert_eq!(r["result"]["protocolVersion"], "2024-11-05");
        assert_eq!(r["id"], "a");
        let r = run(r#"{"jsonrpc":"2.0","id":2,"method":"initialize"}"#);
        assert_eq!(r["result"]["protocolVersion"], "2024-11-05");
    }

    #[test]
    fn notifications_get_no_answer() {
        let call = |_: &str, _: &Value| ok("");
        assert!(handle(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#, &call).is_none());
        assert!(handle(r#"{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":1}}"#, &call).is_none());
        assert!(handle(r#"{"jsonrpc":"2.0","id":3,"result":{}}"#, &call).is_none());
    }

    #[test]
    fn ping_and_unknown_methods() {
        assert_eq!(run(r#"{"jsonrpc":"2.0","id":7,"method":"ping"}"#)["result"], json!({}));
        let r = run(r#"{"jsonrpc":"2.0","id":8,"method":"resources/list"}"#);
        assert_eq!(r["error"]["code"], -32601);
        assert_eq!(r["id"], 8);
    }

    #[test]
    fn garbage_is_a_parse_error() {
        let r = run("not json");
        assert_eq!(r["error"]["code"], -32700);
        assert_eq!(r["id"], Value::Null);
    }

    #[test]
    fn tools_list_has_the_six_tools_and_the_permission_tool() {
        let r = run(r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#);
        let names: Vec<&str> = r["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["list_sessions", "get_session", "list_projects", "start_session", "send_prompt", "stop_session", "approve"]);
        for t in r["result"]["tools"].as_array().unwrap() {
            assert_eq!(t["inputSchema"]["type"], "object");
        }
        let start = &r["result"]["tools"][3]["inputSchema"];
        assert_eq!(start["properties"]["model"]["enum"], json!(["haiku", "sonnet", "opus"]));
        assert_eq!(start["required"], json!(["project", "model", "prompt"]));
    }

    #[test]
    fn tools_call_forwards_and_wraps_the_reply() {
        let r = run(r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"get_session","arguments":{"id":"s1"}}}"#);
        assert_eq!(r["result"]["content"][0]["text"], r#"get_session {"id":"s1"}"#);
        assert_eq!(r["result"]["isError"], false);
        let call = |_: &str, _: &Value| Reply::error("denied");
        let line = r#"{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"list_sessions"}}"#;
        let r: Value = serde_json::from_str(&handle(line, &call).unwrap()).unwrap();
        assert_eq!(r["result"]["isError"], true);
        assert_eq!(r["result"]["content"][0]["text"], "denied");
    }

    #[test]
    fn missing_arguments_become_an_empty_object() {
        let r = run(r#"{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"list_projects"}}"#);
        assert_eq!(r["result"]["content"][0]["text"], "list_projects {}");
    }

    #[test]
    fn unknown_tools_are_a_protocol_error() {
        let r = run(r#"{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"rm_rf","arguments":{}}}"#);
        assert_eq!(r["error"]["code"], -32602);
    }

    #[test]
    fn actions_wait_longer_than_reads() {
        assert!(budget_of("start_session") > budget_of("list_sessions"));
        assert!(budget_of("approve") >= Duration::from_secs(120));
        assert!(budget_of("get_session") <= Duration::from_secs(30));
    }
}
