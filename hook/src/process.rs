//! Finds the Claude Code process the relay runs under, so the app can drop a
//! session as soon as that process is gone. Cheap and silent: any failure
//! just means no pid.

const MAX_HOPS: usize = 16;

/// True for "claude", "claude.exe", "node", "Node.EXE" and the like.
fn is_claude_exe(exe: &str) -> bool {
    let name = exe.rsplit(['/', '\\']).next().unwrap_or(exe);
    let stem = match name.rsplit_once('.') {
        Some((stem, _)) if !stem.is_empty() => stem,
        _ => name,
    };
    stem.eq_ignore_ascii_case("claude") || stem.eq_ignore_ascii_case("node")
}

/// Walks up from `start_pid` (inclusive) and returns the first process whose
/// executable is claude or node. `lookup` gives (parent pid, executable name).
pub fn find_claude_ancestor(start_pid: u32, lookup: impl Fn(u32) -> Option<(u32, String)>) -> Option<u32> {
    let mut seen: Vec<u32> = Vec::with_capacity(MAX_HOPS);
    let mut pid = start_pid;
    for _ in 0..MAX_HOPS {
        if pid == 0 || seen.contains(&pid) {
            return None;
        }
        seen.push(pid);
        let (ppid, exe) = lookup(pid)?;
        if is_claude_exe(&exe) {
            return Some(pid);
        }
        pid = ppid;
    }
    None
}

/// The pid of the Claude Code process above this relay, if there is one.
///
/// Windows: one cheap lookup per hop (open, ask the kernel for the parent pid
/// and the image name, close) instead of a snapshot of every process. The
/// Toolhelp snapshot is only used when the kernel query does not work at all.
#[cfg(windows)]
pub fn claude_pid() -> Option<u32> {
    match win_walk::parent_of_self() {
        Some(parent) => find_claude_ancestor(parent, win_walk::lookup),
        None => toolhelp_claude_pid(),
    }
}

#[cfg(windows)]
mod win_walk {
    use windows::core::PWSTR;
    use windows::Wdk::System::Threading::{NtQueryInformationProcess, ProcessBasicInformation};
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::Threading::{
        GetCurrentProcess, OpenProcess, QueryFullProcessImageNameW, PROCESS_BASIC_INFORMATION, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };

    /// The parent pid behind a process handle. `process` is borrowed, never closed.
    fn parent_pid(process: HANDLE) -> Option<u32> {
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
        if status.is_err() {
            return None;
        }
        u32::try_from(info.InheritedFromUniqueProcessId).ok()
    }

    /// None when the kernel query fails even for this process: then the caller falls back to Toolhelp.
    pub fn parent_of_self() -> Option<u32> {
        // SAFETY: the pseudo handle of the current process needs no closing.
        parent_pid(unsafe { GetCurrentProcess() })
    }

    /// (parent pid, executable path) of `pid`; None when it cannot be opened or queried.
    pub fn lookup(pid: u32) -> Option<(u32, String)> {
        // SAFETY: the handle is closed on every path below.
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
        let result = parent_pid(process).and_then(|ppid| image_name(process).map(|exe| (ppid, exe)));
        // SAFETY: opened above, closed once.
        let _ = unsafe { CloseHandle(process) };
        result
    }

    fn image_name(process: HANDLE) -> Option<String> {
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        // SAFETY: `len` holds the buffer size in characters; the call writes at most that many.
        unsafe { QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len) }.ok()?;
        Some(String::from_utf16_lossy(&buf[..len as usize]))
    }
}

/// The old way: one snapshot of every process, then walk it. Only a fallback now.
#[cfg(windows)]
fn toolhelp_claude_pid() -> Option<u32> {
    let table = toolhelp_table()?;
    let parent = table.get(&std::process::id())?.0;
    find_claude_ancestor(parent, |pid| table.get(&pid).cloned())
}

/// pid -> (parent pid, executable name) for every process.
#[cfg(windows)]
fn toolhelp_table() -> Option<std::collections::HashMap<u32, (u32, String)>> {
    use std::collections::HashMap;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };

    let mut table: HashMap<u32, (u32, String)> = HashMap::new();
    // SAFETY: the snapshot handle is closed below; the entry is a plain struct with dwSize set.
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).ok()?;
        let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut more = Process32FirstW(snap, &mut entry).is_ok();
        while more {
            let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
            let exe = String::from_utf16_lossy(&entry.szExeFile[..len]);
            table.insert(entry.th32ProcessID, (entry.th32ParentProcessID, exe));
            more = Process32NextW(snap, &mut entry).is_ok();
        }
        let _ = CloseHandle(snap);
    }
    Some(table)
}

/// macOS: the native installer runs a binary named after its version
/// (~/.local/share/claude/versions/2.0.1), so a non-matching short name is
/// checked once more against the full executable path.
#[cfg(target_os = "macos")]
pub fn claude_pid() -> Option<u32> {
    fn exe_path(pid: u32) -> Option<String> {
        let mut buf = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
        // SAFETY: proc_pidpath writes at most `buf.len()` bytes and returns the length written.
        let got = unsafe { libc::proc_pidpath(pid as libc::c_int, buf.as_mut_ptr() as *mut libc::c_void, buf.len() as u32) };
        if got <= 0 {
            return None;
        }
        buf.truncate(got as usize);
        Some(String::from_utf8_lossy(&buf).into_owned())
    }

    fn lookup(pid: u32) -> Option<(u32, String)> {
        // SAFETY: proc_bsdinfo is plain data; proc_pidinfo writes at most `size` bytes into it.
        let (ppid, comm) = unsafe {
            let mut info: libc::proc_bsdinfo = std::mem::zeroed();
            let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
            let got = libc::proc_pidinfo(
                pid as libc::c_int,
                libc::PROC_PIDTBSDINFO,
                0,
                &mut info as *mut libc::proc_bsdinfo as *mut libc::c_void,
                size,
            );
            if got != size {
                return None;
            }
            (info.pbi_ppid, std::ffi::CStr::from_ptr(info.pbi_comm.as_ptr()).to_string_lossy().into_owned())
        };
        Some((ppid, exe_name(&comm, || exe_path(pid))))
    }
    find_claude_ancestor(std::os::unix::process::parent_id(), lookup)
}

