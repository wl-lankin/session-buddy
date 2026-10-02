//! The app side of the relay protocol. One connection = one hook event. For the
//! three blocking kinds the connection stays open until the island answers,
//! the user hands it back to the terminal, the deadline passes or the relay
//! goes away - whichever comes first.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc;

use crate::actions::ActionRequest;
use crate::messages::Message;
use crate::now_ms;
use crate::store::{Cue, Store};

const MAX_LINE: usize = 1 << 20;
const ALREADY_ANSWERED: &str = "This question was already answered in the terminal.";
/// Tells the relay the card is on screen, so it keeps waiting (same literal in hook/src/transport.rs).
const ACK_LINE: &[u8] = b"{\"sb_ack\":true}
";

pub enum Reply {
    Ack,
    Answer(String),
    Release,
}

/// Cleans up a pending request on every exit path, including cancellation.
struct PendingGuard<'a> {
    hub: &'a Hub,
    id: String,
    answered: bool,
}

impl Drop for PendingGuard<'_> {
    fn drop(&mut self) {
        self.hub.pending.lock().unwrap().remove(&self.id);
        self.hub.store.lock().unwrap().resolve(&self.id, self.answered, now_ms());
        (self.hub.notify)(Vec::new());
    }
}

type Notify = Box<dyn Fn(Vec<Cue>) + Send + Sync>;

/// Runs one tool call from the relay's MCP server: `{"tool", "args"}` in, `{"ok", "text"}` out.
pub type ToolHandler = Box<dyn Fn(Arc<Hub>, Value) -> Pin<Box<dyn Future<Output = Value> + Send>> + Send + Sync>;

/// Removes an open action request on every exit path, including cancellation.
struct ActionGuard<'a> {
    hub: &'a Hub,
    id: String,
}

impl Drop for ActionGuard<'_> {
    fn drop(&mut self) {
        self.hub.pending.lock().unwrap().remove(&self.id);
        self.hub.actions.lock().unwrap().retain(|a| a.request_id != self.id);
        (self.hub.notify)(Vec::new());
    }
}

pub struct Hub {
    pub store: Mutex<Store>,
    pending: Mutex<HashMap<String, mpsc::Sender<Reply>>>,
    actions: Mutex<Vec<ActionRequest>>,
    tools: OnceLock<ToolHandler>,
    counter: AtomicU64,
    notify: Notify,
    ack_timeout: Duration,
    wait_permission: Duration,
    wait_long: Duration,
}

impl Hub {
    pub fn new(notify: impl Fn(Vec<Cue>) + Send + Sync + 'static) -> Arc<Self> {
        Self::with_timeouts(notify, Duration::from_millis(800), Duration::from_secs(110), Duration::from_secs(540))
    }

    pub fn with_timeouts(
        notify: impl Fn(Vec<Cue>) + Send + Sync + 'static,
        ack_timeout: Duration,
        wait_permission: Duration,
        wait_long: Duration,
    ) -> Arc<Self> {
        Arc::new(Self {
            store: Mutex::new(Store::default()),
            pending: Mutex::new(HashMap::new()),
            actions: Mutex::new(Vec::new()),
            tools: OnceLock::new(),
            counter: AtomicU64::new(1),
            notify: Box::new(notify),
            ack_timeout,
            wait_permission,
            wait_long,
        })
    }

    pub fn set_tool_handler(&self, handler: ToolHandler) {
        let _ = self.tools.set(handler);
    }

    /// Queues a message for a running session (see `Store::queue_message`) and refreshes the island.
    pub fn queue_message(&self, session_id: &str, text: &str) -> Result<Message, String> {
        let message = self.store.lock().unwrap().queue_message(session_id, text, now_ms())?;
        (self.notify)(Vec::new());
        Ok(message)
    }

    pub fn cancel_message(&self, session_id: &str, message_id: &str) -> Result<(), String> {
        self.store.lock().unwrap().cancel_message(session_id, message_id)?;
        (self.notify)(Vec::new());
        Ok(())
    }

    /// The confirmations waiting for the user, oldest first.
    pub fn actions(&self) -> Vec<ActionRequest> {
        self.actions.lock().unwrap().clone()
    }

