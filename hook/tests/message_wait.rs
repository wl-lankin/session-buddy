//! The relay against a missing, silent and answering app, run as the real binary with a private HOME.

use std::io::Write;
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

const EVENT: &str = r#"{"hook_event_name":"PreToolUse","session_id":"s1","tool_name":"Bash","tool_input":{"command":"ls"}}"#;

fn run_relay(event: &str, payload: &str) -> (Output, Duration) {
    let started = Instant::now();
    let mut child = Command::new(env!("CARGO_BIN_EXE_sb-relay"))
        .args(["hook", event])
        .env_remove("SB_CHAT")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(payload.as_bytes()).unwrap();
    let out = child.wait_with_output().unwrap();
    (out, started.elapsed())
}

#[cfg(unix)]
fn serve(reply: Option<&'static str>) -> std::thread::JoinHandle<()> {
    use std::io::{BufRead, BufReader};
    let path = sb_common::socket_path();
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let _ = std::fs::remove_file(&path);
    let listener = std::os::unix::net::UnixListener::bind(&path).unwrap();
    std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut line = String::new();
        BufReader::new(&stream).read_line(&mut line).unwrap();
        assert!(line.contains(r#""sb_wait":"message""#), "{line}");
        match reply {
            Some(text) => {
                let mut stream = &stream;
                stream.write_all(format!("{text}\n").as_bytes()).unwrap();
            }
            None => std::thread::sleep(Duration::from_millis(1500)),
        }
    })
}

// One test: it points HOME at a private folder, which the whole process shares.
#[test]
fn the_relay_never_holds_claude_code_up() {
    // Short on purpose: a Unix socket path is limited to about 100 bytes.
    let base = if cfg!(unix) { std::path::PathBuf::from("/tmp") } else { std::env::temp_dir() };
    let home = base.join(format!("sbr-{}", std::process::id()));
    std::fs::create_dir_all(&home).unwrap();
    std::env::set_var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }, &home);
    std::env::remove_var("XDG_CONFIG_HOME");

    let (out, took) = run_relay("PreToolUse", EVENT);
    assert!(out.status.success());
    assert!(out.stdout.is_empty(), "app absent: prints nothing");
    assert!(took < Duration::from_millis(900), "app absent took {took:?}");

    #[cfg(unix)]
    {
        let app = serve(None);
        let (out, took) = run_relay("PreToolUse", EVENT);
        assert!(out.status.success());
        assert!(out.stdout.is_empty(), "silent app: prints nothing");
        assert!(took < Duration::from_millis(900), "silent app took {took:?}");
        app.join().unwrap();

        let app = serve(Some(r#"{"messages":[]}"#));
        let (out, _) = run_relay("PostToolUse", EVENT);
        assert!(out.status.success() && out.stdout.is_empty(), "nothing queued: prints nothing");
        app.join().unwrap();

        let app = serve(Some(r#"{"messages":["the secret word is pineapple"]}"#));
        let (out, _) = run_relay("PreToolUse", EVENT);
        let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
        assert_eq!(v["hookSpecificOutput"]["hookEventName"], "PreToolUse");
        assert!(v["hookSpecificOutput"]["additionalContext"].as_str().unwrap().ends_with("the secret word is pineapple"));
        app.join().unwrap();

        let app = serve(Some(r#"{"messages":["wrap up"]}"#));
        let (out, _) = run_relay("Stop", r#"{"hook_event_name":"Stop","session_id":"s1","last_assistant_message":"Done."}"#);
        let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
        assert_eq!(v["decision"], "block");
        app.join().unwrap();
    }
    let _ = std::fs::remove_dir_all(&home);
}