/// The name to match for a process: its short name, or "claude" when that does
/// not match but the full path (looked up lazily) has a "/claude" in it.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn exe_name(comm: &str, path: impl FnOnce() -> Option<String>) -> String {
    if is_claude_exe(comm) {
        return comm.to_string();
    }
    match path() {
        Some(p) if p.contains("/claude") => "claude".to_string(),
        _ => comm.to_string(),
    }
}

/// Linux: /proc/<pid>/stat is "pid (comm) state ppid ...", read in-process.
#[cfg(all(unix, not(target_os = "macos")))]
pub fn claude_pid() -> Option<u32> {
    fn lookup(pid: u32) -> Option<(u32, String)> {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        let open = stat.find('(')?;
        let close = stat.rfind(')')?;
        let comm = stat.get(open + 1..close)?.to_string();
        let ppid = stat.get(close + 1..)?.split_whitespace().nth(1)?.parse().ok()?;
        Some((ppid, comm))
    }
    find_claude_ancestor(std::os::unix::process::parent_id(), lookup)
}

#[cfg(not(any(windows, unix)))]
pub fn claude_pid() -> Option<u32> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn tree(rows: &[(u32, u32, &str)]) -> HashMap<u32, (u32, String)> {
        rows.iter().map(|&(pid, ppid, exe)| (pid, (ppid, exe.to_string()))).collect()
    }

    #[test]
    fn finds_native_claude_through_a_shell() {
        let t = tree(&[(30, 20, "bash.exe"), (20, 10, "claude.exe"), (10, 1, "WindowsTerminal.exe")]);
        assert_eq!(find_claude_ancestor(30, |p| t.get(&p).cloned()), Some(20));
    }

    #[test]
    fn finds_node_case_insensitive_and_takes_the_nearest() {
        let t = tree(&[(30, 20, "sh"), (20, 10, "Node.EXE"), (10, 5, "claude")]);
        assert_eq!(find_claude_ancestor(30, |p| t.get(&p).cloned()), Some(20));
        let t = tree(&[(30, 20, "/usr/local/bin/node")]);
        assert_eq!(find_claude_ancestor(30, |p| t.get(&p).cloned()), Some(30));
    }

    #[test]
    fn similar_names_do_not_match() {
        let t = tree(&[(30, 20, "claude-helper.exe"), (20, 10, "nodemon"), (10, 0, "explorer.exe")]);
        assert_eq!(find_claude_ancestor(30, |p| t.get(&p).cloned()), None);
    }

    #[test]
    fn not_found_when_the_chain_ends() {
        let t = tree(&[(30, 20, "bash"), (20, 99, "zsh")]);
        assert_eq!(find_claude_ancestor(30, |p| t.get(&p).cloned()), None);
        assert_eq!(find_claude_ancestor(0, |p| t.get(&p).cloned()), None);
    }

    #[test]
    fn stops_on_a_cycle() {
        let t = tree(&[(30, 20, "bash"), (20, 30, "cmd.exe")]);
        assert_eq!(find_claude_ancestor(30, |p| t.get(&p).cloned()), None);
        let t = tree(&[(7, 7, "bash")]);
        assert_eq!(find_claude_ancestor(7, |p| t.get(&p).cloned()), None);
    }

    #[test]
    fn a_version_named_binary_matches_by_its_path() {
        assert_eq!(exe_name("2.0.1", || Some("/Users/a/.local/share/claude/versions/2.0.1".into())), "claude");
        assert_eq!(exe_name("node", || panic!("the path is only read when the name does not match")), "node");
        assert_eq!(exe_name("zsh", || Some("/bin/zsh".into())), "zsh");
        assert_eq!(exe_name("2.0.1", || None), "2.0.1");
    }

    #[cfg(windows)]
    #[test]
    fn per_hop_lookup_agrees_with_the_snapshot() {
        let table = toolhelp_table().expect("snapshot");
        let me = std::process::id();
        let (ppid, exe) = win_walk::lookup(me).expect("this process can be queried");
        assert_eq!(Some(ppid), win_walk::parent_of_self());
        assert_eq!(ppid, table[&me].0, "same parent as the snapshot");
        let short = exe.rsplit('\\').next().unwrap();
        assert!(short.eq_ignore_ascii_case(&table[&me].1), "{exe} vs {}", table[&me].1);
        assert_eq!(claude_pid(), toolhelp_claude_pid(), "both walks end at the same process");
    }

    #[test]
    fn gives_up_after_sixteen_hops() {
        // 100 -> 99 -> ... ; claude sits 16 hops above the start, one too far.
        let mut rows: Vec<(u32, u32, &str)> = (85..=100).map(|p| (p, p - 1, "bash")).collect();
        rows.push((84, 1, "claude"));
        let t = tree(&rows);
        assert_eq!(find_claude_ancestor(100, |p| t.get(&p).cloned()), None);
        // 15 hops above is still found.
        assert_eq!(find_claude_ancestor(99, |p| t.get(&p).cloned()), Some(84));
    }
}
