//! Opens a link in the default browser: the settings footer links and plain
//! http(s) addresses (from the chat). Nothing else, and never through a shell.

pub const LINKS: [&str; 2] = ["https://wolfgang-linz.de", "https://github.com/Louis-CFM/coucou"];

const MAX_URL_LEN: usize = 2048;

/// A plain web address: no whitespace or control characters, a real host, and no
/// user info before the host ("https://bank.com@evil.test" hides where it goes).
fn is_web_url(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://")) else { return false };
    if url.len() > MAX_URL_LEN || url.chars().any(|c| c.is_control() || c.is_whitespace() || "\"<>\\^`{|}".contains(c)) {
        return false;
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = authority.rsplit_once(':').filter(|(_, port)| port.chars().all(|c| c.is_ascii_digit())).map_or(authority, |(h, _)| h);
    !host.is_empty() && host.contains('.') && host.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
}

pub fn allowed(url: &str) -> bool {
    LINKS.contains(&url) || is_web_url(url)
}

pub fn open(url: &str) -> Result<(), String> {
    if !allowed(url) {
        return Err("This link cannot be opened.".into());
    }
    open_in_browser(url)
}

#[cfg(windows)]
fn open_in_browser(url: &str) -> Result<(), String> {
    use windows::core::{w, HSTRING, PCWSTR};
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let file = HSTRING::from(url);
    // ShellExecuteW hands the URL to the registered browser; no shell or cmd in between.
    let result = unsafe { ShellExecuteW(None, w!("open"), &file, PCWSTR::null(), PCWSTR::null(), SW_SHOWNORMAL) };
    // Values above 32 mean success (documented HINSTANCE convention).
    if result.0 as isize > 32 {
        Ok(())
    } else {
        Err(format!("Could not open the link (code {}).", result.0 as isize))
    }
}

#[cfg(target_os = "macos")]
fn open_in_browser(url: &str) -> Result<(), String> {
    // `open` returns as soon as the browser has the URL; waiting for it reaps the child.
    let status = std::process::Command::new("/usr/bin/open").arg(url).status().map_err(|e| e.to_string())?;
    if status.success() { Ok(()) } else { Err(format!("Could not open the link ({status}).")) }
}

#[cfg(not(any(windows, target_os = "macos")))]
fn open_in_browser(url: &str) -> Result<(), String> {
    let status = std::process::Command::new("xdg-open").arg(url).status().map_err(|e| e.to_string())?;
    if status.success() { Ok(()) } else { Err(format!("Could not open the link ({status}).")) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_web_addresses_and_the_footer_links_are_allowed() {
        assert!(allowed("https://wolfgang-linz.de"));
        assert!(allowed("https://github.com/Louis-CFM/coucou"));
        assert!(allowed("https://www.wetter.de/deutschland/muenchen?x=1#top"));
        assert!(allowed("http://example.com:8080/a"));
    }

    #[test]
    fn everything_else_is_refused() {
        for url in [
            "",
            "file:///C:/Windows/System32/calc.exe",
            "javascript:alert(1)",
            "-a Calculator",
            "https://",
            "https://localhost",
            "https://bank.com@evil.test/login",
            "https://example.com/a b",
            "https://example.com/\"x\"",
            "ftp://example.com",
        ] {
            assert!(!allowed(url), "{url}");
        }
        assert!(!allowed(&format!("https://example.com/{}", "a".repeat(2100))));
        assert!(open("file:///etc/passwd").is_err());
    }
}
