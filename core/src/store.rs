//! Every Claude Code session, built from hook and status-line events.
//! Pure state: no I/O, no clock. Callers pass `now` in epoch milliseconds.

use std::collections::{HashMap, VecDeque};

use serde::Serialize;
use serde_json::Value;

use crate::adopt::{match_processes, Candidate, ClaudeProcess};
use crate::steps::{approval_target, clip, output_tail, project_name, step_detail, step_label, StepDetail};

pub const MAX_STEPS: usize = 50;
pub const FINISHED_TO_IDLE_MS: i64 = 30_000;
pub const DEFAULT_STALE_AFTER_MS: i64 = 10 * 60_000;
pub const DEFAULT_REMOVE_AFTER_MS: i64 = 2 * 60 * 60_000;
const ENDED_AGENT_KEEP_MS: i64 = 10 * 60_000;
/// While a tool or an agent is running the session may be silent for long; it still goes
/// stale eventually (e.g. its terminal tab was closed mid-tool), just not before this.
const BUSY_STALE_AFTER_MS: i64 = 60 * 60_000;

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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<StepDetail>,
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
    /// The agent's last hook event; an agent silent since an earlier turn is taken as ended.
    #[serde(skip)]
    pub last_seen_at: i64,
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
    /// The Claude Code process behind the session, as reported by the relay.
    pub pid: Option<u32>,
    /// True once a hook or status-line event arrived; false for sessions seeded from transcripts.
    pub live: bool,
    /// (subagent_type, description) from main-thread Agent calls, waiting for their SubagentStart.
    #[serde(skip)]
    pub agent_descriptions: Vec<(String, String)>,
    #[serde(skip)]
    pub branch_checked_at: i64,
    /// The first cwd seen: the project name comes from its git top level and never follows later cds.
    #[serde(skip)]
    pub first_cwd: Option<String>,
    #[serde(skip)]
    pub toplevel_checked: bool,
    /// For a seed: its transcript folder name, the encoded directory Claude Code started in.
    #[serde(skip)]
    pub project_key: Option<String>,
    /// When the current turn started (prompt, or the first work event when the prompt was not seen).
    #[serde(skip)]
    pub turn_started_at: Option<i64>,
    /// When the work for the last typed prompt started; outlives the turn while agents or
    /// background tasks keep running after its Stop.
    #[serde(skip)]
    pub work_started_at: Option<i64>,
    /// The last Stop left agents or background tasks running: their end is the real completion.
    #[serde(skip)]
    pub finish_deferred: bool,
    /// When the latest turn started with a UserPromptSubmit (typed or wrapped).
    #[serde(skip)]
    pub prompt_at: Option<i64>,
    /// The plan Claude Code is asking to approve (ExitPlanMode). Answered only in the terminal.
    pub plan: Option<String>,
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
    /// Finish cues: how long the turn took (for the real completion after
    /// background work: how long since the prompt).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_ms: Option<i64>,
    /// Finish cues: agents or background tasks are still running, so this is not the real end.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub busy: bool,
}

