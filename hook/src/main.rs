//! sb-relay: called by Claude Code for every hook event (`sb-relay hook <Event>`)
//! and as the status line (`sb-relay statusline [--quiet]`). It forwards the
//! JSON to session-buddy and, for the three blocking cases, prints the human's
//! answer. If the app is closed, slow or crashed, it prints nothing and exits:
//! Claude Code is never blocked.

mod output;
mod prepare;
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

fn hook(arg_event: &str) {
    let raw = read_stdin();
    let cwd = std::env::current_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
    let term = std::env::var("TERM_PROGRAM").unwrap_or_default();
    let Some(p) = prepare::prepare(&raw, arg_event, &cwd, &term) else { return };
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
/// pipe), then forwards the JSON to the app.
fn statusline(quiet: bool) {
    let raw = read_stdin();
    if !quiet {
        let mut stdout = std::io::stdout();
        let _ = stdout.write_all(&raw);
        let _ = stdout.flush();
    }
    let bytes = raw.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&raw);
    let Ok(mut value) = serde_json::from_slice::<serde_json::Value>(bytes) else { return };
    let Some(map) = value.as_object_mut() else { return };
    map.insert("sb_kind".into(), serde_json::Value::String("statusline".into()));
    let mut line = value.to_string();
    line.push('\n');
    let _ = send_within(line, false, STATUSLINE_BUDGET);
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("hook") => hook(args.get(2).map(String::as_str).unwrap_or("")),
        Some("statusline") => statusline(args.iter().any(|a| a == "--quiet")),
        _ => {}
    }
    std::process::exit(0);
}
