//! Background sessions the chat starts: Claude Code's own `claude --bg` sessions. The CLI's daemon owns
//! the process; we start, list (`claude agents --json`), stop and continue them with the CLI and keep
//! a small in-memory record. They are NOT muted (no SB_CHAT), so their hooks reach the island like any
//! session, permission requests and questions included. No permission flag is ever passed.

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::cli;

/// The name prefix that marks a session as started by Session Buddy; it survives an app restart.
pub const MARKER: &str = "Buddy: ";
const SHORT: Duration = Duration::from_secs(10);
const LONG: Duration = Duration::from_secs(40);
pub const BUSY: &str = "That session is busy with a turn. Try again when it has finished.";

/// What `claude agents --json` says about one background session.
#[derive(Debug, Clone, PartialEq)]
pub struct Agent {
    /// The short id every CLI command takes.
    pub id: String,
    pub session_id: String,
    pub cwd: String,
    pub name: String,
    pub started_at: i64,
    /// Present while the process runs.
    pub pid: Option<u32>,
    /// "busy", "idle" or "waiting" while it runs.
    pub status: Option<String>,
    /// "working", "blocked", "done", "stopped".
    pub state: Option<String>,
}

impl Agent {
    pub fn running(&self) -> bool {
        self.pid.is_some()
    }

    /// Running and between turns: the only moment a follow-up prompt is safe.
    pub fn idle(&self) -> bool {
        self.running() && self.status.as_deref() == Some("idle")
    }

    /// Running and doing something (or waiting for the user): counts against the limit.
    pub fn active(&self) -> bool {
        self.running() && !self.idle()
    }

    pub fn ours(&self) -> bool {
        self.name.starts_with(MARKER)
    }

    /// The project name the marker carries.
    pub fn project(&self) -> String {
        self.name.strip_prefix(MARKER).unwrap_or(&self.name).to_string()
    }
}

/// The background sessions in the CLI's JSON; interactive ones and malformed entries are skipped.
pub fn parse_agents(json: &str) -> Vec<Agent> {
    let Ok(Value::Array(list)) = serde_json::from_str::<Value>(json) else { return Vec::new() };
    list.iter()
        .filter(|a| a["kind"] == "background")
        .filter_map(|a| {
            Some(Agent {
                id: a["id"].as_str()?.to_string(),
                session_id: a["sessionId"].as_str()?.to_string(),
                cwd: a["cwd"].as_str().unwrap_or_default().to_string(),
                name: a["name"].as_str().unwrap_or_default().to_string(),
                started_at: a["startedAt"].as_i64().unwrap_or(0),
                pid: a["pid"].as_u64().and_then(|p| u32::try_from(p).ok()),
                status: a["status"].as_str().map(str::to_string),
                state: a["state"].as_str().map(str::to_string),
            })
        })
        .collect()
}

/// The id in "backgrounded · c91b09c1 · name".
fn parse_backgrounded(output: &str) -> Option<String> {
    let line = output.lines().find(|l| l.trim_start().starts_with("backgrounded"))?;
    line.split('·').nth(1).map(|s| s.trim().to_string()).filter(|id| !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric()))
}

/// Maps the CLI's complaint to a sentence for the model, without the folder path.
fn failure_text(output: &str) -> String {
    if output.contains("not trusted") {
        return "Claude Code does not trust that folder yet. The user has to run claude there once and accept the trust prompt.".into();
    }
    let line = output.lines().map(str::trim).find(|l| !l.is_empty() && !l.starts_with("Starting background")).unwrap_or("no details");
    let clipped: String = line.chars().take(120).collect();
    format!("Claude Code could not start the session: {clipped}")
}

pub trait Runner: Send + Sync {
    /// Runs `claude <args>` (in `cwd`) and returns what it printed; Err when it could not run or timed out.
    fn run(&self, cwd: Option<&Path>, args: &[String], timeout: Duration) -> Result<String, String>;
}

/// The real CLI, looked up on every call so a changed setting applies at once.
pub struct Claude {
    pub path_setting: Box<dyn Fn() -> String + Send + Sync>,
}

