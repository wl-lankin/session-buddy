//! How a tool call reads on the island: "Edit · DatevClient.php".

use serde::Serialize;
use serde_json::Value;

pub fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max.saturating_sub(1)).collect();
    out.push('\u{2026}');
    out
}

fn last_component(path: &str) -> &str {
    let trimmed = path.trim_end_matches(['/', '\\']);
    trimmed.rsplit(['/', '\\']).next().unwrap_or(trimmed)
}

pub fn project_name(cwd: &str) -> String {
    let name = last_component(cwd);
    if name.is_empty() { "Session".into() } else { name.to_string() }
}

const LABELS: &[(&str, &str)] = &[
    ("Bash", "Run"),
    ("PowerShell", "Run"),
    ("Read", "Read"),
    ("Write", "Write"),
    ("Edit", "Edit"),
    ("MultiEdit", "Edit"),
    ("NotebookEdit", "Notebook"),
    ("Glob", "Find"),
    ("Grep", "Search"),
    ("LS", "List"),
    ("WebSearch", "Web search"),
    ("WebFetch", "Fetch"),
    ("TodoWrite", "Todos"),
    ("Task", "Agent"),
    ("Agent", "Agent"),
    ("ToolSearch", "Load tools"),
    ("Skill", "Skill"),
    ("AskUserQuestion", "Question"),
];

pub fn tool_label(tool: &str) -> String {
    if let Some(rest) = tool.strip_prefix("mcp__") {
        let mut parts = rest.splitn(2, "__");
        let server = parts.next().unwrap_or(rest);
        return match parts.next() {
            Some(name) if !name.is_empty() => format!("MCP {server} · {name}"),
            _ => format!("MCP {server}"),
        };
    }
    LABELS
        .iter()
        .find(|(t, _)| *t == tool)
        .map(|(_, l)| l.to_string())
        .unwrap_or_else(|| tool.to_string())
}

const STEP_FIELDS: &[&str] = &[
    "command", "file_path", "notebook_path", "path", "url", "query", "pattern", "skill", "description", "prompt",
];

fn field<'a>(input: &'a Value, key: &str) -> Option<&'a str> {
    input.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
}

pub fn step_label(tool: &str, input: &Value) -> String {
    let label = tool_label(tool);
    for key in STEP_FIELDS {
        if let Some(v) = field(input, key) {
            let shown = match *key {
                "file_path" | "notebook_path" | "path" => last_component(v),
                "command" | "prompt" | "description" => v.lines().next().unwrap_or(v),
                _ => v,
            };
            return format!("{label} · {}", clip(shown, 80));
        }
    }
    label
}

/// What a step changed or ran, unfolded under the steps: Edit and Write show their
/// change, Bash its command and the end of its output.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum StepDetail {
    Diff { path: String, hunks: Vec<Hunk> },
    Run { command: String, output: Option<String> },
}

/// One replacement: `old` becomes `new` (an empty `old` for a newly written file).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Hunk {
    pub old: String,
    pub new: String,
}

/// Per text in a detail; the relay already caps every field at 2000 characters.
const DETAIL_MAX: usize = 2_000;
const MAX_HUNKS: usize = 5;
const OUTPUT_LINES: usize = 12;
const OUTPUT_MAX: usize = 1_200;

fn text<'a>(input: &'a Value, key: &str) -> Option<&'a str> {
    input.get(key).and_then(Value::as_str)
}

fn hunk(edit: &Value) -> Option<Hunk> {
    let old = text(edit, "old_string")?;
    let new = text(edit, "new_string")?;
    Some(Hunk { old: clip(old, DETAIL_MAX), new: clip(new, DETAIL_MAX) })
}

pub fn step_detail(tool: &str, input: &Value) -> Option<StepDetail> {
    let path = || field(input, "file_path").map(str::to_string);
    match tool {
        "Edit" => Some(StepDetail::Diff { path: path()?, hunks: vec![hunk(input)?] }),
        "MultiEdit" => {
            let hunks: Vec<Hunk> = input.get("edits")?.as_array()?.iter().filter_map(hunk).take(MAX_HUNKS).collect();
            if hunks.is_empty() {
                return None;
            }
            Some(StepDetail::Diff { path: path()?, hunks })
        }
        "Write" => {
            let content = text(input, "content")?;
            Some(StepDetail::Diff { path: path()?, hunks: vec![Hunk { old: String::new(), new: clip(content, DETAIL_MAX) }] })
        }
        "Bash" | "PowerShell" => Some(StepDetail::Run { command: clip(field(input, "command")?, DETAIL_MAX), output: None }),
        _ => None,
    }
}

