//! Buddy Chat: a headless Claude Code (stream-json over stdin/stdout) behind the island's chat view.
//! Message contents are never logged, only the lifecycle.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::island::WINDOW_LABEL;
use crate::{log, Shared};

const STYLE_PROMPT: &str = "You are Buddy, a small chat helper inside the Session Buddy desktop app. \
Answer briefly and plainly, in the language the user writes in. Use Markdown sparingly. \
Search the web only when it helps. A message may start with a block describing one of the user's Claude Code sessions; use it as context.";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Off,
    Starting,
    Ready,
    Busy,
    Error,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ChatEvent {
    Status {
        state: State,
        #[serde(skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
    },
    Turn {
        id: String,
    },
    Thinking {
        id: String,
    },
    Delta {
        id: String,
        text: String,
    },
    Tool {
        id: String,
        call_id: String,
        tool: String,
        label: String,
        state: ToolState,
    },
    Done {
        id: String,
        text: String,
        duration_ms: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        cost_usd: Option<f64>,
    },
    Error {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        message: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolState {
    Running,
    Done,
    Error,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatStatus {
    enabled: bool,
    state: State,
    claude_found: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
}

/// Turns the CLI's stream-json lines of one turn into chat events. Pure: no I/O.
pub struct Mapper {
    id: String,
    calls: HashMap<String, (String, String)>,
    text: String,
}

impl Mapper {
    pub fn new(id: &str) -> Self {
        Self { id: id.to_string(), calls: HashMap::new(), text: String::new() }
    }

    /// Text streamed so far in this turn.
    pub fn partial(&self) -> &str {
        &self.text
    }

    pub fn map(&mut self, line: &str) -> Vec<ChatEvent> {
        let Ok(v) = serde_json::from_str::<Value>(line) else { return Vec::new() };
        let id = self.id.clone();
        match v["type"].as_str() {
            Some("stream_event") => {
                if !v["parent_tool_use_id"].is_null() {
                    return Vec::new();
                }
                let ev = &v["event"];
                match ev["type"].as_str() {
                    Some("content_block_start") if ev["content_block"]["type"] == "thinking" => vec![ChatEvent::Thinking { id }],
                    Some("content_block_delta") => match ev["delta"]["text"].as_str() {
                        Some(t) if !t.is_empty() => {
                            self.text.push_str(t);
                            vec![ChatEvent::Delta { id, text: t.to_string() }]
                        }
                        _ => Vec::new(),
                    },
                    _ => Vec::new(),
                }
            }
            Some("assistant") => {
                let mut out = Vec::new();
                for block in v["message"]["content"].as_array().into_iter().flatten() {
                    if block["type"] != "tool_use" {
                        continue;
                    }
                    let (Some(call_id), Some(tool)) = (block["id"].as_str(), block["name"].as_str()) else { continue };
                    if self.calls.contains_key(call_id) {
                        continue;
                    }
                    let label = tool_label(tool, &block["input"]);
                    self.calls.insert(call_id.to_string(), (tool.to_string(), label.clone()));
                    out.push(ChatEvent::Tool {
                        id: id.clone(),
                        call_id: call_id.to_string(),
                        tool: tool.to_string(),
                        label,
                        state: ToolState::Running,
                    });
                }
                out
            }
            Some("user") => {
                let mut out = Vec::new();
                for block in v["message"]["content"].as_array().into_iter().flatten() {
                    if block["type"] != "tool_result" {
                        continue;
                    }
                    let Some(call_id) = block["tool_use_id"].as_str() else { continue };
                    let Some((tool, label)) = self.calls.get(call_id) else { continue };
                    let state = if block["is_error"].as_bool() == Some(true) { ToolState::Error } else { ToolState::Done };
                    out.push(ChatEvent::Tool { id: id.clone(), call_id: call_id.to_string(), tool: tool.clone(), label: label.clone(), state });
                }
                out
            }
            Some("result") => {
                let failed = v["is_error"].as_bool() == Some(true) || v["subtype"].as_str().is_some_and(|s| s != "success");
                if failed {
                    let message = v["result"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .or_else(|| v["errors"][0].as_str())
                        .or_else(|| v["subtype"].as_str())
                        .unwrap_or("The chat failed");
                    vec![ChatEvent::Error { id: Some(id), message: message.to_string() }]
                } else {
                    vec![ChatEvent::Done {
                        id,
                        text: v["result"].as_str().unwrap_or_default().to_string(),
                        duration_ms: v["duration_ms"].as_u64().unwrap_or(0),
                        cost_usd: v["total_cost_usd"].as_f64(),
                    }]
                }
            }
            _ => Vec::new(),
        }
    }
}

fn tool_label(tool: &str, input: &Value) -> String {
    let raw = match tool {
        "WebSearch" => input["query"].as_str().unwrap_or_default().to_string(),
        "WebFetch" => host(input["url"].as_str().unwrap_or_default()),
        _ => String::new(),
    };
    let raw = if raw.is_empty() { tool.to_string() } else { raw };
    raw.chars().take(100).collect()
}

/// The host of a URL: no scheme, credentials, port, path or query.
fn host(url: &str) -> String {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let authority = authority.rsplit('@').next().unwrap_or_default();
    match authority.strip_prefix('[') {
        Some(v6) => v6.split(']').next().unwrap_or_default().to_string(),
        None => authority.split(':').next().unwrap_or_default().to_string(),
    }
}

fn candidates(home: &Path) -> Vec<PathBuf> {
    if cfg!(windows) {
        let mut v = vec![home.join(".local").join("bin").join("claude.exe"), home.join(".claude").join("local").join("claude.exe")];
        v.push(home.join("AppData").join("Roaming").join("npm").join("claude.cmd"));
        v
    } else {
        vec![
            home.join(".local/bin/claude"),
            PathBuf::from("/opt/homebrew/bin/claude"),
            PathBuf::from("/usr/local/bin/claude"),
            home.join(".claude/local/claude"),
            home.join(".npm-global/bin/claude"),
        ]
    }
}

/// The setting first, then the known locations, then whatever a login shell finds.
fn resolve_with(setting: &str, home: &Path, exists: impl Fn(&Path) -> bool, login: impl FnOnce() -> Option<PathBuf>) -> Option<PathBuf> {
    let setting = setting.trim();
    if !setting.is_empty() {
        let p = PathBuf::from(setting);
        if exists(&p) {
            return Some(p);
        }
    }
    candidates(home).into_iter().find(|p| exists(p)).or_else(login)
}

static LOGIN_HIT: Mutex<Option<(Instant, Option<PathBuf>)>> = Mutex::new(None);

/// A GUI app has a short PATH: ask a login shell. A miss is remembered for a minute so status polls stay cheap.
fn login_lookup() -> Option<PathBuf> {
    let mut cache = LOGIN_HIT.lock().unwrap();
    if let Some((at, hit)) = cache.as_ref() {
        if hit.is_some() || at.elapsed() < Duration::from_secs(60) {
            return hit.clone();
        }
    }
    let hit = run_login_lookup();
    *cache = Some((Instant::now(), hit.clone()));
    hit
}

fn run_login_lookup() -> Option<PathBuf> {
    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("where");
        c.arg("claude");
        c
    } else {
        let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/zsh".into());
        let mut c = Command::new(shell);
        c.args(["-l", "-c", "command -v claude"]);
        c
    };
    no_window(&mut cmd);
    let out = cmd.stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    text.lines().map(str::trim).filter(|l| !l.is_empty()).map(PathBuf::from).find(|p| p.is_absolute() && p.is_file())
}

fn resolve(setting: &str) -> Option<PathBuf> {
    resolve_with(setting, &sb_common::home(), |p| p.is_file(), login_lookup)
}

#[cfg(windows)]
fn no_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000);
}

#[cfg(not(windows))]
fn no_window(_cmd: &mut Command) {}

struct Proc {
    child: Child,
    stdin: ChildStdin,
}

struct Inner {
    proc: Option<Proc>,
    state: State,
    detail: Option<String>,
    turn: Option<String>,
    turns: u64,
    interrupted: bool,
    last_active: Instant,
    /// Bumped on every start and stop, so threads of an older process know to give up.
    gen: u64,
    last_err: Arc<Mutex<String>>,
}

pub struct Chat(Mutex<Inner>);

impl Default for Chat {
    fn default() -> Self {
        Self(Mutex::new(Inner {
            proc: None,
            state: State::Off,
            detail: None,
            turn: None,
            turns: 0,
            interrupted: false,
            last_active: Instant::now(),
            gen: 0,
            last_err: Arc::new(Mutex::new(String::new())),
        }))
    }
}

fn emit(app: &AppHandle, ev: ChatEvent) {
    let _ = app.emit_to(WINDOW_LABEL, "chat-event", ev);
}

fn set_state(app: &AppHandle, inner: &mut Inner, state: State, detail: Option<String>) {
    inner.state = state;
    inner.detail = detail.clone();
    emit(app, ChatEvent::Status { state, detail });
}

fn stop_locked(app: &AppHandle, inner: &mut Inner, state: State, detail: Option<String>) {
    inner.gen += 1;
    inner.turn = None;
    inner.interrupted = false;
    if let Some(mut p) = inner.proc.take() {
        let _ = p.child.kill();
        std::thread::spawn(move || {
            let _ = p.child.wait();
        });
        log::line("chat: stopped");
    }
    set_state(app, inner, state, detail);
}

fn settings_of(app: &AppHandle) -> (bool, u32, String, String) {
    let s = app.state::<Shared>().settings.lock().unwrap().clone();
    (s.chat_enabled, s.chat_idle_minutes, s.chat_model, s.chat_claude_path)
}

fn spawn(app: &AppHandle, inner: &mut Inner, bin: &Path, model: &str) -> Result<(), String> {
    let dir = sb_common::config_dir().join("chat");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Chat folder: {e}"))?;
    let mut cmd = Command::new(bin);
    cmd.args(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages"])
        .args(["--model", model, "--tools", "WebSearch,WebFetch", "--allowedTools", "WebSearch,WebFetch", "--no-session-persistence", "--strict-mcp-config"])
        .args(["--append-system-prompt", STYLE_PROMPT])
        .current_dir(dir)
        .env("SB_CHAT", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    no_window(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("Could not start claude: {e}"))?;
    let (Some(stdin), Some(stdout), Some(stderr)) = (child.stdin.take(), child.stdout.take(), child.stderr.take()) else {
        let _ = child.kill();
        return Err("Could not connect to claude".into());
    };
    inner.gen += 1;
    let gen = inner.gen;
    inner.proc = Some(Proc { child, stdin });
    inner.last_active = Instant::now();
    inner.last_err = Arc::new(Mutex::new(String::new()));
    log::line("chat: started");
    set_state(app, inner, State::Starting, None);

    let last_err = inner.last_err.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if !line.trim().is_empty() {
                *last_err.lock().unwrap() = line.chars().take(200).collect();
            }
        }
    });
    let reader_app = app.clone();
    std::thread::spawn(move || read_loop(reader_app, stdout, gen));
    let idle_app = app.clone();
    std::thread::spawn(move || idle_loop(idle_app, gen));
    Ok(())
}