impl Runner for Claude {
    fn run(&self, cwd: Option<&Path>, args: &[String], timeout: Duration) -> Result<String, String> {
        let bin = cli::resolve(&(self.path_setting)()).ok_or("The claude command was not found")?;
        let mut cmd = Command::new(bin);
        cmd.args(args).env_remove("SB_CHAT").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        if let Some(dir) = cwd {
            cmd.current_dir(dir);
        }
        cli::no_window(&mut cmd);
        let mut child = cmd.spawn().map_err(|e| format!("Could not start claude: {e}"))?;
        let drain = |mut pipe: Box<dyn Read + Send>| {
            std::thread::spawn(move || {
                let mut text = String::new();
                let _ = pipe.read_to_string(&mut text);
                text
            })
        };
        let out = drain(Box::new(child.stdout.take().ok_or("no output pipe")?));
        let err = drain(Box::new(child.stderr.take().ok_or("no output pipe")?));
        let deadline = Instant::now() + timeout;
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("Claude Code did not answer in time".into());
                }
            }
        }
        Ok(out.join().unwrap_or_default() + &err.join().unwrap_or_default())
    }
}

/// A session this run started or found by its marker.
#[derive(Debug, Clone, PartialEq)]
struct Record {
    id: String,
    model: Option<String>,
    /// The store has been told that its session is managed.
    flagged: bool,
}

pub struct Workers {
    runner: Arc<dyn Runner>,
    /// Called with a session id that is managed, so the store can flag it.
    on_session: Box<dyn Fn(&str) + Send + Sync>,
    records: Mutex<Vec<Record>>,
    poll: Duration,
}

/// A session as the tools see it.
#[derive(Debug, Clone, PartialEq)]
pub struct Info {
    pub agent: Agent,
    pub model: Option<String>,
}

impl Workers {
    pub fn new(runner: Arc<dyn Runner>, on_session: impl Fn(&str) + Send + Sync + 'static) -> Self {
        Self { runner, on_session: Box::new(on_session), records: Mutex::new(Vec::new()), poll: Duration::from_millis(250) }
    }

    #[cfg(test)]
    fn fast(mut self) -> Self {
        self.poll = Duration::from_millis(2);
        self
    }

    /// The background sessions now. Those carrying our marker become managed (also after an app restart).
    pub fn refresh(&self) -> Result<Vec<Agent>, String> {
        let text = self.runner.run(None, &["agents".into(), "--json".into()], SHORT)?;
        let agents = parse_agents(&text);
        let mut records = self.records.lock().unwrap();
        for a in agents.iter().filter(|a| a.ours()) {
            let i = records.iter().position(|r| r.id == a.id).unwrap_or_else(|| {
                records.push(Record { id: a.id.clone(), model: None, flagged: false });
                records.len() - 1
            });
            if !std::mem::replace(&mut records[i].flagged, true) {
                (self.on_session)(&a.session_id);
            }
        }
        Ok(agents)
    }

    fn managed(&self, session_id: &str) -> Result<Agent, String> {
        let agents = self.refresh()?;
        agents
            .into_iter()
            .find(|a| a.session_id == session_id && a.ours())
            .ok_or_else(|| "That is not a background session Session Buddy started. Only those can be steered.".to_string())
    }

    pub fn info(&self, session_id: &str) -> Option<Info> {
        let agent = self.refresh().ok()?.into_iter().find(|a| a.session_id == session_id && a.ours())?;
        let model = self.records.lock().unwrap().iter().find(|r| r.id == agent.id).and_then(|r| r.model.clone());
        Some(Info { agent, model })
    }

    /// Started sessions that are working or waiting. Idle ones cost no parallel work and do not count.
    pub fn active(&self) -> Result<usize, String> {
        Ok(self.refresh()?.iter().filter(|a| a.ours() && a.active()).count())
    }

