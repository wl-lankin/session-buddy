//! Running the `claude` CLI headless (stream-json over stdin/stdout): binary lookup and spawn, shared by the chat and the workers.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// The flags every headless session starts with; callers add the model and the rest.
pub const STREAM_ARGS: [&str; 7] = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages"];

fn candidates(home: &Path) -> Vec<PathBuf> {
    if cfg!(windows) {
        let mut v = vec![home.join(".local").join("bin").join("claude.exe"), home.join(".claude").join("local").join("claude.exe")];
        v.push(home.join("AppData").join("Roaming").join("npm").join("claude.cmd"));
        v
    } else {
        vec![
            home.join(".local/bin/claude"),
            PathBuf::from("/opt/homebrew/bin/claude"),
            PathBuf::from("/usr/local/bin/claude"),
            home.join(".claude/local/claude"),
            home.join(".npm-global/bin/claude"),
        ]
    }
}

/// The setting first, then the known locations, then whatever a login shell finds.
fn resolve_with(setting: &str, home: &Path, exists: impl Fn(&Path) -> bool, login: impl FnOnce() -> Option<PathBuf>) -> Option<PathBuf> {
    let setting = setting.trim();
    if !setting.is_empty() {
        let p = PathBuf::from(setting);
        if exists(&p) {
            return Some(p);
        }
    }
    candidates(home).into_iter().find(|p| exists(p)).or_else(login)
}

static LOGIN_HIT: Mutex<Option<(Instant, Option<PathBuf>)>> = Mutex::new(None);

/// A GUI app has a short PATH: ask a login shell. A miss is remembered for a minute so status polls stay cheap.
fn login_lookup() -> Option<PathBuf> {
    let mut cache = LOGIN_HIT.lock().unwrap();
    if let Some((at, hit)) = cache.as_ref() {
        if hit.is_some() || at.elapsed() < Duration::from_secs(60) {
            return hit.clone();
        }
    }
    let hit = run_login_lookup();
    *cache = Some((Instant::now(), hit.clone()));
    hit
}

fn run_login_lookup() -> Option<PathBuf> {
    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("where");
        c.arg("claude");
        c
    } else {
        let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/zsh".into());
        let mut c = Command::new(shell);
        c.args(["-l", "-c", "command -v claude"]);
        c
    };
    no_window(&mut cmd);
    let out = cmd.stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    text.lines().map(str::trim).filter(|l| !l.is_empty()).map(PathBuf::from).find(|p| p.is_absolute() && p.is_file())
}

pub fn resolve(setting: &str) -> Option<PathBuf> {
    resolve_with(setting, &sb_common::home(), |p| p.is_file(), login_lookup)
}

#[cfg(windows)]
pub fn no_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000);
}

#[cfg(not(windows))]
pub fn no_window(_cmd: &mut Command) {}

pub struct Spawned {
    pub child: Child,
    pub stdin: ChildStdin,
    pub stdout: ChildStdout,
    /// The last non-empty stderr line, for a message when the process dies.
    pub last_err: Arc<Mutex<String>>,
}

/// Starts the CLI in `cwd` with piped stdio and drains its stderr. `SB_CHAT` is never inherited:
/// only the chat sets it (through `env`), so a worker's hooks reach the island.
pub fn spawn(bin: &Path, args: &[String], env: &[(String, String)], cwd: &Path) -> Result<Spawned, String> {
    let mut cmd = Command::new(bin);
    cmd.args(args).env_remove("SB_CHAT").envs(env.iter().map(|(k, v)| (k, v))).current_dir(cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    no_window(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("Could not start claude: {e}"))?;
    let (Some(stdin), Some(stdout), Some(stderr)) = (child.stdin.take(), child.stdout.take(), child.stderr.take()) else {
        let _ = child.kill();
        return Err("Could not connect to claude".into());
    };
    let last_err = Arc::new(Mutex::new(String::new()));
    let sink = last_err.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if !line.trim().is_empty() {
                *sink.lock().unwrap() = line.chars().take(200).collect();
            }
        }
    });
    Ok(Spawned { child, stdin, stdout, last_err })
}

pub fn write_line(stdin: &mut ChildStdin, line: &Value) -> std::io::Result<()> {
    writeln!(stdin, "{line}").and_then(|_| stdin.flush())
}

pub fn user_line(text: &str) -> Value {
    json!({"type": "user", "message": {"role": "user", "content": text}})
}

/// Ends the running turn and keeps the conversation.
pub fn interrupt_line(request_id: &str) -> Value {
    json!({"type": "control_request", "request_id": request_id, "request": {"subtype": "interrupt"}})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binary_lookup_order() {
        let home = Path::new("/h");
        let known = candidates(home);
        let custom = if cfg!(windows) { "C:\\x\\claude.exe" } else { "/x/claude" };
        let all = |_: &Path| true;
        assert_eq!(resolve_with(custom, home, all, || None), Some(PathBuf::from(custom)));
        assert_eq!(resolve_with("", home, all, || None), Some(known[0].clone()));
        let only_second = |p: &Path| p == known[1];
        assert_eq!(resolve_with(custom, home, only_second, || None), Some(known[1].clone()));
        let none = |_: &Path| false;
        assert_eq!(resolve_with(custom, home, none, || Some(PathBuf::from("/login/claude"))), Some(PathBuf::from("/login/claude")));
        assert_eq!(resolve_with("", home, none, || None), None);
    }
}
