//! Talking to the app. Every failure means "nobody is listening": return None
//! quickly and let Claude Code carry on.

use std::io::{Read, Write};
use std::time::{Duration, Instant};

const CONNECT_TIMEOUT: Duration = Duration::from_millis(100);

pub trait Conn: Read + Write {}
impl<T: Read + Write> Conn for T {}

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

/// Sends one line. When `wait` is set, reads one answer line back.
pub fn send(line: &str, wait: bool) -> Option<String> {
    let mut conn = connect()?;
    conn.write_all(line.as_bytes()).ok()?;
    let _ = conn.flush();
    if !wait {
        return None;
    }
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        match conn.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.contains(&b'\n') {
                    break;
                }
            }
        }
    }
    let answer = String::from_utf8_lossy(&buf).trim().to_string();
    (!answer.is_empty()).then_some(answer)
}
