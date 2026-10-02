//! The chat's session tools, as the app enforces them. The relay (`sb-relay mcp`) only forwards:
//! every rule here holds whatever the model asks for. Reads answer at once. An action is confirmed
//! on the island first, through Claude Code's permission-prompt tool (`approve`): the card's answer
//! becomes a one-time grant for exactly those arguments, and the tool itself refuses to run without one.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use sb_core::actions::{ActionRequest, FolderChoice, HostChoice, HostOption};
use sb_core::hub::Hub;
use sb_core::messages::MAX_QUEUED;
use sb_core::steps::clip;
use sb_core::store::{Interaction, Session};
use serde_json::{json, Value};

use crate::projects;
use crate::settings::Settings;
use crate::workers::{self, Workers};

pub const MAX_TEXT: usize = 4000;
const MODELS: [&str; 3] = ["haiku", "sonnet", "opus"];
const TOOL_PREFIX: &str = "mcp__buddy__";
const GRANT_TTL: Duration = Duration::from_secs(600);
const MAX_SESSIONS_LISTED: usize = 40;
const DENIED: &str = "denied by the user";
const NOT_ANSWERED: &str = "denied: the user did not answer in time";
const BACKGROUND_ONLY: &str = "Only background sessions are available for now.";

pub fn check_model(model: &str) -> Result<&'static str, String> {
    let wanted = model.trim().to_lowercase();
    MODELS.iter().copied().find(|m| *m == wanted).ok_or_else(|| format!("The model must be one of: {}.", MODELS.join(", ")))
}

/// A prompt or message: non-empty, at most `MAX_TEXT` characters, no control characters except newlines.
pub fn check_text(text: &str, what: &str) -> Result<String, String> {
    let text = text.replace("\r\n", "\n");
    let text = text.trim();
    if text.is_empty() {
        return Err(format!("The {what} is empty."));
    }
    if text.chars().count() > MAX_TEXT {
        return Err(format!("The {what} is longer than {MAX_TEXT} characters."));
    }
    if text.chars().any(|c| c.is_control() && c != '\n') {
        return Err(format!("The {what} contains control characters."));
    }
    Ok(text.to_string())
}

fn ok(text: impl Into<String>) -> Value {
    json!({"ok": true, "text": text.into()})
}

fn fail(text: impl Into<String>) -> Value {
    json!({"ok": false, "text": text.into()})
}

/// The permission prompt tool's answer: its text is the JSON Claude Code reads.
fn permission(behavior: Value) -> Value {
    ok(behavior.to_string())
}

fn deny(message: &str) -> Value {
    permission(json!({"behavior": "deny", "message": message}))
}

fn str_arg<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    args.get(key).and_then(Value::as_str).ok_or_else(|| format!("Missing argument: {key}."))
}

struct Grant {
    tool: String,
    args: Value,
    expires: Instant,
}

/// What the user confirmed, ready to be run by the tool call that follows.
struct Prepared {
    request: ActionRequest,
    tool: &'static str,
    /// The arguments with the folder still open for the user's choice.
    args: Value,
}

pub struct Control {
    hub: Arc<Hub>,
    workers: Arc<Workers>,
    settings: Box<dyn Fn() -> Settings + Send + Sync>,
    grants: Mutex<Vec<Grant>>,
}

impl Control {
    pub fn new(hub: Arc<Hub>, workers: Arc<Workers>, settings: impl Fn() -> Settings + Send + Sync + 'static) -> Self {
        Self { hub, workers, settings: Box::new(settings), grants: Mutex::new(Vec::new()) }
    }

    pub fn workers(&self) -> &Arc<Workers> {
        &self.workers
    }

    /// One tool call from the relay: `{"tool", "args"}` in, `{"ok", "text"}` out.
    pub async fn handle(self: Arc<Self>, req: Value) -> Value {
        let tool = req.get("tool").and_then(Value::as_str).unwrap_or_default().to_string();
        let args = req.get("args").cloned().filter(Value::is_object).unwrap_or_else(|| json!({}));
        match tool.as_str() {
            "list_sessions" => ok(self.list_sessions()),
            "get_session" => self.get_session(&args),
            "list_projects" => ok(self.list_projects()),
            "approve" => self.approve(&args).await,
            "start_session" | "send_prompt" | "stop_session" => self.run_granted(tool, args).await,
            _ => fail("Unknown tool."),
        }
    }

    fn sessions(&self) -> Vec<Session> {
        self.hub.store.lock().unwrap().snapshot()
    }

    fn list_sessions(&self) -> String {
        let mut sessions = self.sessions();
        sessions.sort_by_key(|s| std::cmp::Reverse(s.last_event_at));
        let total = sessions.len();
        let list: Vec<Value> = sessions.iter().take(MAX_SESSIONS_LISTED).map(summary).collect();
        json!({"sessions": list, "total": total}).to_string()
    }

    fn get_session(&self, args: &Value) -> Value {
        let id = match str_arg(args, "id") {
            Ok(id) => id,
            Err(e) => return fail(e),
        };
        let Some(s) = self.sessions().into_iter().find(|s| s.id == id) else {
            return fail("No session with that id. Use list_sessions for the ids.");
        };
        let mut v = summary(&s);
        let steps: Vec<Value> = s.steps.iter().rev().take(8).rev().map(|x| json!({"tool": x.tool, "label": clip(&x.label, 100), "ok": x.ok})).collect();
        v["lastMessage"] = json!(s.last_message.as_deref().map(|m| clip(m, 600)));
        v["steps"] = json!(steps);
        v["agentsRunning"] = json!(s.agents.iter().filter(|a| a.running).count());
        ok(v.to_string())
    }

