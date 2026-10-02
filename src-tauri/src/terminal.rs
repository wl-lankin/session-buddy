//! Bringing a session's terminal app to the front ("Approve in terminal").

#[cfg(target_os = "macos")]
const OPEN: &str = "/usr/bin/open";

/// The app that runs a session, from the TERM_PROGRAM its relay reported. A fixed table: the name
/// handed to `open -a` never comes from the session.
#[cfg(target_os = "macos")]
fn app_name(term_program: &str) -> Option<&'static str> {
    Some(match term_program {
        "WarpTerminal" => "Warp",
        "Apple_Terminal" => "Terminal",
        "iTerm.app" => "iTerm",
        "vscode" => "Visual Studio Code",
        "ghostty" => "Ghostty",
        "WezTerm" => "WezTerm",
        "Hyper" => "Hyper",
        _ => return None,
    })
}

#[cfg(target_os = "macos")]
pub async fn focus(term_program: Option<String>) -> Result<(), String> {
    let app = term_program.as_deref().and_then(app_name).ok_or("I do not know this terminal")?;
    let status = tauri::async_runtime::spawn_blocking(move || std::process::Command::new(OPEN).args(["-a", app]).status())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    if status.success() { Ok(()) } else { Err(format!("Could not bring {app} to the front")) }
}

#[cfg(not(target_os = "macos"))]
pub async fn focus(_term_program: Option<String>) -> Result<(), String> {
    Err("Not supported on this system".into())
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::app_name;

    #[test]
    fn known_terminals_map_to_their_app() {
        for (term, app) in [
            ("WarpTerminal", "Warp"),
            ("Apple_Terminal", "Terminal"),
            ("iTerm.app", "iTerm"),
            ("vscode", "Visual Studio Code"),
            ("ghostty", "Ghostty"),
            ("WezTerm", "WezTerm"),
            ("Hyper", "Hyper"),
        ] {
            assert_eq!(app_name(term), Some(app), "{term}");
        }
    }

    #[test]
    fn tmux_and_unknown_terminals_have_no_app() {
        for term in ["tmux", "", "warpterminal", "Terminal; rm -rf /", "/Applications/Evil.app"] {
            assert_eq!(app_name(term), None, "{term}");
        }
    }
}