    /// Starts a background session in `folder` and waits briefly for its session id. Returns (session id or None, id).
    pub fn start(&self, folder: &Path, project: &str, model: &str, prompt: &str, max: usize) -> Result<(Option<String>, String), String> {
        let active = self.active()?;
        if active >= max {
            return Err(format!("{active} background sessions are working already (the limit is {max}). Wait for one or stop one first."));
        }
        let name = format!("{MARKER}{}", project.chars().filter(|c| !c.is_control()).take(40).collect::<String>());
        let args: Vec<String> = ["--bg", "--model", model, "-n", &name, "--", prompt].iter().map(|s| s.to_string()).collect();
        let output = self.runner.run(Some(folder), &args, LONG)?;
        let id = parse_backgrounded(&output).ok_or_else(|| failure_text(&output))?;
        {
            let mut records = self.records.lock().unwrap();
            match records.iter_mut().find(|r| r.id == id) {
                Some(r) => r.model = Some(model.to_string()),
                None => records.push(Record { id: id.clone(), model: Some(model.to_string()), flagged: false }),
            }
        }
        for _ in 0..20 {
            if let Some(a) = self.refresh()?.into_iter().find(|a| a.id == id) {
                return Ok((Some(a.session_id), id));
            }
            std::thread::sleep(self.poll);
        }
        Ok((None, id))
    }

    /// Continues the session with a prompt, under the same id. A running session is only touched while
    /// idle: it is stopped (the conversation is kept) and woken again with the prompt.
    pub fn send(&self, session_id: &str, text: &str) -> Result<String, String> {
        let agent = self.managed(session_id)?;
        if agent.running() {
            if !agent.idle() {
                return Err(BUSY.into());
            }
            self.runner.run(None, &["stop".into(), agent.id.clone()], SHORT)?;
            self.wait_stopped(&agent.id)?;
        }
        let args: Vec<String> = ["--bg", "--resume", &agent.session_id, "--", text].iter().map(|s| s.to_string()).collect();
        let output = self.runner.run(Some(Path::new(&agent.cwd)), &args, LONG)?;
        match parse_backgrounded(&output) {
            Some(id) if id == agent.id => Ok(agent.project()),
            Some(copy) => {
                // The CLI started a copy instead of continuing the session: do not leave it running.
                let _ = self.runner.run(None, &["stop".into(), copy], SHORT);
                Err("The session could not be continued under its own id".into())
            }
            None => Err(failure_text(&output)),
        }
    }

    pub fn stop(&self, session_id: &str) -> Result<String, String> {
        let agent = self.managed(session_id)?;
        if !agent.running() {
            return Err("That session is not running.".into());
        }
        self.runner.run(None, &["stop".into(), agent.id.clone()], SHORT)?;
        Ok(agent.project())
    }

    fn wait_stopped(&self, id: &str) -> Result<(), String> {
        for _ in 0..40 {
            if !self.refresh()?.iter().any(|a| a.id == id && a.running()) {
                return Ok(());
            }
            std::thread::sleep(self.poll);
        }
        Err("The session did not stop in time".into())
    }
}

/// `osascript` arguments that open Terminal.app on `claude attach <id>`: only a validated id and a
/// quoted binary path go into the script, never anything the model wrote.
#[cfg(any(target_os = "macos", test))]
pub fn attach_script(bin: &Path, id: &str) -> Result<String, String> {
    if id.len() != 8 || !id.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("That is not a background session id".into());
    }
    let shell = format!("'{}' attach {id}", bin.to_string_lossy().replace('\'', r"'\''"));
    let applescript = shell.replace('\\', r"\\").replace('"', r#"\""#);
    Ok(format!("tell application \"Terminal\"\nactivate\ndo script \"{applescript}\"\nend tell"))
}

/// Opens the user's Terminal on the session. macOS only.
#[cfg(target_os = "macos")]
pub fn attach(bin: &Path, id: &str) -> Result<(), String> {
    let script = attach_script(bin, id)?;
    Command::new("osascript").arg("-e").arg(script).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|e| format!("Could not open Terminal: {e}"))?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn attach(_bin: &Path, _id: &str) -> Result<(), String> {
    Err("Opening a terminal is only available on macOS for now".into())
}

