# session-buddy

A small island at the top of your screen that shows every running Claude Code session, what each session, sub-agent and background task is doing, and lets you answer permission requests, `AskUserQuestion` prompts and plain-text questions without switching to the terminal. Works with Warp and any other terminal, on Windows and macOS.

Forked from [Coucou](https://github.com/Louis-CFM/coucou) by Louis Raille (MIT). Mochi, its animations and its 28 sounds come from there.

## What you see

| State | Shows |
|---|---|
| Strip (always on screen) | session count, who is working, who needs you, 5H / 7D limits |
| Compact (hover, or any event) | one session: project, branch, +/- lines, context %, current step. Scroll or use the arrows to flip sessions |
| Expanded (click) | tabs for all sessions, context bar, model, limits with reset times and account, last prompt, steps, sub-agents, background tasks |
| Card (when something waits for you) | Allow / Deny, question options, or a reply box. "Answer in terminal" hands it back |

Keys while the island has focus (after the hotkey, default `Ctrl+Alt+Space`): left / right or Tab to switch sessions, 1-9 to jump, Enter to submit, Esc to close.

## Install

Requirements: [Rust](https://rustup.rs), Node 20+, and on Windows the MSVC build tools; on macOS the Xcode Command Line Tools (`xcode-select --install`).

```bash
npm install
npm run pack
```

- Windows: run `target/release/bundle/nsis/session-buddy_0.1.0_x64-setup.exe` (current user, no admin).
- macOS: copy `target/release/bundle/macos/session-buddy.app` to `/Applications` and open it.

Then: tray / menu bar icon > Settings... > Install... > review the diff > Write. New Claude Code sessions report to the island.

On macOS the first limits refresh asks whether session-buddy may read the "Claude Code-credentials" Keychain item. Choose "Always Allow".

## How it works

Claude Code runs `sb-relay` for every hook event and as the status line. The relay forwards the JSON to the app over a per-user named pipe (Windows) or a Unix socket (macOS) and exits within 100 ms if the app is not running, so Claude Code is never blocked. Only permission requests, `AskUserQuestion` and a turn that ends in a question wait for an answer (110 s / 9 min); "Answer in terminal", the deadline or a closed connection all fall back to the terminal.

Limits come from the status-line JSON when Claude Code provides them, otherwise from Claude Code's own usage endpoint with its own login token (read fresh, never stored). No telemetry, no other network calls.

## Development

```bash
npm run dev                 # island in a browser; /dev/preview.html drives it with fake sessions
npx vitest run              # front-end tests
cargo test --workspace      # relay, core, paths
npm run tauri dev           # the real app
```

Logs: `%LOCALAPPDATA%\session-buddy\session-buddy.log` (Windows), `~/Library/Logs/session-buddy.log` (macOS).
