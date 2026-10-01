//! Whether a Claude Code process is still running, and which ones run right now.

use sb_core::adopt::RawProcess;

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

/// Windows: every process from one snapshot; for the claude / node ones of this
/// user also the command line and working directory, read from the process
/// environment block. Anything unreadable stays None.
#[cfg(windows)]
pub fn list_processes() -> Vec<RawProcess> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };

    let mut out = Vec::new();
    // SAFETY: the snapshot handle is closed below; the entry is a plain struct with dwSize set.
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return out };
        let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut more = Process32FirstW(snap, &mut entry).is_ok();
        while more {
            let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
            let exe = String::from_utf16_lossy(&entry.szExeFile[..len]);
            out.push(RawProcess { pid: entry.th32ProcessID, parent_pid: entry.th32ParentProcessID, exe, command_line: None, cwd: None });
            more = Process32NextW(snap, &mut entry).is_ok();
        }
        let _ = CloseHandle(snap);
    }
    let me = sb_common::user_key();
    for p in out.iter_mut().filter(|p| win_peb::worth_reading(&p.exe)) {
        if let Some((cmd, cwd)) = win_peb::command_line_and_cwd(p.pid, &me) {
            p.command_line = cmd;
            p.cwd = cwd;
        }
    }
    out
}

#[cfg(windows)]
mod win_peb {
    use windows::core::PWSTR;
    use windows::Wdk::System::Threading::{NtQueryInformationProcess, ProcessBasicInformation};
    use windows::Win32::Foundation::{CloseHandle, HANDLE, HLOCAL, LocalFree};
    use windows::Win32::Security::Authorization::ConvertSidToStringSidW;
    use windows::Win32::Security::{GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER};
    use windows::Win32::System::Diagnostics::Debug::ReadProcessMemory;
    use windows::Win32::System::Threading::{
        IsWow64Process, OpenProcess, OpenProcessToken, PROCESS_BASIC_INFORMATION, PROCESS_QUERY_INFORMATION,
        PROCESS_VM_READ,
    };

    // x64 layout: PEB.ProcessParameters, and in RTL_USER_PROCESS_PARAMETERS the
    // CurrentDirectory.DosPath and CommandLine UNICODE_STRINGs (length u16, buffer pointer at +8).
    const PEB_PARAMS: usize = 0x20;
    const PARAMS_CWD: usize = 0x38;
    const PARAMS_CMDLINE: usize = 0x70;
    const PARAMS_READ: usize = 0x80;

    /// Only claude and node can be Claude Code; nothing else is opened.
    pub fn worth_reading(exe: &str) -> bool {
        sb_core::adopt::is_claude_process(exe, Some("claude"))
    }