    fn list_projects(&self) -> String {
        let roots = projects::roots(&(self.settings)().chat_project_roots);
        if roots.is_empty() {
            return projects::allowed_text(&roots);
        }
        let list: Vec<Value> = projects::list(&roots).into_iter().map(|(name, path)| json!({"name": name, "path": path.to_string_lossy()})).collect();
        json!({"projects": list}).to_string()
    }

    /// Claude Code asks whether it may run an action tool; the island's card decides.
    async fn approve(self: &Arc<Self>, args: &Value) -> Value {
        let name = args.get("tool_name").and_then(Value::as_str).unwrap_or_default();
        let input = args.get("input").cloned().unwrap_or_else(|| json!({}));
        let Some(tool) = name.strip_prefix(TOOL_PREFIX).and_then(|t| ["start_session", "send_prompt", "stop_session"].into_iter().find(|k| *k == t)) else {
            return deny("That tool is not available here.");
        };
        let prepared = match self.prepare(tool, &input).await {
            Ok(p) => p,
            Err(message) => return deny(&message),
        };
        let Prepared { request, tool, args } = prepared;
        let Some(answer) = self.hub.confirm(request).await else { return deny(NOT_ANSWERED) };
        if answer["allow"] != true {
            return deny(DENIED);
        }
        match finish(&args, &answer) {
            Ok(final_args) => {
                let mut grants = self.grants.lock().unwrap();
                grants.retain(|g| g.expires > Instant::now());
                grants.push(Grant { tool: tool.to_string(), args: final_args.clone(), expires: Instant::now() + GRANT_TTL });
                permission(json!({"behavior": "allow", "updatedInput": final_args}))
            }
            Err(message) => deny(&message),
        }
    }

    /// Validates what the model asked for and builds the card. Nothing runs and nothing is granted yet.
    async fn prepare(self: &Arc<Self>, tool: &'static str, input: &Value) -> Result<Prepared, String> {
        let settings = (self.settings)();
        match tool {
            "start_session" => {
                let model = check_model(str_arg(input, "model")?)?;
                let prompt = check_text(str_arg(input, "prompt")?, "prompt")?;
                if input.get("host").and_then(Value::as_str).is_some_and(|h| h != "background") {
                    return Err(BACKGROUND_ONLY.into());
                }
                let roots = projects::roots(&settings.chat_project_roots);
                let found = projects::resolve(&roots, str_arg(input, "project")?)?;
                let this = self.clone();
                let max = settings.chat_max_workers as usize;
                let active = blocking(move || this.workers.active()).await??;
                if active >= max {
                    return Err(format!("{active} background sessions are working already (the limit is {max}). Wait for one or stop one first."));
                }
                let folder = &found[0];
                let name = workers::folder_name(folder);
                let mut request = ActionRequest::new("Start a session").row("Project", &name).row("Model", model);
                request.body = Some(prompt.clone());
                request.folder = Some(FolderChoice { path: path_text(folder), options: if found.len() > 1 { found.iter().map(|p| path_text(p)).collect() } else { Vec::new() } });
                request.host = Some(HostChoice { value: "background".into(), options: vec![HostOption { id: "background".into(), label: "Background".into() }] });
                Ok(Prepared { request, tool, args: json!({"project": path_text(folder), "model": model, "prompt": prompt, "host": "background"}) })
            }
            "send_prompt" => {
                let id = str_arg(input, "session_id")?.to_string();
                let text = check_text(str_arg(input, "text")?, "text")?;
                let this = self.clone();
                let worker = id.clone();
                let Some(info) = blocking(move || this.workers.info(&worker)).await? else {
                    return self.prepare_message(&id, text);
                };
                if info.agent.running() && !info.agent.idle() {
                    return Err(workers::BUSY.into());
                }
                let mut request = ActionRequest::new("Send a prompt").row("Session", info.agent.project());
                if let Some(model) = &info.model {
                    request = request.row("Model", model);
                }
                request.body = Some(text.clone());
                Ok(Prepared { request, tool, args: json!({"session_id": id, "text": text}) })
            }
            _ => {
                let id = str_arg(input, "session_id")?.to_string();
                let info = self.steerable(&id).await?;
                if !info.agent.running() {
                    return Err("That session is not running.".into());
                }
                let request = ActionRequest::new("Stop a session").row("Session", info.agent.project());
                Ok(Prepared { request, tool, args: json!({"session_id": id}) })
            }
        }
    }

    /// The card for a message to a session Session Buddy did not start: it is queued, not typed.
    fn prepare_message(&self, id: &str, text: String) -> Result<Prepared, String> {
        let store = self.hub.store.lock().unwrap();
        let session = store.get(id).filter(|s| s.live).ok_or("That session is not running or not known. Use list_sessions for the ids.")?;
        if session.messages.queued() >= MAX_QUEUED {
            return Err(format!("{MAX_QUEUED} messages are already waiting for that session."));
        }
        let mut request = ActionRequest::new("Send a message").row("Session", &session.project);
        request.body = Some(text.clone());
        Ok(Prepared { request, tool: "send_prompt", args: json!({"session_id": id, "text": text}) })
    }

