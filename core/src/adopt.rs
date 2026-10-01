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
    /// The transcript folder name under ~/.claude/projects: the directory Claude Code started in, encoded.
    pub project_key: Option<String>,
    /// When its transcript was last written.
    pub modified_ms: i64,
}

fn stem(exe: &str) -> &str {
    let name = exe.rsplit(['/', '\\']).next().unwrap_or(exe);
    // A self-update renames the running binary to claude.exe.old.<time>.<pid>; the process keeps that image.
    let name = match name.to_ascii_lowercase().find(".old.") {
        Some(i) if i > 0 => &name[..i],
        _ => name,
    };
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

/// A directory for comparison: no `\\?\` prefix, no trailing separator (a root keeps one);
/// on Windows also backslashes only and lower case.
pub fn normalize_dir(p: &str, windows: bool) -> String {
    let p = if windows {
        let p = p.replace('/', "\\");
        if let Some(rest) = p.strip_prefix(r"\\?\UNC\") {
            format!(r"\\{rest}")
        } else {
            p.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(p)
        }
    } else {
        p.to_string()
    };
    let sep = if windows { '\\' } else { '/' };
    let trimmed = p.trim_end_matches(sep);
    let p = if trimmed.is_empty() || trimmed.ends_with(':') { format!("{trimmed}{sep}") } else { trimmed.to_string() };
    if windows { p.to_lowercase() } else { p }
}

/// Same directory, ignoring trailing separators and `\\?\` prefixes; on Windows also case and slash direction.
pub fn same_dir(a: &str, b: &str, windows: bool) -> bool {
    !a.is_empty() && !b.is_empty() && normalize_dir(a, windows) == normalize_dir(b, windows)
}

/// The folder name Claude Code files a session's transcripts under: the start directory with
/// every character other than an ASCII letter or digit replaced by `-`.
pub fn project_key(dir: &str) -> String {
    let dir = dir.strip_prefix(r"\\?\").unwrap_or(dir);
    let trimmed = dir.trim_end_matches(['/', '\\']);
    // A root keeps its separator: C:\ is C--, / is -.
    let dir = if trimmed.is_empty() || trimmed.ends_with(':') { &dir[..(trimmed.len() + 1).min(dir.len())] } else { trimmed };
    dir.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

fn same_key(a: &str, b: &str, windows: bool) -> bool {
    !a.is_empty() && if windows { a.eq_ignore_ascii_case(b) } else { a == b }
}

/// The newest of the matching candidates (ties: the smaller id).
fn newest<'a>(it: impl Iterator<Item = &'a Candidate>, rank: impl Fn(&Candidate) -> bool) -> Option<&'a Candidate> {
    it.max_by(|a, b| (rank(a), a.modified_ms).cmp(&(rank(b), b.modified_ms)).then_with(|| b.id.cmp(&a.id)))
}

/// (session id, pid) pairs, independent of the order of `procs` across directories.
///
/// Pass 1, the strong link: the session's transcript folder is the process's start
/// directory encoded (`project_key`); a candidate without a folder uses its first cwd
/// instead. Among those, one whose cwd or first cwd is exactly that directory comes
/// first, then the newest transcript.
/// Pass 2: processes and sessions left over pair on cwd or first cwd, newest first.
/// Each session and each process is used at most once.
///
/// Limits: the key is lossy (`a.b` and `a-b` encode alike, and Claude Code shortens very
/// long folder names), and processes in one directory are interchangeable, so a pairing
/// can be wrong or hold a seed whose session already ended. The relay's `sb_claude_pid`
/// on the next event moves the pid to the right session (`Store::release_pid`).
pub fn match_processes(candidates: &[Candidate], procs: &[ClaudeProcess], windows: bool) -> Vec<(String, u32)> {
    let exact = |c: &Candidate, p: &ClaudeProcess| c.first_cwd.as_deref().is_some_and(|f| same_dir(f, &p.cwd, windows)) || same_dir(&c.cwd, &p.cwd, windows);
    let strong = |c: &Candidate, p: &ClaudeProcess, key: &str| match c.project_key.as_deref() {
        Some(k) => same_key(k, key, windows),
        None => c.first_cwd.as_deref().is_some_and(|f| same_dir(f, &p.cwd, windows)),
    };
    let mut taken: Vec<&str> = Vec::new();
    let mut out: Vec<(String, u32)> = Vec::new();
    for p in procs {
        let key = project_key(&p.cwd);
        let open = candidates.iter().filter(|c| !taken.contains(&c.id.as_str()) && strong(c, p, &key));
        if let Some(c) = newest(open, |c| exact(c, p)) {
            taken.push(&c.id);
            out.push((c.id.clone(), p.pid));
        }
    }
    let left: Vec<&ClaudeProcess> = procs.iter().filter(|p| !out.iter().any(|(_, pid)| *pid == p.pid)).collect();
    for p in left {
        let open = candidates.iter().filter(|c| !taken.contains(&c.id.as_str()) && exact(c, p));
        if let Some(c) = newest(open, |_| false) {
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
        Candidate { id: id.into(), first_cwd: first.map(Into::into), cwd: cwd.into(), project_key: None, modified_ms }
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
    fn a_self_updated_claude_code_keeps_running_under_its_renamed_image() {
        // The native installer renames the running binary on update; the process keeps that image path.
        assert!(is_claude_process(r"C:\Users\a\.local\bin\claude.exe.old.1790878074763.57844", None));
        assert!(is_claude_process("/Users/a/.local/bin/claude.old.1790878074763", None));
        assert!(!is_claude_process(r"C:\x\claude-helper.exe.old.1.2", None));
        assert!(!is_claude_process(r"C:\Users\a\AppData\Local\AnthropicClaude\app-1.2.3\claude.exe.old.1.2", None), "a renamed desktop app stays out");
    }

    #[test]
    fn normalises_separators_case_and_verbatim_prefixes() {
        assert_eq!(normalize_dir(r"C:\Projects\", true), r"c:\projects");
        assert_eq!(normalize_dir(r"\\?\C:\Projects\", true), r"c:\projects");
        assert_eq!(normalize_dir("C:/Projects//", true), r"c:\projects");
        assert_eq!(normalize_dir(r"\\?\UNC\srv\share\x", true), r"\\srv\share\x");
        assert_eq!(normalize_dir(r"C:\", true), r"c:\");
        assert_eq!(normalize_dir("/p/X/", false), "/p/X");
        assert!(same_dir(r"\\?\C:\Projects\", "C:/projects", true));
    }

    #[test]
    fn project_key_is_the_transcript_folder_name() {
        assert_eq!(project_key(r"C:\Projects\"), "C--Projects");
        assert_eq!(project_key(r"\\?\C:\Projects"), "C--Projects");
        assert_eq!(project_key(r"C:\Projects\InvoiceRails\development\api.invoicerails"), "C--Projects-InvoiceRails-development-api-invoicerails");
        assert_eq!(project_key("/Users/a/p/x/"), "-Users-a-p-x");
        assert_eq!(project_key(r"C:\"), "C--", "a drive root keeps its separator");
        assert_eq!(project_key("C:"), "C-");
        assert_eq!(project_key("/"), "-");
    }

    #[test]
    fn the_strong_link_wins_whatever_the_process_order() {
        // S2 started in C:\Projects and cd'd into pushdocs\api; S1 started in pushdocs\api. S2 is newer.
        let c = [
            Candidate { id: "s1".into(), first_cwd: Some(r"C:\Projects\pushdocs\api".into()), cwd: r"C:\Projects\pushdocs\api".into(), project_key: Some("C--Projects-pushdocs-api".into()), modified_ms: 1 },
            Candidate { id: "s2".into(), first_cwd: Some(r"C:\Projects\pushdocs\api".into()), cwd: r"C:\Projects\pushdocs\api".into(), project_key: Some("C--Projects".into()), modified_ms: 2 },
        ];
        let p1 = proc_(1, r"C:\Projects\pushdocs\api");
        let p2 = proc_(2, r"C:\Projects\");
        let mut got = match_processes(&c, &[p1.clone(), p2.clone()], true);
        got.sort();
        assert_eq!(got, vec![("s1".to_string(), 1), ("s2".to_string(), 2)]);
        let mut got = match_processes(&c, &[p2, p1], true);
        got.sort();
        assert_eq!(got, vec![("s1".to_string(), 1), ("s2".to_string(), 2)], "same pairs in the other order");
    }

    #[test]
    fn leftovers_pair_on_cwd_in_a_second_pass() {
        // No transcript folder matches the process; its cwd still does.
        let c = [cand("a", Some("/p/x"), "/p/x", 1)];
        let c = [Candidate { project_key: Some("-elsewhere".into()), ..c[0].clone() }];
        assert_eq!(match_processes(&c, &[proc_(1, "/p/x")], false), vec![("a".to_string(), 1)]);
    }

    #[test]
    fn sessions_that_moved_on_still_match_the_directory_claude_code_started_in() {
        // Real shape: Claude Code processes started in C:\Projects (the PEB path keeps the trailing
        // backslash), their transcripts in projects/C--Projects, the transcript cwds in sub folders.
        let key = |id: &str, cwd: &str, key: &str, modified_ms| Candidate { id: id.into(), first_cwd: Some(cwd.into()), cwd: cwd.into(), project_key: Some(key.into()), modified_ms };
        let c = [
            key("a", r"C:\Projects\pushdocs\api", "C--Projects", 2),
            key("b", r"C:\Projects", "C--Projects", 1),
            key("c", r"C:\Elsewhere", "C--Elsewhere", 3),
        ];
        let procs = [proc_(10, r"C:\Projects\"), proc_(20, r"C:\Projects\")];
        // b's cwd is exactly the start directory: it goes first.
        assert_eq!(match_processes(&c, &procs, true), vec![("b".to_string(), 10), ("a".to_string(), 20)]);
        assert!(match_processes(&c[..1], &[proc_(10, r"C:\Projects\pushdocs")], false).is_empty(), "the key matches the start directory only");
    }

    #[test]
    fn no_match_no_pairs() {
        assert!(match_processes(&[cand("a", Some("/p/a"), "/p/a", 1)], &[proc_(1, "/p/b")], false).is_empty());
        assert!(match_processes(&[], &[proc_(1, "/p/b")], false).is_empty());
        assert!(match_processes(&[cand("a", Some("/p/a"), "/p/a", 1)], &[], false).is_empty());
    }
}