impl Cue {
    pub fn new(session_id: String, kind: CueKind) -> Self {
        Self { session_id, kind, turn_ms: None, busy: false }
    }
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
            pid: None,
            live: false,
            agent_descriptions: Vec::new(),
            branch_checked_at: i64::MIN / 2,
            first_cwd: None,
            toplevel_checked: false,
            project_key: None,
            turn_started_at: None,
            work_started_at: None,
            finish_deferred: false,
            prompt_at: None,
            plan: None,
        }
    }

    /// An open interaction always wins: the session needs the user until it is answered.
    fn set_status(&mut self, wanted: Status, now: i64) {
        let next = if self.pending.is_empty() { wanted } else { Status::NeedsYou };
        if next != self.status {
            self.status = next;
            self.status_since = now;
        }
        match next {
            Status::Thinking | Status::Working => {
                self.turn_started_at.get_or_insert(now);
                self.work_started_at.get_or_insert(now);
            }
            Status::NeedsYou => {}
            Status::Finished => self.turn_started_at = None,
            // Esc at the terminal's plan dialog sends no Stop: a quiet or failed session drops its plan.
            Status::Idle | Status::Stale | Status::Error => {
                self.turn_started_at = None;
                self.plan = None;
            }
        }
    }

    fn push_step(&mut self, tool: &str, label: String, detail: Option<StepDetail>, now: i64) {
        self.steps.push_back(Step { tool: tool.to_string(), label, at: now, ok: None, detail });
        while self.steps.len() > MAX_STEPS {
            self.steps.pop_front();
        }
    }

    /// Closes the open step of `tool`; a command also keeps the end of its output.
    fn finish_step(&mut self, tool: &str, ok: bool, response: Option<&Value>) {
        if let Some(step) = self.steps.iter_mut().rev().find(|x| x.tool == tool && x.ok.is_none()) {
            step.ok = Some(ok);
            if let (Some(StepDetail::Run { output, .. }), Some(r)) = (step.detail.as_mut(), response) {
                *output = output_tail(r);
            }
        }
    }

    /// A denied or interrupted tool never gets a PostToolUse: when the turn ends, whatever is still running failed.
    fn close_open_steps(&mut self) {
        for step in self.steps.iter_mut().filter(|x| x.ok.is_none()) {
            step.ok = Some(false);
        }
    }

    fn agent_entry(&mut self, id: &str, agent_type: Option<&str>, now: i64) -> &mut Agent {
        if let Some(i) = self.agents.iter().position(|a| a.id == id) {
            if let Some(t) = agent_type {
                self.agents[i].agent_type = t.to_string();
            }
            self.agents[i].last_seen_at = now;
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
            last_seen_at: now,
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

    /// Agents that never sent their SubagentStop (Esc, crash) would keep the session busy forever.
    fn end_agents(&mut self, now: i64, ended: impl Fn(&Agent) -> bool) {
        for a in self.agents.iter_mut().filter(|a| a.running && ended(a)) {
            a.running = false;
            a.ended_at = Some(now);
            a.current_step = None;
        }
    }

    /// Sub-agents or background tasks still running.
    fn busy(&self) -> bool {
        self.agents.iter().any(|a| a.running) || self.background.iter().any(|b| b.status == "running")
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

    /// A pid belongs to one session. Any other session holding it (e.g. a seed adopted by a wrong
    /// guess, or the session a /clear replaced) goes back to recent, unless it waits for the user.
    fn release_pid(&mut self, owner: &str, pid: u32) {
        for (id, s) in self.sessions.iter_mut() {
            if id != owner && s.pid == Some(pid) && s.pending.is_empty() {
                s.pid = None;
                s.live = false;
            }
        }
    }

    /// Finds or creates the session, marks it live, records the relay's pid and refreshes cwd / terminal.
    /// The project is set from the first cwd only.
    fn touch(&mut self, p: &Value, now: i64) -> Option<&mut Session> {
        let id = s(p, "session_id")?;
        let pid = p.get("sb_claude_pid").and_then(Value::as_u64).and_then(|x| u32::try_from(x).ok());
        if let Some(pid) = pid {
            self.release_pid(id, pid);
        }
        let sess = self.sessions.entry(id.to_string()).or_insert_with(|| Session::new(id, now));
        sess.live = true;
        if pid.is_some() {
            sess.pid = pid;
        }
        if let Some(cwd) = s(p, "cwd") {
            if sess.cwd != cwd {
                sess.cwd = cwd.to_string();
                sess.branch_checked_at = i64::MIN / 2;
                if sess.first_cwd.is_none() {
                    sess.first_cwd = Some(cwd.to_string());
                    sess.project = project_name(cwd);
                }
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

        if let Some(m) = s(p, "model").filter(|m| !m.is_empty()) {
            // A raw id never replaces the status line's display name.
            if sess.model.as_deref().is_none_or(|cur| cur.starts_with("claude-")) {
                sess.model = Some(m.to_string());
            }
        }

        let request_id = s(p, "sb_request_id").map(str::to_string);
        let deadline = now + p.get("sb_wait_ms").and_then(Value::as_i64).unwrap_or(0);
        let agent_id = s(p, "agent_id").map(str::to_string);
        let agent_type = s(p, "agent_type");
        let tool = s(p, "tool_name").unwrap_or("Tool").to_string();
        let empty = Value::Object(Default::default());
        let input = p.get("tool_input").unwrap_or(&empty);
        let is_agent_tool = tool == "Agent" || tool == "Task";
        let is_plan = tool == "ExitPlanMode";
        let plan_text = s(input, "plan").map(|t| clip(t, 8_000));

        let mut cues = Vec::new();
        let mut finished_turn = None;
        let mut busy = false;
        let mut cue = |kind| cues.push(Cue::new(id.clone(), kind));

        match event {
            "SessionStart" => cue(CueKind::Work),
            "UserPromptSubmit" => {
                // Wrappers such as <agent-message>, <command-name> or <system-reminder> are not typed prompts.
                if let Some(t) = s(p, "prompt").map(str::trim).filter(|t| !t.is_empty() && !t.starts_with('<')) {
                    sess.last_prompt = Some(clip(t, 300));
                    // A typed prompt starts new work; a wrapper (an agent's result) continues the old.
                    sess.work_started_at = Some(now);
                    sess.finish_deferred = false;
                    // An agent silent since the previous turn started is gone.
                    if let Some(prev) = sess.prompt_at {
                        sess.end_agents(now, |a| a.last_seen_at < prev);
                    }
                }
                sess.prompt_at = Some(now);
                sess.turn_started_at = Some(now);
                sess.plan = None;
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
            // The terminal shows its own plan dialog; the island only shows the plan.
            "PreToolUse" if is_plan && agent_id.is_none() => sess.plan = plan_text.or(Some(String::new())),
            "PreToolUse" => {
                if agent_id.is_none() {
                    sess.plan = None;
                }
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
                        sess.push_step(&tool, label, step_detail(&tool, input), now);
                    }
                }
                sess.set_status(Status::Working, now);
            }
            "PostToolUse" | "PostToolUseFailure" => {
                if is_plan {
                    sess.plan = None;
                }
                if agent_id.is_none() {
                    sess.finish_step(&tool, event == "PostToolUse", p.get("tool_response"));
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
            // Never a pending card: Claude Code ignores a hook answer for ExitPlanMode.
            "PermissionRequest" if is_plan => sess.plan = plan_text.or(Some(String::new())),
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
                sess.plan = None;
                sess.close_open_steps();
                if let Some(m) = s(p, "last_assistant_message") {
                    sess.last_message = Some(clip(m, 2_000));
                }
                sess.update_background(p);
                // The payload lists what still runs: a running agent missing from it has ended.
                if let Some(list) = p.get("background_tasks").and_then(Value::as_array) {
                    let ids: Vec<&str> = list.iter().filter_map(|t| s(t, "id")).collect();
                    sess.end_agents(now, |a| !ids.contains(&a.id.as_str()));
                }
                match request_id {
                    Some(request_id) => {
                        let message = sess.last_message.clone().unwrap_or_default();
                        sess.pending.push_back(Interaction::Reply { request_id, message, deadline });
                        sess.set_status(Status::NeedsYou, now);
                        cue(CueKind::Approval);
                    }
                    None => {
                        // After a deferred finish the work runs since the prompt, not since this turn.
                        let since = if sess.finish_deferred { sess.work_started_at.or(sess.turn_started_at) } else { sess.turn_started_at };
                        finished_turn = since.map(|t| now - t);
                        busy = sess.busy();
                        sess.finish_deferred = busy;
                        if !busy {
                            sess.work_started_at = None;
                        }
                        sess.set_status(Status::Finished, now);
                        if sess.status == Status::Finished {
                            cue(CueKind::Finish);
                        }
                    }
                }
            }
            "StopFailure" => {
                sess.plan = None;
                sess.close_open_steps();
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
                // The last agent of a finished turn is done: that is the real completion.
                if sess.finish_deferred && !sess.busy() && matches!(sess.status, Status::Finished | Status::Idle) {
                    finished_turn = sess.work_started_at.map(|t| now - t);
                    sess.finish_deferred = false;
                    sess.work_started_at = None;
                    cue(CueKind::Finish);
                }
            }
            _ => {}
        }
        for c in cues.iter_mut().filter(|c| c.kind == CueKind::Finish) {
            c.turn_ms = finished_turn;
            c.busy = busy;
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
                    cues.push(Cue::new(sess.id.clone(), CueKind::Context));
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
            if next == Status::Thinking {
                sess.turn_started_at = Some(now); // a reply starts a new turn
            }
            sess.set_status(next, now);
            return Some(sess.id.clone());
        }
        None
    }

    /// Time-based transitions. Returns true when anything changed.
    pub fn tick(&mut self, now: i64) -> bool {
        let base = self.stale_after_ms;
        let remove = self.remove_after_ms;
        // A long tool or a running agent sends no events while it works: allow a longer silence.
        let stale_after = |s: &Session| {
            let busy = s.steps.back().is_some_and(|x| x.ok.is_none()) || s.agents.iter().any(|a| a.running);
            if busy { base.max(BUSY_STALE_AFTER_MS) } else { base }
        };
        let mut changed = false;
        self.sessions.retain(|_, s| {
            let keep = !(s.status == Status::Stale && now - s.last_event_at >= stale_after(s) + remove);
            changed |= !keep;
            keep
        });
        for s in self.sessions.values_mut() {
            if s.status == Status::Finished && now - s.status_since >= FINISHED_TO_IDLE_MS {
                s.set_status(Status::Idle, now);
                changed = true;
            }
            if s.pending.is_empty() && s.status != Status::Stale && now - s.last_event_at >= stale_after(s) {
                s.set_status(Status::Stale, now);
                changed = true;
            }
            let before = s.agents.len();
            s.agents.retain(|a| a.running || a.ended_at.is_none_or(|e| now - e < ENDED_AGENT_KEEP_MS));
            changed |= s.agents.len() != before;
        }
        changed
    }

    /// Drops sessions whose Claude Code process has ended (e.g. the terminal tab was closed
    /// without a SessionEnd). Sessions still waiting for the user stay: the hub resolves those
    /// when the relay disconnects. Returns true when anything was removed.
    pub fn remove_dead(&mut self, is_alive: impl Fn(u32) -> bool) -> bool {
        let before = self.sessions.len();
        self.sessions.retain(|_, s| !s.pending.is_empty() || s.pid.is_none_or(&is_alive));
        self.sessions.len() != before
    }

    /// True while a seeded session waits for a process to claim it.
    pub fn has_unclaimed_seeds(&self) -> bool {
        self.sessions.values().any(|s| !s.live && s.pid.is_none())
    }

    /// Gives seeded sessions the running Claude Code process in their directory
    /// (see `adopt::match_processes`) and makes them live. Processes some session
    /// already has are skipped. A claimed session that went stale while it waited is
    /// idle again from `now`: its process runs, so it counts and the stale timers restart.
    /// Returns true when any session was claimed.
    pub fn adopt(&mut self, procs: &[ClaudeProcess], windows: bool, now: i64) -> bool {
        let known: Vec<u32> = self.sessions.values().filter_map(|s| s.pid).collect();
        let free: Vec<ClaudeProcess> = procs.iter().filter(|p| !known.contains(&p.pid)).cloned().collect();
        let mut candidates: Vec<Candidate> = self
            .sessions
            .values()
            .filter(|s| !s.live && s.pid.is_none())
            .map(|s| Candidate { id: s.id.clone(), first_cwd: s.first_cwd.clone(), cwd: s.cwd.clone(), project_key: s.project_key.clone(), modified_ms: s.last_event_at })
            .collect();
        candidates.sort_by(|a, b| a.id.cmp(&b.id));
        let pairs = match_processes(&candidates, &free, windows);
        for (id, pid) in &pairs {
            if let Some(s) = self.sessions.get_mut(id) {
                s.pid = Some(*pid);
                s.live = true;
                if s.status == Status::Stale {
                    s.last_event_at = now;
                    s.set_status(Status::Idle, now);
                }
            }
        }
        !pairs.is_empty()
    }

    /// How many of `procs` some session holds.
    pub fn count_held(&self, procs: &[ClaudeProcess]) -> usize {
        procs.iter().filter(|p| self.sessions.values().any(|s| s.pid == Some(p.pid))).count()
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

    /// Sessions whose first cwd still needs a `git rev-parse --show-toplevel`; each is handed out once.
    pub fn sessions_needing_toplevel(&mut self) -> Vec<(String, String)> {
        let mut out = Vec::new();
        for s in self.sessions.values_mut() {
            if s.toplevel_checked {
                continue;
            }
            if let Some(cwd) = &s.first_cwd {
                s.toplevel_checked = true;
                out.push((s.id.clone(), cwd.clone()));
            }
        }
        out.sort();
        out
    }

    /// Names the project after the repository's top-level directory. `None` keeps the fallback.
    pub fn set_toplevel(&mut self, id: &str, toplevel: Option<String>) -> bool {
        let (Some(s), Some(top)) = (self.sessions.get_mut(id), toplevel) else { return false };
        let name = project_name(&top);
        if s.project == name {
            return false;
        }
        s.project = name;
        true
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
    fn a_command_keeps_the_end_of_its_output() {
        let mut st = Store::default();
        st.apply_hook(&ev("PreToolUse", json!({"tool_name": "Bash", "tool_input": {"command": "npm test"}})), T0);
        st.apply_hook(&ev("PostToolUse", json!({"tool_name": "Bash", "tool_response": {"stdout": "Tests: 48 passed\n", "stderr": ""}})), T0 + 1);
        let step = sess(&st).steps.back().unwrap().clone();
        assert_eq!(step.detail, Some(StepDetail::Run { command: "npm test".into(), output: Some("Tests: 48 passed".into()) }));
        st.apply_hook(&ev("PreToolUse", json!({"tool_name": "Edit", "tool_input": {"file_path": "/p/a.ts", "old_string": "a", "new_string": "b"}})), T0 + 2);
        assert!(matches!(sess(&st).steps.back().unwrap().detail, Some(StepDetail::Diff { .. })));
    }

    #[test]
    fn session_created_with_project_and_terminal() {
        let mut st = Store::default();
        let cues = st.apply_hook(&ev("SessionStart", json!({"term_program": "WarpTerminal"})), T0);
        assert_eq!(cues, vec![Cue::new("s1".into(), CueKind::Work)]);
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
    fn stop_and_stop_failure_close_steps_that_never_completed() {
        for event in ["Stop", "StopFailure"] {
            let mut st = Store::default();
            st.apply_hook(&ev("PreToolUse", json!({"tool_name": "Bash", "tool_input": {"command": "ls"}})), T0);
            st.apply_hook(&ev("PostToolUse", json!({"tool_name": "Bash"})), T0 + 1);
            st.apply_hook(&ev("PreToolUse", json!({"tool_name": "Edit", "tool_input": {"file_path": "a.php"}})), T0 + 2);
            st.apply_hook(&ev(event, json!({})), T0 + 3);
            let steps = &sess(&st).steps;
            assert_eq!(steps[0].ok, Some(true), "{event}: completed steps are untouched");
            assert_eq!(steps[1].ok, Some(false), "{event}: the denied tool is closed as failed");
        }
    }

    #[test]
    fn hook_model_is_a_fallback_for_the_status_line_name() {
        let mut st = Store::default();
        st.apply_hook(&ev("SessionStart", json!({"model": "claude-opus-5-5"})), T0);
        assert_eq!(sess(&st).model.as_deref(), Some("claude-opus-5-5"));
        st.apply_statusline(&json!({"session_id": "s1", "model": {"display_name": "Opus 5.5"}}), T0 + 1);
        assert_eq!(sess(&st).model.as_deref(), Some("Opus 5.5"));
        st.apply_hook(&ev("UserPromptSubmit", json!({"model": "claude-opus-5-5", "prompt": "x"})), T0 + 2);
        assert_eq!(sess(&st).model.as_deref(), Some("Opus 5.5"), "the display name always wins");
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
    fn running_tool_or_agent_delays_stale() {
        let mut st = Store::default();
        st.apply_hook(&ev("PreToolUse", json!({"tool_name": "Bash", "tool_input": {"command": "cargo build"}})), T0);
        st.tick(T0 + DEFAULT_STALE_AFTER_MS * 2);
        assert_eq!(sess(&st).status, Status::Working, "the Bash call is still running");
        st.apply_hook(&ev("PostToolUse", json!({"tool_name": "Bash"})), T0 + 1);
        st.apply_hook(&ev("SubagentStart", json!({"agent_id": "a1", "agent_type": "Explore"})), T0 + 2);
        st.tick(T0 + 2 + DEFAULT_STALE_AFTER_MS * 2);
        assert_ne!(sess(&st).status, Status::Stale, "an agent is still running");
        st.apply_hook(&ev("SubagentStop", json!({"agent_id": "a1"})), T0 + 3);
        st.tick(T0 + 3 + DEFAULT_STALE_AFTER_MS);
        assert_eq!(sess(&st).status, Status::Stale);
    }

    #[test]
    fn running_step_goes_stale_after_an_hour_and_is_removed_later() {
        let mut st = Store::default();
        st.apply_hook(&ev("PreToolUse", json!({"tool_name": "Bash", "tool_input": {"command": "sleep 99999"}})), T0);
        st.tick(T0 + BUSY_STALE_AFTER_MS - 1);
        assert_eq!(sess(&st).status, Status::Working);
        assert!(st.tick(T0 + BUSY_STALE_AFTER_MS));
        assert_eq!(sess(&st).status, Status::Stale, "terminal closed mid-tool: stale after 60 min");
        st.tick(T0 + BUSY_STALE_AFTER_MS + DEFAULT_REMOVE_AFTER_MS - 1);
        assert!(st.get("s1").is_some());
        assert!(st.tick(T0 + BUSY_STALE_AFTER_MS + DEFAULT_REMOVE_AFTER_MS));
        assert!(st.get("s1").is_none());
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
    fn project_comes_from_the_first_cwd_and_never_follows_cd() {
        let mut st = Store::default();
        let at = |cwd: &str| json!({"hook_event_name": "PreToolUse", "session_id": "s1", "cwd": cwd, "tool_name": "Read"});
        st.apply_hook(&at(r"C:\Projects\session-buddy\core"), T0);
        assert_eq!(sess(&st).project, "core", "fallback: last component of the first cwd");
        assert_eq!(st.sessions_needing_toplevel(), vec![("s1".to_string(), r"C:\Projects\session-buddy\core".to_string())]);
        assert!(st.sessions_needing_toplevel().is_empty(), "looked up once");
        assert!(st.set_toplevel("s1", Some("C:/Projects/session-buddy".into())));
        assert_eq!(sess(&st).project, "session-buddy");
        st.apply_hook(&at(r"C:\Projects\pushdocs\api"), T0 + 1);
        assert_eq!(sess(&st).cwd, r"C:\Projects\pushdocs\api", "cwd follows the session");
        assert_eq!(sess(&st).project, "session-buddy", "project never does");
        assert!(st.sessions_needing_toplevel().is_empty(), "a later cwd is not looked up");
    }

    #[test]
    fn project_falls_back_when_not_a_repo() {
        let mut st = Store::default();
        st.apply_hook(&ev("SessionStart", json!({})), T0);
        assert_eq!(st.sessions_needing_toplevel().len(), 1);
        assert!(!st.set_toplevel("s1", None));
        assert_eq!(sess(&st).project, "pushdocs");
        assert!(!st.set_toplevel("nope", Some("/x/y".into())));
    }

    #[test]
    fn seeded_session_keeps_its_project_when_cwd_changes() {
        let mut st = Store::default();
        let mut seeded = Session::new("s1", T0);
        seeded.cwd = r"C:\Projects\pushdocs".into();
        seeded.first_cwd = Some(seeded.cwd.clone());
        seeded.project = "pushdocs".into();
        st.seed(seeded);
        st.apply_hook(&json!({"hook_event_name": "PreToolUse", "session_id": "s1", "cwd": "/tmp/other", "tool_name": "Read"}), T0 + 1);
        assert_eq!(sess(&st).project, "pushdocs");
        assert_eq!(sess(&st).cwd, "/tmp/other");
    }

    #[test]
    fn wrapped_prompts_do_not_replace_the_last_prompt() {
        let mut st = Store::default();
        st.apply_hook(&ev("UserPromptSubmit", json!({"prompt": "fix the island layout"})), T0);
        for wrapped in ["<agent-message from=\"x\">hi</agent-message>", "  <command-name>/clear</command-name>", "<system-reminder>x</system-reminder>"] {
            st.apply_hook(&ev("UserPromptSubmit", json!({"prompt": wrapped})), T0 + 1);
            assert_eq!(sess(&st).last_prompt.as_deref(), Some("fix the island layout"), "{wrapped}");
        }
        assert_eq!(sess(&st).status, Status::Thinking, "the turn still starts");
        st.apply_hook(&ev("UserPromptSubmit", json!({"prompt": "  next < step  "})), T0 + 2);
        assert_eq!(sess(&st).last_prompt.as_deref(), Some("next < step"));
    }

    #[test]
    fn finish_cue_carries_the_turn_duration() {
        let mut st = Store::default();
        st.apply_hook(&ev("UserPromptSubmit", json!({"prompt": "go"})), T0);
        st.apply_hook(&ev("PreToolUse", json!({"tool_name": "Read"})), T0 + 1_000);
        st.apply_hook(&ev("PostToolUse", json!({"tool_name": "Read"})), T0 + 2_000);
        let cues = st.apply_hook(&ev("Stop", json!({})), T0 + 65_000);
        assert_eq!(cues, vec![Cue { session_id: "s1".into(), kind: CueKind::Finish, turn_ms: Some(65_000), busy: false }]);
        let v = serde_json::to_value(&cues[0]).unwrap();
        assert_eq!(v["turnMs"], 65_000);
        // A turn whose start was never seen (app started mid-turn) starts at its first work event.
        let mut st = Store::default();
        st.apply_hook(&ev("PreToolUse", json!({"tool_name": "Read"})), T0);
        let cues = st.apply_hook(&ev("Stop", json!({})), T0 + 5_000);
        assert_eq!(cues[0].turn_ms, Some(5_000));
        // A Stop without any turn has no duration and the field is left out.
        let mut st = Store::default();
        st.apply_hook(&ev("SessionStart", json!({})), T0);
        let cues = st.apply_hook(&ev("Stop", json!({})), T0 + 1);
        assert_eq!(cues[0].turn_ms, None);
        assert!(serde_json::to_value(&cues[0]).unwrap().get("turnMs").is_none());
    }

    #[test]
    fn a_stop_with_running_agents_is_busy_and_their_end_is_the_real_finish() {
        let mut st = Store::default();
        st.apply_hook(&ev("UserPromptSubmit", json!({"prompt": "go"})), T0);
        st.apply_hook(&ev("SubagentStart", json!({"agent_id": "a1", "agent_type": "Explore"})), T0 + 1_000);
        let cues = st.apply_hook(&ev("Stop", json!({})), T0 + 10_000);
        assert_eq!(cues, vec![Cue { session_id: "s1".into(), kind: CueKind::Finish, turn_ms: Some(10_000), busy: true }]);
        assert_eq!(serde_json::to_value(&cues[0]).unwrap()["busy"], true);
        // The finished status falls back to idle while the agent keeps working.
        st.tick(T0 + 10_000 + FINISHED_TO_IDLE_MS);
        assert_eq!(sess(&st).status, Status::Idle);
        let cues = st.apply_hook(&ev("SubagentStop", json!({"agent_id": "a1"})), T0 + 90_000);
        assert_eq!(cues, vec![Cue { session_id: "s1".into(), kind: CueKind::Finish, turn_ms: Some(90_000), busy: false }], "measured from the prompt");
        assert!(serde_json::to_value(&cues[0]).unwrap().get("busy").is_none(), "false is left out");
        // Only once.
        st.apply_hook(&ev("SubagentStart", json!({"agent_id": "a2"})), T0 + 91_000);
        assert!(st.apply_hook(&ev("SubagentStop", json!({"agent_id": "a2"})), T0 + 92_000).is_empty());
    }

    #[test]
    fn background_tasks_from_the_stop_payload_also_defer_the_finish() {
        let mut st = Store::default();
        st.apply_hook(&ev("UserPromptSubmit", json!({"prompt": "go"})), T0);
        let running = json!([{"id": "a1", "type": "subagent", "status": "running", "description": "d"}]);
        let cues = st.apply_hook(&ev("Stop", json!({"background_tasks": running})), T0 + 5_000);
        assert!(cues[0].busy);
        // One of two agents ends: not done yet.
        st.apply_hook(&ev("SubagentStart", json!({"agent_id": "a2"})), T0 + 6_000);
        let cues = st.apply_hook(&ev("SubagentStop", json!({"agent_id": "a2", "background_tasks": running})), T0 + 7_000);
        assert!(cues.is_empty(), "a background task still runs");
        let cues = st.apply_hook(&ev("SubagentStop", json!({"agent_id": "a1", "background_tasks": []})), T0 + 70_000);
        assert_eq!(cues[0].kind, CueKind::Finish);
        assert_eq!(cues[0].turn_ms, Some(70_000));
        assert!(!cues[0].busy);
    }

    #[test]
    fn a_follow_up_turn_after_a_deferred_finish_measures_from_the_typed_prompt() {
        let mut st = Store::default();
        st.apply_hook(&ev("UserPromptSubmit", json!({"prompt": "go"})), T0);
        st.apply_hook(&ev("SubagentStart", json!({"agent_id": "a1"})), T0 + 1);
        st.apply_hook(&ev("Stop", json!({})), T0 + 5_000);
        // The agent's result comes back as a wrapped prompt while it is still marked running.
        st.apply_hook(&ev("UserPromptSubmit", json!({"prompt": "<agent-message>done</agent-message>"})), T0 + 50_000);
        st.apply_hook(&ev("SubagentStop", json!({"agent_id": "a1"})), T0 + 50_001);
        let cues = st.apply_hook(&ev("Stop", json!({})), T0 + 60_000);
        assert_eq!(cues[0].turn_ms, Some(60_000));
        assert!(!cues[0].busy);
        // A new typed prompt starts from scratch.
        st.apply_hook(&ev("UserPromptSubmit", json!({"prompt": "next"})), T0 + 100_000);
        let cues = st.apply_hook(&ev("Stop", json!({})), T0 + 103_000);
        assert_eq!(cues[0].turn_ms, Some(3_000));
    }

    #[test]
    fn the_next_turn_measures_from_its_own_prompt() {
        let mut st = Store::default();
        st.apply_hook(&ev("UserPromptSubmit", json!({"prompt": "one"})), T0);
        st.apply_hook(&ev("Stop", json!({})), T0 + 10_000);
        st.apply_hook(&ev("UserPromptSubmit", json!({"prompt": "two"})), T0 + 50_000);
        let cues = st.apply_hook(&ev("Stop", json!({})), T0 + 53_000);
        assert_eq!(cues[0].turn_ms, Some(3_000));
    }

    #[test]
    fn exit_plan_mode_shows_the_plan_without_a_pending_card() {
        let plan_ev = |event: &str| ev(event, json!({"tool_name": "ExitPlanMode", "tool_input": {"plan": "## Plan\n- step one"}}));
        for event in ["PreToolUse", "PermissionRequest"] {
            let mut st = Store::default();
            st.apply_hook(&ev("UserPromptSubmit", json!({"prompt": "plan it"})), T0);
            let cues = st.apply_hook(&plan_ev(event), T0 + 1);
            assert!(cues.is_empty(), "{event}: no approval cue, nothing to answer");
            let s = sess(&st);
            assert_eq!(s.plan.as_deref(), Some("## Plan\n- step one"), "{event}");
            assert!(s.pending.is_empty(), "{event}");
            assert!(s.steps.is_empty(), "{event}: not a step");
            assert_eq!(s.status, Status::Thinking, "{event}: status stays");
        }
    }

    #[test]
    fn the_plan_clears_on_the_next_prompt_tool_or_stop() {
        let clear_by = [
            ev("UserPromptSubmit", json!({"prompt": "go on"})),
            ev("PreToolUse", json!({"tool_name": "Edit", "tool_input": {"file_path": "a.rs"}})),
            ev("Stop", json!({})),
            ev("PostToolUse", json!({"tool_name": "ExitPlanMode"})),
        ];
        for next in clear_by {
            let mut st = Store::default();
            st.apply_hook(&ev("PreToolUse", json!({"tool_name": "ExitPlanMode", "tool_input": {"plan": "x"}})), T0);
            assert!(sess(&st).plan.is_some());
            st.apply_hook(&next, T0 + 1);
            assert_eq!(sess(&st).plan, None, "{}", next["hook_event_name"]);
        }
        // Another session's or a sub-agent's events do not clear it; a long plan is clipped.
        let mut st = Store::default();
        st.apply_hook(&ev("PreToolUse", json!({"tool_name": "ExitPlanMode", "tool_input": {"plan": "y".repeat(9_000)}})), T0);
        assert_eq!(sess(&st).plan.as_ref().unwrap().chars().count(), 8_000);
        st.apply_hook(&ev("PreToolUse", json!({"tool_name": "Read", "agent_id": "ag1"})), T0 + 1);
        assert!(sess(&st).plan.is_some(), "sub-agent tools leave the plan alone");
        let v = serde_json::to_value(st.snapshot()).unwrap();
        assert!(v[0]["plan"].is_string());
    }

    #[test]
    fn exit_plan_mode_never_becomes_a_pending_card() {
        // Even with a request id (an old blocking relay): Claude Code ignores the hook answer.
        let mut st = Store::default();
        let cues = st.apply_hook(&ev("PermissionRequest", json!({"tool_name": "ExitPlanMode", "tool_input": {"plan": "x"}, "sb_request_id": "r1", "sb_wait_ms": 1})), T0);
        assert!(cues.is_empty());
        assert!(sess(&st).pending.is_empty());
        assert_eq!(sess(&st).plan.as_deref(), Some("x"));
    }

    #[test]
    fn the_plan_clears_when_the_session_goes_idle_stale_or_error() {
        let with_plan = || {
            let mut st = Store::default();
            st.apply_hook(&ev("UserPromptSubmit", json!({"prompt": "plan"})), T0);
            st.apply_hook(&ev("PreToolUse", json!({"tool_name": "ExitPlanMode", "tool_input": {"plan": "x"}})), T0 + 1);
            st
        };
        // Esc at the terminal's plan dialog sends no Stop: the session just goes quiet.
        let mut st = with_plan();
        st.tick(T0 + 1 + DEFAULT_STALE_AFTER_MS);
        assert_eq!(sess(&st).status, Status::Stale);
        assert_eq!(sess(&st).plan, None, "stale");
        let mut st = with_plan();
        st.apply_hook(&ev("StopFailure", json!({})), T0 + 2);
        assert_eq!(sess(&st).plan, None, "error");
        let mut st = with_plan();
        st.sessions.get_mut("s1").unwrap().set_status(Status::Idle, T0 + 2);
        assert_eq!(sess(&st).plan, None, "idle");
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

    #[test]
    fn records_the_claude_pid_latest_wins_and_marks_live() {
        let mut st = Store::default();
        st.seed(Session::new("s1", T0));
        assert!(!sess(&st).live, "a seeded session is only recent");
        assert_eq!(sess(&st).pid, None);
        st.apply_hook(&ev("PreToolUse", json!({"tool_name": "Read"})), T0 + 1);
        assert!(sess(&st).live, "any hook event makes it live");
        assert_eq!(sess(&st).pid, None);
        st.apply_hook(&ev("UserPromptSubmit", json!({"sb_claude_pid": 100})), T0 + 2);
        assert_eq!(sess(&st).pid, Some(100));
        st.apply_hook(&ev("PostToolUse", json!({"tool_name": "Read"})), T0 + 3);
        assert_eq!(sess(&st).pid, Some(100), "events without the field keep the pid");
        st.apply_statusline(&json!({"session_id": "s1", "sb_claude_pid": 200}), T0 + 4);
        assert_eq!(sess(&st).pid, Some(200));
        let v = serde_json::to_value(st.snapshot()).unwrap();
        assert_eq!(v[0]["pid"], 200);
        assert_eq!(v[0]["live"], true);
    }

    #[test]
    fn status_line_alone_makes_a_seeded_session_live() {
        let mut st = Store::default();
        st.seed(Session::new("s1", T0));
        st.apply_statusline(&json!({"session_id": "s1"}), T0 + 1);
        assert!(sess(&st).live);
    }

    #[test]
    fn running_processes_claim_seeded_sessions_by_directory() {
        let seeded = |id: &str, cwd: &str, modified: i64| {
            let mut s = Session::new(id, modified);
            s.cwd = cwd.into();
            s.first_cwd = Some(cwd.into());
            s.last_event_at = modified;
            s
        };
        let mut st = Store::default();
        st.seed(seeded("old", r"C:\Projects\pushdocs", T0));
        st.seed(seeded("new", r"C:\Projects\pushdocs", T0 + 5));
        st.seed(seeded("gone", r"C:\Projects\fetchdocs", T0));
        st.apply_hook(&json!({"hook_event_name": "PreToolUse", "session_id": "live", "cwd": r"C:\Projects\bankconnect", "sb_claude_pid": 7}), T0);
        assert!(st.has_unclaimed_seeds());
        let procs = [
            ClaudeProcess { pid: 7, cwd: r"C:\Projects\pushdocs\".into() },
            ClaudeProcess { pid: 8, cwd: r"c:\projects\PUSHDOCS\".into() },
        ];
        assert!(st.adopt(&procs, true, T0 + 10));
        assert_eq!(st.get("new").unwrap().pid, Some(8), "pid 7 already belongs to a live session");
        assert!(st.get("new").unwrap().live);
        assert!(!st.get("old").unwrap().live, "one process, one session: the newest transcript wins");
        assert!(!st.get("gone").unwrap().live, "no process in its directory: stays recent");
        assert!(!st.adopt(&procs, true, T0 + 10), "nothing left to claim");
        assert!(st.remove_dead(|pid| pid != 8), "a claimed session goes with its process");
        assert!(st.get("new").is_none());
    }

    #[test]
    fn remove_dead_drops_ended_processes_but_not_pending_or_unknown() {
        let mut st = Store::default();
        let hook = |id: &str, extra: Value| {
            let mut v = json!({"hook_event_name": "UserPromptSubmit", "session_id": id, "cwd": "/p/x"});
            for (k, val) in extra.as_object().unwrap() {
                v[k] = val.clone();
            }
            v
        };
        st.apply_hook(&hook("alive", json!({"sb_claude_pid": 1})), T0);
        st.apply_hook(&hook("dead", json!({"sb_claude_pid": 2})), T0);
        st.apply_hook(&hook("nopid", json!({})), T0);
        st.apply_hook(&hook("waiting", json!({"sb_claude_pid": 3})), T0);
        st.apply_hook(
            &json!({"hook_event_name": "PermissionRequest", "session_id": "waiting", "tool_name": "Bash", "sb_request_id": "r1", "sb_wait_ms": 1}),
            T0,
        );
        let alive = |pid: u32| pid == 1;
        assert!(st.remove_dead(alive));
        let mut ids: Vec<String> = st.snapshot().into_iter().map(|s| s.id).collect();
        ids.sort();
        assert_eq!(ids, vec!["alive", "nopid", "waiting"]);
        assert!(!st.remove_dead(alive), "nothing more to remove");
        st.resolve("r1", false, T0 + 1);
        assert!(st.remove_dead(alive), "once answered, a dead waiting session goes too");
        assert!(st.get("waiting").is_none());
    }

    #[test]
    fn adopting_a_stale_seed_makes_it_idle_and_keeps_it() {
        let mut st = Store::default();
        let mut s = Session::new("s1", T0);
        s.cwd = "/p/x".into();
        s.first_cwd = Some("/p/x".into());
        s.status = Status::Stale;
        s.last_event_at = T0;
        st.seed(s);
        let later = T0 + st.stale_after_ms + 60_000;
        assert!(st.adopt(&[ClaudeProcess { pid: 9, cwd: "/p/x".into() }], false, later));
        let got = st.get("s1").unwrap();
        assert!(got.live);
        assert_eq!(got.status, Status::Idle, "a running process is not stale");
        assert_eq!(got.last_event_at, later);
        assert!(!st.tick(later + 1), "the stale timer starts again from the adoption");
        assert_eq!(st.get("s1").unwrap().status, Status::Idle);
    }

    #[test]
    fn seeds_that_cd_elsewhere_are_adopted_by_their_start_directory() {
        // The real shape: every Claude Code started in C:\Projects (PEB cwd with a trailing
        // backslash), transcripts under projects/C--Projects, the latest cwds in sub folders.
        let mut st = Store::default();
        for (id, cwd, age) in [("a", r"C:\Projects\pushdocs\development\api.pushdocs", 760_000), ("b", r"C:\Projects", 761_000), ("c", r"C:\Projects\session-buddy", 39_000)] {
            let seed = crate::bootstrap::Seed {
                session_id: id.into(),
                cwd: cwd.into(),
                first_cwd: cwd.into(),
                project_key: "C--Projects".into(),
                last_prompt: None,
                last_message: None,
                model: None,
                modified_ms: T0 - age,
            };
            st.seed(crate::bootstrap::session_from_seed(&seed, T0, 600_000));
        }
        let procs = [ClaudeProcess { pid: 1, cwd: r"C:\Projects\".into() }, ClaudeProcess { pid: 2, cwd: r"C:\Projects\".into() }, ClaudeProcess { pid: 3, cwd: r"C:\Projects\".into() }];
        assert_eq!(st.count_held(&procs), 0);
        assert!(st.adopt(&procs, true, T0));
        assert!(st.snapshot().iter().all(|s| s.live), "all three are live");
        assert_eq!(st.count_held(&procs), 3);
        assert!(st.snapshot().iter().all(|s| s.status == Status::Idle), "stale seeds with a running process are idle");
    }

    #[test]
    fn a_pid_belongs_to_one_session_only() {
        let mut st = Store::default();
        let mut y = Session::new("y", T0);
        y.cwd = "/p/x".into();
        y.first_cwd = Some("/p/x".into());
        st.seed(y);
        assert!(st.adopt(&[ClaudeProcess { pid: 42, cwd: "/p/x".into() }], false, T0 + 1));
        assert!(st.get("y").unwrap().live, "the guess");
        st.apply_hook(&json!({"hook_event_name": "UserPromptSubmit", "session_id": "x", "cwd": "/p/x", "prompt": "go", "sb_claude_pid": 42}), T0 + 2);
        let y = st.get("y").unwrap();
        assert!(!y.live, "the wrong guess goes back to recent");
        assert_eq!(y.pid, None);
        assert!(st.get("x").unwrap().live);
        assert_eq!(st.get("x").unwrap().pid, Some(42));
        assert_eq!(st.snapshot().iter().filter(|s| s.live).count(), 1, "only x is live");
        // The status line claims a pid the same way.
        st.apply_statusline(&json!({"session_id": "z", "sb_claude_pid": 42}), T0 + 3);
        assert_eq!(st.get("x").unwrap().pid, None);
        assert!(!st.get("x").unwrap().live);
    }

    #[test]
    fn a_session_waiting_for_the_user_keeps_its_pid() {
        let mut st = Store::default();
        st.apply_hook(&json!({"hook_event_name": "UserPromptSubmit", "session_id": "w", "cwd": "/p/x", "prompt": "go", "sb_claude_pid": 5}), T0);
        st.apply_hook(
            &json!({"hook_event_name": "PermissionRequest", "session_id": "w", "tool_name": "Bash", "sb_request_id": "r1", "sb_wait_ms": 1000}),
            T0 + 1,
        );
        st.apply_hook(&json!({"hook_event_name": "UserPromptSubmit", "session_id": "x", "cwd": "/p/x", "prompt": "go", "sb_claude_pid": 5}), T0 + 2);
        assert_eq!(st.get("w").unwrap().pid, Some(5));
        assert!(st.get("w").unwrap().live);
    }

    #[test]
    fn a_stuck_agent_from_an_earlier_turn_does_not_block_the_finish_card() {
        let mut st = Store::default();
        st.apply_hook(&ev("UserPromptSubmit", json!({"prompt": "first"})), T0);
        st.apply_hook(&ev("SubagentStart", json!({"agent_id": "a1", "agent_type": "Explore"})), T0 + 1_000);
        // Esc: no SubagentStop ever arrives for a1.
        assert!(st.apply_hook(&ev("Stop", json!({})), T0 + 5_000)[0].busy);
        st.apply_hook(&ev("UserPromptSubmit", json!({"prompt": "second"})), T0 + 60_000);
        assert!(sess(&st).agents[0].running, "it spoke during the turn that just ended");
        assert!(st.apply_hook(&ev("Stop", json!({})), T0 + 65_000)[0].busy);
        st.apply_hook(&ev("UserPromptSubmit", json!({"prompt": "third"})), T0 + 120_000);
        assert!(!sess(&st).agents[0].running, "silent since the previous turn started");
        assert_eq!(sess(&st).agents[0].ended_at, Some(T0 + 120_000));
        let cues = st.apply_hook(&ev("Stop", json!({})), T0 + 260_000);
        assert_eq!(cues, vec![Cue { session_id: "s1".into(), kind: CueKind::Finish, turn_ms: Some(140_000), busy: false }]);
    }

    #[test]
    fn an_agent_that_spoke_this_turn_keeps_running_over_a_new_prompt() {
        let mut st = Store::default();
        st.apply_hook(&ev("UserPromptSubmit", json!({"prompt": "first"})), T0);
        st.apply_hook(&ev("SubagentStart", json!({"agent_id": "a1"})), T0 + 1_000);
        st.apply_hook(&ev("PreToolUse", json!({"agent_id": "a1", "tool_name": "Read"})), T0 + 2_000);
        st.apply_hook(&ev("UserPromptSubmit", json!({"prompt": "second"})), T0 + 3_000);
        assert!(sess(&st).agents[0].running);
    }

    #[test]
    fn stop_ends_agents_missing_from_its_background_tasks() {
        let mut st = Store::default();
        st.apply_hook(&ev("UserPromptSubmit", json!({"prompt": "go"})), T0);
        st.apply_hook(&ev("SubagentStart", json!({"agent_id": "gone"})), T0 + 1);
        st.apply_hook(&ev("SubagentStart", json!({"agent_id": "bg"})), T0 + 2);
        let running = json!([{"id": "bg", "type": "subagent", "status": "running", "description": "d"}]);
        st.apply_hook(&ev("Stop", json!({"background_tasks": running})), T0 + 90_000);
        fn agent(st: &Store, id: &str) -> Agent {
            sess(st).agents.iter().find(|a| a.id == id).unwrap().clone()
        }
        assert!(!agent(&st, "gone").running);
        assert_eq!(agent(&st, "gone").ended_at, Some(T0 + 90_000));
        assert!(agent(&st, "bg").running, "listed: still running");
        // Without the field nothing is ended.
        st.apply_hook(&ev("UserPromptSubmit", json!({"prompt": "<agent-message>x</agent-message>"})), T0 + 90_001);
        st.apply_hook(&ev("Stop", json!({})), T0 + 90_002);
        assert!(agent(&st, "bg").running);
    }
}