    /// Puts `request` on the island and waits for the answer (`{"allow", ...}`), up to the permission budget.
    /// None: nobody answered, the card was released, or the caller gave up (the future was dropped).
    pub async fn confirm(&self, mut request: ActionRequest) -> Option<Value> {
        let id = format!("a{}", self.counter.fetch_add(1, Ordering::Relaxed));
        let (tx, mut rx) = mpsc::channel::<Reply>(8);
        request.request_id = id.clone();
        request.deadline = now_ms() + self.wait_permission.as_millis() as i64;
        self.pending.lock().unwrap().insert(id.clone(), tx);
        self.actions.lock().unwrap().push(request);
        let _guard = ActionGuard { hub: self, id };
        (self.notify)(Vec::new());
        let deadline = tokio::time::Instant::now() + self.wait_permission;
        loop {
            match tokio::time::timeout_at(deadline, rx.recv()).await {
                Ok(Some(Reply::Ack)) => continue,
                Ok(Some(Reply::Answer(a))) => return serde_json::from_str(&a).ok(),
                _ => return None,
            }
        }
    }

    async fn serve_tool<R, W>(self: &Arc<Self>, payload: Value, rd: &mut R, wr: &mut W)
    where
        R: AsyncRead + Unpin,
        W: AsyncWrite + Unpin,
    {
        let Some(handler) = self.tools.get() else { return };
        let reply = tokio::select! {
            v = handler(self.clone(), payload) => v,
            // The relay went away (Claude Code stopped the call): the pending card goes with the dropped future.
            _ = closed(rd) => return,
        };
        let _ = wr.write_all(format!("{reply}\n").as_bytes()).await;
        let _ = wr.flush().await;
    }

    pub async fn serve<S>(self: Arc<Self>, stream: S)
    where
        S: AsyncRead + AsyncWrite + Unpin + Send,
    {
        let (mut rd, mut wr) = tokio::io::split(stream);
        let Some(mut payload) = read_line_json(&mut rd).await else { return };

        if payload.get("sb_kind").and_then(Value::as_str) == Some("statusline") {
            let cues = self.store.lock().unwrap().apply_statusline(&payload, now_ms());
            (self.notify)(cues);
            return;
        }

        if payload.get("sb_kind").and_then(Value::as_str) == Some("mcp") {
            self.serve_tool(payload, &mut rd, &mut wr).await;
            return;
        }

        // Claude Code ignores a hook answer for ExitPlanMode, so never hold an old relay that still waits:
        // closing without an ack hands the dialog back to the terminal.
        let plan_mode = payload.get("tool_name").and_then(Value::as_str) == Some("ExitPlanMode");
        let wait = payload.get("sb_wait").and_then(Value::as_str).filter(|_| !plan_mode).map(str::to_string);
        let Some(kind) = wait else {
            let cues = self.store.lock().unwrap().apply_hook(&payload, now_ms());
            (self.notify)(cues);
            return;
        };

        if kind == "message" {
            self.serve_message(&payload, &mut wr).await;
            return;
        }

        let budget = if kind == "permission" { self.wait_permission } else { self.wait_long };
        let id = format!("r{}", self.counter.fetch_add(1, Ordering::Relaxed));
        let (tx, mut rx) = mpsc::channel::<Reply>(8);
        self.pending.lock().unwrap().insert(id.clone(), tx);
        payload["sb_request_id"] = json!(id);
        payload["sb_wait_ms"] = json!(budget.as_millis() as i64);
        let cues = self.store.lock().unwrap().apply_hook(&payload, now_ms());
        (self.notify)(cues);

        let mut guard = PendingGuard { hub: &self, id, answered: false };
        let outcome = self.wait(&mut rx, budget, &mut rd, &mut wr).await;
        guard.answered = outcome.is_some();
        drop(guard);

        if let Some(line) = outcome {
            let _ = wr.write_all(format!("{line}\n").as_bytes()).await;
            let _ = wr.flush().await;
        }
    }

