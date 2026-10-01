//! After a start-up, sessions that sit idle send no event, so the island only
//! knows them from their transcripts ("recent"). Matching the running Claude
//! Code processes to those transcripts by working directory makes them live.
//! Pure: the app lists the processes, this decides who is who.

/// One process as the app found it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawProcess {
    pub pid: u32,
    pub parent_pid: u32,
    /// The executable's file name or path.
    pub exe: String,
    /// None when the command line could not be read.
    pub command_line: Option<String>,
    /// None when the working directory could not be read.
    pub cwd: Option<String>,
}

/// A running Claude Code process and the directory it runs in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaudeProcess {
    pub pid: u32,
    pub cwd: String,
}

/// A seeded session that has not been matched yet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub id: String,
    pub first_cwd: Option<String>,
    pub cwd: String,
    /// When its transcript was last written.
    pub modified_ms: i64,
}

fn stem(exe: &str) -> &str {
    let name = exe.rsplit(['/', '\\']).next().unwrap_or(exe);
    match name.rsplit_once('.') {
        Some((stem, _)) if !stem.is_empty() => stem,
        _ => name,
    }
}

/// claude itself, or node running Claude Code (its command line names claude).
pub fn is_claude_process(exe: &str, command_line: Option<&str>) -> bool {
    // The Claude desktop app is also "claude": its Windows (Squirrel or Store) and macOS bundle paths give it away.
    let lower = exe.to_ascii_lowercase();
    if ["anthropicclaude", "windowsapps", ".app/contents/macos"].iter().any(|m| lower.contains(m)) {
        return false;
    }
    let stem = stem(exe);
    if stem.eq_ignore_ascii_case("claude") {
        return true;
    }
    stem.eq_ignore_ascii_case("node") && command_line.is_some_and(|c| c.to_ascii_lowercase().contains("claude"))
}

/// The Claude Code processes in `all` that have a readable working directory.
/// Children of a Claude Code process (MCP servers, tools) are never a session of their own.
pub fn claude_processes(all: &[RawProcess]) -> Vec<ClaudeProcess> {
    let claude: Vec<&RawProcess> = all.iter().filter(|p| is_claude_process(&p.exe, p.command_line.as_deref())).collect();
    let is_claude_pid = |pid: u32| claude.iter().any(|p| p.pid == pid);
    claude
        .iter()
        .filter(|p| p.parent_pid == p.pid || !is_claude_pid(p.parent_pid))
        .filter_map(|p| p.cwd.as_ref().filter(|c| !c.is_empty()).map(|cwd| ClaudeProcess { pid: p.pid, cwd: cwd.clone() }))
        .collect()
}

/// Same directory, ignoring trailing separators; on Windows also case and slash direction.
pub fn same_dir(a: &str, b: &str, windows: bool) -> bool {
    let norm = |p: &str| {
        let p = if windows { p.replace('/', "\\") } else { p.to_string() };
        let sep = if windows { '\\' } else { '/' };
        let trimmed = p.trim_end_matches(sep);
        let p = if trimmed.is_empty() || trimmed.ends_with(':') { p } else { trimmed.to_string() };
        if windows { p.to_lowercase() } else { p }
    };
    !a.is_empty() && !b.is_empty() && norm(a) == norm(b)
}

