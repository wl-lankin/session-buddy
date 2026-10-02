//! sb-relay: called by Claude Code for every hook event (`sb-relay hook <Event>`),
//! as the status line (`sb-relay statusline [--quiet]`) and as the chat's MCP server (`sb-relay mcp`). It forwards the
//! JSON to session-buddy and, for the three blocking cases, prints the human's
//! answer. If the app is closed, slow or crashed, it prints nothing and exits:
//! Claude Code is never blocked.

mod mcp;
mod output;
mod prepare;
mod process;
mod transport;
#[cfg(windows)]
mod win;

use std::io::{Read, Write};
use std::sync::mpsc;
use std::time::Duration;

const FIRE_AND_FORGET_BUDGET: Duration = Duration::from_secs(2);
const STATUSLINE_BUDGET: Duration = Duration::from_millis(300);

fn read_stdin() -> Vec<u8> {
    let mut raw = Vec::new();
    let _ = std::io::stdin().read_to_end(&mut raw);
    raw
}

/// Runs `send` on a worker thread and gives up after `budget`.
fn send_within(line: String, wait: bool, budget: Duration) -> Option<String> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(transport::send(&line, wait));
    });
    rx.recv_timeout(budget).ok().flatten()
}

/// The chat's own headless Claude Code sets SB_CHAT: its hooks must not make it a session in the island.
fn muted(var: Option<std::ffi::OsString>) -> bool {
    var.is_some_and(|v| !v.is_empty())
}

fn hook(arg_event: &str) {
    if muted(std::env::var_os("SB_CHAT")) {
        return;
    }
    let raw = read_stdin();
    let cwd = std::env::current_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
    let term = std::env::var("TERM_PROGRAM").unwrap_or_default();
    let Some(p) = prepare::prepare(&raw, arg_event, &cwd, &term, process::claude_pid) else { return };
    let budget = p.wait.map(|k| k.budget()).unwrap_or(FIRE_AND_FORGET_BUDGET);
    let answer = send_within(p.line.clone(), p.wait.is_some(), budget);
    if let (Some(kind), Some(answer)) = (p.wait, answer) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&answer) {
            if let Some(out) = output::hook_output(kind, &p.original, &value) {
                let mut stdout = std::io::stdout();
                let _ = writeln!(stdout, "{out}");
                let _ = stdout.flush();
            }
        }
    }
}

/// Copies stdin to stdout first (the user's own status line reads it from the
/// pipe), closes stdout so that status line sees EOF at once, then forwards
/// the JSON to the app.
fn statusline(quiet: bool) {
    let raw = read_stdin();
    if !quiet {
        let mut stdout = std::io::stdout().lock();
        let _ = stdout.write_all(&raw);
        let _ = stdout.flush();
        drop(stdout);
        close_stdout();
    }
    let bytes = raw.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&raw);
    let Ok(mut value) = serde_json::from_slice::<serde_json::Value>(bytes) else { return };
    let Some(map) = value.as_object_mut() else { return };
    map.insert("sb_kind".into(), serde_json::Value::String("statusline".into()));
    if let Some(pid) = process::claude_pid() {
        map.insert("sb_claude_pid".into(), serde_json::Value::from(pid));
    }
    let mut line = value.to_string();
    line.push('\n');
    let _ = send_within(line, false, STATUSLINE_BUDGET);
}

/// Closes the process's stdout handle. Nothing is written to stdout afterwards
/// and the buffer is already flushed.
#[cfg(windows)]
fn close_stdout() {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    let handle = std::io::stdout().as_raw_handle();
    if handle.is_null() || handle as isize == -1 {
        return;
    }
    // SAFETY: the standard output handle is owned by this process and never used again.
    drop(unsafe { OwnedHandle::from_raw_handle(handle) });
}

#[cfg(unix)]
fn close_stdout() {
    use std::os::fd::{FromRawFd, OwnedFd};
    // SAFETY: fd 1 is owned by this process and never used again.
    drop(unsafe { OwnedFd::from_raw_fd(1) });
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("hook") => hook(args.get(2).map(String::as_str).unwrap_or("")),
        Some("statusline") => statusline(args.iter().any(|a| a == "--quiet")),
        Some("mcp") => mcp::serve(),
        _ => {}
    }
    std::process::exit(0);
}

#[cfg(test)]
mod tests {
    use super::muted;

    #[test]
    fn sb_chat_mutes_the_hook() {
        assert!(muted(Some("1".into())));
        assert!(!muted(None));
        assert!(!muted(Some("".into())));
    }
}