fn read_loop(app: AppHandle, stdout: std::process::ChildStdout, gen: u64) {
    let chat = app.state::<Chat>();
    let mut mapper = Mapper::new("");
    let mut announced = false;
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        {
            let mut inner = chat.0.lock().unwrap();
            if inner.gen != gen {
                return;
            }
            if !announced && inner.state == State::Starting {
                announced = true;
                set_state(&app, &mut inner, State::Ready, None);
            }
            match &inner.turn {
                Some(id) if *id != mapper.id => mapper = Mapper::new(id),
                None => continue,
                _ => {}
            }
        }
        let mut events = mapper.map(&line);
        let finished = events.iter().any(|e| matches!(e, ChatEvent::Done { .. } | ChatEvent::Error { .. }));
        if finished {
            let mut inner = chat.0.lock().unwrap();
            if inner.gen != gen {
                return;
            }
            if std::mem::take(&mut inner.interrupted) {
                let id = mapper.id.clone();
                events = vec![ChatEvent::Done { id, text: mapper.partial().to_string(), duration_ms: 0, cost_usd: None }];
            }
            inner.turn = None;
            inner.last_active = Instant::now();
            for ev in events {
                emit(&app, ev);
            }
            set_state(&app, &mut inner, State::Ready, None);
        } else {
            for ev in events {
                emit(&app, ev);
            }
        }
    }
    let mut inner = chat.0.lock().unwrap();
    if inner.gen != gen {
        return;
    }
    let code = inner.proc.take().and_then(|mut p| p.child.wait().ok()).and_then(|s| s.code());
    log::line(format!("chat: exited code={}", code.map_or("none".to_string(), |c| c.to_string())));
    let tail = inner.last_err.lock().unwrap().clone();
    let message = if tail.is_empty() { "The chat process ended unexpectedly".to_string() } else { tail };
    if let Some(id) = inner.turn.take() {
        emit(&app, ChatEvent::Error { id: Some(id), message: message.clone() });
    }
    inner.gen += 1;
    set_state(&app, &mut inner, State::Error, Some(message));
}

