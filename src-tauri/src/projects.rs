//! Which folders the chat may start sessions in: the user's project roots and how a name or path
//! the model asks for is resolved against them. Everything is compared after canonicalisation,
//! so neither `..` nor a symlink leads out of a root.

use std::path::{Path, PathBuf};

pub const MAX_ROOTS: usize = 20;
const MAX_MATCHES: usize = 8;
const MAX_LISTED: usize = 100;

/// The folder as the OS resolves it (symlinks followed), only if it exists and is a directory.
pub fn canonical_dir(path: &Path) -> Option<PathBuf> {
    let canonical = std::fs::canonicalize(path).ok()?;
    canonical.is_dir().then(|| plain(canonical))
}

/// Windows canonical paths carry a `\\?\` prefix that nobody wants to read.
#[cfg(windows)]
fn plain(path: PathBuf) -> PathBuf {
    let stripped = path.to_string_lossy().strip_prefix(r"\\?\").filter(|rest| !rest.starts_with("UNC\\")).map(PathBuf::from);
    stripped.unwrap_or(path)
}

#[cfg(not(windows))]
fn plain(path: PathBuf) -> PathBuf {
    path
}

/// The settings' roots that exist now, canonical, without duplicates.
pub fn roots(raw: &[String]) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    for r in raw {
        if let Some(c) = canonical_dir(Path::new(r)) {
            if !out.contains(&c) {
                out.push(c);
            }
        }
    }
    out
}

pub fn any_root(raw: &[String]) -> bool {
    raw.iter().any(|r| canonical_dir(Path::new(r)).is_some())
}

/// What `save_settings` stores: existing directories only, canonical, no duplicates, at most `MAX_ROOTS`.
pub fn normalize_roots(raw: &[String]) -> Vec<String> {
    roots(raw).into_iter().take(MAX_ROOTS).map(|p| p.to_string_lossy().into_owned()).collect()
}

pub fn inside(roots: &[PathBuf], dir: &Path) -> bool {
    roots.iter().any(|r| dir.starts_with(r))
}