    async fn steerable(self: &Arc<Self>, session_id: &str) -> Result<workers::Info, String> {
        let this = self.clone();
        let id = session_id.to_string();
        blocking(move || this.workers.info(&id)).await?.ok_or_else(|| "That is not a background session Session Buddy started. Only those can be steered.".to_string())
    }

    fn take_grant(&self, tool: &str, args: &Value) -> bool {
        let mut grants = self.grants.lock().unwrap();
        grants.retain(|g| g.expires > Instant::now());
        match grants.iter().position(|g| g.tool == tool && g.args == *args) {
            Some(i) => {
                grants.remove(i);
                true
            }
            None => false,
        }
    }

    /// The tool call itself, after the permission step. Without a matching grant nothing runs.
    async fn run_granted(self: Arc<Self>, tool: String, args: Value) -> Value {
        if !self.take_grant(&tool, &args) {
            return fail("The user has not confirmed this action, so it did not run.");
        }
        let max = (self.settings)().chat_max_workers as usize;
        let result = blocking(move || self.execute(&tool, &args, max)).await;
        match result {
            Ok(Ok(text)) => ok(text),
            Ok(Err(message)) | Err(message) => fail(message),
        }
    }

    fn execute(&self, tool: &str, args: &Value, max: usize) -> Result<String, String> {
        match tool {
            "start_session" => {
                let model = check_model(str_arg(args, "model")?)?;
                let prompt = check_text(str_arg(args, "prompt")?, "prompt")?;
                // The grant covers this exact folder, which the user saw (and may have chosen themselves).
                let folder = projects::canonical_dir(Path::new(str_arg(args, "project")?)).ok_or("That folder does not exist.")?;
                let name = workers::folder_name(&folder);
                let (session, _) = self.workers.start(&folder, &name, model, &prompt, max)?;
                Ok(match session {
                    Some(id) => format!("Started a background session in {name} with {model}. Its session id is {id}."),
                    None => format!("Started a background session in {name} with {model}. Its id shows up in list_sessions in a moment."),
                })
            }
            "send_prompt" => {
                let id = str_arg(args, "session_id")?;
                let text = check_text(str_arg(args, "text")?, "text")?;
                if self.workers.info(id).is_none() {
                    self.hub.queue_message(id, &text)?;
                    return Ok("Queued the message. The session receives it at its next step, or when it starts working again.".into());
                }
                Ok(format!("Sent the prompt to {}.", self.workers.send(id, &text)?))
            }
            _ => Ok(format!("Stopped {}.", self.workers.stop(str_arg(args, "session_id")?)?)),
        }
    }

    /// The island's own "send a prompt to this session". No card: the user typed it.
    pub async fn user_send(self: &Arc<Self>, session_id: String, text: String) -> Result<(), String> {
        let text = check_text(&text, "text")?;
        let this = self.clone();
        blocking(move || this.workers.send(&session_id, &text)).await??;
        Ok(())
    }

    /// The island's "Message this session": one command for every session. A session Session Buddy
    /// started takes the text as its next prompt, any other running session gets it queued.
    pub async fn user_message(self: &Arc<Self>, session_id: String, text: String) -> Result<(), String> {
        let unmanaged = self.hub.store.lock().unwrap().get(&session_id).is_some_and(|s| !s.managed);
        if unmanaged {
            return self.hub.queue_message(&session_id, &text).map(|_| ());
        }
        self.user_send(session_id, text).await
    }

    pub async fn user_stop(self: &Arc<Self>, session_id: String) -> Result<(), String> {
        let this = self.clone();
        blocking(move || this.workers.stop(&session_id)).await??;
        Ok(())
    }

    pub async fn user_attach(self: &Arc<Self>, session_id: String, bin: Option<PathBuf>) -> Result<(), String> {
        let bin = bin.ok_or("The claude command was not found")?;
        let info = self.steerable(&session_id).await?;
        workers::attach(&bin, &info.agent.id)
    }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tokio::task::spawn_blocking(f).await.map_err(|_| "The action could not run".to_string())
}