/// The last lines of a command's output (stdout, then stderr), as the relay forwards it.
pub fn output_tail(response: &Value) -> Option<String> {
    let joined = match response {
        Value::String(s) => s.clone(),
        Value::Object(_) => ["stdout", "stderr"]
            .iter()
            .filter_map(|k| text(response, k))
            .map(|t| t.trim_end())
            .filter(|t| !t.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => return None,
    };
    let trimmed = joined.trim_end();
    if trimmed.is_empty() {
        return None;
    }
    let lines: Vec<&str> = trimmed.lines().collect();
    let mut tail = lines[lines.len().saturating_sub(OUTPUT_LINES)..].join("\n");
    let count = tail.chars().count();
    if count > OUTPUT_MAX {
        tail = tail.chars().skip(count - OUTPUT_MAX).collect();
    }
    if tail.len() < trimmed.len() {
        tail.insert(0, '\u{2026}');
    }
    Some(tail)
}

const APPROVAL_FIELDS: &[&str] = &["command", "file_path", "notebook_path", "path", "url", "query", "pattern", "prompt"];

/// What Allow actually authorises: the full command or path, never just the tool name.
pub fn approval_target(tool: &str, input: &Value) -> String {
    for key in APPROVAL_FIELDS {
        if let Some(v) = field(input, key) {
            return format!("{tool} · {}", clip(v, 600));
        }
    }
    tool.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn clip_counts_chars_and_marks_the_cut() {
        assert_eq!(clip("hello", 10), "hello");
        assert_eq!(clip("hello world", 6), "hello\u{2026}");
        assert_eq!(clip("\u{e9}\u{e9}\u{e9}", 2), "\u{e9}\u{2026}");
    }

    #[test]
    fn project_from_cwd() {
        assert_eq!(project_name(r"C:\Projects\pushdocs"), "pushdocs");
        assert_eq!(project_name("/Users/w/code/bankconnect/"), "bankconnect");
        assert_eq!(project_name(""), "Session");
    }

    #[test]
    fn labels() {
        assert_eq!(tool_label("Bash"), "Run");
        assert_eq!(tool_label("PowerShell"), "Run");
        assert_eq!(tool_label("Grep"), "Search");
        assert_eq!(tool_label("mcp__datadog-bankconnect__search_datadog_logs"), "MCP datadog-bankconnect · search_datadog_logs");
        assert_eq!(tool_label("mcp__linear"), "MCP linear");
        assert_eq!(tool_label("SomethingNew"), "SomethingNew");
    }

    #[test]
    fn step_targets() {
        assert_eq!(step_label("Edit", &json!({"file_path": r"C:\p\src\DatevClient.php"})), "Edit · DatevClient.php");
        assert_eq!(step_label("Bash", &json!({"command": "git status\ngit diff"})), "Run · git status");
        assert_eq!(step_label("Agent", &json!({"description": "Find callers", "prompt": "long"})), "Agent · Find callers");
        assert_eq!(step_label("TodoWrite", &json!({"todos": []})), "Todos");
        let long = "x".repeat(200);
        assert_eq!(step_label("Grep", &json!({"pattern": long})).chars().count(), "Search · ".chars().count() + 80);
    }

    #[test]
    fn details_for_edits_writes_and_commands() {
        let edit = step_detail("Edit", &json!({"file_path": "/p/a.ts", "old_string": "x = 1", "new_string": "x = 2"}));
        assert_eq!(edit, Some(StepDetail::Diff { path: "/p/a.ts".into(), hunks: vec![Hunk { old: "x = 1".into(), new: "x = 2".into() }] }));
        let multi = step_detail("MultiEdit", &json!({"file_path": "/p/a.ts", "edits": [{"old_string": "a", "new_string": "b"}, {"old_string": "c", "new_string": "d"}]}));
        assert!(matches!(multi, Some(StepDetail::Diff { ref hunks, .. }) if hunks.len() == 2));
        let write = step_detail("Write", &json!({"file_path": "/p/n.ts", "content": "new file"}));
        assert_eq!(write, Some(StepDetail::Diff { path: "/p/n.ts".into(), hunks: vec![Hunk { old: String::new(), new: "new file".into() }] }));
        assert_eq!(step_detail("Bash", &json!({"command": "npm test"})), Some(StepDetail::Run { command: "npm test".into(), output: None }));
        assert_eq!(step_detail("Read", &json!({"file_path": "/p/a.ts"})), None);
        assert_eq!(step_detail("Edit", &json!({"file_path": "/p/a.ts"})), None, "no strings, no diff");
    }

    #[test]
    fn output_tail_keeps_the_last_lines() {
        assert_eq!(output_tail(&json!({"stdout": "ok\n", "stderr": ""})).as_deref(), Some("ok"));
        assert_eq!(output_tail(&json!({"stdout": "a", "stderr": "warn"})).as_deref(), Some("a\nwarn"));
        let many = (1..=20).map(|i| i.to_string()).collect::<Vec<_>>().join("\n");
        let tail = output_tail(&json!({"stdout": many})).unwrap();
        assert!(tail.starts_with("\u{2026}9\n10"), "{tail}");
        assert!(tail.ends_with("20"));
        assert_eq!(output_tail(&json!({"stdout": "  \n"})), None);
        assert_eq!(output_tail(&json!(42)), None);
    }

    #[test]
    fn approval_target_is_complete() {
        let cmd = "rm -rf build && npm run build -- --mode production";
        assert_eq!(approval_target("Bash", &json!({"command": cmd})), format!("Bash · {cmd}"));
        assert_eq!(approval_target("Write", &json!({"file_path": r"C:\p\.env"})), r"Write · C:\p\.env");
        assert_eq!(approval_target("Mystery", &json!({})), "Mystery");
    }
}