    /// The immediate answer for a Pre/PostToolUse or Stop the relay waits on: `{"messages": [...]}`,
    /// empty when nothing is queued. The texts are marked delivered before they are written; if the
    /// relay is already gone they go back to the queue.
    async fn serve_message<W: AsyncWrite + Unpin>(&self, payload: &Value, wr: &mut W) {
        let session = payload.get("session_id").and_then(Value::as_str).unwrap_or_default().to_string();
        let (cues, taken) = self.store.lock().unwrap().apply_hook_delivering(payload, now_ms());
        (self.notify)(cues);
        let texts: Vec<&str> = taken.iter().map(|(_, text)| text.as_str()).collect();
        let reply = format!("{}\n", json!({"messages": texts}));
        let sent = wr.write_all(reply.as_bytes()).await.is_ok() && wr.flush().await.is_ok();
        if taken.is_empty() {
            return;
        }
        if !sent {
            let ids: Vec<String> = taken.into_iter().map(|(id, _)| id).collect();
            self.store.lock().unwrap().restore_messages(&session, &ids);
        }
        (self.notify)(Vec::new());
    }

    /// Two waits: a short one for "the card is on screen" (passed on to the relay as
    /// one ack line), then the long one for a human.
    async fn wait<R: AsyncRead + Unpin, W: AsyncWrite + Unpin>(
        &self,
        rx: &mut mpsc::Receiver<Reply>,
        budget: Duration,
        rd: &mut R,
        wr: &mut W,
    ) -> Option<String> {
        let first = tokio::select! {
            r = tokio::time::timeout(self.ack_timeout, rx.recv()) => r,
            _ = closed(rd) => return None,
        };
        match first {
            Ok(Some(Reply::Ack)) => {
                if wr.write_all(ACK_LINE).await.is_err() || wr.flush().await.is_err() {
                    return None;
                }
            }
            Ok(Some(Reply::Answer(a))) => return Some(a),
            _ => return None,
        }
        let deadline = tokio::time::Instant::now() + budget;
        loop {
            let next = tokio::select! {
                r = tokio::time::timeout_at(deadline, rx.recv()) => r,
                _ = closed(rd) => return None,
            };
            match next {
                Ok(Some(Reply::Ack)) => continue,
                Ok(Some(Reply::Answer(a))) => return Some(a),
                _ => return None,
            }
        }
    }

    fn send(&self, request_id: &str, reply: Reply) -> Result<(), String> {
        let tx = self.pending.lock().unwrap().get(request_id).cloned();
        match tx {
            Some(tx) => tx.try_send(reply).map_err(|_| ALREADY_ANSWERED.to_string()),
            None => Err(ALREADY_ANSWERED.into()),
        }
    }

    /// The island has the card on screen.
    pub fn ack(&self, request_id: &str) {
        let _ = self.send(request_id, Reply::Ack);
    }

    pub fn answer(&self, request_id: &str, answer: &Value) -> Result<(), String> {
        let behavior_ok = matches!(answer.get("behavior").and_then(Value::as_str), Some("allow" | "deny"));
        let answers_ok = answer
            .get("answers")
            .and_then(Value::as_object)
            .map(|m| !m.is_empty() && m.values().all(Value::is_string))
            .unwrap_or(false);
        let reply_ok = answer.get("reply").and_then(Value::as_str).map(|t| !t.trim().is_empty()).unwrap_or(false);
        let allow_ok = answer.get("allow").is_some_and(Value::is_boolean);
        if !(behavior_ok || answers_ok || reply_ok || allow_ok) {
            return Err("invalid answer".into());
        }
        self.send(request_id, Reply::Answer(answer.to_string()))
    }

    /// "Answer in terminal".
    pub fn release(&self, request_id: &str) {
        let _ = self.send(request_id, Reply::Release);
    }
}

async fn read_line_json<R: AsyncRead + Unpin>(rd: &mut R) -> Option<Value> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        match rd.read(&mut chunk).await {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.contains(&b'\n') || buf.len() > MAX_LINE {
                    break;
                }
            }
            Err(_) => return None,
        }
    }
    let end = buf.iter().position(|b| *b == b'\n').unwrap_or(buf.len());
    let v: Value = serde_json::from_slice(&buf[..end]).ok()?;
    v.is_object().then_some(v)
}