    /// (command line, working directory) of a process of the user `me`; None for other users.
    pub fn command_line_and_cwd(pid: u32, me: &str) -> Option<(Option<String>, Option<String>)> {
        // SAFETY: the handle is closed on every path below.
        let process = unsafe { OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid) }.ok()?;
        let result = if user_sid(process).as_deref() == Some(me) { read_params(process) } else { None };
        // SAFETY: opened above, closed once.
        let _ = unsafe { CloseHandle(process) };
        result
    }

    fn read_params(process: HANDLE) -> Option<(Option<String>, Option<String>)> {
        if !cfg!(target_pointer_width = "64") || is_wow64(process) {
            return None;
        }
        let mut info = PROCESS_BASIC_INFORMATION::default();
        let mut len = 0u32;
        // SAFETY: `info` is a plain struct of exactly the size passed in.
        let status = unsafe {
            NtQueryInformationProcess(
                process,
                ProcessBasicInformation,
                &mut info as *mut PROCESS_BASIC_INFORMATION as *mut core::ffi::c_void,
                std::mem::size_of::<PROCESS_BASIC_INFORMATION>() as u32,
                &mut len,
            )
        };
        if status.is_err() || info.PebBaseAddress.is_null() {
            return None;
        }
        let params = usize::from_le_bytes(read_bytes::<8>(process, info.PebBaseAddress as usize + PEB_PARAMS)?);
        if params == 0 {
            return None;
        }
        let block = read_bytes::<PARAMS_READ>(process, params)?;
        Some((unicode_at(process, &block, PARAMS_CMDLINE), unicode_at(process, &block, PARAMS_CWD)))
    }

    fn is_wow64(process: HANDLE) -> bool {
        let mut wow = windows::core::BOOL(0);
        // SAFETY: plain out parameter.
        unsafe { IsWow64Process(process, &mut wow) }.is_err() || wow.as_bool()
    }

    fn read_bytes<const N: usize>(process: HANDLE, addr: usize) -> Option<[u8; N]> {
        let mut buf = [0u8; N];
        let mut got = 0usize;
        // SAFETY: reads at most N bytes into a buffer of N bytes.
        unsafe { ReadProcessMemory(process, addr as *const core::ffi::c_void, buf.as_mut_ptr().cast(), N, Some(&mut got)) }.ok()?;
        (got == N).then_some(buf)
    }

    /// The UNICODE_STRING at `offset` of the parameter block, read from the other process.
    fn unicode_at(process: HANDLE, block: &[u8; PARAMS_READ], offset: usize) -> Option<String> {
        let len = u16::from_le_bytes([block[offset], block[offset + 1]]) as usize;
        let addr = usize::from_le_bytes(block[offset + 8..offset + 16].try_into().ok()?);
        if len == 0 || addr == 0 || !len.is_multiple_of(2) {
            return None;
        }
        let mut buf = vec![0u16; len / 2];
        let mut got = 0usize;
        // SAFETY: reads exactly `len` bytes into a buffer of `len` bytes.
        unsafe { ReadProcessMemory(process, addr as *const core::ffi::c_void, buf.as_mut_ptr().cast(), len, Some(&mut got)) }.ok()?;
        (got == len).then(|| String::from_utf16_lossy(&buf))
    }

    /// The user SID behind a process handle. `process` is borrowed, never closed.
    fn user_sid(process: HANDLE) -> Option<String> {
        // SAFETY: the token is closed on every path; the buffer is sized by the first call.
        unsafe {
            let mut token = HANDLE::default();
            OpenProcessToken(process, TOKEN_QUERY, &mut token).ok()?;
            let mut needed = 0u32;
            let _ = GetTokenInformation(token, TokenUser, None, 0, &mut needed);
            if needed == 0 {
                let _ = CloseHandle(token);
                return None;
            }
            let mut buf = vec![0u8; needed as usize];
            let ok = GetTokenInformation(token, TokenUser, Some(buf.as_mut_ptr().cast()), needed, &mut needed).is_ok();
            let _ = CloseHandle(token);
            if !ok {
                return None;
            }
            let user = &*(buf.as_ptr() as *const TOKEN_USER);
            let mut text = PWSTR::null();
            ConvertSidToStringSidW(user.User.Sid, &mut text).ok()?;
            let sid = text.to_string().ok();
            let _ = LocalFree(Some(HLOCAL(text.0 as *mut _)));
            sid
        }
    }
}

/// macOS: every process of this user that can be Claude Code, with its working
/// directory and, for node, its command line.
#[cfg(target_os = "macos")]
pub fn list_processes() -> Vec<RawProcess> {
    use std::ffi::CStr;

    // SAFETY: a null buffer only asks for the count.
    let count = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
    if count <= 0 {
        return Vec::new();
    }
    let mut pids: Vec<libc::pid_t> = vec![0; count as usize + 64];
    let bytes = (pids.len() * std::mem::size_of::<libc::pid_t>()) as libc::c_int;
    // SAFETY: the buffer holds `bytes` bytes; the call returns how many pids it wrote.
    let got = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), bytes) };
    if got <= 0 {
        return Vec::new();
    }
    pids.truncate((got as usize).min(pids.len()));
    // SAFETY: getuid cannot fail.
    let me = unsafe { libc::getuid() };
    let mut out = Vec::new();
    for pid in pids.into_iter().filter(|&p| p > 0) {
        let Some(info) = mac::bsd_info(pid) else { continue };
        if info.pbi_uid != me {
            continue;
        }
        // SAFETY: pbi_comm is NUL-terminated within its array.
        let comm = unsafe { CStr::from_ptr(info.pbi_comm.as_ptr()) }.to_string_lossy().into_owned();
        // The native installer's binary is named after its version: match it by its path.
        let exe = if sb_core::adopt::is_claude_process(&comm, Some("claude")) {
            comm
        } else {
            match mac::exe_path(pid) {
                Some(path) if path.contains("/claude") => "claude".to_string(),
                _ => continue,
            }
        };
        let is_node = !sb_core::adopt::is_claude_process(&exe, None);
        out.push(RawProcess {
            pid: pid as u32,
            parent_pid: info.pbi_ppid,
            command_line: if is_node { mac::command_line(pid) } else { None },
            cwd: mac::cwd(pid),
            exe,
        });
    }
    out
}

#[cfg(target_os = "macos")]
mod mac {
    use std::ffi::CStr;