fn display(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// "The allowed folders are ...": what a refusal tells the model. Only roots, never the rejected input.
pub fn allowed_text(roots: &[PathBuf]) -> String {
    if roots.is_empty() {
        return "No project folders are set. The user adds them in Settings, Chat, Control.".to_string();
    }
    format!("Allowed project folders: {}. Use list_projects.", roots.iter().map(|r| display(r)).collect::<Vec<_>>().join(", "))
}

fn looks_like_path(input: &str) -> bool {
    input.contains(['/', '\\', ':']) || input.starts_with('~') || Path::new(input).is_absolute()
}

/// Adds the canonical form of `candidate` when it is a directory inside a root.
fn add_inside(roots: &[PathBuf], found: &mut Vec<PathBuf>, candidate: PathBuf) {
    if let Some(c) = canonical_dir(&candidate).filter(|c| inside(roots, c)) {
        if !found.contains(&c) {
            found.push(c);
        }
    }
}

/// Folders inside `roots` that match what the model asked for, canonical. A name matches the root itself
/// or a direct child (exactly, ignoring case, else by containing it); a path must lie inside a root.
pub fn resolve(roots: &[PathBuf], input: &str) -> Result<Vec<PathBuf>, String> {
    let input = input.trim();
    if input.is_empty() || input.chars().count() > 300 || input.chars().any(char::is_control) {
        return Err("The project is empty or not valid. Use a name from list_projects.".into());
    }
    if roots.is_empty() {
        return Err(allowed_text(roots));
    }
    let mut found: Vec<PathBuf> = Vec::new();
    if looks_like_path(input) {
        let path = match input.strip_prefix("~/").or_else(|| input.strip_prefix("~\\")) {
            Some(rest) => sb_common::home().join(rest),
            None => PathBuf::from(input),
        };
        if path.is_absolute() {
            add_inside(roots, &mut found, path);
        } else {
            roots.iter().for_each(|r| add_inside(roots, &mut found, r.join(&path)));
        }
        if found.is_empty() {
            return Err(format!("That folder is not inside the allowed project folders. {}", allowed_text(roots)));
        }
    } else {
        if input == "." || input == ".." {
            return Err("The project is not a valid name. Use a name from list_projects.".into());
        }
        let wanted = input.to_lowercase();
        let children: Vec<(String, PathBuf)> = roots
            .iter()
            .flat_map(|r| std::iter::once(r.clone()).chain(child_dirs(r)))
            .filter_map(|p| Some((p.file_name()?.to_string_lossy().to_lowercase(), p)))
            .collect();
        children.iter().filter(|(n, _)| *n == wanted).for_each(|(_, p)| add_inside(roots, &mut found, p.clone()));
        if found.is_empty() && wanted.chars().count() >= 2 {
            children.iter().filter(|(n, _)| n.contains(&wanted)).for_each(|(_, p)| add_inside(roots, &mut found, p.clone()));
        }
        found.truncate(MAX_MATCHES);
        if found.is_empty() {
            return Err(format!("No project folder named \"{input}\". {}", allowed_text(roots)));
        }
    }
    Ok(found)
}

/// Direct subfolders, sorted by name, hidden ones left out.
fn child_dirs(dir: &Path) -> Vec<PathBuf> {
    let Ok(read) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<PathBuf> = read
        .filter_map(Result::ok)
        .filter(|e| !e.file_name().to_string_lossy().starts_with('.') && e.path().is_dir())
        .map(|e| e.path())
        .collect();
    out.sort();
    out
}

/// `(name, path)` of every root and its direct subfolders that really lie inside the roots, capped.
pub fn list(roots: &[PathBuf]) -> Vec<(String, PathBuf)> {
    let mut out: Vec<(String, PathBuf)> = Vec::new();
    for root in roots {
        for dir in std::iter::once(root.clone()).chain(child_dirs(root)) {
            let Some(c) = canonical_dir(&dir).filter(|c| inside(roots, c)) else { continue };
            let name = c.file_name().map_or_else(|| display(&c), |n| n.to_string_lossy().into_owned());
            if !out.iter().any(|(_, p)| *p == c) {
                out.push((name, c));
            }
        }
    }
    out.truncate(MAX_LISTED);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Tree {
        _dir: tempfile::TempDir,
        root: PathBuf,
        outside: PathBuf,
    }

    fn tree() -> Tree {
        let dir = tempfile::tempdir().unwrap();
        let base = canonical_dir(dir.path()).unwrap();
        let root = base.join("code");
        let outside = base.join("secret");
        for p in ["code/Nexa", "code/Nexa/api", "code/nexa-tools", "code/.hidden", "secret/Nexa", "other/Nexa"] {
            std::fs::create_dir_all(base.join(p)).unwrap();
        }
        std::fs::write(base.join("code/file.txt"), "x").unwrap();
        Tree { _dir: dir, root, outside }
    }

    fn names(found: &[PathBuf]) -> Vec<String> {
        found.iter().map(|p| p.file_name().unwrap().to_string_lossy().into_owned()).collect()
    }

    #[test]
    fn a_name_matches_exactly_before_loosely() {
        let t = tree();
        let roots = vec![t.root.clone()];
        assert_eq!(resolve(&roots, "Nexa").unwrap(), vec![t.root.join("Nexa")]);
        assert_eq!(resolve(&roots, "nexa").unwrap(), vec![t.root.join("Nexa")]);
        assert_eq!(names(&resolve(&roots, "tools").unwrap()), ["nexa-tools"]);
        assert_eq!(names(&resolve(&roots, "code").unwrap()), ["code"], "the root itself is a project too");
    }

    #[test]
    fn several_roots_can_give_several_matches() {
        let t = tree();
        let other = t.root.parent().unwrap().join("other");
        let found = resolve(&[t.root.clone(), other.clone()], "Nexa").unwrap();
        assert_eq!(found, vec![t.root.join("Nexa"), other.join("Nexa")]);
    }

    #[test]
    fn unknown_hidden_and_file_names_are_refused() {
        let t = tree();
        let roots = vec![t.root.clone()];
        assert!(resolve(&roots, "nothing-here").unwrap_err().contains("No project folder named"));
        assert!(resolve(&roots, ".hidden").is_err());
        assert!(resolve(&roots, "file.txt").is_err());
        assert!(resolve(&roots, "").is_err());
        assert!(resolve(&roots, ".").is_err());
        assert!(resolve(&roots, "..").is_err());
        assert!(resolve(&roots, "a\nb").is_err());
        assert!(resolve(&[], "Nexa").unwrap_err().contains("Settings"));
    }

    #[test]
    fn paths_must_lie_inside_a_root() {
        let t = tree();
        let roots = vec![t.root.clone()];
        let inside_abs = t.root.join("Nexa").join("api");
        assert_eq!(resolve(&roots, &display(&inside_abs)).unwrap(), vec![inside_abs]);
        assert_eq!(resolve(&roots, "Nexa/api").unwrap(), vec![t.root.join("Nexa").join("api")], "relative to a root");
        let refused = resolve(&roots, &display(&t.outside.join("Nexa"))).unwrap_err();
        assert!(refused.contains("not inside the allowed"));
        assert!(!refused.contains("secret"), "the refusal never repeats the rejected path");
        assert!(refused.contains(&display(&t.root)), "it names the allowed roots instead");
    }

    #[test]
    fn dot_dot_cannot_leave_the_root() {
        let t = tree();
        let roots = vec![t.root.clone()];
        let sneaky = format!("{}/Nexa/../../secret/Nexa", display(&t.root));
        assert!(resolve(&roots, &sneaky).is_err());
        assert!(resolve(&roots, "../secret/Nexa").is_err());
        assert!(resolve(&roots, "Nexa/../../secret").is_err());
        assert!(resolve(&roots, "Nexa/../api").is_err(), "Nexa/../api is code/api, which does not exist");
        assert_eq!(resolve(&roots, "Nexa/../nexa-tools").unwrap(), vec![t.root.join("nexa-tools")]);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_out_of_the_root_is_refused() {
        let t = tree();
        std::os::unix::fs::symlink(&t.outside, t.root.join("link")).unwrap();
        std::os::unix::fs::symlink(t.outside.join("Nexa"), t.root.join("Nexa-link")).unwrap();
        let roots = vec![t.root.clone()];
        assert!(resolve(&roots, "link").is_err(), "by name");
        assert!(resolve(&roots, "Nexa-link").is_err(), "by partial name");
        assert!(resolve(&roots, &format!("{}/link/Nexa", display(&t.root))).is_err(), "by path through the link");
        assert!(resolve(&roots, "link/Nexa").is_err(), "relative through the link");
        assert!(list(&roots).iter().all(|(n, _)| !n.contains("link")));
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_inside_the_root_is_followed_to_its_target() {
        let t = tree();
        std::os::unix::fs::symlink(t.root.join("Nexa"), t.root.join("alias")).unwrap();
        assert_eq!(resolve(std::slice::from_ref(&t.root), "alias").unwrap(), vec![t.root.join("Nexa")]);
    }

    #[test]
    fn a_sibling_with_the_same_prefix_is_not_inside() {
        let t = tree();
        let base = t.root.parent().unwrap();
        std::fs::create_dir_all(base.join("code-evil/x")).unwrap();
        assert!(!inside(std::slice::from_ref(&t.root), &base.join("code-evil").join("x")));
        assert!(inside(std::slice::from_ref(&t.root), &t.root.join("Nexa")));
    }

    #[test]
    fn roots_are_normalised() {
        let t = tree();
        let raw = vec![
            display(&t.root),
            format!("{}/Nexa/..", display(&t.root)),
            display(&t.root.join("nope")),
            display(&t.root.join("file.txt")),
            display(&t.outside),
        ];
        assert_eq!(normalize_roots(&raw), vec![display(&t.root), display(&t.outside)]);
        assert!(any_root(&raw));
        assert!(!any_root(&[display(&t.root.join("nope"))]));
        assert!(!any_root(&[]));
    }

    #[test]
    fn at_most_twenty_roots_are_kept() {
        let dir = tempfile::tempdir().unwrap();
        let raw: Vec<String> = (0..25)
            .map(|i| {
                let p = dir.path().join(format!("r{i}"));
                std::fs::create_dir_all(&p).unwrap();
                display(&p)
            })
            .collect();
        assert_eq!(normalize_roots(&raw).len(), MAX_ROOTS);
    }

    #[test]
    fn list_has_the_roots_and_their_children_without_hidden_ones() {
        let t = tree();
        let listed = list(std::slice::from_ref(&t.root));
        let n: Vec<&str> = listed.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(n, ["code", "Nexa", "nexa-tools"]);
    }
}
