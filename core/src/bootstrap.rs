//! After the app (re)starts, sessions that are already running only show up on
//! their next hook event. Reading the tail of each recent transcript fills the
//! list right away: project, last prompt, last message.

use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use serde_json::Value;

use crate::steps::{clip, project_name};
use crate::store::{Session, Status};

const TAIL_BYTES: u64 = 512 * 1024;
const TAIL_LINES: usize = 200;

#[derive(Debug, Clone, PartialEq)]
pub struct Seed {
    pub session_id: String,
    pub cwd: String,
    pub last_prompt: Option<String>,
    pub last_message: Option<String>,
    pub model: Option<String>,
    pub modified_ms: i64,
}

fn text_of(content: &Value) -> Option<String> {
    match content {
        Value::String(s) => Some(s.clone()),
        Value::Array(items) => {
            let parts: Vec<&str> = items
                .iter()
                .filter(|i| i.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|i| i.get("text").and_then(Value::as_str))
                .collect();
            (!parts.is_empty()).then(|| parts.concat())
        }
        _ => None,
    }
}

/// What the tail of a transcript says about its session.
#[derive(Debug, Default, PartialEq)]
pub struct Tail {
    pub id: Option<String>,
    pub cwd: Option<String>,
    pub prompt: Option<String>,
    pub message: Option<String>,
    pub model: Option<String>,
}

pub fn parse_tail(text: &str) -> Tail {
    let (mut id, mut cwd, mut prompt, mut message, mut model) = (None, None, None, None, None);
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        if let Some(s) = v.get("sessionId").and_then(Value::as_str) {
            id = Some(s.to_string());
        }
        if let Some(c) = v.get("cwd").and_then(Value::as_str).filter(|c| !c.is_empty()) {
            cwd = Some(c.to_string());
        }
        if v.get("isMeta").and_then(Value::as_bool).unwrap_or(false) {
            continue;
        }
        let Some(content) = v.pointer("/message/content") else { continue };
        match v.get("type").and_then(Value::as_str) {
            Some("user") => {
                // Only typed prompts: tool results are arrays, wrappers start with '<'.
                if let Value::String(s) = content {
                    let t = s.trim();
                    if !t.is_empty() && !t.starts_with('<') {
                        prompt = Some(clip(t, 300));
                    }
                }
            }
            Some("assistant") => {
                if let Some(m) = v.pointer("/message/model").and_then(Value::as_str).filter(|m| m.starts_with("claude-")) {
                    model = Some(m.to_string());
                }
                if let Some(t) = text_of(content).filter(|t| !t.trim().is_empty()) {
                    message = Some(clip(t.trim(), 2_000));
                }
            }
            _ => {}
        }
    }
    Tail { id, cwd, prompt, message, model }
}

fn read_tail(path: &Path) -> Option<String> {
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let start = len.saturating_sub(TAIL_BYTES);
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::new();
    f.take(TAIL_BYTES).read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf).into_owned();
    let mut lines: Vec<&str> = text.lines().collect();
    if start > 0 && !lines.is_empty() {
        lines.remove(0); // first line is cut in the middle
    }
    let keep = lines.len().saturating_sub(TAIL_LINES);
    Some(lines[keep..].join("\n"))
}

fn modified_ms(path: &Path) -> Option<i64> {
    let t = std::fs::metadata(path).ok()?.modified().ok()?;
    Some(t.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as i64)
}

pub fn scan(projects_dir: &Path, now: i64, max_age_ms: i64) -> Vec<Seed> {
    let mut seeds = Vec::new();
    let Ok(projects) = std::fs::read_dir(projects_dir) else { return seeds };
    for project in projects.flatten() {
        let Ok(files) = std::fs::read_dir(project.path()) else { continue };
        for file in files.flatten() {
            let path = file.path();
            if !path.is_file() || path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let Some(mtime) = modified_ms(&path) else { continue };
            if now - mtime > max_age_ms {
                continue;
            }
            let Some(text) = read_tail(&path) else { continue };
            let Tail { id, cwd, prompt: last_prompt, message: last_message, model } = parse_tail(&text);
            let session_id = id.unwrap_or_else(|| path.file_stem().unwrap_or_default().to_string_lossy().to_string());
            seeds.push(Seed { session_id, cwd: cwd.unwrap_or_default(), last_prompt, last_message, model, modified_ms: mtime });
        }
    }
    seeds.sort_by_key(|s| s.modified_ms);
    seeds
}

