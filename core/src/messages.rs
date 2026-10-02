//! Messages the user queued for a running session. They live in memory only and reach the session
//! through the hooks (see the relay): never written to disk.

use serde::{Serialize, Serializer};
use std::collections::VecDeque;

pub const MAX_QUEUED: usize = 5;
pub const MAX_TEXT: usize = 4000;
/// How many messages the snapshot shows per session.
pub const SHOWN: usize = 5;
/// How many finished messages a session keeps besides the queued ones.
const KEPT: usize = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageState {
    Queued,
    Delivered,
    Cancelled,
    Expired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum Via {
    #[serde(rename = "mid-turn")]
    MidTurn,
    #[serde(rename = "stop")]
    Stop,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub text: String,
    pub state: MessageState,
    pub queued_at: i64,
    pub delivered_at: Option<i64>,
    pub via: Option<Via>,
}

/// The text as it is queued: control characters except newlines removed, trimmed, 1 to `MAX_TEXT` characters.
pub fn clean(text: &str) -> Result<String, String> {
    let text: String = text.replace("\r\n", "\n").chars().filter(|c| !c.is_control() || *c == '\n').collect();
    let text = text.trim();
    if text.is_empty() {
        return Err("The message is empty.".into());
    }
    if text.chars().count() > MAX_TEXT {
        return Err(format!("The message is longer than {MAX_TEXT} characters."));
    }
    Ok(text.to_string())
}

pub fn serialize_shown<S: Serializer>(queue: &Queue, s: S) -> Result<S::Ok, S::Error> {
    let list = &queue.0;
    s.collect_seq(list.iter().skip(list.len().saturating_sub(SHOWN)))
}

/// Per-session queue plus the recent history.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Queue(pub VecDeque<Message>);

impl Queue {
    pub fn queued(&self) -> usize {
        self.0.iter().filter(|m| m.state == MessageState::Queued).count()
    }

    pub fn push(&mut self, message: Message) -> Result<(), String> {
        if self.queued() >= MAX_QUEUED {
            return Err(format!("{MAX_QUEUED} messages are already waiting for this session. Cancel one or wait for delivery."));
        }
        self.0.push_back(message);
        while self.0.len() > MAX_QUEUED + KEPT {
            match self.0.iter().position(|m| m.state != MessageState::Queued) {
                Some(i) => self.0.remove(i),
                None => break,
            };
        }
        Ok(())
    }

    pub fn cancel(&mut self, id: &str) -> Result<(), String> {
        let m = self.0.iter_mut().find(|m| m.id == id).ok_or("That message does not exist.")?;
        if m.state != MessageState::Queued {
            return Err("That message is no longer waiting.".into());
        }
        m.state = MessageState::Cancelled;
        Ok(())
    }

    /// Marks every queued message delivered and returns (id, text), oldest first. Calling it again returns nothing.
    pub fn take(&mut self, via: Via, now: i64) -> Vec<(String, String)> {
        let mut out = Vec::new();
        for m in self.0.iter_mut().filter(|m| m.state == MessageState::Queued) {
            m.state = MessageState::Delivered;
            m.delivered_at = Some(now);
            m.via = Some(via);
            out.push((m.id.clone(), m.text.clone()));
        }
        out
    }

    /// Undoes `take` for messages whose answer never left the app.
    pub fn restore(&mut self, ids: &[String]) {
        for m in self.0.iter_mut().filter(|m| ids.contains(&m.id) && m.state == MessageState::Delivered) {
            m.state = MessageState::Queued;
            m.delivered_at = None;
            m.via = None;
        }
    }

    /// The session ended: whatever still waits will never be delivered.
    pub fn expire(&mut self) {
        for m in self.0.iter_mut().filter(|m| m.state == MessageState::Queued) {
            m.state = MessageState::Expired;
        }
    }
}
