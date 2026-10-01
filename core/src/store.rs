//! Every Claude Code session, built from hook and status-line events.
//! Pure state: no I/O, no clock. Callers pass `now` in epoch milliseconds.

use std::collections::{HashMap, VecDeque};

use serde::Serialize;
use serde_json::Value;

use crate::steps::{approval_target, clip, project_name, step_label};

pub const MAX_STEPS: usize = 50;
pub const FINISHED_TO_IDLE_MS: i64 = 30_000;
pub const DEFAULT_STALE_AFTER_MS: i64 = 10 * 60_000;
pub const DEFAULT_REMOVE_AFTER_MS: i64 = 2 * 60 * 60_000;
const ENDED_AGENT_KEEP_MS: i64 = 10 * 60_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Thinking,
    Working,
    NeedsYou,
    Finished,
    Error,
    Idle,
    Stale,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub tool: String,
    pub label: String,
    pub at: i64,
    pub ok: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Agent {
    pub id: String,
    pub agent_type: String,
    pub description: Option<String>,
    pub running: bool,
    pub current_step: Option<String>,
    pub started_at: i64,
    pub ended_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundTask {
    pub id: String,
    pub kind: String,
    pub status: String,
    pub description: String,
    pub agent_type: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub lines_added: u64,
    pub lines_removed: u64,
    pub context_used_pct: Option<f64>,
    pub context_tokens: Option<u64>,
    pub context_size: Option<u64>,
    pub cost_usd: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum Interaction {
    Approval { request_id: String, tool: String, target: String, agent_id: Option<String>, deadline: i64 },
    Question { request_id: String, questions: Value, deadline: i64 },
    Reply { request_id: String, message: String, deadline: i64 },
}

impl Interaction {
    pub fn request_id(&self) -> &str {
        match self {
            Interaction::Approval { request_id, .. }
            | Interaction::Question { request_id, .. }
            | Interaction::Reply { request_id, .. } => request_id,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub project: String,
    pub cwd: String,
    pub branch: Option<String>,
    pub term_program: Option<String>,
    pub model: Option<String>,
    pub status: Status,
    pub status_since: i64,
    pub last_prompt: Option<String>,
    pub last_message: Option<String>,
    pub steps: VecDeque<Step>,
    pub agents: Vec<Agent>,
    pub background: Vec<BackgroundTask>,
    pub stats: Stats,
    pub pending: VecDeque<Interaction>,
    pub started_at: i64,
    pub last_event_at: i64,
    /// (subagent_type, description) from main-thread Agent calls, waiting for their SubagentStart.
    #[serde(skip)]
    pub agent_descriptions: Vec<(String, String)>,
    #[serde(skip)]
    pub branch_checked_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CueKind {
    Work,
    Finish,
    Error,
    Approval,
    Rate,
    Context,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cue {
    pub session_id: String,
    pub kind: CueKind,
}

pub struct Store {
    sessions: HashMap<String, Session>,
    pub stale_after_ms: i64,
    pub remove_after_ms: i64,
    /// Latest `rate_limits` object seen in a status-line payload, with when it arrived.
    pub rate_limits: Option<(Value, i64)>,
}

impl Default for Store {
    fn default() -> Self {
        Self {
            sessions: HashMap::new(),
            stale_after_ms: DEFAULT_STALE_AFTER_MS,
            remove_after_ms: DEFAULT_REMOVE_AFTER_MS,
            rate_limits: None,
        }
    }
}

fn s<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str).filter(|x| !x.is_empty())
}

impl Session {
    pub fn new(id: &str, now: i64) -> Self {
        Self {
            id: id.to_string(),
            project: "Session".into(),
            cwd: String::new(),
            branch: None,
            term_program: None,
            model: None,
            status: Status::Idle,
            status_since: now,
            last_prompt: None,
            last_message: None,
            steps: VecDeque::new(),
            agents: Vec::new(),
            background: Vec::new(),
            stats: Stats::default(),
            pending: VecDeque::new(),
            started_at: now,
            last_event_at: now,
            agent_descriptions: Vec::new(),
            branch_checked_at: i64::MIN / 2,
        }
    }

    /// An open interaction always wins: the session needs the user until it is answered.
    fn set_status(&mut self, wanted: Status, now: i64) {
        let next = if self.pending.is_empty() { wanted } else { Status::NeedsYou };
        if next != self.status {
            self.status = next;
            self.status_since = now;
        }
    }

    fn push_step(&mut self, tool: &str, label: String, now: i64) {
        self.steps.push_back(Step { tool: tool.to_string(), label, at: now, ok: None });
        while self.steps.len() > MAX_STEPS {
            self.steps.pop_front();
        }
    }

    fn finish_step(&mut self, tool: &str, ok: bool) {
        if let Some(step) = self.steps.iter_mut().rev().find(|x| x.tool == tool && x.ok.is_none()) {
            step.ok = Some(ok);
        }
    }

    fn agent_entry(&mut self, id: &str, agent_type: Option<&str>, now: i64) -> &mut Agent {
        if let Some(i) = self.agents.iter().position(|a| a.id == id) {
            if let Some(t) = agent_type {
                self.agents[i].agent_type = t.to_string();
            }
            return &mut self.agents[i];
        }
        self.agents.push(Agent {
            id: id.to_string(),
            agent_type: agent_type.unwrap_or("agent").to_string(),
            description: None,
            running: true,
            current_step: None,
            started_at: now,
            ended_at: None,
        });
        self.agents.last_mut().expect("just pushed")
    }

    /// The description of the oldest waiting Agent call of this type (or any type).
    fn take_description(&mut self, agent_type: &str) -> Option<String> {
        let i = self
            .agent_descriptions
            .iter()
            .position(|(t, _)| t == agent_type)
            .or(if self.agent_descriptions.is_empty() { None } else { Some(0) })?;
        let (_, d) = self.agent_descriptions.remove(i);
        (!d.is_empty()).then_some(d)
    }

    fn update_background(&mut self, p: &Value) {
        let Some(list) = p.get("background_tasks").and_then(Value::as_array) else { return };
        self.background = list
            .iter()
            .map(|t| BackgroundTask {
                id: s(t, "id").unwrap_or_default().to_string(),
                kind: s(t, "type").unwrap_or("task").to_string(),
                status: s(t, "status").unwrap_or("running").to_string(),
                description: s(t, "description").unwrap_or_default().to_string(),
                agent_type: s(t, "agent_type").map(str::to_string),
            })
            .collect();
    }
}

impl Store {
    pub fn get(&self, id: &str) -> Option<&Session> {
        self.sessions.get(id)
    }

    pub fn snapshot(&self) -> Vec<Session> {
        let mut list: Vec<Session> = self.sessions.values().cloned().collect();
        list.sort_by(|a, b| a.started_at.cmp(&b.started_at).then_with(|| a.id.cmp(&b.id)));
        list
    }

    /// Finds or creates the session and refreshes cwd / project / terminal.
    fn touch(&mut self, p: &Value, now: i64) -> Option<&mut Session> {
        let id = s(p, "session_id")?;
        let sess = self.sessions.entry(id.to_string()).or_insert_with(|| Session::new(id, now));
        if let Some(cwd) = s(p, "cwd") {
            if sess.cwd != cwd {
                sess.cwd = cwd.to_string();
                sess.project = project_name(cwd);
                sess.branch_checked_at = i64::MIN / 2;
            }
        }
        if let Some(t) = s(p, "term_program") {
            sess.term_program = Some(t.to_string());
        }
        Some(sess)
    }

    pub fn apply_hook(&mut self, p: &Value, now: i64) -> Vec<Cue> {
        let event = s(p, "hook_event_name").unwrap_or_default();
        let Some(id) = s(p, "session_id").map(str::to_string) else { return Vec::new() };
        if event == "SessionEnd" {
            self.sessions.remove(&id);
            return Vec::new();
        }
        let Some(sess) = self.touch(p, now) else { return Vec::new() };
        sess.last_event_at = now;
        if sess.status == Status::Stale {
            sess.set_status(Status::Idle, now);
        }

        let request_id = s(p, "sb_request_id").map(str::to_string);
        let deadline = now + p.get("sb_wait_ms").and_then(Value::as_i64).unwrap_or(0);
        let agent_id = s(p, "agent_id").map(str::to_string);
        let agent_type = s(p, "agent_type");
        let tool = s(p, "tool_name").unwrap_or("Tool").to_string();
        let empty = Value::Object(Default::default());
        let input = p.get("tool_input").unwrap_or(&empty);
        let is_agent_tool = tool == "Agent" || tool == "Task";

        let mut cues = Vec::new();
        let mut cue = |kind| cues.push(Cue { session_id: id.clone(), kind });

        match event {
            "SessionStart" => cue(CueKind::Work),
            "UserPromptSubmit" => {
                if let Some(t) = s(p, "prompt") {
                    sess.last_prompt = Some(clip(t, 300));
                }
                sess.set_status(Status::Thinking, now);
            }
            "PreToolUse" if tool == "AskUserQuestion" => {
                if let Some(request_id) = request_id {
                    let questions = input.get("questions").cloned().unwrap_or(Value::Array(Vec::new()));
                    sess.pending.push_back(Interaction::Question { request_id, questions, deadline });
                    sess.set_status(Status::NeedsYou, now);
                    cue(CueKind::Approval);
                }
            }
            "PreToolUse" => {
                let label = step_label(&tool, input);
                match &agent_id {
                    Some(aid) => {
                        let a = sess.agent_entry(aid, agent_type, now);
                        a.current_step = Some(label);
                        a.running = true;
                    }
                    None => {
                        if is_agent_tool {
                            let t = s(input, "subagent_type").unwrap_or("general-purpose").to_string();
                            let d = s(input, "description").unwrap_or_default().to_string();
                            sess.agent_descriptions.push((t, d));
                        }
                        sess.push_step(&tool, label, now);
                    }
                }
                sess.set_status(Status::Working, now);
            }
            "PostToolUse" | "PostToolUseFailure" => {
                if agent_id.is_none() {
                    sess.finish_step(&tool, event == "PostToolUse");
                }
                if is_agent_tool {
                    if let Some(resp) = p.get("tool_response") {
                        if let (Some(aid), Some(desc)) = (s(resp, "agentId"), s(resp, "description")) {
                            if let Some(a) = sess.agents.iter_mut().find(|a| a.id == aid) {
                                a.description = Some(desc.to_string());
                            }
                        }
                    }
                }
                if sess.status != Status::Finished {
                    sess.set_status(Status::Working, now);
                }
            }
            "PermissionRequest" => {
                if let Some(request_id) = request_id {
                    sess.pending.push_back(Interaction::Approval {
                        request_id,
                        tool: tool.clone(),
                        target: approval_target(&tool, input),
                        agent_id: agent_id.clone(),
                        deadline,
                    });
                    sess.set_status(Status::NeedsYou, now);
                    cue(CueKind::Approval);
                }
            }
            "Notification" => {
                let m = s(p, "message").unwrap_or_default().to_lowercase();
                if m.contains("rate limit") || m.contains("usage limit") {
                    cue(CueKind::Rate);
                }
            }
            "Stop" => {
                if let Some(m) = s(p, "last_assistant_message") {
                    sess.last_message = Some(clip(m, 2_000));
                }
                sess.update_background(p);
                match request_id {
                    Some(request_id) => {
                        let message = sess.last_message.clone().unwrap_or_default();
                        sess.pending.push_back(Interaction::Reply { request_id, message, deadline });
                        sess.set_status(Status::NeedsYou, now);
                        cue(CueKind::Approval);
                    }
                    None => {
                        sess.set_status(Status::Finished, now);
                        if sess.status == Status::Finished {
                            cue(CueKind::Finish);
                        }
                    }
                }
            }
            "StopFailure" => {
                sess.set_status(Status::Error, now);
                cue(CueKind::Error);
            }
            "SubagentStart" => {
                if let Some(aid) = &agent_id {
                    let t = agent_type.unwrap_or("agent").to_string();
                    let desc = sess.take_description(&t);
                    let a = sess.agent_entry(aid, Some(&t), now);
                    a.running = true;
                    if a.description.is_none() {
                        a.description = desc;
                    }
                }
            }
            "SubagentStop" => {
                if let Some(aid) = &agent_id {
                    let a = sess.agent_entry(aid, agent_type, now);
                    a.running = false;
                    a.ended_at = Some(now);
                    a.current_step = None;
                }
                sess.update_background(p);
            }
            _ => {}
        }
        cues
    }

    pub fn apply_statusline(&mut self, p: &Value, now: i64) -> Vec<Cue> {
        if let Some(rl) = p.get("rate_limits").filter(|v| v.is_object()) {
            self.rate_limits = Some((rl.clone(), now));
        }
        let Some(sess) = self.touch(p, now) else { return Vec::new() };
        if let Some(m) = p.pointer("/model/display_name").and_then(Value::as_str) {
            sess.model = Some(m.to_string());
        }
        if let Some(c) = p.get("cost") {
            sess.stats.lines_added = c.get("total_lines_added").and_then(Value::as_u64).unwrap_or(sess.stats.lines_added);
            sess.stats.lines_removed = c.get("total_lines_removed").and_then(Value::as_u64).unwrap_or(sess.stats.lines_removed);
            sess.stats.cost_usd = c.get("total_cost_usd").and_then(Value::as_f64).or(sess.stats.cost_usd);
        }
        let mut cues = Vec::new();
        if let Some(cw) = p.get("context_window") {
            let before = sess.stats.context_used_pct.unwrap_or(0.0);
            let pct = cw.get("used_percentage").and_then(Value::as_f64);
            let size = cw.get("context_window_size").and_then(Value::as_u64);
            sess.stats.context_used_pct = pct;
            sess.stats.context_size = size;
            sess.stats.context_tokens = match (pct, size) {
                (Some(pc), Some(sz)) => Some((pc / 100.0 * sz as f64).round() as u64),
                _ => None,
            };
            if let Some(pc) = pct {
                if before < 90.0 && pc >= 90.0 {
                    cues.push(Cue { session_id: sess.id.clone(), kind: CueKind::Context });
                }
            }
        }
        cues
    }

    /// Drops an open interaction. `answered` = the human answered on the island;
    /// false = released to the terminal (button, deadline or closed connection).
    pub fn resolve(&mut self, request_id: &str, answered: bool, now: i64) -> Option<String> {
        for sess in self.sessions.values_mut() {
            let Some(i) = sess.pending.iter().position(|x| x.request_id() == request_id) else { continue };
            let item = sess.pending.remove(i).expect("index from position");
            let next = match (item, answered) {
                (Interaction::Reply { .. }, true) => Status::Thinking,
                (Interaction::Reply { .. }, false) => Status::Finished,
                _ => Status::Working,
            };
            sess.status = Status::Idle; // force set_status to stamp status_since
            sess.set_status(next, now);
            return Some(sess.id.clone());
        }
        None
    }

    /// Time-based transitions. Returns true when anything changed.
    pub fn tick(&mut self, now: i64) -> bool {
        let stale = self.stale_after_ms;
        let remove = self.remove_after_ms;
        let mut changed = false;
        self.sessions.retain(|_, s| {
            let keep = !(s.status == Status::Stale && now - s.last_event_at >= stale + remove);
            changed |= !keep;
            keep
        });
        for s in self.sessions.values_mut() {
            if s.status == Status::Finished && now - s.status_since >= FINISHED_TO_IDLE_MS {
                s.set_status(Status::Idle, now);
                changed = true;
            }
            if s.pending.is_empty() && s.status != Status::Stale && now - s.last_event_at >= stale {
                s.set_status(Status::Stale, now);
                changed = true;
            }
            let before = s.agents.len();
            s.agents.retain(|a| a.running || a.ended_at.is_none_or(|e| now - e < ENDED_AGENT_KEEP_MS));
            changed |= s.agents.len() != before;
        }
        changed
    }

    /// Adds a session found on disk at start-up; never overwrites a live one.
    pub fn seed(&mut self, session: Session) {
        self.sessions.entry(session.id.clone()).or_insert(session);
    }

    pub fn sessions_needing_branch(&mut self, now: i64, every_ms: i64) -> Vec<(String, String)> {
        let mut out = Vec::new();
        for s in self.sessions.values_mut() {
            if !s.cwd.is_empty() && now - s.branch_checked_at >= every_ms {
                s.branch_checked_at = now;
                out.push((s.id.clone(), s.cwd.clone()));
            }
        }
        out.sort();
        out
    }

    pub fn set_branch(&mut self, id: &str, branch: Option<String>) -> bool {
        match self.sessions.get_mut(id) {
            Some(s) if s.branch != branch => {
                s.branch = branch;
                true
            }
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const T0: i64 = 1_000_000;

    fn ev(event: &str, extra: Value) -> Value {
        let mut v = json!({"hook_event_name": event, "session_id": "s1", "cwd": r"C:\Projects\pushdocs"});
        for (k, val) in extra.as_object().unwrap() {
            v[k] = val.clone();
        }
        v
    }

    fn sess(store: &Store) -> &Session {
        store.get("s1").expect("session s1")
    }

    #[test]
    fn session_created_with_project_and_terminal() {
        let mut st = Store::default();
        let cues = st.apply_hook(&ev("SessionStart", json!({"term_program": "WarpTerminal"})), T0);
        assert_eq!(cues, vec![Cue { session_id: "s1".into(), kind: CueKind::Work }]);
        let s = sess(&st);
        assert_eq!(s.project, "pushdocs");
        assert_eq!(s.term_program.as_deref(), Some("WarpTerminal"));
        assert_eq!(s.status, Status::Idle);
        assert_eq!(s.started_at, T0);
    }

    #[test]
    fn prompt_then_tool_then_failure() {
        let mut st = Store::default();
        st.apply_hook(&ev("UserPromptSubmit", json!({"prompt": "fix the DATEV 409 handling"})), T0);
        assert_eq!(sess(&st).status, Status::Thinking);
        assert_eq!(sess(&st).last_prompt.as_deref(), Some("fix the DATEV 409 handling"));
        st.apply_hook(&ev("PreToolUse", json!({"tool_name": "Edit", "tool_input": {"file_path": "a/DatevClient.php"}})), T0 + 1);
        assert_eq!(sess(&st).status, Status::Working);
        assert_eq!(sess(&st).steps.back().unwrap().label, "Edit · DatevClient.php");
        assert_eq!(sess(&st).steps.back().unwrap().ok, None);
        st.apply_hook(&ev("PostToolUseFailure", json!({"tool_name": "Edit"})), T0 + 2);
        assert_eq!(sess(&st).steps.back().unwrap().ok, Some(false));
    }

    #[test]
    fn steps_ring_buffer_caps_at_50() {
        let mut st = Store::default();
        for i in 0..60 {
            st.apply_hook(&ev("PreToolUse", json!({"tool_name": "Read", "tool_input": {"file_path": format!("f{i}.rs")}})), T0 + i);
        }
        let steps = &sess(&st).steps;
        assert_eq!(steps.len(), MAX_STEPS);
        assert_eq!(steps.front().unwrap().label, "Read · f10.rs");
    }

    #[test]
    fn permission_needs_you_until_resolved() {
        let mut st = Store::default();
        let cues = st.apply_hook(
            &ev("PermissionRequest", json!({"tool_name": "Bash", "tool_input": {"command": "rm -rf build"}, "sb_request_id": "r1", "sb_wait_ms": 110_000})),
            T0,
        );
        assert_eq!(cues[0].kind, CueKind::Approval);
        let s = sess(&st);
        assert_eq!(s.status, Status::NeedsYou);
        assert_eq!(
            s.pending[0],
            Interaction::Approval { request_id: "r1".into(), tool: "Bash".into(), target: "Bash · rm -rf build".into(), agent_id: None, deadline: T0 + 110_000 }
        );
        // Work events while waiting must not hide the card.
        st.apply_hook(&ev("PostToolUse", json!({"tool_name": "Read"})), T0 + 5);
        assert_eq!(sess(&st).status, Status::NeedsYou);
        assert_eq!(st.resolve("r1", true, T0 + 10), Some("s1".into()));
        assert_eq!(sess(&st).status, Status::Working);
        assert!(sess(&st).pending.is_empty());
        assert_eq!(st.resolve("r1", true, T0 + 11), None);
    }

    #[test]
    fn permission_without_request_id_is_ignored() {
        let mut st = Store::default();
        let cues = st.apply_hook(&ev("PermissionRequest", json!({"tool_name": "Bash"})), T0);
        assert!(cues.is_empty());
        assert!(sess(&st).pending.is_empty());
    }

    #[test]
    fn question_and_reply_queue_in_order() {
        let mut st = Store::default();
        st.apply_hook(
            &ev("PreToolUse", json!({"tool_name": "AskUserQuestion", "tool_input": {"questions": [{"question": "Pick?", "options": [{"label": "A"}]}]}, "sb_request_id": "q1", "sb_wait_ms": 540_000})),
            T0,
        );
        st.apply_hook(&ev("Stop", json!({"last_assistant_message": "Push now?", "sb_request_id": "p1", "sb_wait_ms": 540_000})), T0 + 1);
        let s = sess(&st);
        assert_eq!(s.pending.len(), 2);
        assert!(matches!(&s.pending[0], Interaction::Question { request_id, .. } if request_id == "q1"));
        assert!(matches!(&s.pending[1], Interaction::Reply { request_id, message, .. } if request_id == "p1" && message == "Push now?"));
        // An AskUserQuestion is never shown as a step.
        assert!(s.steps.is_empty());
        st.resolve("q1", true, T0 + 2);
        assert_eq!(sess(&st).status, Status::NeedsYou);
        // Released in the terminal: the turn is over, so the session is finished, not thinking.
        st.resolve("p1", false, T0 + 3);
        assert_eq!(sess(&st).status, Status::Finished);
    }

    #[test]
    fn stop_finishes_with_cue_then_idle_after_30s() {
        let mut st = Store::default();
        st.apply_hook(&ev("UserPromptSubmit", json!({"prompt": "go"})), T0);
        let cues = st.apply_hook(&ev("Stop", json!({"last_assistant_message": "All done."})), T0 + 1_000);
        assert_eq!(cues[0].kind, CueKind::Finish);
        assert_eq!(sess(&st).status, Status::Finished);
        assert_eq!(sess(&st).last_message.as_deref(), Some("All done."));
        assert!(!st.tick(T0 + 1_000 + FINISHED_TO_IDLE_MS - 1));
        assert!(st.tick(T0 + 1_000 + FINISHED_TO_IDLE_MS));
        assert_eq!(sess(&st).status, Status::Idle);
    }

    #[test]
    fn stop_failure_is_error() {
        let mut st = Store::default();
        let cues = st.apply_hook(&ev("StopFailure", json!({})), T0);
        assert_eq!(cues[0].kind, CueKind::Error);
        assert_eq!(sess(&st).status, Status::Error);
    }

    #[test]
    fn stale_then_removed() {
        let mut st = Store::default();
        st.apply_hook(&ev("SessionStart", json!({})), T0);
        st.tick(T0 + DEFAULT_STALE_AFTER_MS - 1);
        assert_eq!(sess(&st).status, Status::Idle);
        st.tick(T0 + DEFAULT_STALE_AFTER_MS);
        assert_eq!(sess(&st).status, Status::Stale);
        st.tick(T0 + DEFAULT_STALE_AFTER_MS + DEFAULT_REMOVE_AFTER_MS - 1);
        assert!(st.get("s1").is_some());
        assert!(st.tick(T0 + DEFAULT_STALE_AFTER_MS + DEFAULT_REMOVE_AFTER_MS));
        assert!(st.get("s1").is_none());
    }

    #[test]
    fn pending_session_never_goes_stale() {
        let mut st = Store::default();
        st.apply_hook(&ev("PermissionRequest", json!({"tool_name": "Bash", "sb_request_id": "r1", "sb_wait_ms": 1})), T0);
        st.tick(T0 + DEFAULT_STALE_AFTER_MS * 2);
        assert_eq!(sess(&st).status, Status::NeedsYou);
    }

    #[test]
    fn stale_session_revives_on_event() {
        let mut st = Store::default();
        st.apply_hook(&ev("SessionStart", json!({})), T0);
        st.tick(T0 + DEFAULT_STALE_AFTER_MS);
        st.apply_hook(&ev("Notification", json!({"message": "Claude is waiting for your input"})), T0 + DEFAULT_STALE_AFTER_MS + 5);
        assert_eq!(sess(&st).status, Status::Idle);
    }

    #[test]
    fn rate_limit_notification_cues() {
        let mut st = Store::default();
        let cues = st.apply_hook(&ev("Notification", json!({"message": "Claude usage limit reached"})), T0);
        assert_eq!(cues[0].kind, CueKind::Rate);
    }

    #[test]
    fn session_end_removes() {
        let mut st = Store::default();
        st.apply_hook(&ev("SessionStart", json!({})), T0);
        st.apply_hook(&ev("SessionEnd", json!({})), T0 + 1);
        assert!(st.get("s1").is_none());
        assert!(st.snapshot().is_empty());
    }

    #[test]
    fn subagent_attribution_from_spike() {
        let mut st = Store::default();
        let fixture = include_str!("../tests/fixtures/spike-events.jsonl");
        let mut sid = String::new();
        for (i, line) in fixture.lines().filter(|l| !l.trim().is_empty()).enumerate() {
            let row: Value = serde_json::from_str(line).unwrap();
            if sid.is_empty() {
                sid = row["payload"]["session_id"].as_str().unwrap().to_string();
            }
            st.apply_hook(&row["payload"], T0 + i as i64);
        }
        let s = st.get(&sid).unwrap();
        let labels: Vec<&str> = s.steps.iter().map(|x| x.label.as_str()).collect();
        assert!(labels.contains(&"Agent · Run shell command and reply DONE"));
        assert!(labels.contains(&"Load tools · select:AskUserQuestion"));
        assert!(!labels.iter().any(|l| l.contains("hello-from-subagent")), "sub-agent step leaked into main thread: {labels:?}");
        assert_eq!(s.agents.len(), 1);
        let a = &s.agents[0];
        assert_eq!(a.id, "ad7c4b5d237f7193a");
        assert_eq!(a.agent_type, "general-purpose");
        assert_eq!(a.description.as_deref(), Some("Run shell command and reply DONE"));
        assert!(!a.running);
        assert!(a.ended_at.is_some());
        assert_eq!(s.status, Status::Finished);
        assert!(s.background.is_empty(), "last Stop reported no background tasks");
    }

    #[test]
    fn agent_current_step_and_background_tasks() {
        let mut st = Store::default();
        st.apply_hook(&ev("PreToolUse", json!({"tool_name": "Agent", "tool_input": {"subagent_type": "Explore", "description": "Find callers"}})), T0);
        st.apply_hook(&ev("SubagentStart", json!({"agent_id": "a1", "agent_type": "Explore"})), T0 + 1);
        st.apply_hook(&ev("PreToolUse", json!({"agent_id": "a1", "agent_type": "Explore", "tool_name": "Grep", "tool_input": {"pattern": "409"}})), T0 + 2);
        let s = sess(&st);
        assert_eq!(s.agents[0].current_step.as_deref(), Some("Search · 409"));
        assert_eq!(s.agents[0].description.as_deref(), Some("Find callers"));
        assert_eq!(s.steps.len(), 1, "only the Agent call itself is a main-thread step");
        st.apply_hook(
            &ev("Stop", json!({"last_assistant_message": "Started.", "background_tasks": [{"id": "a1", "type": "subagent", "status": "running", "description": "Find callers", "agent_type": "Explore"}]})),
            T0 + 3,
        );
        assert_eq!(
            sess(&st).background,
            vec![BackgroundTask { id: "a1".into(), kind: "subagent".into(), status: "running".into(), description: "Find callers".into(), agent_type: Some("Explore".into()) }]
        );
    }

    #[test]
    fn ended_agents_are_pruned_after_10_minutes() {
        let mut st = Store::default();
        st.apply_hook(&ev("SubagentStart", json!({"agent_id": "a1", "agent_type": "Plan"})), T0);
        st.apply_hook(&ev("SubagentStop", json!({"agent_id": "a1", "agent_type": "Plan"})), T0 + 1);
        st.tick(T0 + 1 + 10 * 60_000 - 1);
        assert_eq!(sess(&st).agents.len(), 1);
        st.tick(T0 + 1 + 10 * 60_000);
        assert!(sess(&st).agents.is_empty());
    }

    #[test]
    fn statusline_stats_context_cue_and_rate_limits() {
        let mut st = Store::default();
        let p = json!({
            "session_id": "s1", "cwd": r"C:\Projects\pushdocs",
            "model": {"display_name": "Opus 5.5"},
            "cost": {"total_lines_added": 128, "total_lines_removed": 34, "total_cost_usd": 1.25},
            "context_window": {"used_percentage": 61.0, "context_window_size": 200000},
            "rate_limits": {"five_hour": {"used_percentage": 42.0}}
        });
        assert!(st.apply_statusline(&p, T0).is_empty());
        let s = sess(&st);
        assert_eq!(s.model.as_deref(), Some("Opus 5.5"));
        assert_eq!(s.stats.lines_added, 128);
        assert_eq!(s.stats.lines_removed, 34);
        assert_eq!(s.stats.context_tokens, Some(122_000));
        assert_eq!(s.stats.context_size, Some(200_000));
        assert_eq!(st.rate_limits.as_ref().unwrap().1, T0);
        let mut hot = p.clone();
        hot["context_window"]["used_percentage"] = json!(91.0);
        assert_eq!(st.apply_statusline(&hot, T0 + 1)[0].kind, CueKind::Context);
        // Only on the crossing, not on every refresh.
        assert!(st.apply_statusline(&hot, T0 + 2).is_empty());
    }

    #[test]
    fn statusline_does_not_keep_a_session_fresh() {
        let mut st = Store::default();
        st.apply_hook(&ev("SessionStart", json!({})), T0);
        st.apply_statusline(&json!({"session_id": "s1"}), T0 + DEFAULT_STALE_AFTER_MS - 1);
        st.tick(T0 + DEFAULT_STALE_AFTER_MS);
        assert_eq!(sess(&st).status, Status::Stale);
    }

    #[test]
    fn branch_lookups_are_rate_limited() {
        let mut st = Store::default();
        st.apply_hook(&ev("SessionStart", json!({})), T0);
        assert_eq!(st.sessions_needing_branch(T0, 30_000), vec![("s1".to_string(), r"C:\Projects\pushdocs".to_string())]);
        assert!(st.sessions_needing_branch(T0 + 29_999, 30_000).is_empty());
        assert!(st.set_branch("s1", Some("PDD-1981".into())));
        assert!(!st.set_branch("s1", Some("PDD-1981".into())));
        assert_eq!(sess(&st).branch.as_deref(), Some("PDD-1981"));
        assert_eq!(st.sessions_needing_branch(T0 + 30_000, 30_000).len(), 1);
    }

    #[test]
    fn snapshot_is_ordered_by_start() {
        let mut st = Store::default();
        st.apply_hook(&json!({"hook_event_name": "SessionStart", "session_id": "b", "cwd": "/x/b"}), T0 + 5);
        st.apply_hook(&json!({"hook_event_name": "SessionStart", "session_id": "a", "cwd": "/x/a"}), T0);
        let ids: Vec<String> = st.snapshot().into_iter().map(|s| s.id).collect();
        assert_eq!(ids, vec!["a", "b"]);
    }

    #[test]
    fn serializes_for_the_front_end() {
        let mut st = Store::default();
        st.apply_hook(&ev("PermissionRequest", json!({"tool_name": "Bash", "sb_request_id": "r1", "sb_wait_ms": 1})), T0);
        let v = serde_json::to_value(st.snapshot()).unwrap();
        assert_eq!(v[0]["status"], "needs_you");
        assert_eq!(v[0]["pending"][0]["kind"], "approval");
        assert_eq!(v[0]["pending"][0]["requestId"], "r1");
        assert!(v[0].get("agentDescriptions").is_none());
        assert!(v[0]["stats"].get("linesAdded").is_some());
    }
}