pub fn folder_name(folder: &Path) -> String {
    folder.file_name().map_or_else(|| "project".to_string(), |n| n.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    const LIST: &str = r#"[
      {"id":"4e8f76b4","cwd":"/p/ReAL","kind":"background","startedAt":1,"sessionId":"4e8f76b4-708d","name":"AI-Server-Setup","state":"blocked"},
      {"pid":3679,"cwd":"/p","kind":"interactive","startedAt":2,"sessionId":"12975bdf","name":"projects-b1","status":"busy"},
      {"pid":55390,"id":"c91b09c1","cwd":"/p/Nexa","kind":"background","startedAt":3,"sessionId":"c91b09c1-0923","name":"Buddy: Nexa","status":"idle","state":"done"},
      {"id":"bad","kind":"background"}
    ]"#;

    #[test]
    fn agents_json_is_parsed() {
        let a = parse_agents(LIST);
        assert_eq!(a.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), ["4e8f76b4", "c91b09c1"]);
        assert!(!a[0].running() && !a[0].ours());
        assert!(a[1].running() && a[1].idle() && !a[1].active() && a[1].ours());
        assert_eq!(a[1].project(), "Nexa");
        assert_eq!((a[1].pid, a[1].status.as_deref(), a[1].state.as_deref()), (Some(55390), Some("idle"), Some("done")));
        assert!(parse_agents("not json").is_empty());
        assert!(parse_agents("{}").is_empty());
    }

    #[test]
    fn busy_and_waiting_count_as_active() {
        let mk = |status: &str| Agent { id: "i".into(), session_id: "s".into(), cwd: String::new(), name: MARKER.into(), started_at: 0, pid: Some(1), status: Some(status.into()), state: None };
        assert!(mk("busy").active() && mk("waiting").active());
        assert!(!mk("idle").active() && mk("idle").idle());
        assert!(!mk("busy").idle());
    }

    #[test]
    fn the_start_output_is_parsed() {
        let out = "Starting background service…\nbackgrounded · c91b09c1 · Buddy: Nexa\n  claude agents   list sessions\n";
        assert_eq!(parse_backgrounded(out).as_deref(), Some("c91b09c1"));
        assert_eq!(parse_backgrounded("backgrounded · 15d35396\n").as_deref(), Some("15d35396"));
        assert_eq!(parse_backgrounded("Workspace not trusted."), None);
        assert_eq!(parse_backgrounded("backgrounded · \n"), None);
    }

    #[test]
    fn failures_never_repeat_the_folder() {
        let t = failure_text("Workspace not trusted. Run `claude` in /Users/me/secret once and accept the trust prompt, then retry.");
        assert!(t.contains("trust") && !t.contains("/Users"));
        assert!(failure_text("Starting background service…\nboom").ends_with("boom"));
        assert!(failure_text("").contains("no details"));
        assert!(failure_text(&"x".repeat(500)).chars().count() < 200);
    }

    /// A scripted CLI: answers `agents --json` from a mutable list and records every other call.
    struct Fake {
        agents: Mutex<String>,
        calls: Mutex<Vec<(Option<PathBuf>, Vec<String>)>>,
        start_output: Mutex<String>,
        /// What `agents --json` shows after a `stop`.
        after_stop: Mutex<Option<String>>,
    }

    impl Fake {
        fn new(agents: &str) -> Arc<Self> {
            Arc::new(Self { agents: Mutex::new(agents.into()), calls: Mutex::new(Vec::new()), start_output: Mutex::new("backgrounded · c91b09c1 · Buddy: Nexa\n".into()), after_stop: Mutex::new(None) })
        }
        fn calls(&self) -> Vec<Vec<String>> {
            self.calls.lock().unwrap().iter().map(|c| c.1.clone()).filter(|a| a[0] != "agents").collect()
        }
    }

    impl Runner for Fake {
        fn run(&self, cwd: Option<&Path>, args: &[String], _timeout: Duration) -> Result<String, String> {
            if args[0] == "agents" {
                return Ok(self.agents.lock().unwrap().clone());
            }
            self.calls.lock().unwrap().push((cwd.map(Path::to_path_buf), args.to_vec()));
            if args[0] == "stop" {
                if let Some(next) = self.after_stop.lock().unwrap().clone() {
                    *self.agents.lock().unwrap() = next;
                }
                return Ok(format!("stopped {}\n", args[1]));
            }
            Ok(self.start_output.lock().unwrap().clone())
        }
    }

    fn workers(fake: &Arc<Fake>) -> (Workers, Arc<Mutex<Vec<String>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        (Workers::new(fake.clone(), move |s| sink.lock().unwrap().push(s.to_string())).fast(), seen)
    }

    fn entry(id: &str, pid: Option<u32>, status: &str, name: &str) -> String {
        let pid = pid.map_or(String::new(), |p| format!(r#""pid":{p},"#));
        format!(r#"{{{pid}"id":"{id}","cwd":"/p/Nexa","kind":"background","startedAt":1,"sessionId":"{id}-full","name":"{name}","status":"{status}","state":"done"}}"#)
    }

    #[test]
    fn start_runs_the_bg_command_without_any_permission_flag() {
        let fake = Fake::new(&format!("[{}]", entry("c91b09c1", Some(5), "busy", "Buddy: Nexa")));
        let (w, seen) = workers(&fake);
        let (session, id) = w.start(Path::new("/p/Nexa"), "Nexa", "sonnet", "-fix the inbox", 3).unwrap();
        assert_eq!((session.as_deref(), id.as_str()), (Some("c91b09c1-full"), "c91b09c1"));
        let calls = fake.calls.lock().unwrap().clone();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0.as_deref(), Some(Path::new("/p/Nexa")), "started in the folder");
        assert_eq!(calls[0].1, ["--bg", "--model", "sonnet", "-n", "Buddy: Nexa", "--", "-fix the inbox"]);
        assert!(!calls[0].1.iter().any(|a| a.contains("permission") || a.contains("dangerously") || a.contains("bypass")));
        assert_eq!(seen.lock().unwrap().as_slice(), ["c91b09c1-full"], "flagged as managed");
        assert_eq!(w.info("c91b09c1-full").unwrap().model.as_deref(), Some("sonnet"));
    }

    #[test]
    fn the_limit_counts_working_sessions_only() {
        let list = format!("[{},{},{},{}]", entry("aaaaaaa1", Some(1), "busy", "Buddy: A"), entry("aaaaaaa2", Some(2), "waiting", "Buddy: B"), entry("aaaaaaa3", Some(3), "idle", "Buddy: C"), entry("aaaaaaa4", Some(4), "busy", "mine"));
        let fake = Fake::new(&list);
        let (w, _) = workers(&fake);
        assert_eq!(w.active().unwrap(), 2);
        let refused = w.start(Path::new("/p/Nexa"), "Nexa", "haiku", "x", 2).unwrap_err();
        assert!(refused.contains("limit is 2"), "{refused}");
        assert!(fake.calls().is_empty(), "nothing was started");
        assert!(w.start(Path::new("/p/Nexa"), "Nexa", "haiku", "x", 3).is_ok());
    }

    #[test]
    fn a_failed_start_says_why() {
        let fake = Fake::new("[]");
        *fake.start_output.lock().unwrap() = "Workspace not trusted. Run `claude` in /p/x once and accept the trust prompt, then retry.".into();
        let (w, _) = workers(&fake);
        assert!(w.start(Path::new("/p/x"), "x", "haiku", "hi", 3).unwrap_err().contains("trust"));
    }

    #[test]
    fn markers_are_found_again_after_a_restart() {
        let fake = Fake::new(&format!("[{},{}]", entry("c91b09c1", None, "idle", "Buddy: Nexa"), entry("bbbbbbb2", None, "idle", "other")));
        let (w, seen) = workers(&fake);
        w.refresh().unwrap();
        assert_eq!(seen.lock().unwrap().as_slice(), ["c91b09c1-full"]);
    }

    #[test]
    fn only_our_sessions_can_be_steered() {
        let fake = Fake::new(&format!("[{}]", entry("bbbbbbb2", Some(2), "idle", "someone elses")));
        let (w, _) = workers(&fake);
        assert!(w.send("bbbbbbb2-full", "hi").unwrap_err().contains("Only those"));
        assert!(w.stop("bbbbbbb2-full").is_err());
        assert!(w.send("nope", "hi").is_err());
        assert!(fake.calls().is_empty());
    }

    #[test]
    fn a_busy_session_refuses_a_prompt() {
        for status in ["busy", "waiting"] {
            let fake = Fake::new(&format!("[{}]", entry("c91b09c1", Some(5), status, "Buddy: Nexa")));
            let (w, _) = workers(&fake);
            assert_eq!(w.send("c91b09c1-full", "more").unwrap_err(), BUSY);
            assert!(fake.calls().is_empty());
        }
    }

    #[test]
    fn an_idle_running_session_is_stopped_and_woken_with_the_prompt() {
        let fake = Fake::new(&format!("[{}]", entry("c91b09c1", Some(5), "idle", "Buddy: Nexa")));
        *fake.after_stop.lock().unwrap() = Some(format!("[{}]", entry("c91b09c1", None, "idle", "Buddy: Nexa")));
        let (w, _) = workers(&fake);
        assert_eq!(w.send("c91b09c1-full", "next step").unwrap(), "Nexa");
        let calls = fake.calls();
        assert_eq!(calls[0], ["stop", "c91b09c1"]);
        assert_eq!(calls[1], ["--bg", "--resume", "c91b09c1-full", "--", "next step"], "no flags: the saved options apply");
        let cwd = fake.calls.lock().unwrap()[1].0.clone();
        assert_eq!(cwd.as_deref(), Some(Path::new("/p/Nexa")));
    }

    #[test]
    fn a_stopped_session_is_woken_directly() {
        let fake = Fake::new(&format!("[{}]", entry("c91b09c1", None, "idle", "Buddy: Nexa")));
        let (w, _) = workers(&fake);
        w.send("c91b09c1-full", "go").unwrap();
        assert_eq!(fake.calls().len(), 1);
        assert_eq!(fake.calls()[0][0], "--bg");
    }

    #[test]
    fn a_copy_is_stopped_and_reported() {
        let fake = Fake::new(&format!("[{}]", entry("c91b09c1", None, "idle", "Buddy: Nexa")));
        *fake.start_output.lock().unwrap() = "note: started a copy\nbackgrounded · d1d34953\n".into();
        let (w, _) = workers(&fake);
        assert!(w.send("c91b09c1-full", "go").unwrap_err().contains("own id"));
        assert_eq!(fake.calls().last().unwrap(), &["stop", "d1d34953"]);
    }

    #[test]
    fn a_session_that_never_stops_is_reported() {
        let fake = Fake::new(&format!("[{}]", entry("c91b09c1", Some(5), "idle", "Buddy: Nexa")));
        let (w, _) = workers(&fake);
        assert!(w.send("c91b09c1-full", "go").unwrap_err().contains("did not stop"));
    }

    #[test]
    fn stop_stops_by_short_id() {
        let fake = Fake::new(&format!("[{}]", entry("c91b09c1", Some(5), "busy", "Buddy: Nexa")));
        let (w, _) = workers(&fake);
        assert_eq!(w.stop("c91b09c1-full").unwrap(), "Nexa");
        assert_eq!(fake.calls(), vec![vec!["stop".to_string(), "c91b09c1".to_string()]]);
        let fake = Fake::new(&format!("[{}]", entry("c91b09c1", None, "idle", "Buddy: Nexa")));
        let (w, _) = workers(&fake);
        assert!(w.stop("c91b09c1-full").unwrap_err().contains("not running"));
    }

    #[test]
    fn the_attach_script_quotes_for_the_shell_and_applescript() {
        let s = attach_script(Path::new("/Users/o'neil/bin/claude"), "c91b09c1").unwrap();
        assert!(s.contains(r#"do script "'/Users/o'\\''neil/bin/claude' attach c91b09c1""#), "{s}");
        let s = attach_script(Path::new(r#"/a "b"/claude"#), "c91b09c1").unwrap();
        assert!(s.contains(r#"'/a \"b\"/claude' attach"#), "{s}");
        for bad in ["", "c91b09c", "c91b09c1;ls", "c91b09c1 ", "../../x", "g91b09c1", "c91b09c1\"; do shell script \"x"] {
            assert!(attach_script(Path::new("/x/claude"), bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn folder_names() {
        assert_eq!(folder_name(Path::new("/p/Nexa")), "Nexa");
    }

    /// Read-only against the real CLI: `cargo test -p session-buddy e2e_agents -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn e2e_agents_lists_background_sessions() {
        let runner = Claude { path_setting: Box::new(String::new) };
        let w = Workers::new(Arc::new(runner), |_| {});
        let agents = w.refresh().expect("claude agents --json");
        println!("{agents:#?}");
    }
}
