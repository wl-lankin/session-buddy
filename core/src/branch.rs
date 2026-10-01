//! The git branch of a session's working directory. Called off the hook path.

use std::process::Command;

pub fn lookup(cwd: &str) -> Option<String> {
    let mut cmd = Command::new("git");
    cmd.args(["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let branch = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!branch.is_empty()).then_some(branch)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn branch_of_a_fresh_repo() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().to_string_lossy().to_string();
        assert!(lookup(&p).is_none(), "not a repo yet");
        let ok = Command::new("git").args(["-C", &p, "init", "-q", "-b", "PDD-1981"]).status().unwrap().success();
        assert!(ok);
        // A repo without commits has no HEAD to resolve; that is still "no branch".
        assert!(lookup(&p).is_none() || lookup(&p).as_deref() == Some("PDD-1981"));
        Command::new("git").args(["-C", &p, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]).status().unwrap();
        assert_eq!(lookup(&p).as_deref(), Some("PDD-1981"));
    }
}