/// Resolves when the relay closes its end (Claude Code killed the hook).
async fn closed<R: AsyncRead + Unpin>(rd: &mut R) {
    let mut b = [0u8; 64];
    loop {
        match rd.read(&mut b).await {
            Ok(0) | Err(_) => return,
            Ok(_) => continue,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{duplex, AsyncBufReadExt, BufReader};

    fn hub() -> Arc<Hub> {
        Hub::with_timeouts(|_| {}, Duration::from_millis(400), Duration::from_millis(2000), Duration::from_millis(2000))
    }

    async fn send(h: &Arc<Hub>, payload: Value) -> (tokio::task::JoinHandle<()>, tokio::io::DuplexStream) {
        let (client, server) = duplex(1 << 16);
        let task = tokio::spawn(h.clone().serve(server));
        let mut client = client;
        client.write_all(format!("{payload}\n").as_bytes()).await.unwrap();
        (task, client)
    }

    const ACK: &str = r#"{"sb_ack":true}"#;

    async fn read_lines(client: tokio::io::DuplexStream) -> Vec<String> {
        let mut lines = BufReader::new(client).lines();
        let mut out = Vec::new();
        while let Ok(Some(line)) = lines.next_line().await {
            out.push(line);
        }
        out
    }

    fn pending_id(h: &Hub) -> Option<String> {
        h.store.lock().unwrap().snapshot().iter().flat_map(|s| s.pending.iter()).map(|p| p.request_id().to_string()).next()
    }

    async fn wait_for_pending(h: &Hub) -> String {
        for _ in 0..100 {
            if let Some(id) = pending_id(h) {
                return id;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("no pending interaction appeared");
    }

    fn permission(session: &str) -> Value {
        json!({"sb_kind":"hook","sb_wait":"permission","hook_event_name":"PermissionRequest","session_id":session,"cwd":"/p/x","tool_name":"Bash","tool_input":{"command":"ls"}})
    }

    #[tokio::test]
    async fn exit_plan_mode_from_an_old_relay_never_blocks() {
        let h = hub();
        let payload = json!({"sb_kind":"hook","sb_wait":"permission","hook_event_name":"PermissionRequest","session_id":"s1","cwd":"/p/x","tool_name":"ExitPlanMode","tool_input":{"plan":"## Plan"}});
        let (task, client) = send(&h, payload).await;
        // The hub closes at once without an ack: the old relay hands the dialog back to the terminal.
        tokio::time::timeout(Duration::from_millis(300), task).await.expect("serve returns at once").unwrap();
        assert!(read_lines(client).await.is_empty());
        assert!(pending_id(&h).is_none());
        assert!(h.pending.lock().unwrap().is_empty());
        assert_eq!(h.store.lock().unwrap().get("s1").unwrap().plan.as_deref(), Some("## Plan"));
    }

    #[tokio::test]
    async fn fire_and_forget_updates_store() {
        let h = hub();
        let (task, _client) = send(&h, json!({"sb_kind":"hook","sb_wait":null,"hook_event_name":"SessionStart","session_id":"s1","cwd":"/p/x"})).await;
        task.await.unwrap();
        assert!(h.store.lock().unwrap().get("s1").is_some());
    }

    #[tokio::test]
    async fn statusline_updates_stats() {
        let h = hub();
        let (task, _c) = send(&h, json!({"sb_kind":"statusline","session_id":"s1","cost":{"total_lines_added":3}})).await;
        task.await.unwrap();
        assert_eq!(h.store.lock().unwrap().get("s1").unwrap().stats.lines_added, 3);
    }

    #[tokio::test]
    async fn ack_then_answer_reaches_relay() {
        let h = hub();
        let (task, client) = send(&h, permission("s1")).await;
        let id = wait_for_pending(&h).await;
        h.ack(&id);
        h.answer(&id, &json!({"behavior":"allow"})).unwrap();
        assert_eq!(read_lines(client).await, vec![ACK.to_string(), r#"{"behavior":"allow"}"#.to_string()]);
        task.await.unwrap();
        assert!(pending_id(&h).is_none());
    }

    #[tokio::test]
    async fn answer_before_ack_reaches_relay_without_ack_line() {
        let h = hub();
        let (task, client) = send(&h, permission("s1")).await;
        let id = wait_for_pending(&h).await;
        h.answer(&id, &json!({"behavior":"deny"})).unwrap();
        assert_eq!(read_lines(client).await, vec![r#"{"behavior":"deny"}"#.to_string()]);
        task.await.unwrap();
    }

    #[tokio::test]
    async fn no_ack_means_terminal() {
        let h = hub();
        let (task, client) = send(&h, permission("s1")).await;
        let _ = wait_for_pending(&h).await;
        let lines = tokio::time::timeout(Duration::from_millis(1200), read_lines(client)).await.expect("closed after the ack timeout, not the long budget");
        assert!(lines.is_empty(), "no ack line without an ack: {lines:?}");
        task.await.unwrap();
        assert!(pending_id(&h).is_none());
    }

    #[tokio::test]
    async fn release_means_terminal() {
        let h = hub();
        let (task, client) = send(&h, permission("s1")).await;
        let id = wait_for_pending(&h).await;
        h.ack(&id);
        h.release(&id);
        let lines = tokio::time::timeout(Duration::from_millis(300), read_lines(client)).await.expect("release observed well before the deadline");
        assert_eq!(lines, vec![ACK.to_string()]);
        task.await.unwrap();
        assert!(pending_id(&h).is_none());
    }

    #[tokio::test]
    async fn deadline_means_terminal_and_late_answer_fails() {
        let h = hub();
        let (task, client) = send(&h, permission("s1")).await;
        let id = wait_for_pending(&h).await;
        h.ack(&id);
        assert_eq!(read_lines(client).await, vec![ACK.to_string()]);
        task.await.unwrap();
        assert!(h.answer(&id, &json!({"behavior":"allow"})).is_err());
    }

    #[tokio::test]
    async fn client_disconnect_releases() {
        let h = hub();
        let (task, client) = send(&h, permission("s1")).await;
        let id = wait_for_pending(&h).await;
        h.ack(&id);
        drop(client);
        tokio::time::timeout(Duration::from_millis(200), task).await.expect("released promptly").unwrap();
        assert!(pending_id(&h).is_none());
    }

    #[tokio::test]
    async fn aborted_serve_cleans_up() {
        let h = hub();
        let (task, _client) = send(&h, permission("s1")).await;
        let id = wait_for_pending(&h).await;
        h.ack(&id);
        task.abort();
        let _ = task.await;
        assert!(pending_id(&h).is_none());
        assert!(h.answer(&id, &json!({"behavior":"allow"})).is_err());
    }

    #[tokio::test]
    async fn invalid_answers_are_rejected() {
        let h = hub();
        let (_task, _client) = send(&h, permission("s1")).await;
        let id = wait_for_pending(&h).await;
        assert!(h.answer(&id, &json!({"behavior":"maybe"})).is_err());
        assert!(h.answer(&id, &json!({"answers":{}})).is_err());
        assert!(h.answer(&id, &json!({"answers":{"Q?":1}})).is_err());
        assert!(h.answer(&id, &json!({"reply":"  "})).is_err());
        assert!(h.answer(&id, &json!({"reply":"yes"})).is_ok());
    }

    #[tokio::test]
    async fn two_pending_answers_route_by_id() {
        let h = hub();
        let (t1, c1) = send(&h, permission("a")).await;
        let (t2, c2) = send(&h, json!({"sb_kind":"hook","sb_wait":"question","hook_event_name":"PreToolUse","session_id":"b","tool_name":"AskUserQuestion","tool_input":{"questions":[]}})).await;
        let mut ids = Vec::new();
        for _ in 0..100 {
            ids = h.store.lock().unwrap().snapshot().iter().flat_map(|s| s.pending.iter().map(move |p| (s.id.clone(), p.request_id().to_string()))).collect::<Vec<_>>();
            if ids.len() == 2 { break; }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let id_a = ids.iter().find(|(s, _)| s == "a").unwrap().1.clone();
        let id_b = ids.iter().find(|(s, _)| s == "b").unwrap().1.clone();
        h.ack(&id_a);
        h.ack(&id_b);
        h.answer(&id_b, &json!({"answers":{"Q?":"x"}})).unwrap();
        h.answer(&id_a, &json!({"behavior":"deny"})).unwrap();
        assert_eq!(read_lines(c1).await, vec![ACK.to_string(), r#"{"behavior":"deny"}"#.to_string()]);
        assert_eq!(read_lines(c2).await, vec![ACK.to_string(), r#"{"answers":{"Q?":"x"}}"#.to_string()]);
        t1.await.unwrap();
        t2.await.unwrap();
    }

    fn confirm_handler(h: &Arc<Hub>) {
        h.set_tool_handler(Box::new(|hub, req| {
            Box::pin(async move {
                let tool = req["tool"].as_str().unwrap_or_default().to_string();
                if tool == "list" {
                    return json!({"ok": true, "text": "listed"});
                }
                match hub.confirm(ActionRequest::new("Do it").row("Tool", tool)).await {
                    Some(a) if a["allow"] == true => json!({"ok": true, "text": "done", "folder": a["folder"]}),
                    _ => json!({"ok": false, "text": "denied by the user"}),
                }
            })
        }));
    }

    async fn wait_for_action(h: &Hub) -> ActionRequest {
        for _ in 0..100 {
            if let Some(a) = h.actions().into_iter().next() {
                return a;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("no action appeared");
    }

    #[tokio::test]
    async fn a_tool_call_without_a_confirmation_answers_at_once() {
        let h = hub();
        confirm_handler(&h);
        let (task, client) = send(&h, json!({"sb_kind":"mcp","tool":"list","args":{}})).await;
        assert_eq!(read_lines(client).await, vec![r#"{"ok":true,"text":"listed"}"#.to_string()]);
        task.await.unwrap();
    }

    #[tokio::test]
    async fn an_action_waits_for_the_answer_and_carries_the_folder() {
        let h = hub();
        confirm_handler(&h);
        let (task, client) = send(&h, json!({"sb_kind":"mcp","tool":"start","args":{}})).await;
        let a = wait_for_action(&h).await;
        assert_eq!(a.title, "Do it");
        assert!(a.deadline > now_ms());
        assert!(h.store.lock().unwrap().snapshot().is_empty(), "an action has no session");
        h.ack(&a.request_id);
        h.answer(&a.request_id, &json!({"allow": true, "folder": "/p/x"})).unwrap();
        let lines = read_lines(client).await;
        assert_eq!(serde_json::from_str::<Value>(&lines[0]).unwrap(), json!({"ok": true, "text": "done", "folder": "/p/x"}));
        task.await.unwrap();
        assert!(h.actions().is_empty());
        assert!(h.answer(&a.request_id, &json!({"allow": true})).is_err());
    }

    #[tokio::test]
    async fn denying_and_invalid_answers() {
        let h = hub();
        confirm_handler(&h);
        let (task, client) = send(&h, json!({"sb_kind":"mcp","tool":"start","args":{}})).await;
        let a = wait_for_action(&h).await;
        assert!(h.answer(&a.request_id, &json!({"allow": "yes"})).is_err());
        h.answer(&a.request_id, &json!({"allow": false})).unwrap();
        assert_eq!(read_lines(client).await, vec![r#"{"ok":false,"text":"denied by the user"}"#.to_string()]);
        task.await.unwrap();
    }

    #[tokio::test]
    async fn an_unanswered_action_times_out_as_denied() {
        let h = Hub::with_timeouts(|_| {}, Duration::from_millis(50), Duration::from_millis(100), Duration::from_millis(100));
        confirm_handler(&h);
        let (task, client) = send(&h, json!({"sb_kind":"mcp","tool":"start","args":{}})).await;
        assert_eq!(read_lines(client).await, vec![r#"{"ok":false,"text":"denied by the user"}"#.to_string()]);
        task.await.unwrap();
        assert!(h.actions().is_empty());
    }

    #[tokio::test]
    async fn a_closed_connection_withdraws_the_card() {
        let h = hub();
        confirm_handler(&h);
        let (task, client) = send(&h, json!({"sb_kind":"mcp","tool":"start","args":{}})).await;
        let _ = wait_for_action(&h).await;
        drop(client);
        tokio::time::timeout(Duration::from_millis(300), task).await.expect("served ends promptly").unwrap();
        assert!(h.actions().is_empty());
        assert!(h.pending.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn tool_calls_without_a_handler_just_close() {
        let h = hub();
        let (task, client) = send(&h, json!({"sb_kind":"mcp","tool":"list","args":{}})).await;
        task.await.unwrap();
        assert!(read_lines(client).await.is_empty());
    }

    #[tokio::test]
    async fn notify_is_called_with_cues() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let h = Hub::with_timeouts(move |c| sink.lock().unwrap().extend(c), Duration::from_millis(50), Duration::from_millis(50), Duration::from_millis(50));
        let (task, _c) = send(&h, json!({"sb_kind":"hook","hook_event_name":"SessionStart","session_id":"s1"})).await;
        task.await.unwrap();
        assert_eq!(seen.lock().unwrap().len(), 1);
    }

    fn tool_event(event: &str) -> Value {
        json!({"sb_kind":"hook","sb_wait":"message","hook_event_name":event,"session_id":"s1","cwd":"/p/x","tool_name":"Bash","tool_input":{"command":"ls"}})
    }

    async fn live_session(h: &Arc<Hub>) {
        let (task, _c) = send(h, json!({"sb_kind":"hook","sb_wait":null,"hook_event_name":"SessionStart","session_id":"s1","cwd":"/p/x"})).await;
        task.await.unwrap();
    }

    #[tokio::test]
    async fn a_message_wait_answers_at_once_with_nothing() {
        let h = hub();
        live_session(&h).await;
        let (task, client) = send(&h, tool_event("PreToolUse")).await;
        let lines = tokio::time::timeout(Duration::from_millis(300), read_lines(client)).await.expect("answers immediately");
        assert_eq!(lines, vec![r#"{"messages":[]}"#.to_string()]);
        task.await.unwrap();
        assert!(h.pending.lock().unwrap().is_empty(), "no pending interaction");
        assert!(h.store.lock().unwrap().get("s1").unwrap().pending.is_empty());
    }

    #[tokio::test]
    async fn a_queued_message_is_answered_once() {
        let h = hub();
        live_session(&h).await;
        h.store.lock().unwrap().queue_message("s1", "use tabs", now_ms()).unwrap();
        let (t1, c1) = send(&h, tool_event("PreToolUse")).await;
        let (t2, c2) = send(&h, tool_event("PostToolUse")).await;
        let mut got = read_lines(c1).await;
        got.extend(read_lines(c2).await);
        t1.await.unwrap();
        t2.await.unwrap();
        got.sort();
        assert_eq!(got, vec![r#"{"messages":["use tabs"]}"#.to_string(), r#"{"messages":[]}"#.to_string()]);
    }

    #[tokio::test]
    async fn a_message_whose_answer_cannot_be_written_goes_back_to_the_queue() {
        let h = hub();
        live_session(&h).await;
        h.store.lock().unwrap().queue_message("s1", "hello", now_ms()).unwrap();
        let (client, server) = duplex(1 << 16);
        let mut client = client;
        client.write_all(format!("{}\n", tool_event("PreToolUse")).as_bytes()).await.unwrap();
        drop(client);
        h.clone().serve(server).await;
        let st = h.store.lock().unwrap();
        let m = &st.get("s1").unwrap().messages.0[0];
        assert_eq!(m.state, crate::messages::MessageState::Queued);
    }

    #[tokio::test]
    async fn a_stop_message_wait_without_a_message_still_finishes_the_turn() {
        let h = hub();
        live_session(&h).await;
        let stop = json!({"sb_kind":"hook","sb_wait":"message","hook_event_name":"Stop","session_id":"s1","last_assistant_message":"Done."});
        let (task, client) = send(&h, stop).await;
        assert_eq!(read_lines(client).await, vec![r#"{"messages":[]}"#.to_string()]);
        task.await.unwrap();
        assert_eq!(h.store.lock().unwrap().get("s1").unwrap().status, crate::store::Status::Finished);
    }
}