fn path_text(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// Applies the card's answer: a folder the user picked is trusted (it only has to be a directory),
/// the host can only be the background.
fn finish(args: &Value, answer: &Value) -> Result<Value, String> {
    let mut out = args.clone();
    if args.get("project").is_some() {
        if let Some(chosen) = answer.get("folder").and_then(Value::as_str).filter(|f| !f.trim().is_empty()) {
            let dir = projects::canonical_dir(Path::new(chosen)).ok_or("The folder the user chose does not exist.")?;
            out["project"] = json!(path_text(&dir));
        }
        if answer.get("host").and_then(Value::as_str).is_some_and(|h| h != "background") {
            return Err(BACKGROUND_ONLY.into());
        }
    }
    Ok(out)
}

fn pending_json(i: &Interaction) -> Value {
    match i {
        Interaction::Approval { tool, target, .. } => json!({"kind": "approval", "target": clip(&format!("{tool}: {target}"), 120)}),
        Interaction::Question { questions, .. } => {
            let first = questions.get(0).and_then(|q| q.get("question")).and_then(Value::as_str).unwrap_or_default();
            json!({"kind": "question", "target": clip(first, 120)})
        }
        Interaction::Reply { message, .. } => json!({"kind": "reply", "target": clip(message, 120)}),
    }
}

fn summary(s: &Session) -> Value {
    json!({
        "id": s.id,
        "project": s.project,
        "branch": s.branch,
        "status": s.status,
        "model": s.model,
        "managed": s.managed,
        "lastPrompt": s.last_prompt.as_deref().map(|p| clip(p, 200)),
        "pending": s.pending.iter().map(pending_json).collect::<Vec<_>>(),
    })
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use sb_core::store::Status;

    use super::*;
    use crate::workers::Runner;

    #[test]
    fn models_are_the_fixed_set() {
        assert_eq!(check_model("Sonnet").unwrap(), "sonnet");
        assert_eq!(check_model(" opus ").unwrap(), "opus");
        for bad in ["", "claude-opus-4", "haiku; rm", "gpt-4", "ollama"] {
            assert!(check_model(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn text_rules() {
        assert_eq!(check_text("  fix it \r\nplease ", "prompt").unwrap(), "fix it \nplease");
        assert!(check_text("   ", "prompt").unwrap_err().contains("empty"));
        assert!(check_text(&"a".repeat(MAX_TEXT), "prompt").is_ok());
        assert!(check_text(&"a".repeat(MAX_TEXT + 1), "prompt").unwrap_err().contains("longer"));
        assert!(check_text(&"ä".repeat(MAX_TEXT), "prompt").is_ok(), "characters, not bytes");
        for bad in ["a\u{0}b", "a\u{1b}[31mb", "tab\there", "a\rb", "bell\u{7}", "del\u{7f}"] {
            assert!(check_text(bad, "prompt").unwrap_err().contains("control"), "{bad:?}");
        }
        assert!(check_text("multi\nline\n\ntext", "prompt").is_ok());
    }

    struct Cli {
        agents: Mutex<String>,
        calls: Mutex<Vec<Vec<String>>>,
    }

    impl Runner for Cli {
        fn run(&self, _cwd: Option<&Path>, args: &[String], _t: Duration) -> Result<String, String> {
            if args[0] == "agents" {
                return Ok(self.agents.lock().unwrap().clone());
            }
            self.calls.lock().unwrap().push(args.to_vec());
            Ok(if args[0] == "stop" { "stopped\n".into() } else { "backgrounded · c91b09c1 · Buddy: Nexa\n".into() })
        }
    }

    struct Rig {
        control: Arc<Control>,
        hub: Arc<Hub>,
        cli: Arc<Cli>,
        root: PathBuf,
        _dir: tempfile::TempDir,
    }

    fn agent(id: &str, pid: Option<u32>, status: &str, name: &str, cwd: &Path) -> Value {
        let mut v = json!({"id": id, "cwd": cwd.to_string_lossy(), "kind": "background", "startedAt": 1, "sessionId": format!("{id}-full"), "name": name, "status": status, "state": "done"});
        if let Some(p) = pid {
            v["pid"] = json!(p);
        }
        v
    }

    fn rig(agents: Vec<Value>, max: u32) -> Rig {
        let dir = tempfile::tempdir().unwrap();
        let base = projects::canonical_dir(dir.path()).unwrap();
        let root = base.join("code");
        for p in ["code/Nexa", "code/Other", "elsewhere/Picked"] {
            std::fs::create_dir_all(base.join(p)).unwrap();
        }
        let hub = Hub::with_timeouts(|_| {}, Duration::from_millis(50), Duration::from_secs(5), Duration::from_secs(5));
        let cli = Arc::new(Cli { agents: Mutex::new(Value::Array(agents).to_string()), calls: Mutex::new(Vec::new()) });
        let sink = hub.clone();
        let workers = Arc::new(Workers::new(cli.clone(), move |s| sink.store.lock().unwrap().mark_managed(s)));
        let settings = Settings { chat_project_roots: vec![path_text(&root)], chat_max_workers: max, ..Settings::default() };
        let control = Arc::new(Control::new(hub.clone(), workers, move || settings.clone()));
        Rig { control, hub, cli, root, _dir: dir }
    }

    async fn wait_for_action(hub: &Hub) -> ActionRequest {
        for _ in 0..200 {
            if let Some(a) = hub.actions().into_iter().next() {
                return a;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("no card appeared");
    }

    fn text_of(v: &Value) -> String {
        v["text"].as_str().unwrap().to_string()
    }

    fn approve_args(tool: &str, input: Value) -> Value {
        json!({"tool": "approve", "args": {"tool_name": format!("mcp__buddy__{tool}"), "input": input, "tool_use_id": "t1"}})
    }

    /// Runs `approve` and answers the card with `answer`; returns the permission decision.
    async fn approve_with(r: &Rig, tool: &'static str, input: Value, answer: Value) -> Value {
        let c = r.control.clone();
        let task = tokio::spawn(async move { c.handle(approve_args(tool, input)).await });
        let card = wait_for_action(&r.hub).await;
        r.hub.answer(&card.request_id, &answer).unwrap();
        let reply = task.await.unwrap();
        assert_eq!(reply["ok"], true);
        serde_json::from_str(reply["text"].as_str().unwrap()).unwrap()
    }

    fn start_input() -> Value {
        json!({"project": "Nexa", "model": "sonnet", "prompt": "fix the inbox search"})
    }

    #[tokio::test]
    async fn the_card_for_a_start_has_everything_and_allow_grants_exactly_that() {
        let r = rig(vec![], 3);
        let c = r.control.clone();
        let task = tokio::spawn(async move { c.handle(approve_args("start_session", start_input())).await });
        let card = wait_for_action(&r.hub).await;
        assert_eq!(card.title, "Start a session");
        assert_eq!(card.rows.iter().map(|x| (x.label.as_str(), x.value.as_str())).collect::<Vec<_>>(), [("Project", "Nexa"), ("Model", "sonnet")]);
        assert_eq!(card.body.as_deref(), Some("fix the inbox search"));
        let folder = card.folder.clone().unwrap();
        assert_eq!(folder.path, path_text(&r.root.join("Nexa")));
        assert!(folder.options.is_empty());
        assert_eq!(card.host.clone().unwrap().value, "background");
        r.hub.answer(&card.request_id, &json!({"allow": true})).unwrap();
        let decision: Value = serde_json::from_str(&text_of(&task.await.unwrap())).unwrap();
        assert_eq!(decision["behavior"], "allow");
        let updated = decision["updatedInput"].clone();
        assert_eq!(updated["project"], path_text(&r.root.join("Nexa")));
        assert_eq!(updated["host"], "background");

        // The tool call with the granted arguments runs once.
        let run = r.control.clone().handle(json!({"tool": "start_session", "args": updated.clone()})).await;
        assert_eq!(run["ok"], true, "{run}");
        assert!(text_of(&run).contains("c91b09c1") || text_of(&run).contains("Started a background session in Nexa"));
        let calls = r.cli.calls.lock().unwrap().clone();
        assert_eq!(calls[0][..6], ["--bg", "--model", "sonnet", "-n", "Buddy: Nexa", "--"]);
        let again = r.control.clone().handle(json!({"tool": "start_session", "args": updated})).await;
        assert_eq!(again["ok"], false, "a grant is used up once");
        assert_eq!(r.cli.calls.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_denied_card_gives_the_denied_text_and_no_grant() {
        let r = rig(vec![], 3);
        let d = approve_with(&r, "start_session", start_input(), json!({"allow": false})).await;
        assert_eq!(d, json!({"behavior": "deny", "message": "denied by the user"}));
        let run = r.control.clone().handle(json!({"tool": "start_session", "args": {"project": path_text(&r.root.join("Nexa")), "model": "sonnet", "prompt": "fix the inbox search", "host": "background"}})).await;
        assert_eq!(run["ok"], false);
        assert!(r.cli.calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn an_ungranted_action_never_runs() {
        let r = rig(vec![agent("c91b09c1", Some(5), "idle", "Buddy: Nexa", &r_root())], 3);
        for (tool, args) in [
            ("start_session", json!({"project": "Nexa", "model": "haiku", "prompt": "x"})),
            ("send_prompt", json!({"session_id": "c91b09c1-full", "text": "x"})),
            ("stop_session", json!({"session_id": "c91b09c1-full"})),
        ] {
            let run = r.control.clone().handle(json!({"tool": tool, "args": args})).await;
            assert_eq!(run["ok"], false, "{tool}");
            assert!(text_of(&run).contains("not confirmed"));
        }
        assert!(r.cli.calls.lock().unwrap().is_empty());
    }

    fn r_root() -> PathBuf {
        PathBuf::from("/p/Nexa")
    }

    #[tokio::test]
    async fn changed_arguments_do_not_match_the_grant() {
        let r = rig(vec![], 3);
        let d = approve_with(&r, "start_session", start_input(), json!({"allow": true})).await;
        let mut tampered = d["updatedInput"].clone();
        tampered["prompt"] = json!("something else");
        let run = r.control.clone().handle(json!({"tool": "start_session", "args": tampered})).await;
        assert_eq!(run["ok"], false);
        let mut other_tool = d["updatedInput"].clone();
        other_tool["session_id"] = json!("x");
        let run = r.control.clone().handle(json!({"tool": "stop_session", "args": other_tool})).await;
        assert_eq!(run["ok"], false);
        assert!(r.cli.calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_folder_the_user_picked_is_trusted_outside_the_roots() {
        let r = rig(vec![], 3);
        let picked = r.root.parent().unwrap().join("elsewhere").join("Picked");
        let d = approve_with(&r, "start_session", start_input(), json!({"allow": true, "folder": path_text(&picked), "host": "background"})).await;
        assert_eq!(d["updatedInput"]["project"], path_text(&picked));
        let run = r.control.clone().handle(json!({"tool": "start_session", "args": d["updatedInput"].clone()})).await;
        assert_eq!(run["ok"], true, "{run}");
        assert!(text_of(&run).contains("Picked"));
    }

    #[tokio::test]
    async fn a_chosen_folder_must_exist() {
        let r = rig(vec![], 3);
        let missing = r.root.join("no-such-folder");
        let d = approve_with(&r, "start_session", start_input(), json!({"allow": true, "folder": path_text(&missing)})).await;
        assert_eq!(d["behavior"], "deny");
        let file = r.root.join("Nexa").join("f.txt");
        std::fs::write(&file, "x").unwrap();
        let d = approve_with(&r, "start_session", start_input(), json!({"allow": true, "folder": path_text(&file)})).await;
        assert_eq!(d["behavior"], "deny", "a file is not a folder");
    }

    #[tokio::test]
    async fn only_background_runs() {
        let r = rig(vec![], 3);
        let mut input = start_input();
        input["host"] = json!("iterm");
        let reply = r.control.clone().handle(approve_args("start_session", input)).await;
        let d: Value = serde_json::from_str(&text_of(&reply)).unwrap();
        assert_eq!(d["behavior"], "deny");
        assert!(d["message"].as_str().unwrap().contains("background"));
        assert!(r.hub.actions().is_empty(), "no card for a request that cannot run");
        let d = approve_with(&r, "start_session", start_input(), json!({"allow": true, "host": "warp"})).await;
        assert_eq!(d["behavior"], "deny");
    }

    #[tokio::test]
    async fn bad_requests_get_no_card() {
        let r = rig(vec![], 3);
        let cases = [
            json!({"project": "Nexa", "model": "gpt", "prompt": "x"}),
            json!({"project": "Nexa", "model": "haiku", "prompt": "a\u{1b}b"}),
            json!({"project": "Nexa", "model": "haiku", "prompt": "a".repeat(MAX_TEXT + 1)}),
            json!({"project": "Nexa", "model": "haiku", "prompt": ""}),
            json!({"project": "../elsewhere/Picked", "model": "haiku", "prompt": "x"}),
            json!({"project": "NoSuch", "model": "haiku", "prompt": "x"}),
            json!({"model": "haiku", "prompt": "x"}),
        ];
        for input in cases {
            let reply = r.control.clone().handle(approve_args("start_session", input.clone())).await;
            let d: Value = serde_json::from_str(&text_of(&reply)).unwrap();
            assert_eq!(d["behavior"], "deny", "{input}");
            assert!(!d["message"].as_str().unwrap().contains("elsewhere"), "the refusal never echoes a path outside the roots");
        }
        assert!(r.hub.actions().is_empty());
    }

    #[tokio::test]
    async fn several_matches_become_folder_options() {
        let r = rig(vec![], 3);
        std::fs::create_dir_all(r.root.join("nexa-old")).unwrap();
        let c = r.control.clone();
        let task = tokio::spawn(async move { c.handle(approve_args("start_session", json!({"project": "nex", "model": "haiku", "prompt": "x"}))).await });
        let card = wait_for_action(&r.hub).await;
        let f = card.folder.unwrap();
        assert_eq!(f.options.len(), 2);
        assert!(f.options.contains(&f.path));
        r.hub.answer(&card.request_id, &json!({"allow": false})).unwrap();
        let _ = task.await;
    }

    #[tokio::test]
    async fn the_limit_is_checked_before_a_card() {
        let busy = vec![agent("aaaaaaa1", Some(1), "busy", "Buddy: A", &r_root()), agent("aaaaaaa2", Some(2), "waiting", "Buddy: B", &r_root())];
        let r = rig(busy, 2);
        let reply = r.control.clone().handle(approve_args("start_session", start_input())).await;
        let d: Value = serde_json::from_str(&text_of(&reply)).unwrap();
        assert_eq!(d["behavior"], "deny");
        assert!(d["message"].as_str().unwrap().contains("limit is 2"));
        assert!(r.hub.actions().is_empty());
    }

    #[tokio::test]
    async fn only_managed_sessions_can_be_steered() {
        let r = rig(vec![agent("bbbbbbb2", Some(2), "idle", "interactive-ish", &r_root())], 3);
        let reply = r.control.clone().handle(approve_args("stop_session", json!({"session_id": "bbbbbbb2-full"}))).await;
        let d: Value = serde_json::from_str(&text_of(&reply)).unwrap();
        assert_eq!(d["behavior"], "deny");
        assert!(d["message"].as_str().unwrap().contains("Only those"));
        let reply = r.control.clone().handle(approve_args("stop_session", json!({"session_id": "nope"}))).await;
        assert!(text_of(&reply).contains("deny"));
        assert!(r.hub.actions().is_empty());
    }

    #[tokio::test]
    async fn send_and_stop_run_after_a_yes() {
        let r = rig(vec![agent("c91b09c1", None, "idle", "Buddy: Nexa", &r_root())], 3);
        let d = approve_with(&r, "send_prompt", json!({"session_id": "c91b09c1-full", "text": "next step"}), json!({"allow": true})).await;
        assert_eq!(d["updatedInput"], json!({"session_id": "c91b09c1-full", "text": "next step"}));
        let run = r.control.clone().handle(json!({"tool": "send_prompt", "args": d["updatedInput"].clone()})).await;
        assert_eq!(run["ok"], true, "{run}");
        assert_eq!(text_of(&run), "Sent the prompt to Nexa.");

        *r.cli.agents.lock().unwrap() = Value::Array(vec![agent("c91b09c1", Some(5), "busy", "Buddy: Nexa", &r_root())]).to_string();
        let d = approve_with(&r, "stop_session", json!({"session_id": "c91b09c1-full"}), json!({"allow": true})).await;
        let run = r.control.clone().handle(json!({"tool": "stop_session", "args": d["updatedInput"].clone()})).await;
        assert_eq!(text_of(&run), "Stopped Nexa.");
        assert_eq!(r.cli.calls.lock().unwrap().last().unwrap(), &["stop", "c91b09c1"]);
    }

    #[tokio::test]
    async fn a_busy_session_gets_no_prompt_card() {
        let r = rig(vec![agent("c91b09c1", Some(5), "busy", "Buddy: Nexa", &r_root())], 3);
        let reply = r.control.clone().handle(approve_args("send_prompt", json!({"session_id": "c91b09c1-full", "text": "x"}))).await;
        assert!(text_of(&reply).contains("busy"));
        assert!(r.hub.actions().is_empty());
    }

    #[tokio::test]
    async fn no_tool_can_answer_a_session_request() {
        let r = rig(vec![], 3);
        for tool in ["answer", "allow", "approve_session", "answer_permission", "answer_question", "Bash"] {
            let reply = r.control.clone().handle(json!({"tool": tool, "args": {"request_id": "r1", "allow": true}})).await;
            assert_eq!(reply["ok"], false, "{tool}");
        }
        let reply = r.control.clone().handle(approve_args("answer_question", json!({}))).await;
        assert!(text_of(&reply).contains("deny"));
        let reply = r.control.clone().handle(json!({"tool": "approve", "args": {"tool_name": "mcp__buddy__list_sessions", "input": {}}})).await;
        assert!(text_of(&reply).contains("deny"), "only the three action tools go through the card");
    }

    #[tokio::test]
    async fn an_unanswered_card_is_denied() {
        let hub = Hub::with_timeouts(|_| {}, Duration::from_millis(20), Duration::from_millis(60), Duration::from_millis(60));
        let cli = Arc::new(Cli { agents: Mutex::new("[]".into()), calls: Mutex::new(Vec::new()) });
        let dir = tempfile::tempdir().unwrap();
        let root = projects::canonical_dir(dir.path()).unwrap();
        std::fs::create_dir_all(root.join("Nexa")).unwrap();
        let settings = Settings { chat_project_roots: vec![path_text(&root)], ..Settings::default() };
        let control = Arc::new(Control::new(hub, Arc::new(Workers::new(cli, |_| {})), move || settings.clone()));
        let reply = control.handle(approve_args("start_session", start_input())).await;
        let d: Value = serde_json::from_str(&text_of(&reply)).unwrap();
        assert_eq!(d["behavior"], "deny");
        assert!(d["message"].as_str().unwrap().starts_with("denied"));
    }

    fn sample_session(id: &str, project: &str) -> Value {
        json!({"sb_kind": "hook", "hook_event_name": "UserPromptSubmit", "session_id": id, "cwd": format!("/p/{project}"), "prompt": "x".repeat(500)})
    }

    #[tokio::test]
    async fn reads_return_clipped_data() {
        let r = rig(vec![], 3);
        {
            let mut st = r.hub.store.lock().unwrap();
            st.mark_managed("s2");
            st.apply_hook(&sample_session("s1", "Nexa"), 1_000);
            st.apply_hook(&sample_session("s2", "Other"), 2_000);
            st.apply_hook(&json!({"hook_event_name": "PreToolUse", "session_id": "s2", "cwd": "/p/Other", "tool_name": "Bash", "tool_input": {"command": "ls"}}), 2_500);
        }
        let list: Value = serde_json::from_str(&text_of(&r.control.clone().handle(json!({"tool": "list_sessions"})).await)).unwrap();
        assert_eq!(list["total"], 2);
        assert_eq!(list["sessions"][0]["id"], "s2", "newest activity first");
        assert_eq!(list["sessions"][0]["managed"], true);
        assert_eq!(list["sessions"][1]["managed"], false);
        assert_eq!(list["sessions"][1]["status"], serde_json::to_value(Status::Thinking).unwrap());
        assert!(list["sessions"][1]["lastPrompt"].as_str().unwrap().chars().count() <= 200);
        assert!(list["sessions"][0].get("cwd").is_none(), "no paths in the overview");

        let one: Value = serde_json::from_str(&text_of(&r.control.clone().handle(json!({"tool": "get_session", "args": {"id": "s2"}})).await)).unwrap();
        assert_eq!(one["project"], "Other");
        assert_eq!(one["steps"][0]["tool"], "Bash");
        let missing = r.control.clone().handle(json!({"tool": "get_session", "args": {"id": "zzz"}})).await;
        assert_eq!(missing["ok"], false);
        let none = r.control.clone().handle(json!({"tool": "get_session", "args": {}})).await;
        assert_eq!(none["ok"], false);
    }

    #[tokio::test]
    async fn pending_requests_show_kind_and_target() {
        let r = rig(vec![], 3);
        r.hub.store.lock().unwrap().apply_hook(
            &json!({"sb_kind": "hook", "hook_event_name": "PermissionRequest", "session_id": "s1", "cwd": "/p/Nexa", "tool_name": "Bash", "tool_input": {"command": "rm -rf build"}, "sb_request_id": "r1", "sb_wait_ms": 1000}),
            1_000,
        );
        let list: Value = serde_json::from_str(&text_of(&r.control.clone().handle(json!({"tool": "list_sessions"})).await)).unwrap();
        assert_eq!(list["sessions"][0]["pending"][0]["kind"], "approval");
        assert!(list["sessions"][0]["pending"][0]["target"].as_str().unwrap().contains("rm -rf build"));
    }

    #[tokio::test]
    async fn projects_are_listed_inside_the_roots() {
        let r = rig(vec![], 3);
        let list: Value = serde_json::from_str(&text_of(&r.control.clone().handle(json!({"tool": "list_projects"})).await)).unwrap();
        let names: Vec<&str> = list["projects"].as_array().unwrap().iter().map(|p| p["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["code", "Nexa", "Other"]);
        let empty = Arc::new(Control::new(r.hub.clone(), r.control.workers().clone(), Settings::default));
        assert!(text_of(&empty.handle(json!({"tool": "list_projects"})).await).contains("Settings"));
    }

    #[test]
    fn finish_only_touches_the_folder_of_a_start() {
        let args = json!({"session_id": "s", "text": "t"});
        assert_eq!(finish(&args, &json!({"allow": true, "folder": "/nonexistent"})).unwrap(), args);
    }

    fn live_session(r: &Rig, id: &str) {
        r.hub.store.lock().unwrap().apply_hook(&json!({"hook_event_name": "SessionStart", "session_id": id, "cwd": "/p/Nexa"}), 1);
    }

    fn queued(r: &Rig, id: &str) -> Vec<(String, String)> {
        let st = r.hub.store.lock().unwrap();
        st.get(id).unwrap().messages.0.iter().map(|m| (m.text.clone(), format!("{:?}", m.state))).collect()
    }

    #[tokio::test]
    async fn send_prompt_to_another_session_is_confirmed_then_queued() {
        let r = rig(vec![], 3);
        live_session(&r, "s1");
        let c = r.control.clone();
        let task = tokio::spawn(async move { c.handle(approve_args("send_prompt", json!({"session_id": "s1", "text": "use tabs"}))).await });
        let card = wait_for_action(&r.hub).await;
        assert_eq!(card.title, "Send a message");
        assert_eq!(card.body.as_deref(), Some("use tabs"));
        assert!(queued(&r, "s1").is_empty(), "nothing is queued before the yes");
        r.hub.answer(&card.request_id, &json!({"allow": true})).unwrap();
        let d: Value = serde_json::from_str(&text_of(&task.await.unwrap())).unwrap();
        assert_eq!(d["behavior"], "allow");
        let run = r.control.clone().handle(json!({"tool": "send_prompt", "args": d["updatedInput"].clone()})).await;
        assert_eq!(run["ok"], true, "{run}");
        assert_eq!(queued(&r, "s1"), [("use tabs".to_string(), "Queued".to_string())]);
        assert!(r.cli.calls.lock().unwrap().is_empty(), "no CLI call for an unmanaged session");
    }

    #[tokio::test]
    async fn an_unconfirmed_message_is_not_queued() {
        let r = rig(vec![], 3);
        live_session(&r, "s1");
        let run = r.control.clone().handle(json!({"tool": "send_prompt", "args": {"session_id": "s1", "text": "sneaky"}})).await;
        assert_eq!(run["ok"], false);
        assert!(queued(&r, "s1").is_empty());
    }

    #[tokio::test]
    async fn no_card_for_a_message_that_cannot_be_queued() {
        let r = rig(vec![], 3);
        for input in [json!({"session_id": "ghost", "text": "hi"}), json!({"session_id": "s1", "text": "  "})] {
            live_session(&r, "s1");
            let reply = r.control.clone().handle(approve_args("send_prompt", input)).await;
            assert!(text_of(&reply).contains("deny"));
        }
        for i in 0..5 {
            r.hub.queue_message("s1", &format!("m{i}")).unwrap();
        }
        let reply = r.control.clone().handle(approve_args("send_prompt", json!({"session_id": "s1", "text": "sixth"}))).await;
        assert!(text_of(&reply).contains("already waiting"));
        assert!(r.hub.actions().is_empty());
    }

    #[tokio::test]
    async fn a_managed_session_still_takes_the_prompt_through_the_worker() {
        let r = rig(vec![agent("c91b09c1", None, "idle", "Buddy: Nexa", &r_root())], 3);
        live_session(&r, "c91b09c1-full");
        let d = approve_with(&r, "send_prompt", json!({"session_id": "c91b09c1-full", "text": "next"}), json!({"allow": true})).await;
        let run = r.control.clone().handle(json!({"tool": "send_prompt", "args": d["updatedInput"].clone()})).await;
        assert_eq!(text_of(&run), "Sent the prompt to Nexa.");
        assert!(queued(&r, "c91b09c1-full").is_empty());
    }

    #[tokio::test]
    async fn the_island_message_command_picks_the_path_by_session_kind() {
        let r = rig(vec![agent("c91b09c1", None, "idle", "Buddy: Nexa", &r_root())], 3);
        live_session(&r, "s1");
        r.control.user_message("s1".into(), "hello\u{7}".into()).await.unwrap();
        assert_eq!(queued(&r, "s1"), [("hello".to_string(), "Queued".to_string())]);

        assert!(r.control.user_message("s1".into(), "".into()).await.unwrap_err().contains("empty"));
        assert!(r.control.user_message("gone".into(), "hi".into()).await.unwrap_err().contains("Only those"), "unknown id: the worker path's error");

        live_session(&r, "c91b09c1-full");
        r.hub.store.lock().unwrap().mark_managed("c91b09c1-full");
        r.control.user_message("c91b09c1-full".into(), "go on".into()).await.unwrap();
        assert!(queued(&r, "c91b09c1-full").is_empty(), "managed: direct prompt, no queue");
        assert_eq!(r.cli.calls.lock().unwrap().last().unwrap()[0], "--bg");
    }
}