    pub fn bsd_info(pid: libc::pid_t) -> Option<libc::proc_bsdinfo> {
        // SAFETY: proc_bsdinfo is plain data; proc_pidinfo writes at most `size` bytes into it.
        unsafe {
            let mut info: libc::proc_bsdinfo = std::mem::zeroed();
            let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
            let n = libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, (&mut info as *mut libc::proc_bsdinfo).cast(), size);
            (n == size).then_some(info)
        }
    }

    pub fn exe_path(pid: libc::pid_t) -> Option<String> {
        let mut buf = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
        // SAFETY: proc_pidpath writes at most `buf.len()` bytes and returns the length written.
        let got = unsafe { libc::proc_pidpath(pid, buf.as_mut_ptr().cast(), buf.len() as u32) };
        if got <= 0 {
            return None;
        }
        buf.truncate(got as usize);
        Some(String::from_utf8_lossy(&buf).into_owned())
    }

    pub fn cwd(pid: libc::pid_t) -> Option<String> {
        // SAFETY: proc_vnodepathinfo is plain data; proc_pidinfo writes at most `size` bytes into it.
        unsafe {
            let mut info: libc::proc_vnodepathinfo = std::mem::zeroed();
            let size = std::mem::size_of::<libc::proc_vnodepathinfo>() as libc::c_int;
            let n = libc::proc_pidinfo(pid, libc::PROC_PIDVNODEPATHINFO, 0, (&mut info as *mut libc::proc_vnodepathinfo).cast(), size);
            if n != size {
                return None;
            }
            let path = CStr::from_ptr(info.pvi_cdir.vip_path.as_ptr().cast()).to_string_lossy().into_owned();
            (!path.is_empty()).then_some(path)
        }
    }

    /// KERN_PROCARGS2: argc, the executable path, NUL padding, then argc NUL-terminated arguments.
    pub fn command_line(pid: libc::pid_t) -> Option<String> {
        let mut mib = [libc::CTL_KERN, libc::KERN_ARGMAX];
        let mut argmax: libc::c_int = 0;
        let mut size = std::mem::size_of::<libc::c_int>();
        // SAFETY: argmax is an int and `size` says so.
        let rc = unsafe { libc::sysctl(mib.as_mut_ptr(), 2, (&mut argmax as *mut libc::c_int).cast(), &mut size, std::ptr::null_mut(), 0) };
        if rc != 0 || argmax <= 0 {
            return None;
        }
        let mut buf = vec![0u8; argmax as usize];
        let mut size = buf.len();
        let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
        // SAFETY: the buffer holds `size` bytes; sysctl updates `size` to what it wrote.
        let rc = unsafe { libc::sysctl(mib.as_mut_ptr(), 3, buf.as_mut_ptr().cast(), &mut size, std::ptr::null_mut(), 0) };
        if rc != 0 || size < 4 {
            return None;
        }
        buf.truncate(size);
        let argc = i32::from_ne_bytes(buf[..4].try_into().ok()?).max(0) as usize;
        let rest = &buf[4..];
        // Skip the executable path and the NUL padding after it.
        let path_end = rest.iter().position(|&b| b == 0)?;
        let args_start = path_end + rest[path_end..].iter().position(|&b| b != 0)?;
        let args: Vec<String> = rest[args_start..]
            .split(|&b| b == 0)
            .take(argc)
            .map(|a| String::from_utf8_lossy(a).into_owned())
            .collect();
        Some(args.join(" "))
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
pub fn list_processes() -> Vec<RawProcess> {
    Vec::new()
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
    #[cfg(windows)]
    #[test]
    fn lists_this_process_and_reads_the_directory_of_a_claude_named_child() {
        assert!(list_processes().iter().any(|p| p.pid == std::process::id()), "the snapshot has this process");
        // A copy of cmd.exe named claude.exe, started in a temp dir, is read like Claude Code.
        let dir = std::env::temp_dir().join(format!("sb-proc-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("claude.exe");
        let system = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        std::fs::copy(std::path::Path::new(&system).join("System32").join("cmd.exe"), &exe).unwrap();
        let mut child = std::process::Command::new(&exe)
            .args(["/C", "ping -n 4 127.0.0.1 >NUL"])
            .current_dir(&dir)
            .spawn()
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(300));
        let found = list_processes().into_iter().find(|p| p.pid == child.id());
        let _ = child.kill();
        let _ = child.wait();
        let _ = std::fs::remove_dir_all(&dir);
        let found = found.expect("the child is listed");
        assert_eq!(found.exe, "claude.exe");
        assert!(found.command_line.as_deref().unwrap_or_default().contains("ping"), "{found:?}");
        let cwd = found.cwd.expect("cwd read from the process parameters");
        assert!(sb_core::adopt::same_dir(&cwd, &dir.to_string_lossy(), true), "{cwd} vs {}", dir.display());
    }
}