fn idle_loop(app: AppHandle, gen: u64) {
    loop {
        std::thread::sleep(Duration::from_secs(2));
        let minutes = settings_of(&app).1;
        let chat = app.state::<Chat>();
        let mut inner = chat.0.lock().unwrap();
        if inner.gen != gen {
            return;
        }
        if minutes > 0 && inner.state == State::Ready && inner.last_active.elapsed() >= Duration::from_secs(minutes as u64 * 60) {
            log::line("chat: idle stop");
            stop_locked(&app, &mut inner, State::Off, None);
            return;
        }
    }
}

fn ensure_running(app: &AppHandle, inner: &mut Inner, bin: &Option<PathBuf>, model: &str) -> Result<(), String> {
    if inner.proc.is_some() {
        return Ok(());
    }
    let Some(bin) = bin else {
        let msg = "The claude command was not found".to_string();
        set_state(app, inner, State::Error, Some(msg.clone()));
        return Err(msg);
    };
    spawn(app, inner, bin, model).inspect_err(|e| set_state(app, inner, State::Error, Some(e.clone())))
}

fn send_blocking(app: &AppHandle, text: String) -> Result<(), String> {
    let (enabled, _, model, path) = settings_of(app);
    if !enabled {
        return Err("Chat is turned off".into());
    }
    let running = app.state::<Chat>().0.lock().unwrap().proc.is_some();
    let bin = if running { None } else { resolve(&path) };
    let chat = app.state::<Chat>();
    let mut inner = chat.0.lock().unwrap();
    if inner.state == State::Busy {
        return Err("Chat is busy".into());
    }
    ensure_running(app, &mut inner, &bin, &model)?;
    inner.turns += 1;
    let id = format!("t{}", inner.turns);
    inner.turn = Some(id.clone());
    inner.interrupted = false;
    emit(app, ChatEvent::Turn { id });
    set_state(app, &mut inner, State::Busy, None);
    let line = json!({"type": "user", "message": {"role": "user", "content": text}}).to_string();
    let written = match inner.proc.as_mut() {
        Some(p) => writeln!(p.stdin, "{line}").and_then(|_| p.stdin.flush()),
        None => Err(std::io::Error::other("not running")),
    };
    if written.is_err() {
        stop_locked(app, &mut inner, State::Error, Some("The chat process is not reachable".into()));
        return Err("The chat process is not reachable".into());
    }
    Ok(())
}

