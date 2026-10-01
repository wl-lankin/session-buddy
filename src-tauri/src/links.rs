//! Opens the two links in the settings footer in the default browser. Only
//! these exact URLs are accepted: the web views can never open anything else.

pub const LINKS: [&str; 2] = ["https://wolfgang-linz.de", "https://github.com/Louis-CFM/coucou"];

pub fn allowed(url: &str) -> bool {
    LINKS.contains(&url)
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
    fn only_the_two_footer_links_are_allowed() {
        assert!(allowed("https://wolfgang-linz.de"));
        assert!(allowed("https://github.com/Louis-CFM/coucou"));
        assert!(!allowed("https://wolfgang-linz.de/"));
        assert!(!allowed("https://github.com/Louis-CFM/coucou/../../evil"));
        assert!(!allowed("file:///C:/Windows/System32/calc.exe"));
        assert!(!allowed(""));
        assert!(open("https://example.com").is_err());
    }
}