pub fn session_from_seed(seed: &Seed, now: i64, stale_after_ms: i64) -> Session {
    let mut s = Session::new(&seed.session_id, seed.modified_ms);
    s.cwd = seed.cwd.clone();
    s.project = project_name(&seed.cwd);
    s.last_prompt = seed.last_prompt.clone();
    s.last_message = seed.last_message.clone();
    s.model = seed.model.clone();
    s.last_event_at = seed.modified_ms;
    s.status = if now - seed.modified_ms >= stale_after_ms { Status::Stale } else { Status::Idle };
    s.status_since = now;
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn lines(rows: &[Value]) -> String {
        rows.iter().map(|r| r.to_string()).collect::<Vec<_>>().join("\n") + "\n"
    }

    fn transcript() -> String {
        lines(&[
            json!({"type":"user","sessionId":"s1","cwd":"C:\\Projects\\pushdocs","message":{"role":"user","content":"<command-name>/clear</command-name>"}}),
            json!({"type":"user","sessionId":"s1","cwd":"C:\\Projects\\pushdocs","message":{"role":"user","content":"fix the DATEV 409 handling"}}),
            json!({"type":"assistant","sessionId":"s1","message":{"model":"claude-sonnet-4-5","content":[{"type":"tool_use","name":"Read"}]}}),
            json!({"type":"user","sessionId":"s1","message":{"content":[{"type":"tool_result","content":"..."}]}}),
            json!({"type":"user","sessionId":"s1","isMeta":true,"message":{"content":"meta noise"}}),
            json!({"type":"assistant","sessionId":"s1","message":{"model":"claude-opus-5-5","content":[{"type":"text","text":"Fixed. "},{"type":"text","text":"Tests pass."}]}}),
        ])
    }

    #[test]
    fn parses_last_real_prompt_and_message() {
        let Tail { id, cwd, prompt, message: msg, model } = parse_tail(&transcript());
        assert_eq!(id.as_deref(), Some("s1"));
        assert_eq!(cwd.as_deref(), Some("C:\\Projects\\pushdocs"));
        assert_eq!(prompt.as_deref(), Some("fix the DATEV 409 handling"));
        assert_eq!(msg.as_deref(), Some("Fixed. Tests pass."));
        assert_eq!(model.as_deref(), Some("claude-opus-5-5"), "the last assistant message's model wins");
    }

    #[test]
    fn ignores_garbage_lines() {
        assert_eq!(parse_tail("not json\n{\"broken\":\n"), Tail::default());
    }

    #[test]
    fn scans_recent_transcripts_only() {
        let dir = tempfile::tempdir().unwrap();
        let proj = dir.path().join("C--Projects-pushdocs");
        std::fs::create_dir_all(proj.join("s1").join("subagents")).unwrap();
        std::fs::write(proj.join("s1.jsonl"), transcript()).unwrap();
        std::fs::write(proj.join("s1").join("subagents").join("agent-x.jsonl"), transcript()).unwrap();
        std::fs::write(proj.join("notes.txt"), "x").unwrap();
        let now = crate::now_ms();
        let seeds = scan(dir.path(), now, 2 * 60 * 60_000);
        assert_eq!(seeds.len(), 1, "sub-agent transcripts and other files are skipped");
        assert_eq!(seeds[0].session_id, "s1");
        assert_eq!(seeds[0].last_prompt.as_deref(), Some("fix the DATEV 409 handling"));
        // Three hours later the same file is too old.
        assert!(scan(dir.path(), now + 3 * 60 * 60_000, 2 * 60 * 60_000).is_empty());
    }

    #[test]
    fn missing_dir_is_empty() {
        assert!(scan(Path::new("/definitely/not/here"), 0, 1).is_empty());
    }

    #[test]
    fn seed_becomes_idle_or_stale() {
        let seed = Seed { session_id: "s1".into(), cwd: "/p/bankconnect".into(), last_prompt: Some("p".into()), last_message: None, model: Some("claude-opus-5-5".into()), modified_ms: 1_000 };
        let fresh = session_from_seed(&seed, 1_000 + 60_000, 10 * 60_000);
        assert_eq!(fresh.status, Status::Idle);
        assert_eq!(fresh.project, "bankconnect");
        assert_eq!(fresh.model.as_deref(), Some("claude-opus-5-5"));
        assert_eq!(fresh.last_event_at, 1_000);
        let old = session_from_seed(&seed, 1_000 + 11 * 60_000, 10 * 60_000);
        assert_eq!(old.status, Status::Stale);
    }

    #[test]
    fn large_transcript_is_read_from_a_bounded_tail() {
        // Multi-byte padding so the seek offset can land inside a character;
        // the extra 0..4 filler bytes shift the offset across every alignment.
        let pad_row = json!({"type":"user","message":{"content":"\u{e4}\u{1f600}".repeat(200)}}).to_string();
        for shift in 0..4 {
            let dir = tempfile::tempdir().unwrap();
            std::fs::create_dir_all(dir.path().join("proj")).unwrap();
            let path = dir.path().join("proj").join("big.jsonl");
            let mut body = String::from("{\"type\":\"user\",\"sessionId\":\"s9\",\"message\":{\"content\":\"EARLY_MARKER\"}}\n");
            while body.len() < 640 * 1024 {
                body.push_str(&pad_row);
                body.push('\n');
            }
            body.push_str(&" ".repeat(shift));
            body.push('\n');
            body.push_str(&lines(&[
                json!({"type":"user","sessionId":"s9","cwd":"/p/pushdocs","message":{"content":"the real last prompt"}}),
                json!({"type":"assistant","sessionId":"s9","message":{"content":[{"type":"text","text":"the real last message"}]}}),
            ]));
            std::fs::write(&path, &body).unwrap();

            let tail = read_tail(&path).unwrap();
            assert!(tail.len() <= TAIL_BYTES as usize + 16, "tail is bounded, got {} bytes", tail.len());
            assert!(!tail.contains("EARLY_MARKER"), "the start of the file is not read");

            let seeds = scan(dir.path(), crate::now_ms(), 60_000)
                .into_iter()
                .collect::<Vec<_>>();
            assert_eq!(seeds.len(), 1);
            assert_eq!(seeds[0].last_prompt.as_deref(), Some("the real last prompt"));
            assert_eq!(seeds[0].last_message.as_deref(), Some("the real last message"));
        }
    }
}