fn wake_blocking(app: &AppHandle) {
    let (enabled, _, model, path) = settings_of(app);
    if !enabled || app.state::<Chat>().0.lock().unwrap().proc.is_some() {
        return;
    }
    let bin = resolve(&path);
    let chat = app.state::<Chat>();
    let mut inner = chat.0.lock().unwrap();
    let _ = ensure_running(app, &mut inner, &bin, &model);
}

#[tauri::command]
pub async fn chat_send(app: AppHandle, text: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || send_blocking(&app, text)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn chat_wake(app: AppHandle) {
    let _ = tauri::async_runtime::spawn_blocking(move || wake_blocking(&app)).await;
}

/// The CLI takes an interrupt control request on stdin and keeps the conversation.
#[tauri::command]
pub fn chat_interrupt(app: AppHandle) {
    let chat = app.state::<Chat>();
    let mut inner = chat.0.lock().unwrap();
    if inner.state != State::Busy {
        return;
    }
    inner.interrupted = true;
    let line = json!({"type": "control_request", "request_id": format!("int_{}", inner.turns), "request": {"subtype": "interrupt"}}).to_string();
    let written = match inner.proc.as_mut() {
        Some(p) => writeln!(p.stdin, "{line}").and_then(|_| p.stdin.flush()),
        None => Err(std::io::Error::other("not running")),
    };
    if written.is_err() {
        stop_locked(&app, &mut inner, State::Off, None);
    }
}

#[tauri::command]
pub fn chat_reset(app: AppHandle) {
    let chat = app.state::<Chat>();
    let mut inner = chat.0.lock().unwrap();
    stop_locked(&app, &mut inner, State::Off, None);
}

#[tauri::command]
pub async fn chat_status(app: AppHandle) -> ChatStatus {
    tauri::async_runtime::spawn_blocking(move || {
        let (enabled, _, _, path) = settings_of(&app);
        let claude_found = resolve(&path).is_some();
        let chat = app.state::<Chat>();
        let inner = chat.0.lock().unwrap();
        let (state, detail) = if enabled { (inner.state, inner.detail.clone()) } else { (State::Off, None) };
        ChatStatus { enabled, state, claude_found, detail }
    })
    .await
    .unwrap_or(ChatStatus { enabled: false, state: State::Off, claude_found: false, detail: None })
}

/// Stops the process at once (chat turned off, app exit).
pub fn stop(app: &AppHandle) {
    let chat = app.state::<Chat>();
    let mut inner = chat.0.lock().unwrap();
    if inner.proc.is_some() || inner.state != State::Off {
        stop_locked(app, &mut inner, State::Off, None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(m: &mut Mapper, lines: &[&str]) -> Vec<ChatEvent> {
        lines.iter().flat_map(|l| m.map(l)).collect()
    }

    #[test]
    fn a_text_turn_streams_once_and_ends_with_done() {
        let mut m = Mapper::new("t1");
        let ev = run(
            &mut m,
            &[
                r#"{"type":"system","subtype":"hook_started"}"#,
                r#"{"type":"system","subtype":"thinking_tokens","estimated_tokens":50}"#,
                r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}},"parent_tool_use_id":null}"#,
                r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hm"}},"parent_tool_use_id":null}"#,
                r#"{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}},"parent_tool_use_id":null}"#,
                r#"{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hel"}},"parent_tool_use_id":null}"#,
                r#"{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"lo"}},"parent_tool_use_id":null}"#,
                r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Hello"}]}}"#,
                r#"{"type":"rate_limit_event"}"#,
                r#"{"type":"result","subtype":"success","is_error":false,"duration_ms":1234,"total_cost_usd":0.002,"result":"Hello"}"#,
            ],
        );
        assert_eq!(
            ev,
            vec![
                ChatEvent::Thinking { id: "t1".into() },
                ChatEvent::Delta { id: "t1".into(), text: "Hel".into() },
                ChatEvent::Delta { id: "t1".into(), text: "lo".into() },
                ChatEvent::Done { id: "t1".into(), text: "Hello".into(), duration_ms: 1234, cost_usd: Some(0.002) },
            ]
        );
        assert_eq!(m.partial(), "Hello");
    }

    #[test]
    fn a_web_search_turn_has_tool_pills() {
        let mut m = Mapper::new("t2");
        let ev = run(
            &mut m,
            &[
                r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"c1","name":"WebSearch","input":{"query":"rust 2024 edition"}}]}}"#,
                r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"c1","name":"WebSearch","input":{"query":"rust 2024 edition"}}]}}"#,
                r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"c2","name":"WebFetch","input":{"url":"https://user:pw@doc.rust-lang.org:443/edition-guide/?secret=1#top"}}]}}"#,
                r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"c1","content":"..."}]}}"#,
                r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"c2","is_error":true,"content":"x"}]}}"#,
                r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"zz"}]}}"#,
            ],
        );
        let tool = |call: &str, name: &str, label: &str, state| ChatEvent::Tool {
            id: "t2".into(),
            call_id: call.into(),
            tool: name.into(),
            label: label.into(),
            state,
        };
        assert_eq!(
            ev,
            vec![
                tool("c1", "WebSearch", "rust 2024 edition", ToolState::Running),
                tool("c2", "WebFetch", "doc.rust-lang.org", ToolState::Running),
                tool("c1", "WebSearch", "rust 2024 edition", ToolState::Done),
                tool("c2", "WebFetch", "doc.rust-lang.org", ToolState::Error),
            ]
        );
    }

    #[test]
    fn an_error_result_becomes_an_error_event() {
        let mut m = Mapper::new("t3");
        let ev = m.map(r#"{"type":"result","subtype":"error_during_execution","is_error":true,"result":"","errors":["Boom"]}"#);
        assert_eq!(ev, vec![ChatEvent::Error { id: Some("t3".into()), message: "Boom".into() }]);
        let ev = m.map(r#"{"type":"result","subtype":"error_max_turns","result":"Too long"}"#);
        assert_eq!(ev, vec![ChatEvent::Error { id: Some("t3".into()), message: "Too long".into() }]);
    }

    #[test]
    fn noise_and_subagent_lines_are_ignored() {
        let mut m = Mapper::new("t4");
        let ev = run(
            &mut m,
            &[
                "",
                "not json",
                r#"{"type":"control_response","response":{"subtype":"success"}}"#,
                r#"{"type":"system","subtype":"init"}"#,
                r#"{"type":"stream_event","event":{"type":"message_start"}}"#,
                r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"text":"x"}},"parent_tool_use_id":"abc"}"#,
                r#"{"type":"user","message":{"content":[{"type":"text","text":"[Request interrupted by user]"}]}}"#,
            ],
        );
        assert!(ev.is_empty());
    }

    #[test]
    fn events_serialize_like_the_typescript_union() {
        let v = serde_json::to_value(ChatEvent::Done { id: "t1".into(), text: "a".into(), duration_ms: 5, cost_usd: None }).unwrap();
        assert_eq!(v, json!({"type": "done", "id": "t1", "text": "a", "durationMs": 5}));
        let v = serde_json::to_value(ChatEvent::Tool {
            id: "t1".into(),
            call_id: "c".into(),
            tool: "WebSearch".into(),
            label: "q".into(),
            state: ToolState::Running,
        })
        .unwrap();
        assert_eq!(v["callId"], "c");
        assert_eq!(v["state"], "running");
        let v = serde_json::to_value(ChatEvent::Status { state: State::Starting, detail: None }).unwrap();
        assert_eq!(v, json!({"type": "status", "state": "starting"}));
        let v = serde_json::to_value(ChatEvent::Error { id: None, message: "m".into() }).unwrap();
        assert_eq!(v, json!({"type": "error", "message": "m"}));
    }

    #[test]
    fn binary_lookup_order() {
        let home = Path::new("/h");
        let known = candidates(home);
        let custom = if cfg!(windows) { "C:\\x\\claude.exe" } else { "/x/claude" };
        let all = |_: &Path| true;
        assert_eq!(resolve_with(custom, home, all, || None), Some(PathBuf::from(custom)));
        assert_eq!(resolve_with("", home, all, || None), Some(known[0].clone()));
        let only_second = |p: &Path| p == known[1];
        assert_eq!(resolve_with(custom, home, only_second, || None), Some(known[1].clone()));
        let none = |_: &Path| false;
        assert_eq!(resolve_with(custom, home, none, || Some(PathBuf::from("/login/claude"))), Some(PathBuf::from("/login/claude")));
        assert_eq!(resolve_with("", home, none, || None), None);
    }

    #[test]
    fn host_drops_everything_but_the_name() {
        assert_eq!(host("https://example.com/a?b=c"), "example.com");
        assert_eq!(host("http://[::1]:8080/x"), "::1");
        assert_eq!(host("example.com/path"), "example.com");
    }
}
