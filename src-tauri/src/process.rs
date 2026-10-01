//! Whether a Claude Code process is still running.

/// Windows: a process we cannot open for lack of rights still exists; any other
/// failure (no such pid, ...) means it is gone.
#[cfg(windows)]
pub fn pid_alive(pid: u32) -> bool {
    use windows::Win32::Foundation::{CloseHandle, ERROR_ACCESS_DENIED};
    use windows::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    const STILL_ACTIVE: u32 = 259;

    // SAFETY: the handle is closed before returning.
    unsafe {
        let process = match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
            Ok(h) => h,
            Err(err) => return err.code() == ERROR_ACCESS_DENIED.to_hresult(),
        };
        let mut code = 0u32;
        // An exit code we cannot read is no proof the process ended.
        let alive = GetExitCodeProcess(process, &mut code).is_err() || code == STILL_ACTIVE;
        let _ = CloseHandle(process);
        alive
    }
}

/// Unix: signal 0 only checks; EPERM means the process exists but is not ours.
#[cfg(unix)]
pub fn pid_alive(pid: u32) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else { return false };
    if pid <= 0 {
        return false;
    }
    // SAFETY: signal 0 delivers nothing.
    if unsafe { libc::kill(pid, 0) } == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn this_process_is_alive() {
        assert!(pid_alive(std::process::id()));
    }

    #[test]
    fn an_exited_child_is_dead() {
        #[cfg(windows)]
        let mut cmd = std::process::Command::new("cmd");
        #[cfg(windows)]
        cmd.args(["/C", "exit 0"]);
        #[cfg(unix)]
        let mut cmd = std::process::Command::new("true");
        let mut child = cmd.spawn().expect("spawn");
        let pid = child.id();
        child.wait().expect("wait");
        drop(child);
        assert!(!pid_alive(pid));
    }
}
