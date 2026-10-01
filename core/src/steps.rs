//! How a tool call reads on the island: "Edit · DatevClient.php".

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
    fn approval_target_is_complete() {
        let cmd = "rm -rf build && npm run build -- --mode production";
        assert_eq!(approval_target("Bash", &json!({"command": cmd})), format!("Bash · {cmd}"));
        assert_eq!(approval_target("Write", &json!({"file_path": r"C:\p\.env"})), r"Write · C:\p\.env");
        assert_eq!(approval_target("Mystery", &json!({})), "Mystery");
    }
}
