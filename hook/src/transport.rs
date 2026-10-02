//! Talking to the app. Every failure means "nobody is listening": return None
//! quickly and let Claude Code carry on.

use std::io::{BufRead, BufReader, Read, Write};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

const CONNECT_TIMEOUT: Duration = Duration::from_millis(100);

pub trait Conn: Read + Write + Send {}
impl<T: Read + Write + Send> Conn for T {}

#[cfg(windows)]
fn connect() -> Option<Box<dyn Conn>> {
    use std::os::windows::io::AsRawHandle;
    const ERROR_PIPE_BUSY: i32 = 231;
    let path = sb_common::pipe_name(&sb_common::user_key());
    let deadline = Instant::now() + CONNECT_TIMEOUT;
    loop {
        match std::fs::OpenOptions::new().read(true).write(true).open(&path) {
            Ok(file) => {
                let handle = windows::Win32::Foundation::HANDLE(file.as_raw_handle());
                return crate::win::pipe_server_is_same_user(handle).then(|| Box::new(file) as Box<dyn Conn>);
            }
            Err(err) => {
                if err.raw_os_error() != Some(ERROR_PIPE_BUSY) || Instant::now() >= deadline {
                    return None;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    }
}

#[cfg(unix)]
fn connect() -> Option<Box<dyn Conn>> {
    let _ = (Instant::now(), CONNECT_TIMEOUT);
    let stream = std::os::unix::net::UnixStream::connect(sb_common::socket_path()).ok()?;
    Some(Box::new(stream))
}

/// How long the app has to put the card on screen. Without an ack the relay
/// gives up, so a hung app never blocks Claude Code for the long budget.
const ACK_WAIT: Duration = Duration::from_millis(1500);
/// The app's "card is on screen" line (same literal in core/src/hub.rs).
const ACK_LINE: &str = r#"{"sb_ack":true}"#;

/// Sends one line. When `wait` is set, waits for the ack and then one answer line.
/// The overall budget is enforced by the caller.
pub fn send(line: &str, wait: bool) -> Option<String> {
    let mut conn = connect()?;
    conn.write_all(line.as_bytes()).ok()?;
    let _ = conn.flush();
    if !wait {
        return None;
    }
    let lines = spawn_line_reader(conn);
    await_answer(&lines, ACK_WAIT)
}

/// Sends one request line and returns the app's single reply line, whatever it takes up to `budget`.
/// The error text is meant for the model: it says why nothing came back.
pub fn request(line: &str, budget: Duration) -> Result<String, String> {
    let mut conn = connect().ok_or("Session Buddy is not running. Start the app and try again.")?;
    conn.write_all(line.as_bytes()).map_err(|_| "Session Buddy did not accept the request")?;
    let _ = conn.flush();
    let lines = spawn_line_reader(conn);
    let deadline = Instant::now() + budget;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match lines.recv_timeout(left) {
            Ok(l) if l.trim() == ACK_LINE => continue,
            Ok(l) if !l.trim().is_empty() => return Ok(l),
            Ok(_) => continue,
            Err(mpsc::RecvTimeoutError::Timeout) => return Err("Session Buddy did not answer in time".into()),
            Err(mpsc::RecvTimeoutError::Disconnected) => return Err("Session Buddy closed the connection without an answer".into()),
        }
    }
}

/// Reads lines on a worker thread so the ack wait can time out.
fn spawn_line_reader(conn: Box<dyn Conn>) -> Receiver<String> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(conn).lines() {
            let Ok(line) = line else { break };
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    rx
}

/// The first line must arrive within `ack_wait`: either the ack (then the answer
/// follows, however long it takes) or the answer itself (answered before the ack).
/// A closed connection or no first line means "answer in the terminal".
fn await_answer(lines: &Receiver<String>, ack_wait: Duration) -> Option<String> {
    let mut line = lines.recv_timeout(ack_wait).ok()?;
    while line.trim() == ACK_LINE {
        line = lines.recv().ok()?;
    }
    let answer = line.trim().to_string();
    (!answer.is_empty()).then_some(answer)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed(lines: &[&str]) -> Receiver<String> {
        let (tx, rx) = mpsc::channel();
        for l in lines {
            tx.send((*l).to_string()).unwrap();
        }
        rx
    }

    #[test]
    fn ack_then_answer() {
        let rx = feed(&[ACK_LINE, r#"{"behavior":"allow"}"#]);
        assert_eq!(await_answer(&rx, Duration::from_millis(50)).as_deref(), Some(r#"{"behavior":"allow"}"#));
    }

    #[test]
    fn answer_without_ack() {
        let rx = feed(&[r#"{"reply":"yes"}"#]);
        assert_eq!(await_answer(&rx, Duration::from_millis(50)).as_deref(), Some(r#"{"reply":"yes"}"#));
    }

    #[test]
    fn no_ack_gives_up() {
        let (tx, rx) = mpsc::channel::<String>();
        let start = Instant::now();
        assert_eq!(await_answer(&rx, Duration::from_millis(50)), None);
        assert!(start.elapsed() < Duration::from_millis(500));
        drop(tx);
    }

    #[test]
    fn ack_then_answer_after_the_ack_wait() {
        let (tx, rx) = mpsc::channel::<String>();
        tx.send(ACK_LINE.to_string()).unwrap();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(120));
            let _ = tx.send(r#"{"behavior":"deny"}"#.to_string());
        });
        assert_eq!(await_answer(&rx, Duration::from_millis(50)).as_deref(), Some(r#"{"behavior":"deny"}"#));
    }

    #[test]
    fn ack_then_closed_means_terminal() {
        assert_eq!(await_answer(&feed(&[ACK_LINE]), Duration::from_millis(50)), None);
        assert_eq!(await_answer(&feed(&[ACK_LINE, ""]), Duration::from_millis(50)), None);
    }

    #[test]
    fn reads_lines_from_a_stream() {
        let conn: Box<dyn Conn> = Box::new(std::io::Cursor::new(format!("{ACK_LINE}
{{\"behavior\":\"allow\"}}
").into_bytes()));
        let rx = spawn_line_reader(conn);
        assert_eq!(await_answer(&rx, Duration::from_millis(500)).as_deref(), Some(r#"{"behavior":"allow"}"#));
    }
}
