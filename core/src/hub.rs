//! The app side of the relay protocol. One connection = one hook event. For the
//! three blocking kinds the connection stays open until the island answers,
//! the user hands it back to the terminal, the deadline passes or the relay
//! goes away - whichever comes first.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc;

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

pub struct Hub {
    pub store: Mutex<Store>,
    pending: Mutex<HashMap<String, mpsc::Sender<Reply>>>,
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
            counter: AtomicU64::new(1),
            notify: Box::new(notify),
            ack_timeout,
            wait_permission,
            wait_long,
        })
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

        // Claude Code ignores a hook answer for ExitPlanMode, so never hold an old relay that still waits:
        // closing without an ack hands the dialog back to the terminal.
        let plan_mode = payload.get("tool_name").and_then(Value::as_str) == Some("ExitPlanMode");
        let wait = payload.get("sb_wait").and_then(Value::as_str).filter(|_| !plan_mode).map(str::to_string);
        let Some(kind) = wait else {
            let cues = self.store.lock().unwrap().apply_hook(&payload, now_ms());
            (self.notify)(cues);
            return;
        };

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
        if !(behavior_ok || answers_ok || reply_ok) {
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

    #[tokio::test]
    async fn notify_is_called_with_cues() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let h = Hub::with_timeouts(move |c| sink.lock().unwrap().extend(c), Duration::from_millis(50), Duration::from_millis(50), Duration::from_millis(50));
        let (task, _c) = send(&h, json!({"sb_kind":"hook","hook_event_name":"SessionStart","session_id":"s1"})).await;
        task.await.unwrap();
        assert_eq!(seen.lock().unwrap().len(), 1);
    }
}