/// (session id, pid) pairs. A process takes the seeded session whose first cwd
/// or cwd is its working directory; when several match, the one with the newest
/// transcript. Each session and each process is used at most once.
pub fn match_processes(candidates: &[Candidate], procs: &[ClaudeProcess], windows: bool) -> Vec<(String, u32)> {
    let mut taken: Vec<&str> = Vec::new();
    let mut out = Vec::new();
    for p in procs {
        let best = candidates
            .iter()
            .filter(|c| !taken.contains(&c.id.as_str()))
            .filter(|c| c.first_cwd.as_deref().is_some_and(|f| same_dir(f, &p.cwd, windows)) || same_dir(&c.cwd, &p.cwd, windows))
            .max_by(|a, b| a.modified_ms.cmp(&b.modified_ms).then_with(|| b.id.cmp(&a.id)));
        if let Some(c) = best {
            taken.push(&c.id);
            out.push((c.id.clone(), p.pid));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(pid: u32, parent_pid: u32, exe: &str, cmd: Option<&str>, cwd: Option<&str>) -> RawProcess {
        RawProcess { pid, parent_pid, exe: exe.into(), command_line: cmd.map(Into::into), cwd: cwd.map(Into::into) }
    }

    fn cand(id: &str, first: Option<&str>, cwd: &str, modified_ms: i64) -> Candidate {
        Candidate { id: id.into(), first_cwd: first.map(Into::into), cwd: cwd.into(), modified_ms }
    }

    fn proc_(pid: u32, cwd: &str) -> ClaudeProcess {
        ClaudeProcess { pid, cwd: cwd.into() }
    }

    #[test]
    fn recognises_claude_and_node_running_claude() {
        assert!(is_claude_process(r"C:\Users\a\.local\bin\claude.exe", None));
        assert!(is_claude_process("claude", Some("claude --resume")));
        assert!(is_claude_process("node.exe", Some(r"node C:\npm\node_modules\@anthropic-ai\claude-code\cli.js")));
        assert!(is_claude_process("/usr/local/bin/node", Some("node /usr/local/bin/Claude")));
        assert!(!is_claude_process("node.exe", Some("node vite.js")));
        assert!(!is_claude_process("node.exe", None), "an unreadable command line is not proof");
        assert!(!is_claude_process("claude-helper.exe", None));
        assert!(!is_claude_process("bash.exe", Some("bash -c claude")));
    }

    #[test]
    fn the_claude_desktop_app_is_not_claude_code() {
        assert!(!is_claude_process(r"C:\Users\a\AppData\Local\AnthropicClaude\app-1.2.3\claude.exe", None));
        assert!(!is_claude_process(r"C:\Program Files\WindowsApps\Claude_1.2.3.0_x64__abc\app\Claude.exe", None));
        assert!(!is_claude_process("/Applications/Claude.app/Contents/MacOS/Claude", None));
        assert!(is_claude_process("/Users/a/.local/bin/claude", None), "the CLI still counts");
    }

    #[test]
    fn lists_sessions_not_their_children_or_unreadable_ones() {
        let all = [
            raw(10, 1, "claude.exe", None, Some(r"C:\Projects\pushdocs\")),
            // An MCP server started by Claude Code: a node process naming .claude, child of pid 10.
            raw(11, 10, "node.exe", Some(r"node C:\Users\a\.claude\plugins\x\server.js"), Some(r"C:\Projects\pushdocs\")),
            raw(20, 2, "node.exe", Some("node claude-code/cli.js"), Some("/p/fetchdocs")),
            raw(30, 3, "claude.exe", None, None),
            raw(40, 4, "node.exe", Some("node vite.js"), Some("/p/web")),
        ];
        assert_eq!(claude_processes(&all), vec![proc_(10, r"C:\Projects\pushdocs\"), proc_(20, "/p/fetchdocs")]);
    }

    #[test]
    fn same_dir_rules() {
        assert!(same_dir(r"C:\Projects\pushdocs\", r"c:\projects\PUSHDOCS", true));
        assert!(same_dir("C:/Projects/pushdocs", r"C:\Projects\pushdocs", true));
        assert!(same_dir(r"C:\", r"c:\", true));
        assert!(!same_dir(r"C:\Projects\push", r"C:\Projects\pushdocs", true));
        assert!(same_dir("/p/x/", "/p/x", false));
        assert!(!same_dir("/p/X", "/p/x", false), "case matters off Windows");
        assert!(same_dir("/", "/", false));
        assert!(!same_dir("", "", true));
    }

    #[test]
    fn one_match_by_first_cwd_or_cwd() {
        let c = [cand("a", Some(r"C:\Projects\pushdocs"), r"C:\Projects\pushdocs\api", 1), cand("b", None, r"C:\Projects\fetchdocs", 1)];
        let procs = [proc_(10, r"C:\Projects\pushdocs\"), proc_(20, r"c:\projects\fetchdocs"), proc_(30, r"C:\Elsewhere")];
        assert_eq!(match_processes(&c, &procs, true), vec![("a".to_string(), 10), ("b".to_string(), 20)]);
    }

    #[test]
    fn several_in_one_directory_newest_transcript_wins_and_each_is_used_once() {
        let c = [cand("old", Some("/p/x"), "/p/x", 100), cand("new", Some("/p/x"), "/p/x", 300), cand("mid", Some("/p/x"), "/p/x", 200)];
        assert_eq!(match_processes(&c, &[proc_(1, "/p/x")], false), vec![("new".to_string(), 1)]);
        // Two processes in the same directory take the two newest sessions.
        assert_eq!(match_processes(&c, &[proc_(1, "/p/x"), proc_(2, "/p/x")], false), vec![("new".to_string(), 1), ("mid".to_string(), 2)]);
    }

    #[test]
    fn no_match_no_pairs() {
        assert!(match_processes(&[cand("a", Some("/p/a"), "/p/a", 1)], &[proc_(1, "/p/b")], false).is_empty());
        assert!(match_processes(&[], &[proc_(1, "/p/b")], false).is_empty());
        assert!(match_processes(&[cand("a", Some("/p/a"), "/p/a", 1)], &[], false).is_empty());
    }
}
