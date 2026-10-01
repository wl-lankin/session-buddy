# session-buddy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Windows + macOS desktop island (forked from Coucou) that lists every running Claude Code session, shows what each session, sub-agent and background task is doing, shows context / lines / branch / 5H+7D limits, and lets the user answer permission requests, `AskUserQuestion` prompts and plain-text questions without going to the terminal.

**Architecture:** Claude Code calls a tiny relay binary (`sb-relay`) for every hook event and for the status line. The relay forwards JSON over a named pipe (Windows) or Unix socket (macOS) to the Tauri app. A pure-Rust core crate (`sb-core`) holds the session store and the relay protocol (`Hub`), fully unit tested without Tauri. The TypeScript front end (no framework, Coucou's Mochi engine) renders snapshots the app emits and sends answers back through Tauri commands.

**Tech Stack:** Rust 2021 (Tauri 2.5+, tokio, serde_json with `preserve_order`, reqwest rustls, chrono), TypeScript 5 + Vite 6 + Vitest 3, Canvas 2D (Mochi), WebAudio (28 WAVs from Coucou).

**Spec:** `docs/specs/2026-10-01-session-buddy-design.md` (read it before starting any task).

**Source of the fork:** `C:\Projects\coucou` (MIT). Paths below written as `coucou/...` mean `C:\Projects\coucou\...`. On the Mac, clone `https://github.com/Louis-CFM/coucou` next to session-buddy if a file is needed there (it should not be: everything is copied in Task 1).

## Global Constraints

- Repo: `C:\Projects\session-buddy`, remote `https://github.com/wl-lankin/session-buddy.git` (private). Commit after every task; push only when the user asks.
- Commit messages: plain imperative sentence, first word capitalized, no ticket prefix, no attribution footer, no session URL.
- Never write em-dashes or en-dashes anywhere (code, comments, UI text, docs). Use `-`. The minus in `+128 -34` is a plain hyphen.
- All UI text in English.
- Windows commands run in Git Bash unless stated otherwise. Rust via `cargo` on PATH; Node 20+.
- Claude Code must never be blocked: relay connect budget 100 ms, fire-and-forget budget 2 s, no output on any failure.
- Wait deadlines (app side): permission 110 s, question and reply 540 s; relay budgets 112 s and 545 s; settings.json hook timeouts: `PermissionRequest` 120, `PreToolUse` 600, `Stop` 600, all others 10.
- `~/.claude/settings.json` is only ever written after a dated backup, a diff shown to the user and an explicit click; only entries whose command contains `sb-relay` are added or removed.
- No telemetry. Only network call: `GET https://api.anthropic.com/api/oauth/usage` (fallback for limits), cached 10 min.
- Tokens are read fresh and never written anywhere.
- Bundle identifier `de.wlankin.sessionbuddy`, product name `session-buddy`.
- Thresholds: bars orange at >= 70 %, red at >= 90 %. Stale after 10 min without events (configurable), removed 2 h after becoming stale (configurable). `finished` falls back to `idle` after 30 s.
- Keep the 28 sounds byte-identical and keep Mochi's engine (`engine.ts`, `greeting.ts`) unchanged.

## Review Focus

1. A session whose Warp tab was closed (no `SessionEnd`): it must go grey ("stale") after 10 min and disappear 2 h later, never linger forever. Covered by `store::tests::stale_then_removed` (Task 3).
2. Two sessions asking at the same time (permission in A, `AskUserQuestion` in B): neither card may replace the other; both are answerable in turn and each answer reaches the right relay. Covered by `hub::tests::two_pending_answers_route_by_id` (Task 4) and `viewmodel.test.ts` "pending queue order" (Task 8).
3. The user answers in the terminal instead (or presses Esc in Claude Code, which kills the hook): the card must disappear as soon as the relay connection closes, not after 9 minutes. Covered by `hub::tests::client_disconnect_releases` (Task 4).
4. A user who already has a custom `statusLine` (like `python ~/.claude/statusline.py`): installing must keep it working unchanged and uninstalling must restore it byte for byte. Covered by `claude_settings::tests::round_trip_restores_original` and `status_line_with_operators_is_grouped` (Task 6).
5. Sub-agent tool calls must never be shown as the main thread's steps, and an agent's description must survive whether the `Agent` call is sync or async. Covered by `store::tests::subagent_attribution_from_spike` (Task 3).

---

## File Structure

```
session-buddy/
  Cargo.toml                    workspace: common, core, hook, src-tauri; shared release profile
  package.json, tsconfig.json, vite.config.ts, index.html, settings.html
  LICENSE, LICENSE-ASSETS.md, README.md, .gitignore, .gitattributes
  sounds/*.wav                  the 28 Coucou WAVs, copied verbatim
  common/                       crate sb-common
    src/lib.rs                  config/local/log dirs, relay path, claude dir, pipe name / socket path
    src/win_user.rs             current user SID (Windows only)
  core/                         crate sb-core (no Tauri)
    src/lib.rs                  module list + now_ms()
    src/steps.rs                tool -> step label, approval target, project name, clip()
    src/store.rs                Session model, Store (hook + status-line events -> state), cues
    src/hub.rs                  relay protocol server: store + pending waits + ack/answer/release
    src/bootstrap.rs            seed sessions from ~/.claude/projects/*/*.jsonl tails
    src/usage.rs                Limit / Usage / Account types, parsing of rate_limits and oauth usage
    src/claude_settings.rs      settings.json install / uninstall merge, diff, fingerprint, safe write
    tests/fixtures/spike-events.jsonl   captured 2026-10-01 hook payloads
  hook/                         crate sb-relay (binary)
    src/main.rs                 modes: `hook <Event>`, `statusline [--quiet]`
    src/prepare.rs              stdin -> forward line + original payload + wait kind
    src/output.rs               WaitKind classification and Claude Code output JSON
    src/transport.rs            connect (pipe / socket) and send / wait
    src/win.rs                  pipe server same-user check (Windows only)
  src-tauri/                    crate session-buddy (Tauri app)
    tauri.conf.json, tauri.windows.conf.json, tauri.macos.conf.json, capabilities/default.json
    icons/                      copied from coucou, regenerated with `tauri icon`
    src/main.rs, src/lib.rs     setup, commands, emitter + tick loops
    src/ipc.rs                  pipe / socket listener -> Hub::serve
    src/island.rs               window placement, click-through, cursor feed, activation
    src/settings.rs             app preferences JSON
    src/install.rs              relay copy, hooks preview/write using sb-core::claude_settings
    src/usage_poll.rs           token + account reading, oauth fetch, Usage state
    src/branch.rs               git branch lookup off the hook path
    src/tray.rs, src/log.rs
  src/                          front end
    main.ts
    core/anim.ts, core/sound.ts            copied verbatim from coucou
    core/bridge.ts, core/state.ts, core/layout.ts, core/types.ts
    mochi/engine.ts, mochi/greeting.ts     copied verbatim from coucou
    model/format.ts (+ .test.ts), model/viewmodel.ts (+ .test.ts)
    island/fsm.ts, island/island.ts
    views/dom.ts, views/icons.ts           copied verbatim from coucou
    views/views.ts, views/strip.ts, views/compact.ts, views/expanded.ts, views/cards.ts
    settings/main.ts, settings/settings.css
    style.css
  dev/preview.html, dev/preview.ts, dev/fixtures.ts
```

---

### Task 1: Scaffold the workspace and the shared paths crate

**Files:**
- Create: `Cargo.toml`, `.gitignore`, `.gitattributes`, `LICENSE`, `LICENSE-ASSETS.md`, `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `src/main.ts` (stub)
- Create: `common/Cargo.toml`, `common/src/lib.rs`, `common/src/win_user.rs`
- Copy verbatim: `sounds/*.wav` from `coucou/NotchBuddy/Resources/sounds/`; `src/core/anim.ts`, `src/core/sound.ts`, `src/mochi/engine.ts`, `src/mochi/greeting.ts`, `src/views/dom.ts`, `src/views/icons.ts` from `coucou/windows/src/...`; `src-tauri/icons/` from `coucou/windows/src-tauri/icons/`; `scripts/gen-icons.mjs` from `coucou/windows/scripts/gen-icons.mjs`
- Test: `common/src/lib.rs` (unit tests)

**Interfaces:**
- Produces (sb-common): `APP_DIR: &str`, `home() -> PathBuf`, `claude_dir() -> PathBuf`, `config_dir() -> PathBuf`, `local_dir() -> PathBuf`, `relay_path() -> PathBuf`, `log_path() -> PathBuf`, `user_key() -> String`, `#[cfg(windows)] pipe_name(key: &str) -> String`, `#[cfg(unix)] socket_path() -> PathBuf`.

- [ ] **Step 1: Create the workspace files**

`Cargo.toml`:
```toml
[workspace]
members = ["common", "core", "hook", "src-tauri"]
resolver = "2"

[workspace.package]
version = "0.1.0"
edition = "2021"
license = "MIT"

# The relay starts on every Claude Code event: optimise for size and start-up.
[profile.release]
opt-level = "s"
lto = true
codegen-units = 1
panic = "abort"
strip = true
```

Until Tasks 2 and 3 exist, temporarily set `members = ["common"]` and restore the full list in Task 2 Step 1 / Task 3 Step 1 (each task adds its own member).

`.gitignore`:
```
/target
/node_modules
/dist
/release
/src-tauri/gen
*.log
.DS_Store
```

`.gitattributes`:
```
* text=auto eol=lf
*.wav binary
*.png binary
*.ico binary
*.icns binary
```

`LICENSE`: copy `coucou/LICENSE` verbatim, then append below it:
```

session-buddy modifications Copyright (c) 2026 Wolfgang Linz, released under the same MIT license.
```
`LICENSE-ASSETS.md`: copy `coucou/LICENSE-ASSETS.md` verbatim (covers Mochi and the sounds).

`package.json`:
```json
{
  "name": "session-buddy",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "test": "vitest run",
    "icons": "node scripts/gen-icons.mjs",
    "tauri": "tauri",
    "prebuild": "cargo build --release -p sb-relay",
    "pack": "tauri build"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2.5.0",
    "typescript": "^5.6.0",
    "vite": "^6.0.0",
    "vitest": "^3.0.0"
  },
  "dependencies": {
    "@tauri-apps/api": "^2.5.0"
  }
}
```
(`prebuild` will fail until Task 2 adds `sb-relay`; it is only run by `npm run build` from Task 9 on.)

`tsconfig.json`: copy `coucou/windows/tsconfig.json`, change `"include": ["src"]` to `"include": ["src", "dev"]` and `"types": ["vite/client"]` to `"types": ["vite/client", "vitest/globals"]`.

`vite.config.ts`:
```ts
import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// Sounds live in /sounds and are served / copied as static assets.
export default defineConfig({
  publicDir: false,
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: "127.0.0.1", fs: { allow: ["."] } },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "chrome110",
    minify: "esbuild",
    sourcemap: false,
    emptyOutDir: true,
    rollupOptions: {
      input: {
        island: resolve(__dirname, "index.html"),
        settings: resolve(__dirname, "settings.html"),
      },
    },
  },
  plugins: [
    {
      name: "sb-sounds",
      configureServer(server) {
        server.middlewares.use("/sounds", (req, res, next) => {
          const name = decodeURIComponent((req.url ?? "").replace(/^\//, "").split("?")[0]);
          if (!/^[a-z]+\.wav$/.test(name)) return next();
          res.setHeader("Content-Type", "audio/wav");
          import("node:fs").then((fs) => fs.createReadStream(resolve(__dirname, "sounds", name)).pipe(res));
        });
      },
      async closeBundle() {
        const fs = await import("node:fs");
        const out = resolve(__dirname, "dist/sounds");
        fs.mkdirSync(out, { recursive: true });
        for (const f of fs.readdirSync(resolve(__dirname, "sounds"))) {
          if (f.endsWith(".wav")) fs.copyFileSync(resolve(__dirname, "sounds", f), resolve(out, f));
        }
      },
    },
  ],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    globals: true,
  },
});
```

`index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>session-buddy</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

`src/main.ts` (stub, replaced in Task 9):
```ts
export {};
```

- [ ] **Step 2: Copy the kept front-end modules, sounds and icons**

```bash
cd /c/Projects/session-buddy
C=/c/Projects/coucou
mkdir -p sounds src/core src/mochi src/views src-tauri/icons scripts
cp "$C"/NotchBuddy/Resources/sounds/*.wav sounds/
cp "$C"/windows/src/core/anim.ts "$C"/windows/src/core/sound.ts src/core/
cp "$C"/windows/src/mochi/engine.ts "$C"/windows/src/mochi/greeting.ts src/mochi/
cp "$C"/windows/src/views/dom.ts "$C"/windows/src/views/icons.ts src/views/
cp -r "$C"/windows/src-tauri/icons/. src-tauri/icons/
cp "$C"/windows/scripts/gen-icons.mjs scripts/
ls sounds | wc -l
```
Expected: `28`.

In `src/core/sound.ts` change only the header comment (first 4 lines) to:
```ts
// SoundEngine - port of Coucou's SoundEngine (itself a port of SoundEngine.swift).
// The 28 WAVs are served at /sounds/<name>.wav. Default volume 0.12, several
// sounds may overlap.
```
Leave every other line of the copied files unchanged. Then in `src/core/sound.ts` and the copied files replace every `[coucou]` log prefix with nothing (no prefixes in log messages):
```bash
grep -rl "\[coucou\] " src | xargs -r sed -i 's/\[coucou\] //g'
```

- [ ] **Step 3: Write the failing tests for sb-common**

`common/Cargo.toml`:
```toml
[package]
name = "sb-common"
version.workspace = true
edition.workspace = true
license.workspace = true

[dependencies]

[target.'cfg(windows)'.dependencies]
windows = { version = "0.61", features = [
  "Win32_Foundation",
  "Win32_Security",
  "Win32_Security_Authorization",
  "Win32_System_Threading",
] }
```

`common/src/lib.rs` (tests first, functions as `todo!()`):
```rust
//! Paths and names shared by the app and the relay. Both sides must agree on
//! them byte for byte, so they live in exactly one place.

use std::path::PathBuf;

#[cfg(windows)]
mod win_user;

pub const APP_DIR: &str = "session-buddy";

pub fn home() -> PathBuf { todo!() }
pub fn claude_dir() -> PathBuf { todo!() }
pub fn config_dir() -> PathBuf { todo!() }
pub fn local_dir() -> PathBuf { todo!() }
pub fn relay_path() -> PathBuf { todo!() }
pub fn log_path() -> PathBuf { todo!() }
pub fn user_key() -> String { todo!() }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_dir_ends_with_app_dir() {
        assert!(config_dir().ends_with(APP_DIR));
    }

    #[test]
    fn relay_lives_in_bin() {
        let p = relay_path();
        assert_eq!(p.parent().unwrap().file_name().unwrap(), "bin");
        let name = p.file_name().unwrap().to_string_lossy().to_string();
        assert_eq!(name, if cfg!(windows) { "sb-relay.exe" } else { "sb-relay" });
    }

    #[test]
    fn claude_dir_respects_override() {
        std::env::set_var("CLAUDE_CONFIG_DIR", "/tmp/xyz-claude");
        assert_eq!(claude_dir(), PathBuf::from("/tmp/xyz-claude"));
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        assert!(claude_dir().ends_with(".claude"));
    }

    #[test]
    fn user_key_is_not_empty() {
        assert!(!user_key().is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn pipe_name_is_per_user() {
        assert_eq!(pipe_name("S-1-5-21-1"), r"\\.\pipe\session-buddy-S-1-5-21-1");
    }

    #[cfg(unix)]
    #[test]
    fn socket_is_in_config_dir() {
        assert_eq!(socket_path(), config_dir().join("sb.sock"));
        // macOS limits AF_UNIX paths to 104 bytes.
        assert!(socket_path().to_string_lossy().len() < 104);
    }
}
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `cargo test -p sb-common`
Expected: compile error for `pipe_name` / `socket_path` not found (and `todo!()` panics once they exist).

- [ ] **Step 5: Implement sb-common**

Replace the `todo!()` functions in `common/src/lib.rs` with:
```rust
fn env_dir(var: &str) -> Option<PathBuf> {
    std::env::var_os(var).filter(|v| !v.is_empty()).map(PathBuf::from)
}

pub fn home() -> PathBuf {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    env_dir(var).unwrap_or_else(|| PathBuf::from("."))
}

/// `~/.claude`, or `CLAUDE_CONFIG_DIR` when Claude Code is pointed elsewhere.
pub fn claude_dir() -> PathBuf {
    env_dir("CLAUDE_CONFIG_DIR").unwrap_or_else(|| home().join(".claude"))
}

/// %APPDATA%\session-buddy | ~/Library/Application Support/session-buddy | ~/.config/session-buddy
pub fn config_dir() -> PathBuf {
    #[cfg(windows)]
    let base = env_dir("APPDATA").unwrap_or_else(|| home().join("AppData").join("Roaming"));
    #[cfg(target_os = "macos")]
    let base = home().join("Library").join("Application Support");
    #[cfg(all(unix, not(target_os = "macos")))]
    let base = env_dir("XDG_CONFIG_HOME").unwrap_or_else(|| home().join(".config"));
    base.join(APP_DIR)
}

/// Where the relay binary lives: %LOCALAPPDATA%\session-buddy on Windows, the config dir elsewhere.
pub fn local_dir() -> PathBuf {
    #[cfg(windows)]
    {
        env_dir("LOCALAPPDATA")
            .unwrap_or_else(|| home().join("AppData").join("Local"))
            .join(APP_DIR)
    }
    #[cfg(not(windows))]
    {
        config_dir()
    }
}

pub fn relay_path() -> PathBuf {
    let name = if cfg!(windows) { "sb-relay.exe" } else { "sb-relay" };
    local_dir().join("bin").join(name)
}

pub fn log_path() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        home().join("Library").join("Logs").join("session-buddy.log")
    }
    #[cfg(not(target_os = "macos"))]
    {
        local_dir().join("session-buddy.log")
    }
}

/// Distinguishes OS users sharing one machine: the SID on Windows, the user name elsewhere.
pub fn user_key() -> String {
    #[cfg(windows)]
    if let Some(sid) = win_user::current_user_sid() {
        return sid;
    }
    std::env::var(if cfg!(windows) { "USERNAME" } else { "USER" }).unwrap_or_else(|_| "user".into())
}

#[cfg(windows)]
pub fn pipe_name(key: &str) -> String {
    format!(r"\\.\pipe\session-buddy-{key}")
}

#[cfg(unix)]
pub fn socket_path() -> PathBuf {
    config_dir().join("sb.sock")
}
```

`common/src/win_user.rs`: copy `coucou/windows/src-tauri/src/win_user.rs` verbatim and change its visibility line to `pub fn current_user_sid() -> Option<String>` if it is not already `pub` (it is). Replace its header comment with:
```rust
//! The current user's SID as a string, used to keep two Windows accounts on
//! one machine from ever sharing a pipe.
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cargo test -p sb-common`
Expected: 5 tests pass on Windows (`socket_is_in_config_dir` is not compiled there), 5 on macOS.

- [ ] **Step 7: Commit**

```bash
cd /c/Projects/session-buddy
git add -A
git commit -m "Scaffold workspace, shared paths crate and copied Mochi assets"
```

---

### Task 2: The relay binary (`sb-relay`)

**Files:**
- Modify: `Cargo.toml` (members += `"hook"`)
- Create: `hook/Cargo.toml`, `hook/src/main.rs`, `hook/src/prepare.rs`, `hook/src/output.rs`, `hook/src/transport.rs`, `hook/src/win.rs`
- Test: unit tests in `hook/src/prepare.rs` and `hook/src/output.rs`

**Interfaces:**
- Consumes: `sb_common::{user_key, pipe_name, socket_path}`.
- Produces (wire protocol, relied on by Task 4 `Hub`):
  - Relay -> app: one JSON line. Hook events: the Claude Code payload with `transcript_path` removed, `tool_response` removed unless `tool_name` is `Agent` or `Task`, strings capped at 2000 chars, plus `"sb_kind": "hook"`, `"sb_wait": "permission" | "question" | "reply" | null`, `"term_program": "<TERM_PROGRAM>"`, and `cwd` filled from the process cwd if missing. Status line: the status-line JSON plus `"sb_kind": "statusline"`.
  - App -> relay (only when `sb_wait` is not null): one JSON line, one of `{"behavior":"allow"|"deny"}`, `{"answers":{"<question>":"<string>",...}}`, `{"reply":"<text>"}`; or the connection closes with nothing written.
  - Relay -> Claude Code stdout, per wait kind (exact shapes in `output.rs`).

- [ ] **Step 1: Crate manifest**

Add `"hook"` to `members` in the root `Cargo.toml`.

`hook/Cargo.toml`:
```toml
[package]
name = "sb-relay"
description = "Relays Claude Code hook and status-line events to session-buddy"
version.workspace = true
edition.workspace = true
license.workspace = true

[[bin]]
name = "sb-relay"
path = "src/main.rs"

[dependencies]
serde_json = "1"
sb-common = { path = "../common" }

[target.'cfg(windows)'.dependencies]
windows = { version = "0.61", features = [
  "Win32_Foundation",
  "Win32_Security",
  "Win32_Security_Authorization",
  "Win32_System_Pipes",
  "Win32_System_Threading",
] }
```

- [ ] **Step 2: Write the failing tests for output.rs**

`hook/src/output.rs`:
```rust
//! What the relay prints for Claude Code once a human answered on the island.
//! Anything unexpected prints nothing: silence hands the question back to the
//! terminal, which is always safe.

use serde_json::{json, Value};
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WaitKind {
    Permission,
    Question,
    Reply,
}

impl WaitKind {
    pub fn as_str(self) -> &'static str { todo!() }
    pub fn budget(self) -> Duration { todo!() }
}

pub fn wait_kind(payload: &Value) -> Option<WaitKind> { todo!() }

pub fn hook_output(kind: WaitKind, original: &Value, answer: &Value) -> Option<String> { todo!() }

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(s: &str) -> Value {
        serde_json::from_str(s).unwrap()
    }

    #[test]
    fn classifies_blocking_events() {
        assert_eq!(wait_kind(&json!({"hook_event_name":"PermissionRequest"})), Some(WaitKind::Permission));
        assert_eq!(
            wait_kind(&json!({"hook_event_name":"PreToolUse","tool_name":"AskUserQuestion"})),
            Some(WaitKind::Question)
        );
        assert_eq!(wait_kind(&json!({"hook_event_name":"PreToolUse","tool_name":"Bash"})), None);
        assert_eq!(
            wait_kind(&json!({"hook_event_name":"Stop","stop_hook_active":false,"last_assistant_message":"Shall I push it?"})),
            Some(WaitKind::Reply)
        );
        // Markdown and whitespace after the question mark still count.
        assert_eq!(
            wait_kind(&json!({"hook_event_name":"Stop","last_assistant_message":"**Want me to continue?**\n\n"})),
            Some(WaitKind::Reply)
        );
        assert_eq!(
            wait_kind(&json!({"hook_event_name":"Stop","stop_hook_active":true,"last_assistant_message":"Again?"})),
            None
        );
        assert_eq!(wait_kind(&json!({"hook_event_name":"Stop","last_assistant_message":"Done."})), None);
        assert_eq!(wait_kind(&json!({"hook_event_name":"Stop"})), None);
        assert_eq!(wait_kind(&json!({"hook_event_name":"SessionStart"})), None);
    }

    #[test]
    fn budgets_exceed_app_deadlines() {
        assert_eq!(WaitKind::Permission.budget(), Duration::from_secs(112));
        assert_eq!(WaitKind::Question.budget(), Duration::from_secs(545));
        assert_eq!(WaitKind::Reply.budget(), Duration::from_secs(545));
    }

    #[test]
    fn permission_allow_and_deny() {
        let allow = hook_output(WaitKind::Permission, &json!({}), &json!({"behavior":"allow"})).unwrap();
        assert_eq!(
            parse(&allow),
            json!({"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}})
        );
        let deny = hook_output(WaitKind::Permission, &json!({}), &json!({"behavior":"deny"})).unwrap();
        assert_eq!(
            parse(&deny),
            json!({"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied from session-buddy"}}})
        );
        assert!(hook_output(WaitKind::Permission, &json!({}), &json!({"behavior":"maybe"})).is_none());
    }

    #[test]
    fn question_answers_go_into_updated_input() {
        let original = json!({"tool_name":"AskUserQuestion","tool_input":{"questions":[{"question":"Pick a color?","header":"Color","options":[{"label":"Red"},{"label":"Blue"}],"multiSelect":false}]}});
        let out = hook_output(WaitKind::Question, &original, &json!({"answers":{"Pick a color?":"Blue"}})).unwrap();
        assert_eq!(
            parse(&out),
            json!({"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{
                "questions":[{"question":"Pick a color?","header":"Color","options":[{"label":"Red"},{"label":"Blue"}],"multiSelect":false}],
                "answers":{"Pick a color?":"Blue"}}}})
        );
    }

    #[test]
    fn question_rejects_empty_or_non_string_answers() {
        let original = json!({"tool_input":{"questions":[]}});
        assert!(hook_output(WaitKind::Question, &original, &json!({"answers":{}})).is_none());
        assert!(hook_output(WaitKind::Question, &original, &json!({"answers":{"Q?":["a","b"]}})).is_none());
        assert!(hook_output(WaitKind::Question, &json!({}), &json!({"answers":{"Q?":"a"}})).is_none());
    }

    #[test]
    fn reply_blocks_stop_with_reason() {
        let out = hook_output(WaitKind::Reply, &json!({}), &json!({"reply":"  yes, push it  "})).unwrap();
        assert_eq!(parse(&out), json!({"decision":"block","reason":"yes, push it"}));
        assert!(hook_output(WaitKind::Reply, &json!({}), &json!({"reply":"   "})).is_none());
    }
}
```

- [ ] **Step 3: Write the failing tests for prepare.rs**

`hook/src/prepare.rs`:
```rust
//! Turns the raw hook JSON from stdin into the line we forward to the app,
//! keeping the untouched original for building the answer later.

use serde_json::Value;

use crate::output::{wait_kind, WaitKind};

const MAX_FIELD_LEN: usize = 2_000;

pub struct Prepared {
    pub line: String,
    pub original: Value,
    pub wait: Option<WaitKind>,
}

pub fn prepare(raw: &[u8], arg_event: &str, cwd: &str, term_program: &str) -> Option<Prepared> { todo!() }

pub fn truncate_strings(value: &mut Value) { todo!() }

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fwd(p: &Prepared) -> Value {
        assert!(p.line.ends_with('\n'));
        serde_json::from_str(p.line.trim_end()).unwrap()
    }

    #[test]
    fn strips_bom_and_fills_event_cwd_and_terminal() {
        let mut raw = vec![0xEF, 0xBB, 0xBF];
        raw.extend_from_slice(br#"{"session_id":"s1","transcript_path":"x"}"#);
        let p = prepare(&raw, "SessionStart", "C:/work", "WarpTerminal").unwrap();
        let v = fwd(&p);
        assert_eq!(v["hook_event_name"], "SessionStart");
        assert_eq!(v["cwd"], "C:/work");
        assert_eq!(v["term_program"], "WarpTerminal");
        assert_eq!(v["sb_kind"], "hook");
        assert!(v["sb_wait"].is_null());
        assert!(v.get("transcript_path").is_none());
        assert!(p.wait.is_none());
    }

    #[test]
    fn keeps_tool_response_only_for_agent_calls() {
        let raw = br#"{"hook_event_name":"PostToolUse","tool_name":"Bash","tool_response":{"stdout":"x"}}"#;
        assert!(fwd(&prepare(raw, "", "", "").unwrap()).get("tool_response").is_none());
        let raw = br#"{"hook_event_name":"PostToolUse","tool_name":"Agent","tool_response":{"agentId":"a1","description":"d"}}"#;
        assert_eq!(fwd(&prepare(raw, "", "", "").unwrap())["tool_response"]["agentId"], "a1");
    }

    #[test]
    fn marks_waits_and_keeps_untruncated_original() {
        let long = "x".repeat(5_000);
        let raw = serde_json::to_vec(&json!({
            "hook_event_name":"PreToolUse","tool_name":"AskUserQuestion",
            "tool_input":{"questions":[{"question": long}]}
        })).unwrap();
        let p = prepare(&raw, "", "", "").unwrap();
        assert_eq!(p.wait, Some(WaitKind::Question));
        assert_eq!(fwd(&p)["sb_wait"], "question");
        let forwarded = fwd(&p)["tool_input"]["questions"][0]["question"].as_str().unwrap().to_string();
        assert!(forwarded.chars().count() <= MAX_FIELD_LEN + 1);
        assert_eq!(p.original["tool_input"]["questions"][0]["question"].as_str().unwrap().len(), 5_000);
    }

    #[test]
    fn rejects_garbage() {
        assert!(prepare(b"", "Stop", "", "").is_none());
        assert!(prepare(b"not json", "Stop", "", "").is_none());
        assert!(prepare(b"[1,2]", "Stop", "", "").is_none());
    }

    #[test]
    fn truncates_on_char_boundary() {
        let mut v = json!({"a": "\u{e9}".repeat(3_000)});
        truncate_strings(&mut v);
        let s = v["a"].as_str().unwrap();
        assert!(s.ends_with('\u{2026}'));
        assert_eq!(s.chars().count(), MAX_FIELD_LEN + 1);
    }
}
```

- [ ] **Step 4: Run the tests to verify they fail**

Create a minimal `hook/src/main.rs` so the crate compiles for tests:
```rust
mod output;
mod prepare;
fn main() {}
```
Run: `cargo test -p sb-relay`
Expected: all tests panic with `not yet implemented`.

- [ ] **Step 5: Implement output.rs**

Replace the three `todo!()` bodies:
```rust
impl WaitKind {
    pub fn as_str(self) -> &'static str {
        match self {
            WaitKind::Permission => "permission",
            WaitKind::Question => "question",
            WaitKind::Reply => "reply",
        }
    }

    /// A little longer than the app's own deadline, so the app always decides first.
    pub fn budget(self) -> Duration {
        match self {
            WaitKind::Permission => Duration::from_secs(112),
            WaitKind::Question | WaitKind::Reply => Duration::from_secs(545),
        }
    }
}

/// The three cases where a human can answer from the island. Everything else is fire-and-forget.
pub fn wait_kind(payload: &Value) -> Option<WaitKind> {
    match payload.get("hook_event_name")?.as_str()? {
        "PermissionRequest" => Some(WaitKind::Permission),
        "PreToolUse" if payload.get("tool_name").and_then(Value::as_str) == Some("AskUserQuestion") => {
            Some(WaitKind::Question)
        }
        "Stop" => {
            if payload.get("stop_hook_active").and_then(Value::as_bool).unwrap_or(false) {
                return None;
            }
            let msg = payload.get("last_assistant_message")?.as_str()?;
            let trimmed = msg.trim_end_matches(|c: char| c.is_whitespace() || "*_`)\"'".contains(c));
            trimmed.ends_with('?').then_some(WaitKind::Reply)
        }
        _ => None,
    }
}

/// Claude Code's documented hook output for each kind, or None to stay silent.
pub fn hook_output(kind: WaitKind, original: &Value, answer: &Value) -> Option<String> {
    match kind {
        WaitKind::Permission => {
            let decision = match answer.get("behavior")?.as_str()? {
                "allow" => json!({"behavior": "allow"}),
                "deny" => json!({"behavior": "deny", "message": "Denied from session-buddy"}),
                _ => return None,
            };
            Some(
                json!({"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": decision}})
                    .to_string(),
            )
        }
        WaitKind::Question => {
            let answers = answer.get("answers")?.as_object()?;
            if answers.is_empty() || !answers.values().all(Value::is_string) {
                return None;
            }
            let mut input = original.get("tool_input")?.clone();
            input.as_object_mut()?.insert("answers".into(), Value::Object(answers.clone()));
            Some(
                json!({"hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "allow",
                    "updatedInput": input
                }})
                .to_string(),
            )
        }
        WaitKind::Reply => {
            let text = answer.get("reply")?.as_str()?.trim();
            if text.is_empty() {
                return None;
            }
            Some(json!({"decision": "block", "reason": text}).to_string())
        }
    }
}
```

- [ ] **Step 6: Implement prepare.rs**

```rust
pub fn prepare(raw: &[u8], arg_event: &str, cwd: &str, term_program: &str) -> Option<Prepared> {
    let bytes = raw.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(raw);
    if bytes.is_empty() {
        return None;
    }
    let mut original: Value = serde_json::from_slice(bytes).ok()?;
    let map = original.as_object_mut()?;

    let has_event = map
        .get("hook_event_name")
        .and_then(Value::as_str)
        .map(|s| !s.is_empty())
        .unwrap_or(false);
    if !has_event {
        map.insert("hook_event_name".into(), Value::String(arg_event.to_string()));
    }
    let cwd_missing = map.get("cwd").and_then(Value::as_str).map(str::is_empty).unwrap_or(true);
    if cwd_missing && !cwd.is_empty() {
        map.insert("cwd".into(), Value::String(cwd.to_string()));
    }

    let wait = wait_kind(&original);

    let mut fwd = original.clone();
    let fmap = fwd.as_object_mut()?;
    fmap.remove("transcript_path");
    let keeps_response = matches!(
        fmap.get("tool_name").and_then(Value::as_str),
        Some("Agent") | Some("Task")
    );
    if !keeps_response {
        fmap.remove("tool_response");
    }
    fmap.insert("term_program".into(), Value::String(term_program.to_string()));
    fmap.insert("sb_kind".into(), Value::String("hook".into()));
    fmap.insert(
        "sb_wait".into(),
        wait.map(|k| Value::String(k.as_str().into())).unwrap_or(Value::Null),
    );
    truncate_strings(&mut fwd);

    let mut line = fwd.to_string();
    line.push('\n');
    Some(Prepared { line, original, wait })
}

/// Caps every string. A single Write can carry a whole file.
pub fn truncate_strings(value: &mut Value) {
    match value {
        Value::String(s) => {
            if s.chars().count() > MAX_FIELD_LEN {
                let cut: String = s.chars().take(MAX_FIELD_LEN).collect();
                *s = cut + "\u{2026}";
            }
        }
        Value::Array(items) => items.iter_mut().for_each(truncate_strings),
        Value::Object(map) => map.values_mut().for_each(truncate_strings),
        _ => {}
    }
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cargo test -p sb-relay`
Expected: 11 tests pass.

- [ ] **Step 8: Transport, Windows check and main**

`hook/src/win.rs`: copy `coucou/windows/hook/src/win.rs` verbatim (it keeps its own `current_user_sid`, which `pipe_server_is_same_user` needs; a fallback user name must never pass the SID comparison). Only replace the header comment with `//! Windows only: check that the pipe server runs as the same user as the relay.`

`hook/src/transport.rs`:
```rust
//! Talking to the app. Every failure means "nobody is listening": return None
//! quickly and let Claude Code carry on.

use std::io::{Read, Write};
use std::time::{Duration, Instant};

const CONNECT_TIMEOUT: Duration = Duration::from_millis(100);

pub trait Conn: Read + Write {}
impl<T: Read + Write> Conn for T {}

#[cfg(windows)]
fn connect() -> Option<Box<dyn Conn>> {
    use std::os::windows::io::AsRawHandle;
    const ERROR_PIPE_BUSY: i32 = 231;
    let path = sb_common::pipe_name(&sb_common::user_key());
    let deadline = Instant::now() + CONNECT_TIMEOUT;
    loop {
        match std::fs::OpenOptions::new().read(true).write(true).open(&path) {
            Ok(file) => {
                let handle = windows::Win32::Foundation::HANDLE(file.as_raw_handle());
                return crate::win::pipe_server_is_same_user(handle).then(|| Box::new(file) as Box<dyn Conn>);
            }
            Err(err) => {
                if err.raw_os_error() != Some(ERROR_PIPE_BUSY) || Instant::now() >= deadline {
                    return None;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    }
}

#[cfg(unix)]
fn connect() -> Option<Box<dyn Conn>> {
    let _ = (Instant::now(), CONNECT_TIMEOUT);
    let stream = std::os::unix::net::UnixStream::connect(sb_common::socket_path()).ok()?;
    Some(Box::new(stream))
}

/// Sends one line. When `wait` is set, reads one answer line back.
pub fn send(line: &str, wait: bool) -> Option<String> {
    let mut conn = connect()?;
    conn.write_all(line.as_bytes()).ok()?;
    let _ = conn.flush();
    if !wait {
        return None;
    }
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        match conn.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.contains(&b'\n') {
                    break;
                }
            }
        }
    }
    let answer = String::from_utf8_lossy(&buf).trim().to_string();
    (!answer.is_empty()).then_some(answer)
}
```

`hook/src/main.rs`:
```rust
//! sb-relay: called by Claude Code for every hook event (`sb-relay hook <Event>`)
//! and as the status line (`sb-relay statusline [--quiet]`). It forwards the
//! JSON to session-buddy and, for the three blocking cases, prints the human's
//! answer. If the app is closed, slow or crashed, it prints nothing and exits:
//! Claude Code is never blocked.

mod output;
mod prepare;
mod transport;
#[cfg(windows)]
mod win;

use std::io::{Read, Write};
use std::sync::mpsc;
use std::time::Duration;

const FIRE_AND_FORGET_BUDGET: Duration = Duration::from_secs(2);
const STATUSLINE_BUDGET: Duration = Duration::from_millis(300);

fn read_stdin() -> Vec<u8> {
    let mut raw = Vec::new();
    let _ = std::io::stdin().read_to_end(&mut raw);
    raw
}

/// Runs `send` on a worker thread and gives up after `budget`.
fn send_within(line: String, wait: bool, budget: Duration) -> Option<String> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(transport::send(&line, wait));
    });
    rx.recv_timeout(budget).ok().flatten()
}

fn hook(arg_event: &str) {
    let raw = read_stdin();
    let cwd = std::env::current_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
    let term = std::env::var("TERM_PROGRAM").unwrap_or_default();
    let Some(p) = prepare::prepare(&raw, arg_event, &cwd, &term) else { return };
    let budget = p.wait.map(|k| k.budget()).unwrap_or(FIRE_AND_FORGET_BUDGET);
    let answer = send_within(p.line.clone(), p.wait.is_some(), budget);
    if let (Some(kind), Some(answer)) = (p.wait, answer) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&answer) {
            if let Some(out) = output::hook_output(kind, &p.original, &value) {
                let mut stdout = std::io::stdout();
                let _ = writeln!(stdout, "{out}");
                let _ = stdout.flush();
            }
        }
    }
}

/// Copies stdin to stdout first (the user's own status line reads it from the
/// pipe), then forwards the JSON to the app.
fn statusline(quiet: bool) {
    let raw = read_stdin();
    if !quiet {
        let mut stdout = std::io::stdout();
        let _ = stdout.write_all(&raw);
        let _ = stdout.flush();
    }
    let bytes = raw.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&raw);
    let Ok(mut value) = serde_json::from_slice::<serde_json::Value>(bytes) else { return };
    let Some(map) = value.as_object_mut() else { return };
    map.insert("sb_kind".into(), serde_json::Value::String("statusline".into()));
    let mut line = value.to_string();
    line.push('\n');
    let _ = send_within(line, false, STATUSLINE_BUDGET);
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("hook") => hook(args.get(2).map(String::as_str).unwrap_or("")),
        Some("statusline") => statusline(args.iter().any(|a| a == "--quiet")),
        _ => {}
    }
    std::process::exit(0);
}
```

- [ ] **Step 9: Build and smoke-test with no app running**

Run:
```bash
cargo build --release -p sb-relay
time (echo '{"hook_event_name":"PermissionRequest","session_id":"x","tool_name":"Bash"}' | ./target/release/sb-relay hook PermissionRequest)
echo '{"session_id":"x","cwd":"/tmp"}' | ./target/release/sb-relay statusline
echo '{"session_id":"x"}' | ./target/release/sb-relay statusline --quiet; echo "[exit $?]"
```
Expected: first command prints nothing and finishes in well under 1 s; the second prints the JSON back unchanged; the third prints only `[exit 0]`.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "Add sb-relay: hook forwarding, blocking answers and status-line tee"
```

### Task 3: Core crate - step labels and the session store

**Files:**
- Modify: `Cargo.toml` (members += `"core"`)
- Create: `core/Cargo.toml`, `core/src/lib.rs`, `core/src/steps.rs`, `core/src/store.rs`
- Create: `core/tests/fixtures/spike-events.jsonl` (copied from the brainstorming spike)
- Test: unit tests in `core/src/steps.rs`, `core/src/store.rs`

**Interfaces:**
- Produces (`sb_core::steps`): `clip(text: &str, max: usize) -> String`, `project_name(cwd: &str) -> String`, `tool_label(tool: &str) -> String`, `step_label(tool: &str, input: &Value) -> String`, `approval_target(tool: &str, input: &Value) -> String`.
- Produces (`sb_core::store`): `Status`, `Step`, `Agent`, `BackgroundTask`, `Stats`, `Interaction` (with `request_id()`), `Session`, `CueKind`, `Cue`, `Store` with:
  - `Store::default()`, pub fields `stale_after_ms: i64`, `remove_after_ms: i64`, `rate_limits: Option<(Value, i64)>`
  - `apply_hook(&mut self, p: &Value, now: i64) -> Vec<Cue>`
  - `apply_statusline(&mut self, p: &Value, now: i64) -> Vec<Cue>`
  - `resolve(&mut self, request_id: &str, answered: bool, now: i64) -> Option<String>`
  - `tick(&mut self, now: i64) -> bool`
  - `seed(&mut self, session: Session)`
  - `sessions_needing_branch(&mut self, now: i64, every_ms: i64) -> Vec<(String, String)>`
  - `set_branch(&mut self, id: &str, branch: Option<String>) -> bool`
  - `get(&self, id: &str) -> Option<&Session>`, `snapshot(&self) -> Vec<Session>`
  - Serialized JSON (camelCase) is the front end's `Session` type (Task 8).
- Hook payload extras read by the store (set by the Hub in Task 4): `sb_request_id: string`, `sb_wait_ms: number`.
- Produces (`sb_core`): `now_ms() -> i64`.

- [ ] **Step 1: Crate manifest and fixture**

Add `"core"` to `members` in the root `Cargo.toml`.

`core/Cargo.toml`:
```toml
[package]
name = "sb-core"
version.workspace = true
edition.workspace = true
license.workspace = true

[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = { version = "1", features = ["preserve_order"] }
tokio = { version = "1", features = ["io-util", "sync", "time", "macros", "rt"] }
chrono = { version = "0.4", default-features = false, features = ["clock", "std"] }

[dev-dependencies]
tokio = { version = "1", features = ["io-util", "sync", "time", "macros", "rt", "rt-multi-thread", "test-util"] }
tempfile = "3"
```

`core/src/lib.rs`:
```rust
//! session-buddy's core: everything that can be tested without a window.

pub mod bootstrap;
pub mod claude_settings;
pub mod hub;
pub mod steps;
pub mod store;
pub mod usage;

/// Milliseconds since the Unix epoch.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
```
Until Tasks 4-7 exist, create each of `bootstrap.rs`, `claude_settings.rs`, `hub.rs`, `usage.rs` as an empty file containing only `//! Filled in by a later task.` so the crate compiles.

Copy the spike capture:
```bash
mkdir -p core/tests/fixtures
cp "/c/Users/WolfgangLinz/AppData/Local/Temp/claude/C--Projects/f4065047-5e11-4658-aa37-db0249baa246/scratchpad/hookspike/events.jsonl" core/tests/fixtures/spike-events.jsonl
wc -l core/tests/fixtures/spike-events.jsonl
```
Expected: `11` lines, each `{"ev":"<Event>","payload":{...}}`. If the scratchpad file is gone (new machine or cleaned temp dir), recreate it with the content from the plan appendix "Spike fixture" at the end of this document.

- [ ] **Step 2: Write the failing tests for steps.rs**

`core/src/steps.rs`:
```rust
//! How a tool call reads on the island: "Edit · DatevClient.php".

use serde_json::Value;

pub fn clip(text: &str, max: usize) -> String { todo!() }
pub fn project_name(cwd: &str) -> String { todo!() }
pub fn tool_label(tool: &str) -> String { todo!() }
pub fn step_label(tool: &str, input: &Value) -> String { todo!() }
pub fn approval_target(tool: &str, input: &Value) -> String { todo!() }

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn clip_counts_chars_and_marks_the_cut() {
        assert_eq!(clip("hello", 10), "hello");
        assert_eq!(clip("hello world", 6), "hello\u{2026}");
        assert_eq!(clip("\u{e9}\u{e9}\u{e9}", 2), "\u{e9}\u{2026}");
    }

    #[test]
    fn project_from_cwd() {
        assert_eq!(project_name(r"C:\Projects\pushdocs"), "pushdocs");
        assert_eq!(project_name("/Users/w/code/bankconnect/"), "bankconnect");
        assert_eq!(project_name(""), "Session");
    }

    #[test]
    fn labels() {
        assert_eq!(tool_label("Bash"), "Run");
        assert_eq!(tool_label("PowerShell"), "Run");
        assert_eq!(tool_label("Grep"), "Search");
        assert_eq!(tool_label("mcp__datadog-bankconnect__search_datadog_logs"), "MCP datadog-bankconnect · search_datadog_logs");
        assert_eq!(tool_label("mcp__linear"), "MCP linear");
        assert_eq!(tool_label("SomethingNew"), "SomethingNew");
    }

    #[test]
    fn step_targets() {
        assert_eq!(step_label("Edit", &json!({"file_path": r"C:\p\src\DatevClient.php"})), "Edit · DatevClient.php");
        assert_eq!(step_label("Bash", &json!({"command": "git status\ngit diff"})), "Run · git status");
        assert_eq!(step_label("Agent", &json!({"description": "Find callers", "prompt": "long"})), "Agent · Find callers");
        assert_eq!(step_label("TodoWrite", &json!({"todos": []})), "Todos");
        let long = "x".repeat(200);
        assert_eq!(step_label("Grep", &json!({"pattern": long})).chars().count(), "Search · ".chars().count() + 80);
    }

    #[test]
    fn approval_target_is_complete() {
        let cmd = "rm -rf build && npm run build -- --mode production";
        assert_eq!(approval_target("Bash", &json!({"command": cmd})), format!("Bash · {cmd}"));
        assert_eq!(approval_target("Write", &json!({"file_path": r"C:\p\.env"})), r"Write · C:\p\.env");
        assert_eq!(approval_target("Mystery", &json!({})), "Mystery");
    }
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cargo test -p sb-core steps`
Expected: 5 tests panic with `not yet implemented`.

- [ ] **Step 4: Implement steps.rs**

```rust
pub fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max.saturating_sub(1)).collect();
    out.push('\u{2026}');
    out
}

fn last_component(path: &str) -> &str {
    let trimmed = path.trim_end_matches(['/', '\\']);
    trimmed.rsplit(['/', '\\']).next().unwrap_or(trimmed)
}

pub fn project_name(cwd: &str) -> String {
    let name = last_component(cwd);
    if name.is_empty() { "Session".into() } else { name.to_string() }
}

const LABELS: &[(&str, &str)] = &[
    ("Bash", "Run"),
    ("PowerShell", "Run"),
    ("Read", "Read"),
    ("Write", "Write"),
    ("Edit", "Edit"),
    ("MultiEdit", "Edit"),
    ("NotebookEdit", "Notebook"),
    ("Glob", "Find"),
    ("Grep", "Search"),
    ("LS", "List"),
    ("WebSearch", "Web search"),
    ("WebFetch", "Fetch"),
    ("TodoWrite", "Todos"),
    ("Task", "Agent"),
    ("Agent", "Agent"),
    ("ToolSearch", "Load tools"),
    ("Skill", "Skill"),
    ("AskUserQuestion", "Question"),
];

pub fn tool_label(tool: &str) -> String {
    if let Some(rest) = tool.strip_prefix("mcp__") {
        let mut parts = rest.splitn(2, "__");
        let server = parts.next().unwrap_or(rest);
        return match parts.next() {
            Some(name) if !name.is_empty() => format!("MCP {server} · {name}"),
            _ => format!("MCP {server}"),
        };
    }
    LABELS
        .iter()
        .find(|(t, _)| *t == tool)
        .map(|(_, l)| l.to_string())
        .unwrap_or_else(|| tool.to_string())
}

const STEP_FIELDS: &[&str] = &[
    "command", "file_path", "notebook_path", "path", "url", "query", "pattern", "skill", "description", "prompt",
];

fn field<'a>(input: &'a Value, key: &str) -> Option<&'a str> {
    input.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
}

pub fn step_label(tool: &str, input: &Value) -> String {
    let label = tool_label(tool);
    for key in STEP_FIELDS {
        if let Some(v) = field(input, key) {
            let shown = match *key {
                "file_path" | "notebook_path" | "path" => last_component(v),
                "command" | "prompt" | "description" => v.lines().next().unwrap_or(v),
                _ => v,
            };
            return format!("{label} · {}", clip(shown, 80));
        }
    }
    label
}

const APPROVAL_FIELDS: &[&str] = &["command", "file_path", "notebook_path", "path", "url", "query", "pattern", "prompt"];

/// What Allow actually authorises: the full command or path, never just the tool name.
pub fn approval_target(tool: &str, input: &Value) -> String {
    for key in APPROVAL_FIELDS {
        if let Some(v) = field(input, key) {
            return format!("{tool} · {}", clip(v, 600));
        }
    }
    tool.to_string()
}
```

- [ ] **Step 5: Run the steps tests to verify they pass**

Run: `cargo test -p sb-core steps`
Expected: 5 passed.

- [ ] **Step 6: Write the store types and failing tests**

`core/src/store.rs`, part 1 (types, helpers, and the test module; the `impl Store` bodies come in Step 8):
```rust
//! Every Claude Code session, built from hook and status-line events.
//! Pure state: no I/O, no clock. Callers pass `now` in epoch milliseconds.

use std::collections::{HashMap, VecDeque};

use serde::Serialize;
use serde_json::Value;

use crate::steps::{approval_target, clip, project_name, step_label};

pub const MAX_STEPS: usize = 50;
pub const FINISHED_TO_IDLE_MS: i64 = 30_000;
pub const DEFAULT_STALE_AFTER_MS: i64 = 10 * 60_000;
pub const DEFAULT_REMOVE_AFTER_MS: i64 = 2 * 60 * 60_000;
const ENDED_AGENT_KEEP_MS: i64 = 10 * 60_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Thinking,
    Working,
    NeedsYou,
    Finished,
    Error,
    Idle,
    Stale,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub tool: String,
    pub label: String,
    pub at: i64,
    pub ok: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Agent {
    pub id: String,
    pub agent_type: String,
    pub description: Option<String>,
    pub running: bool,
    pub current_step: Option<String>,
    pub started_at: i64,
    pub ended_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundTask {
    pub id: String,
    pub kind: String,
    pub status: String,
    pub description: String,
    pub agent_type: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub lines_added: u64,
    pub lines_removed: u64,
    pub context_used_pct: Option<f64>,
    pub context_tokens: Option<u64>,
    pub context_size: Option<u64>,
    pub cost_usd: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum Interaction {
    Approval { request_id: String, tool: String, target: String, agent_id: Option<String>, deadline: i64 },
    Question { request_id: String, questions: Value, deadline: i64 },
    Reply { request_id: String, message: String, deadline: i64 },
}

impl Interaction {
    pub fn request_id(&self) -> &str {
        match self {
            Interaction::Approval { request_id, .. }
            | Interaction::Question { request_id, .. }
            | Interaction::Reply { request_id, .. } => request_id,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub project: String,
    pub cwd: String,
    pub branch: Option<String>,
    pub term_program: Option<String>,
    pub model: Option<String>,
    pub status: Status,
    pub status_since: i64,
    pub last_prompt: Option<String>,
    pub last_message: Option<String>,
    pub steps: VecDeque<Step>,
    pub agents: Vec<Agent>,
    pub background: Vec<BackgroundTask>,
    pub stats: Stats,
    pub pending: VecDeque<Interaction>,
    pub started_at: i64,
    pub last_event_at: i64,
    /// (subagent_type, description) from main-thread Agent calls, waiting for their SubagentStart.
    #[serde(skip)]
    pub agent_descriptions: Vec<(String, String)>,
    #[serde(skip)]
    pub branch_checked_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CueKind {
    Work,
    Finish,
    Error,
    Approval,
    Rate,
    Context,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cue {
    pub session_id: String,
    pub kind: CueKind,
}

pub struct Store {
    sessions: HashMap<String, Session>,
    pub stale_after_ms: i64,
    pub remove_after_ms: i64,
    /// Latest `rate_limits` object seen in a status-line payload, with when it arrived.
    pub rate_limits: Option<(Value, i64)>,
}

impl Default for Store {
    fn default() -> Self {
        Self {
            sessions: HashMap::new(),
            stale_after_ms: DEFAULT_STALE_AFTER_MS,
            remove_after_ms: DEFAULT_REMOVE_AFTER_MS,
            rate_limits: None,
        }
    }
}

fn s<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str).filter(|x| !x.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const T0: i64 = 1_000_000;

    fn ev(event: &str, extra: Value) -> Value {
        let mut v = json!({"hook_event_name": event, "session_id": "s1", "cwd": r"C:\Projects\pushdocs"});
        for (k, val) in extra.as_object().unwrap() {
            v[k] = val.clone();
        }
        v
    }

    fn sess(store: &Store) -> &Session {
        store.get("s1").expect("session s1")
    }

    #[test]
    fn session_created_with_project_and_terminal() {
        let mut st = Store::default();
        let cues = st.apply_hook(&ev("SessionStart", json!({"term_program": "WarpTerminal"})), T0);
        assert_eq!(cues, vec![Cue { session_id: "s1".into(), kind: CueKind::Work }]);
        let s = sess(&st);
        assert_eq!(s.project, "pushdocs");
        assert_eq!(s.term_program.as_deref(), Some("WarpTerminal"));
        assert_eq!(s.status, Status::Idle);
        assert_eq!(s.started_at, T0);
    }

    #[test]
    fn prompt_then_tool_then_failure() {
        let mut st = Store::default();
        st.apply_hook(&ev("UserPromptSubmit", json!({"prompt": "fix the DATEV 409 handling"})), T0);
        assert_eq!(sess(&st).status, Status::Thinking);
        assert_eq!(sess(&st).last_prompt.as_deref(), Some("fix the DATEV 409 handling"));
        st.apply_hook(&ev("PreToolUse", json!({"tool_name": "Edit", "tool_input": {"file_path": "a/DatevClient.php"}})), T0 + 1);
        assert_eq!(sess(&st).status, Status::Working);
        assert_eq!(sess(&st).steps.back().unwrap().label, "Edit · DatevClient.php");
        assert_eq!(sess(&st).steps.back().unwrap().ok, None);
        st.apply_hook(&ev("PostToolUseFailure", json!({"tool_name": "Edit"})), T0 + 2);
        assert_eq!(sess(&st).steps.back().unwrap().ok, Some(false));
    }

    #[test]
    fn steps_ring_buffer_caps_at_50() {
        let mut st = Store::default();
        for i in 0..60 {
            st.apply_hook(&ev("PreToolUse", json!({"tool_name": "Read", "tool_input": {"file_path": format!("f{i}.rs")}})), T0 + i);
        }
        let steps = &sess(&st).steps;
        assert_eq!(steps.len(), MAX_STEPS);
        assert_eq!(steps.front().unwrap().label, "Read · f10.rs");
    }

    #[test]
    fn permission_needs_you_until_resolved() {
        let mut st = Store::default();
        let cues = st.apply_hook(
            &ev("PermissionRequest", json!({"tool_name": "Bash", "tool_input": {"command": "rm -rf build"}, "sb_request_id": "r1", "sb_wait_ms": 110_000})),
            T0,
        );
        assert_eq!(cues[0].kind, CueKind::Approval);
        let s = sess(&st);
        assert_eq!(s.status, Status::NeedsYou);
        assert_eq!(
            s.pending[0],
            Interaction::Approval { request_id: "r1".into(), tool: "Bash".into(), target: "Bash · rm -rf build".into(), agent_id: None, deadline: T0 + 110_000 }
        );
        // Work events while waiting must not hide the card.
        st.apply_hook(&ev("PostToolUse", json!({"tool_name": "Read"})), T0 + 5);
        assert_eq!(sess(&st).status, Status::NeedsYou);
        assert_eq!(st.resolve("r1", true, T0 + 10), Some("s1".into()));
        assert_eq!(sess(&st).status, Status::Working);
        assert!(sess(&st).pending.is_empty());
        assert_eq!(st.resolve("r1", true, T0 + 11), None);
    }

    #[test]
    fn permission_without_request_id_is_ignored() {
        let mut st = Store::default();
        let cues = st.apply_hook(&ev("PermissionRequest", json!({"tool_name": "Bash"})), T0);
        assert!(cues.is_empty());
        assert!(sess(&st).pending.is_empty());
    }

    #[test]
    fn question_and_reply_queue_in_order() {
        let mut st = Store::default();
        st.apply_hook(
            &ev("PreToolUse", json!({"tool_name": "AskUserQuestion", "tool_input": {"questions": [{"question": "Pick?", "options": [{"label": "A"}]}]}, "sb_request_id": "q1", "sb_wait_ms": 540_000})),
            T0,
        );
        st.apply_hook(&ev("Stop", json!({"last_assistant_message": "Push now?", "sb_request_id": "p1", "sb_wait_ms": 540_000})), T0 + 1);
        let s = sess(&st);
        assert_eq!(s.pending.len(), 2);
        assert!(matches!(&s.pending[0], Interaction::Question { request_id, .. } if request_id == "q1"));
        assert!(matches!(&s.pending[1], Interaction::Reply { request_id, message, .. } if request_id == "p1" && message == "Push now?"));
        // An AskUserQuestion is never shown as a step.
        assert!(s.steps.is_empty());
        st.resolve("q1", true, T0 + 2);
        assert_eq!(sess(&st).status, Status::NeedsYou);
        // Released in the terminal: the turn is over, so the session is finished, not thinking.
        st.resolve("p1", false, T0 + 3);
        assert_eq!(sess(&st).status, Status::Finished);
    }

    #[test]
    fn stop_finishes_with_cue_then_idle_after_30s() {
        let mut st = Store::default();
        st.apply_hook(&ev("UserPromptSubmit", json!({"prompt": "go"})), T0);
        let cues = st.apply_hook(&ev("Stop", json!({"last_assistant_message": "All done."})), T0 + 1_000);
        assert_eq!(cues[0].kind, CueKind::Finish);
        assert_eq!(sess(&st).status, Status::Finished);
        assert_eq!(sess(&st).last_message.as_deref(), Some("All done."));
        assert!(!st.tick(T0 + 1_000 + FINISHED_TO_IDLE_MS - 1));
        assert!(st.tick(T0 + 1_000 + FINISHED_TO_IDLE_MS));
        assert_eq!(sess(&st).status, Status::Idle);
    }

    #[test]
    fn stop_failure_is_error() {
        let mut st = Store::default();
        let cues = st.apply_hook(&ev("StopFailure", json!({})), T0);
        assert_eq!(cues[0].kind, CueKind::Error);
        assert_eq!(sess(&st).status, Status::Error);
    }

    #[test]
    fn stale_then_removed() {
        let mut st = Store::default();
        st.apply_hook(&ev("SessionStart", json!({})), T0);
        st.tick(T0 + DEFAULT_STALE_AFTER_MS - 1);
        assert_eq!(sess(&st).status, Status::Idle);
        st.tick(T0 + DEFAULT_STALE_AFTER_MS);
        assert_eq!(sess(&st).status, Status::Stale);
        st.tick(T0 + DEFAULT_STALE_AFTER_MS + DEFAULT_REMOVE_AFTER_MS - 1);
        assert!(st.get("s1").is_some());
        assert!(st.tick(T0 + DEFAULT_STALE_AFTER_MS + DEFAULT_REMOVE_AFTER_MS));
        assert!(st.get("s1").is_none());
    }

    #[test]
    fn pending_session_never_goes_stale() {
        let mut st = Store::default();
        st.apply_hook(&ev("PermissionRequest", json!({"tool_name": "Bash", "sb_request_id": "r1", "sb_wait_ms": 1})), T0);
        st.tick(T0 + DEFAULT_STALE_AFTER_MS * 2);
        assert_eq!(sess(&st).status, Status::NeedsYou);
    }

    #[test]
    fn stale_session_revives_on_event() {
        let mut st = Store::default();
        st.apply_hook(&ev("SessionStart", json!({})), T0);
        st.tick(T0 + DEFAULT_STALE_AFTER_MS);
        st.apply_hook(&ev("Notification", json!({"message": "Claude is waiting for your input"})), T0 + DEFAULT_STALE_AFTER_MS + 5);
        assert_eq!(sess(&st).status, Status::Idle);
    }

    #[test]
    fn rate_limit_notification_cues() {
        let mut st = Store::default();
        let cues = st.apply_hook(&ev("Notification", json!({"message": "Claude usage limit reached"})), T0);
        assert_eq!(cues[0].kind, CueKind::Rate);
    }

    #[test]
    fn session_end_removes() {
        let mut st = Store::default();
        st.apply_hook(&ev("SessionStart", json!({})), T0);
        st.apply_hook(&ev("SessionEnd", json!({})), T0 + 1);
        assert!(st.get("s1").is_none());
        assert!(st.snapshot().is_empty());
    }

    #[test]
    fn subagent_attribution_from_spike() {
        let mut st = Store::default();
        let fixture = include_str!("../tests/fixtures/spike-events.jsonl");
        let mut sid = String::new();
        for (i, line) in fixture.lines().filter(|l| !l.trim().is_empty()).enumerate() {
            let row: Value = serde_json::from_str(line).unwrap();
            sid = row["payload"]["session_id"].as_str().unwrap().to_string();
            st.apply_hook(&row["payload"], T0 + i as i64);
        }
        let s = st.get(&sid).unwrap();
        let labels: Vec<&str> = s.steps.iter().map(|x| x.label.as_str()).collect();
        assert!(labels.contains(&"Agent · Run shell command and reply DONE"));
        assert!(labels.contains(&"Load tools · select:AskUserQuestion"));
        assert!(!labels.iter().any(|l| l.contains("hello-from-subagent")), "sub-agent step leaked into main thread: {labels:?}");
        assert_eq!(s.agents.len(), 1);
        let a = &s.agents[0];
        assert_eq!(a.id, "ad7c4b5d237f7193a");
        assert_eq!(a.agent_type, "general-purpose");
        assert_eq!(a.description.as_deref(), Some("Run shell command and reply DONE"));
        assert!(!a.running);
        assert!(a.ended_at.is_some());
        assert_eq!(s.status, Status::Finished);
        assert!(s.background.is_empty(), "last Stop reported no background tasks");
    }

    #[test]
    fn agent_current_step_and_background_tasks() {
        let mut st = Store::default();
        st.apply_hook(&ev("PreToolUse", json!({"tool_name": "Agent", "tool_input": {"subagent_type": "Explore", "description": "Find callers"}})), T0);
        st.apply_hook(&ev("SubagentStart", json!({"agent_id": "a1", "agent_type": "Explore"})), T0 + 1);
        st.apply_hook(&ev("PreToolUse", json!({"agent_id": "a1", "agent_type": "Explore", "tool_name": "Grep", "tool_input": {"pattern": "409"}})), T0 + 2);
        let s = sess(&st);
        assert_eq!(s.agents[0].current_step.as_deref(), Some("Search · 409"));
        assert_eq!(s.agents[0].description.as_deref(), Some("Find callers"));
        assert_eq!(s.steps.len(), 1, "only the Agent call itself is a main-thread step");
        st.apply_hook(
            &ev("Stop", json!({"last_assistant_message": "Started.", "background_tasks": [{"id": "a1", "type": "subagent", "status": "running", "description": "Find callers", "agent_type": "Explore"}]})),
            T0 + 3,
        );
        assert_eq!(
            sess(&st).background,
            vec![BackgroundTask { id: "a1".into(), kind: "subagent".into(), status: "running".into(), description: "Find callers".into(), agent_type: Some("Explore".into()) }]
        );
    }

    #[test]
    fn ended_agents_are_pruned_after_10_minutes() {
        let mut st = Store::default();
        st.apply_hook(&ev("SubagentStart", json!({"agent_id": "a1", "agent_type": "Plan"})), T0);
        st.apply_hook(&ev("SubagentStop", json!({"agent_id": "a1", "agent_type": "Plan"})), T0 + 1);
        st.tick(T0 + 1 + 10 * 60_000 - 1);
        assert_eq!(sess(&st).agents.len(), 1);
        st.tick(T0 + 1 + 10 * 60_000);
        assert!(sess(&st).agents.is_empty());
    }

    #[test]
    fn statusline_stats_context_cue_and_rate_limits() {
        let mut st = Store::default();
        let p = json!({
            "session_id": "s1", "cwd": r"C:\Projects\pushdocs",
            "model": {"display_name": "Opus 5.5"},
            "cost": {"total_lines_added": 128, "total_lines_removed": 34, "total_cost_usd": 1.25},
            "context_window": {"used_percentage": 61.0, "context_window_size": 200000},
            "rate_limits": {"five_hour": {"used_percentage": 42.0}}
        });
        assert!(st.apply_statusline(&p, T0).is_empty());
        let s = sess(&st);
        assert_eq!(s.model.as_deref(), Some("Opus 5.5"));
        assert_eq!(s.stats.lines_added, 128);
        assert_eq!(s.stats.lines_removed, 34);
        assert_eq!(s.stats.context_tokens, Some(122_000));
        assert_eq!(s.stats.context_size, Some(200_000));
        assert_eq!(st.rate_limits.as_ref().unwrap().1, T0);
        let mut hot = p.clone();
        hot["context_window"]["used_percentage"] = json!(91.0);
        assert_eq!(st.apply_statusline(&hot, T0 + 1)[0].kind, CueKind::Context);
        // Only on the crossing, not on every refresh.
        assert!(st.apply_statusline(&hot, T0 + 2).is_empty());
    }

    #[test]
    fn statusline_does_not_keep_a_session_fresh() {
        let mut st = Store::default();
        st.apply_hook(&ev("SessionStart", json!({})), T0);
        st.apply_statusline(&json!({"session_id": "s1"}), T0 + DEFAULT_STALE_AFTER_MS - 1);
        st.tick(T0 + DEFAULT_STALE_AFTER_MS);
        assert_eq!(sess(&st).status, Status::Stale);
    }

    #[test]
    fn branch_lookups_are_rate_limited() {
        let mut st = Store::default();
        st.apply_hook(&ev("SessionStart", json!({})), T0);
        assert_eq!(st.sessions_needing_branch(T0, 30_000), vec![("s1".to_string(), r"C:\Projects\pushdocs".to_string())]);
        assert!(st.sessions_needing_branch(T0 + 29_999, 30_000).is_empty());
        assert!(st.set_branch("s1", Some("PDD-1981".into())));
        assert!(!st.set_branch("s1", Some("PDD-1981".into())));
        assert_eq!(sess(&st).branch.as_deref(), Some("PDD-1981"));
        assert_eq!(st.sessions_needing_branch(T0 + 30_000, 30_000).len(), 1);
    }

    #[test]
    fn snapshot_is_ordered_by_start() {
        let mut st = Store::default();
        st.apply_hook(&json!({"hook_event_name": "SessionStart", "session_id": "b", "cwd": "/x/b"}), T0 + 5);
        st.apply_hook(&json!({"hook_event_name": "SessionStart", "session_id": "a", "cwd": "/x/a"}), T0);
        let ids: Vec<String> = st.snapshot().into_iter().map(|s| s.id).collect();
        assert_eq!(ids, vec!["a", "b"]);
    }

    #[test]
    fn serializes_for_the_front_end() {
        let mut st = Store::default();
        st.apply_hook(&ev("PermissionRequest", json!({"tool_name": "Bash", "sb_request_id": "r1", "sb_wait_ms": 1})), T0);
        let v = serde_json::to_value(st.snapshot()).unwrap();
        assert_eq!(v[0]["status"], "needs_you");
        assert_eq!(v[0]["pending"][0]["kind"], "approval");
        assert_eq!(v[0]["pending"][0]["requestId"], "r1");
        assert!(v[0].get("agentDescriptions").is_none());
        assert!(v[0]["stats"].get("linesAdded").is_some());
    }
}
```

- [ ] **Step 7: Run the tests to verify they fail**

Add an empty `impl Store {}` plus stub methods that `todo!()` so the module compiles:
```rust
impl Store {
    pub fn get(&self, _id: &str) -> Option<&Session> { todo!() }
    pub fn snapshot(&self) -> Vec<Session> { todo!() }
    pub fn apply_hook(&mut self, _p: &Value, _now: i64) -> Vec<Cue> { todo!() }
    pub fn apply_statusline(&mut self, _p: &Value, _now: i64) -> Vec<Cue> { todo!() }
    pub fn resolve(&mut self, _id: &str, _answered: bool, _now: i64) -> Option<String> { todo!() }
    pub fn tick(&mut self, _now: i64) -> bool { todo!() }
    pub fn seed(&mut self, _s: Session) { todo!() }
    pub fn sessions_needing_branch(&mut self, _now: i64, _every: i64) -> Vec<(String, String)> { todo!() }
    pub fn set_branch(&mut self, _id: &str, _b: Option<String>) -> bool { todo!() }
}
```
Run: `cargo test -p sb-core store`
Expected: 20 tests fail with `not yet implemented`.

- [ ] **Step 8: Implement the store**

Replace the stub `impl Store` with the following, and add `impl Session`:
```rust
impl Session {
    pub fn new(id: &str, now: i64) -> Self {
        Self {
            id: id.to_string(),
            project: "Session".into(),
            cwd: String::new(),
            branch: None,
            term_program: None,
            model: None,
            status: Status::Idle,
            status_since: now,
            last_prompt: None,
            last_message: None,
            steps: VecDeque::new(),
            agents: Vec::new(),
            background: Vec::new(),
            stats: Stats::default(),
            pending: VecDeque::new(),
            started_at: now,
            last_event_at: now,
            agent_descriptions: Vec::new(),
            branch_checked_at: i64::MIN / 2,
        }
    }

    /// An open interaction always wins: the session needs the user until it is answered.
    fn set_status(&mut self, wanted: Status, now: i64) {
        let next = if self.pending.is_empty() { wanted } else { Status::NeedsYou };
        if next != self.status {
            self.status = next;
            self.status_since = now;
        }
    }

    fn push_step(&mut self, tool: &str, label: String, now: i64) {
        self.steps.push_back(Step { tool: tool.to_string(), label, at: now, ok: None });
        while self.steps.len() > MAX_STEPS {
            self.steps.pop_front();
        }
    }

    fn finish_step(&mut self, tool: &str, ok: bool) {
        if let Some(step) = self.steps.iter_mut().rev().find(|x| x.tool == tool && x.ok.is_none()) {
            step.ok = Some(ok);
        }
    }

    fn agent_entry(&mut self, id: &str, agent_type: Option<&str>, now: i64) -> &mut Agent {
        if let Some(i) = self.agents.iter().position(|a| a.id == id) {
            if let Some(t) = agent_type {
                self.agents[i].agent_type = t.to_string();
            }
            return &mut self.agents[i];
        }
        self.agents.push(Agent {
            id: id.to_string(),
            agent_type: agent_type.unwrap_or("agent").to_string(),
            description: None,
            running: true,
            current_step: None,
            started_at: now,
            ended_at: None,
        });
        self.agents.last_mut().expect("just pushed")
    }

    /// The description of the oldest waiting Agent call of this type (or any type).
    fn take_description(&mut self, agent_type: &str) -> Option<String> {
        let i = self
            .agent_descriptions
            .iter()
            .position(|(t, _)| t == agent_type)
            .or(if self.agent_descriptions.is_empty() { None } else { Some(0) })?;
        let (_, d) = self.agent_descriptions.remove(i);
        (!d.is_empty()).then_some(d)
    }

    fn update_background(&mut self, p: &Value) {
        let Some(list) = p.get("background_tasks").and_then(Value::as_array) else { return };
        self.background = list
            .iter()
            .map(|t| BackgroundTask {
                id: s(t, "id").unwrap_or_default().to_string(),
                kind: s(t, "type").unwrap_or("task").to_string(),
                status: s(t, "status").unwrap_or("running").to_string(),
                description: s(t, "description").unwrap_or_default().to_string(),
                agent_type: s(t, "agent_type").map(str::to_string),
            })
            .collect();
    }
}

impl Store {
    pub fn get(&self, id: &str) -> Option<&Session> {
        self.sessions.get(id)
    }

    pub fn snapshot(&self) -> Vec<Session> {
        let mut list: Vec<Session> = self.sessions.values().cloned().collect();
        list.sort_by(|a, b| a.started_at.cmp(&b.started_at).then_with(|| a.id.cmp(&b.id)));
        list
    }

    /// Finds or creates the session and refreshes cwd / project / terminal.
    fn touch(&mut self, p: &Value, now: i64) -> Option<&mut Session> {
        let id = s(p, "session_id")?;
        let sess = self.sessions.entry(id.to_string()).or_insert_with(|| Session::new(id, now));
        if let Some(cwd) = s(p, "cwd") {
            if sess.cwd != cwd {
                sess.cwd = cwd.to_string();
                sess.project = project_name(cwd);
                sess.branch_checked_at = i64::MIN / 2;
            }
        }
        if let Some(t) = s(p, "term_program") {
            sess.term_program = Some(t.to_string());
        }
        Some(sess)
    }

    pub fn apply_hook(&mut self, p: &Value, now: i64) -> Vec<Cue> {
        let event = s(p, "hook_event_name").unwrap_or_default();
        let Some(id) = s(p, "session_id").map(str::to_string) else { return Vec::new() };
        if event == "SessionEnd" {
            self.sessions.remove(&id);
            return Vec::new();
        }
        let Some(sess) = self.touch(p, now) else { return Vec::new() };
        sess.last_event_at = now;
        if sess.status == Status::Stale {
            sess.set_status(Status::Idle, now);
        }

        let request_id = s(p, "sb_request_id").map(str::to_string);
        let deadline = now + p.get("sb_wait_ms").and_then(Value::as_i64).unwrap_or(0);
        let agent_id = s(p, "agent_id").map(str::to_string);
        let agent_type = s(p, "agent_type");
        let tool = s(p, "tool_name").unwrap_or("Tool").to_string();
        let empty = Value::Object(Default::default());
        let input = p.get("tool_input").unwrap_or(&empty);
        let is_agent_tool = tool == "Agent" || tool == "Task";

        let mut cues = Vec::new();
        let mut cue = |kind| cues.push(Cue { session_id: id.clone(), kind });

        match event {
            "SessionStart" => cue(CueKind::Work),
            "UserPromptSubmit" => {
                if let Some(t) = s(p, "prompt") {
                    sess.last_prompt = Some(clip(t, 300));
                }
                sess.set_status(Status::Thinking, now);
            }
            "PreToolUse" if tool == "AskUserQuestion" => {
                if let Some(request_id) = request_id {
                    let questions = input.get("questions").cloned().unwrap_or(Value::Array(Vec::new()));
                    sess.pending.push_back(Interaction::Question { request_id, questions, deadline });
                    sess.set_status(Status::NeedsYou, now);
                    cue(CueKind::Approval);
                }
            }
            "PreToolUse" => {
                let label = step_label(&tool, input);
                match &agent_id {
                    Some(aid) => {
                        let a = sess.agent_entry(aid, agent_type, now);
                        a.current_step = Some(label);
                        a.running = true;
                    }
                    None => {
                        if is_agent_tool {
                            let t = s(input, "subagent_type").unwrap_or("general-purpose").to_string();
                            let d = s(input, "description").unwrap_or_default().to_string();
                            sess.agent_descriptions.push((t, d));
                        }
                        sess.push_step(&tool, label, now);
                    }
                }
                sess.set_status(Status::Working, now);
            }
            "PostToolUse" | "PostToolUseFailure" => {
                if agent_id.is_none() {
                    sess.finish_step(&tool, event == "PostToolUse");
                }
                if is_agent_tool {
                    if let Some(resp) = p.get("tool_response") {
                        if let (Some(aid), Some(desc)) = (s(resp, "agentId"), s(resp, "description")) {
                            if let Some(a) = sess.agents.iter_mut().find(|a| a.id == aid) {
                                a.description = Some(desc.to_string());
                            }
                        }
                    }
                }
                if sess.status != Status::Finished {
                    sess.set_status(Status::Working, now);
                }
            }
            "PermissionRequest" => {
                if let Some(request_id) = request_id {
                    sess.pending.push_back(Interaction::Approval {
                        request_id,
                        tool: tool.clone(),
                        target: approval_target(&tool, input),
                        agent_id: agent_id.clone(),
                        deadline,
                    });
                    sess.set_status(Status::NeedsYou, now);
                    cue(CueKind::Approval);
                }
            }
            "Notification" => {
                let m = s(p, "message").unwrap_or_default().to_lowercase();
                if m.contains("rate limit") || m.contains("usage limit") {
                    cue(CueKind::Rate);
                }
            }
            "Stop" => {
                if let Some(m) = s(p, "last_assistant_message") {
                    sess.last_message = Some(clip(m, 2_000));
                }
                sess.update_background(p);
                match request_id {
                    Some(request_id) => {
                        let message = sess.last_message.clone().unwrap_or_default();
                        sess.pending.push_back(Interaction::Reply { request_id, message, deadline });
                        sess.set_status(Status::NeedsYou, now);
                        cue(CueKind::Approval);
                    }
                    None => {
                        sess.set_status(Status::Finished, now);
                        if sess.status == Status::Finished {
                            cue(CueKind::Finish);
                        }
                    }
                }
            }
            "StopFailure" => {
                sess.set_status(Status::Error, now);
                cue(CueKind::Error);
            }
            "SubagentStart" => {
                if let Some(aid) = &agent_id {
                    let t = agent_type.unwrap_or("agent").to_string();
                    let desc = sess.take_description(&t);
                    let a = sess.agent_entry(aid, Some(&t), now);
                    a.running = true;
                    if a.description.is_none() {
                        a.description = desc;
                    }
                }
            }
            "SubagentStop" => {
                if let Some(aid) = &agent_id {
                    let a = sess.agent_entry(aid, agent_type, now);
                    a.running = false;
                    a.ended_at = Some(now);
                    a.current_step = None;
                }
                sess.update_background(p);
            }
            _ => {}
        }
        cues
    }

    pub fn apply_statusline(&mut self, p: &Value, now: i64) -> Vec<Cue> {
        if let Some(rl) = p.get("rate_limits").filter(|v| v.is_object()) {
            self.rate_limits = Some((rl.clone(), now));
        }
        let Some(sess) = self.touch(p, now) else { return Vec::new() };
        if let Some(m) = p.pointer("/model/display_name").and_then(Value::as_str) {
            sess.model = Some(m.to_string());
        }
        if let Some(c) = p.get("cost") {
            sess.stats.lines_added = c.get("total_lines_added").and_then(Value::as_u64).unwrap_or(sess.stats.lines_added);
            sess.stats.lines_removed = c.get("total_lines_removed").and_then(Value::as_u64).unwrap_or(sess.stats.lines_removed);
            sess.stats.cost_usd = c.get("total_cost_usd").and_then(Value::as_f64).or(sess.stats.cost_usd);
        }
        let mut cues = Vec::new();
        if let Some(cw) = p.get("context_window") {
            let before = sess.stats.context_used_pct.unwrap_or(0.0);
            let pct = cw.get("used_percentage").and_then(Value::as_f64);
            let size = cw.get("context_window_size").and_then(Value::as_u64);
            sess.stats.context_used_pct = pct;
            sess.stats.context_size = size;
            sess.stats.context_tokens = match (pct, size) {
                (Some(pc), Some(sz)) => Some((pc / 100.0 * sz as f64).round() as u64),
                _ => None,
            };
            if let Some(pc) = pct {
                if before < 90.0 && pc >= 90.0 {
                    cues.push(Cue { session_id: sess.id.clone(), kind: CueKind::Context });
                }
            }
        }
        cues
    }

    /// Drops an open interaction. `answered` = the human answered on the island;
    /// false = released to the terminal (button, deadline or closed connection).
    pub fn resolve(&mut self, request_id: &str, answered: bool, now: i64) -> Option<String> {
        for sess in self.sessions.values_mut() {
            let Some(i) = sess.pending.iter().position(|x| x.request_id() == request_id) else { continue };
            let item = sess.pending.remove(i).expect("index from position");
            let next = match (item, answered) {
                (Interaction::Reply { .. }, true) => Status::Thinking,
                (Interaction::Reply { .. }, false) => Status::Finished,
                _ => Status::Working,
            };
            sess.status = Status::Idle; // force set_status to stamp status_since
            sess.set_status(next, now);
            return Some(sess.id.clone());
        }
        None
    }

    /// Time-based transitions. Returns true when anything changed.
    pub fn tick(&mut self, now: i64) -> bool {
        let stale = self.stale_after_ms;
        let remove = self.remove_after_ms;
        let mut changed = false;
        self.sessions.retain(|_, s| {
            let keep = !(s.status == Status::Stale && now - s.last_event_at >= stale + remove);
            changed |= !keep;
            keep
        });
        for s in self.sessions.values_mut() {
            if s.status == Status::Finished && now - s.status_since >= FINISHED_TO_IDLE_MS {
                s.set_status(Status::Idle, now);
                changed = true;
            }
            if s.pending.is_empty() && s.status != Status::Stale && now - s.last_event_at >= stale {
                s.set_status(Status::Stale, now);
                changed = true;
            }
            let before = s.agents.len();
            s.agents.retain(|a| a.running || a.ended_at.map_or(true, |e| now - e < ENDED_AGENT_KEEP_MS));
            changed |= s.agents.len() != before;
        }
        changed
    }

    /// Adds a session found on disk at start-up; never overwrites a live one.
    pub fn seed(&mut self, session: Session) {
        self.sessions.entry(session.id.clone()).or_insert(session);
    }

    pub fn sessions_needing_branch(&mut self, now: i64, every_ms: i64) -> Vec<(String, String)> {
        let mut out = Vec::new();
        for s in self.sessions.values_mut() {
            if !s.cwd.is_empty() && now - s.branch_checked_at >= every_ms {
                s.branch_checked_at = now;
                out.push((s.id.clone(), s.cwd.clone()));
            }
        }
        out.sort();
        out
    }

    pub fn set_branch(&mut self, id: &str, branch: Option<String>) -> bool {
        match self.sessions.get_mut(id) {
            Some(s) if s.branch != branch => {
                s.branch = branch;
                true
            }
            _ => false,
        }
    }
}
```

Note on `resolve`: setting `sess.status = Status::Idle` before `set_status(next)` would wrongly produce `Idle` when `next == Idle`; `next` is never `Idle` here, so the stamp is always applied.

- [ ] **Step 9: Run the tests to verify they pass**

Run: `cargo test -p sb-core`
Expected: 25 passed (5 steps + 20 store).

If `subagent_attribution_from_spike` fails because the fixture's last `Stop` arrives while the agent is still listed in `background_tasks`, check the fixture: its final `Stop` has `"background_tasks":[]`, so `s.background` must be empty.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "Add core session store with step labels, sub-agents and cues"
```

---

### Task 4: Core crate - the Hub (relay protocol server)

**Files:**
- Modify: `core/src/hub.rs`
- Test: unit tests in `core/src/hub.rs`

**Interfaces:**
- Consumes: `store::{Store, Cue}`, wire protocol from Task 2.
- Produces (`sb_core::hub`):
  - `pub struct Hub { pub store: Mutex<Store>, .. }`
  - `Hub::new(notify: impl Fn(Vec<Cue>) + Send + Sync + 'static) -> Arc<Hub>` (called after every store change, possibly with an empty Vec)
  - `Hub::with_timeouts(notify, ack: Duration, permission: Duration, long: Duration) -> Arc<Hub>` (tests)
  - `async fn serve<S: AsyncRead + AsyncWrite + Unpin + Send>(self: Arc<Self>, stream: S)`
  - `fn ack(&self, request_id: &str)`, `fn answer(&self, request_id: &str, answer: &Value) -> Result<(), String>`, `fn release(&self, request_id: &str)`
  - Defaults: ack 800 ms, permission 110 s, question/reply 540 s.

- [ ] **Step 1: Write the failing tests**

`core/src/hub.rs`:
```rust
//! The app side of the relay protocol. One connection = one hook event. For the
//! three blocking kinds the connection stays open until the island answers,
//! the user hands it back to the terminal, the deadline passes or the relay
//! goes away - whichever comes first.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc;

use crate::now_ms;
use crate::store::{Cue, Store};

const MAX_LINE: usize = 1 << 20;

pub enum Reply {
    Ack,
    Answer(String),
    Release,
}

type Notify = Box<dyn Fn(Vec<Cue>) + Send + Sync>;

pub struct Hub {
    pub store: Mutex<Store>,
    pending: Mutex<HashMap<String, mpsc::Sender<Reply>>>,
    counter: AtomicU64,
    notify: Notify,
    ack_timeout: Duration,
    wait_permission: Duration,
    wait_long: Duration,
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{duplex, AsyncBufReadExt, BufReader};

    fn hub() -> Arc<Hub> {
        Hub::with_timeouts(|_| {}, Duration::from_millis(150), Duration::from_millis(600), Duration::from_millis(600))
    }

    async fn send(h: &Arc<Hub>, payload: Value) -> (tokio::task::JoinHandle<()>, tokio::io::DuplexStream) {
        let (client, server) = duplex(1 << 16);
        let task = tokio::spawn(h.clone().serve(server));
        let mut client = client;
        client.write_all(format!("{payload}\n").as_bytes()).await.unwrap();
        (task, client)
    }

    async fn read_answer(client: tokio::io::DuplexStream) -> String {
        let mut line = String::new();
        let _ = BufReader::new(client).read_line(&mut line).await;
        line.trim().to_string()
    }

    fn pending_id(h: &Hub) -> Option<String> {
        h.store.lock().unwrap().snapshot().iter().flat_map(|s| s.pending.iter()).map(|p| p.request_id().to_string()).next()
    }

    async fn wait_for_pending(h: &Hub) -> String {
        for _ in 0..100 {
            if let Some(id) = pending_id(h) {
                return id;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("no pending interaction appeared");
    }

    fn permission(session: &str) -> Value {
        json!({"sb_kind":"hook","sb_wait":"permission","hook_event_name":"PermissionRequest","session_id":session,"cwd":"/p/x","tool_name":"Bash","tool_input":{"command":"ls"}})
    }

    #[tokio::test]
    async fn fire_and_forget_updates_store() {
        let h = hub();
        let (task, _client) = send(&h, json!({"sb_kind":"hook","sb_wait":null,"hook_event_name":"SessionStart","session_id":"s1","cwd":"/p/x"})).await;
        task.await.unwrap();
        assert!(h.store.lock().unwrap().get("s1").is_some());
    }

    #[tokio::test]
    async fn statusline_updates_stats() {
        let h = hub();
        let (task, _c) = send(&h, json!({"sb_kind":"statusline","session_id":"s1","cost":{"total_lines_added":3}})).await;
        task.await.unwrap();
        assert_eq!(h.store.lock().unwrap().get("s1").unwrap().stats.lines_added, 3);
    }

    #[tokio::test]
    async fn ack_then_answer_reaches_relay() {
        let h = hub();
        let (task, client) = send(&h, permission("s1")).await;
        let id = wait_for_pending(&h).await;
        h.ack(&id);
        h.answer(&id, &json!({"behavior":"allow"})).unwrap();
        assert_eq!(read_answer(client).await, r#"{"behavior":"allow"}"#);
        task.await.unwrap();
        assert!(pending_id(&h).is_none());
    }

    #[tokio::test]
    async fn no_ack_means_terminal() {
        let h = hub();
        let (task, client) = send(&h, permission("s1")).await;
        let _ = wait_for_pending(&h).await;
        assert_eq!(read_answer(client).await, "");
        task.await.unwrap();
        assert!(pending_id(&h).is_none());
    }

    #[tokio::test]
    async fn release_means_terminal() {
        let h = hub();
        let (task, client) = send(&h, permission("s1")).await;
        let id = wait_for_pending(&h).await;
        h.ack(&id);
        h.release(&id);
        assert_eq!(read_answer(client).await, "");
        task.await.unwrap();
    }

    #[tokio::test]
    async fn deadline_means_terminal_and_late_answer_fails() {
        let h = hub();
        let (task, client) = send(&h, permission("s1")).await;
        let id = wait_for_pending(&h).await;
        h.ack(&id);
        assert_eq!(read_answer(client).await, "");
        task.await.unwrap();
        assert!(h.answer(&id, &json!({"behavior":"allow"})).is_err());
    }

    #[tokio::test]
    async fn client_disconnect_releases() {
        let h = hub();
        let (task, client) = send(&h, permission("s1")).await;
        let id = wait_for_pending(&h).await;
        h.ack(&id);
        drop(client);
        tokio::time::timeout(Duration::from_millis(200), task).await.expect("released promptly").unwrap();
        assert!(pending_id(&h).is_none());
    }

    #[tokio::test]
    async fn invalid_answers_are_rejected() {
        let h = hub();
        let (_task, _client) = send(&h, permission("s1")).await;
        let id = wait_for_pending(&h).await;
        assert!(h.answer(&id, &json!({"behavior":"maybe"})).is_err());
        assert!(h.answer(&id, &json!({"answers":{}})).is_err());
        assert!(h.answer(&id, &json!({"answers":{"Q?":1}})).is_err());
        assert!(h.answer(&id, &json!({"reply":"  "})).is_err());
        assert!(h.answer(&id, &json!({"reply":"yes"})).is_ok());
    }

    #[tokio::test]
    async fn two_pending_answers_route_by_id() {
        let h = hub();
        let (t1, c1) = send(&h, permission("a")).await;
        let (t2, c2) = send(&h, json!({"sb_kind":"hook","sb_wait":"question","hook_event_name":"PreToolUse","session_id":"b","tool_name":"AskUserQuestion","tool_input":{"questions":[]}})).await;
        let mut ids = Vec::new();
        for _ in 0..100 {
            ids = h.store.lock().unwrap().snapshot().iter().flat_map(|s| s.pending.iter().map(move |p| (s.id.clone(), p.request_id().to_string()))).collect::<Vec<_>>();
            if ids.len() == 2 { break; }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let id_a = ids.iter().find(|(s, _)| s == "a").unwrap().1.clone();
        let id_b = ids.iter().find(|(s, _)| s == "b").unwrap().1.clone();
        h.ack(&id_a);
        h.ack(&id_b);
        h.answer(&id_b, &json!({"answers":{"Q?":"x"}})).unwrap();
        h.answer(&id_a, &json!({"behavior":"deny"})).unwrap();
        assert_eq!(read_answer(c1).await, r#"{"behavior":"deny"}"#);
        assert_eq!(read_answer(c2).await, r#"{"answers":{"Q?":"x"}}"#);
        t1.await.unwrap();
        t2.await.unwrap();
    }

    #[tokio::test]
    async fn notify_is_called_with_cues() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let h = Hub::with_timeouts(move |c| sink.lock().unwrap().extend(c), Duration::from_millis(50), Duration::from_millis(50), Duration::from_millis(50));
        let (task, _c) = send(&h, json!({"sb_kind":"hook","hook_event_name":"SessionStart","session_id":"s1"})).await;
        task.await.unwrap();
        assert_eq!(seen.lock().unwrap().len(), 1);
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Add stubs so it compiles:
```rust
impl Hub {
    pub fn new(_n: impl Fn(Vec<Cue>) + Send + Sync + 'static) -> Arc<Self> { todo!() }
    pub fn with_timeouts(_n: impl Fn(Vec<Cue>) + Send + Sync + 'static, _a: Duration, _p: Duration, _l: Duration) -> Arc<Self> { todo!() }
    pub async fn serve<S: AsyncRead + AsyncWrite + Unpin + Send>(self: Arc<Self>, _s: S) { todo!() }
    pub fn ack(&self, _id: &str) { todo!() }
    pub fn answer(&self, _id: &str, _a: &Value) -> Result<(), String> { todo!() }
    pub fn release(&self, _id: &str) { todo!() }
}
```
Run: `cargo test -p sb-core hub`
Expected: 10 tests fail.

- [ ] **Step 3: Implement the Hub**

Replace the stubs:
```rust
impl Hub {
    pub fn new(notify: impl Fn(Vec<Cue>) + Send + Sync + 'static) -> Arc<Self> {
        Self::with_timeouts(notify, Duration::from_millis(800), Duration::from_secs(110), Duration::from_secs(540))
    }

    pub fn with_timeouts(
        notify: impl Fn(Vec<Cue>) + Send + Sync + 'static,
        ack_timeout: Duration,
        wait_permission: Duration,
        wait_long: Duration,
    ) -> Arc<Self> {
        Arc::new(Self {
            store: Mutex::new(Store::default()),
            pending: Mutex::new(HashMap::new()),
            counter: AtomicU64::new(1),
            notify: Box::new(notify),
            ack_timeout,
            wait_permission,
            wait_long,
        })
    }

    pub async fn serve<S>(self: Arc<Self>, stream: S)
    where
        S: AsyncRead + AsyncWrite + Unpin + Send,
    {
        let (mut rd, mut wr) = tokio::io::split(stream);
        let Some(mut payload) = read_line_json(&mut rd).await else { return };

        if payload.get("sb_kind").and_then(Value::as_str) == Some("statusline") {
            let cues = self.store.lock().unwrap().apply_statusline(&payload, now_ms());
            (self.notify)(cues);
            return;
        }

        let wait = payload.get("sb_wait").and_then(Value::as_str).map(str::to_string);
        let Some(kind) = wait else {
            let cues = self.store.lock().unwrap().apply_hook(&payload, now_ms());
            (self.notify)(cues);
            return;
        };

        let budget = if kind == "permission" { self.wait_permission } else { self.wait_long };
        let id = format!("r{}", self.counter.fetch_add(1, Ordering::Relaxed));
        let (tx, mut rx) = mpsc::channel::<Reply>(8);
        self.pending.lock().unwrap().insert(id.clone(), tx);
        payload["sb_request_id"] = json!(id);
        payload["sb_wait_ms"] = json!(budget.as_millis() as i64);
        let cues = self.store.lock().unwrap().apply_hook(&payload, now_ms());
        (self.notify)(cues);

        let outcome = self.wait(&mut rx, budget, &mut rd).await;

        self.pending.lock().unwrap().remove(&id);
        self.store.lock().unwrap().resolve(&id, outcome.is_some(), now_ms());
        (self.notify)(Vec::new());

        if let Some(line) = outcome {
            let _ = wr.write_all(format!("{line}\n").as_bytes()).await;
            let _ = wr.flush().await;
        }
    }

    /// Two waits: a short one for "the card is on screen", then the long one for a human.
    async fn wait<R: AsyncRead + Unpin>(
        &self,
        rx: &mut mpsc::Receiver<Reply>,
        budget: Duration,
        rd: &mut R,
    ) -> Option<String> {
        let first = tokio::select! {
            r = tokio::time::timeout(self.ack_timeout, rx.recv()) => r,
            _ = closed(rd) => return None,
        };
        match first {
            Ok(Some(Reply::Ack)) => {}
            Ok(Some(Reply::Answer(a))) => return Some(a),
            _ => return None,
        }
        let deadline = tokio::time::Instant::now() + budget;
        loop {
            let next = tokio::select! {
                r = tokio::time::timeout_at(deadline, rx.recv()) => r,
                _ = closed(rd) => return None,
            };
            match next {
                Ok(Some(Reply::Ack)) => continue,
                Ok(Some(Reply::Answer(a))) => return Some(a),
                _ => return None,
            }
        }
    }

    fn send(&self, request_id: &str, reply: Reply) -> Result<(), String> {
        let tx = self.pending.lock().unwrap().get(request_id).cloned();
        match tx {
            Some(tx) => tx.try_send(reply).map_err(|e| e.to_string()),
            None => Err("This question was already answered in the terminal.".into()),
        }
    }

    /// The island has the card on screen.
    pub fn ack(&self, request_id: &str) {
        let _ = self.send(request_id, Reply::Ack);
    }

    pub fn answer(&self, request_id: &str, answer: &Value) -> Result<(), String> {
        let behavior_ok = matches!(answer.get("behavior").and_then(Value::as_str), Some("allow" | "deny"));
        let answers_ok = answer
            .get("answers")
            .and_then(Value::as_object)
            .map(|m| !m.is_empty() && m.values().all(Value::is_string))
            .unwrap_or(false);
        let reply_ok = answer.get("reply").and_then(Value::as_str).map(|t| !t.trim().is_empty()).unwrap_or(false);
        if !(behavior_ok || answers_ok || reply_ok) {
            return Err("invalid answer".into());
        }
        self.send(request_id, Reply::Answer(answer.to_string()))
    }

    /// "Answer in terminal".
    pub fn release(&self, request_id: &str) {
        let _ = self.send(request_id, Reply::Release);
    }
}

async fn read_line_json<R: AsyncRead + Unpin>(rd: &mut R) -> Option<Value> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        match rd.read(&mut chunk).await {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.contains(&b'\n') || buf.len() > MAX_LINE {
                    break;
                }
            }
            Err(_) => return None,
        }
    }
    let end = buf.iter().position(|b| *b == b'\n').unwrap_or(buf.len());
    let v: Value = serde_json::from_slice(&buf[..end]).ok()?;
    v.is_object().then_some(v)
}

/// Resolves when the relay closes its end (Claude Code killed the hook).
async fn closed<R: AsyncRead + Unpin>(rd: &mut R) {
    let mut b = [0u8; 64];
    loop {
        match rd.read(&mut b).await {
            Ok(0) | Err(_) => return,
            Ok(_) => continue,
        }
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p sb-core hub`
Expected: 10 passed. (The relay never writes after its first line, so `closed` only fires on EOF.)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Add hub: relay protocol with ack, answer, release and disconnect handling"
```

### Task 5: Core crate - transcript bootstrap and git branch lookup

**Files:**
- Modify: `core/src/bootstrap.rs`, `core/src/lib.rs` (add `pub mod branch;`)
- Create: `core/src/branch.rs`
- Test: unit tests in both files

**Interfaces:**
- Consumes: `store::{Session, Status}`, `steps::{clip, project_name}`.
- Produces (`sb_core::bootstrap`): `struct Seed { session_id: String, cwd: String, last_prompt: Option<String>, last_message: Option<String>, modified_ms: i64 }`, `parse_tail(text: &str) -> (Option<String>, Option<String>, Option<String>, Option<String>)` (session id, cwd, last prompt, last message), `scan(projects_dir: &Path, now: i64, max_age_ms: i64) -> Vec<Seed>`, `session_from_seed(seed: &Seed, now: i64, stale_after_ms: i64) -> Session`.
- Produces (`sb_core::branch`): `lookup(cwd: &str) -> Option<String>`.

- [ ] **Step 1: Write the failing tests**

`core/src/bootstrap.rs`:
```rust
//! After the app (re)starts, sessions that are already running only show up on
//! their next hook event. Reading the tail of each recent transcript fills the
//! list right away: project, last prompt, last message.

use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use serde_json::Value;

use crate::steps::{clip, project_name};
use crate::store::{Session, Status};

const TAIL_BYTES: u64 = 512 * 1024;
const TAIL_LINES: usize = 200;

#[derive(Debug, Clone, PartialEq)]
pub struct Seed {
    pub session_id: String,
    pub cwd: String,
    pub last_prompt: Option<String>,
    pub last_message: Option<String>,
    pub modified_ms: i64,
}

pub fn parse_tail(text: &str) -> (Option<String>, Option<String>, Option<String>, Option<String>) { todo!() }
pub fn scan(projects_dir: &Path, now: i64, max_age_ms: i64) -> Vec<Seed> { todo!() }
pub fn session_from_seed(seed: &Seed, now: i64, stale_after_ms: i64) -> Session { todo!() }

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn lines(rows: &[Value]) -> String {
        rows.iter().map(|r| r.to_string()).collect::<Vec<_>>().join("\n") + "\n"
    }

    fn transcript() -> String {
        lines(&[
            json!({"type":"user","sessionId":"s1","cwd":"C:\\Projects\\pushdocs","message":{"role":"user","content":"<command-name>/clear</command-name>"}}),
            json!({"type":"user","sessionId":"s1","cwd":"C:\\Projects\\pushdocs","message":{"role":"user","content":"fix the DATEV 409 handling"}}),
            json!({"type":"assistant","sessionId":"s1","message":{"content":[{"type":"tool_use","name":"Read"}]}}),
            json!({"type":"user","sessionId":"s1","message":{"content":[{"type":"tool_result","content":"..."}]}}),
            json!({"type":"user","sessionId":"s1","isMeta":true,"message":{"content":"meta noise"}}),
            json!({"type":"assistant","sessionId":"s1","message":{"content":[{"type":"text","text":"Fixed. "},{"type":"text","text":"Tests pass."}]}}),
        ])
    }

    #[test]
    fn parses_last_real_prompt_and_message() {
        let (id, cwd, prompt, msg) = parse_tail(&transcript());
        assert_eq!(id.as_deref(), Some("s1"));
        assert_eq!(cwd.as_deref(), Some("C:\\Projects\\pushdocs"));
        assert_eq!(prompt.as_deref(), Some("fix the DATEV 409 handling"));
        assert_eq!(msg.as_deref(), Some("Fixed. Tests pass."));
    }

    #[test]
    fn ignores_garbage_lines() {
        let (id, _, _, _) = parse_tail("not json\n{\"broken\":\n");
        assert!(id.is_none());
    }

    #[test]
    fn scans_recent_transcripts_only() {
        let dir = tempfile::tempdir().unwrap();
        let proj = dir.path().join("C--Projects-pushdocs");
        std::fs::create_dir_all(proj.join("s1").join("subagents")).unwrap();
        std::fs::write(proj.join("s1.jsonl"), transcript()).unwrap();
        std::fs::write(proj.join("s1").join("subagents").join("agent-x.jsonl"), transcript()).unwrap();
        std::fs::write(proj.join("notes.txt"), "x").unwrap();
        let now = crate::now_ms();
        let seeds = scan(dir.path(), now, 2 * 60 * 60_000);
        assert_eq!(seeds.len(), 1, "sub-agent transcripts and other files are skipped");
        assert_eq!(seeds[0].session_id, "s1");
        assert_eq!(seeds[0].last_prompt.as_deref(), Some("fix the DATEV 409 handling"));
        // Three hours later the same file is too old.
        assert!(scan(dir.path(), now + 3 * 60 * 60_000, 2 * 60 * 60_000).is_empty());
    }

    #[test]
    fn missing_dir_is_empty() {
        assert!(scan(Path::new("/definitely/not/here"), 0, 1).is_empty());
    }

    #[test]
    fn seed_becomes_idle_or_stale() {
        let seed = Seed { session_id: "s1".into(), cwd: "/p/bankconnect".into(), last_prompt: Some("p".into()), last_message: None, modified_ms: 1_000 };
        let fresh = session_from_seed(&seed, 1_000 + 60_000, 10 * 60_000);
        assert_eq!(fresh.status, Status::Idle);
        assert_eq!(fresh.project, "bankconnect");
        assert_eq!(fresh.last_event_at, 1_000);
        let old = session_from_seed(&seed, 1_000 + 11 * 60_000, 10 * 60_000);
        assert_eq!(old.status, Status::Stale);
    }
}
```

`core/src/branch.rs`:
```rust
//! The git branch of a session's working directory. Called off the hook path.

use std::process::Command;

pub fn lookup(cwd: &str) -> Option<String> { todo!() }

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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p sb-core bootstrap branch`
(cargo takes one filter; run `cargo test -p sb-core bootstrap` then `cargo test -p sb-core branch`.)
Expected: all fail with `not yet implemented`.

- [ ] **Step 3: Implement**

`core/src/bootstrap.rs` bodies:
```rust
fn text_of(content: &Value) -> Option<String> {
    match content {
        Value::String(s) => Some(s.clone()),
        Value::Array(items) => {
            let parts: Vec<&str> = items
                .iter()
                .filter(|i| i.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|i| i.get("text").and_then(Value::as_str))
                .collect();
            (!parts.is_empty()).then(|| parts.concat())
        }
        _ => None,
    }
}

pub fn parse_tail(text: &str) -> (Option<String>, Option<String>, Option<String>, Option<String>) {
    let (mut id, mut cwd, mut prompt, mut message) = (None, None, None, None);
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        if let Some(s) = v.get("sessionId").and_then(Value::as_str) {
            id = Some(s.to_string());
        }
        if let Some(c) = v.get("cwd").and_then(Value::as_str).filter(|c| !c.is_empty()) {
            cwd = Some(c.to_string());
        }
        if v.get("isMeta").and_then(Value::as_bool).unwrap_or(false) {
            continue;
        }
        let Some(content) = v.pointer("/message/content") else { continue };
        match v.get("type").and_then(Value::as_str) {
            Some("user") => {
                // Only typed prompts: tool results are arrays, wrappers start with '<'.
                if let Value::String(s) = content {
                    let t = s.trim();
                    if !t.is_empty() && !t.starts_with('<') {
                        prompt = Some(clip(t, 300));
                    }
                }
            }
            Some("assistant") => {
                if let Some(t) = text_of(content).filter(|t| !t.trim().is_empty()) {
                    message = Some(clip(t.trim(), 2_000));
                }
            }
            _ => {}
        }
    }
    (id, cwd, prompt, message)
}

fn read_tail(path: &Path) -> Option<String> {
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let start = len.saturating_sub(TAIL_BYTES);
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf).to_string();
    let mut lines: Vec<&str> = text.lines().collect();
    if start > 0 && !lines.is_empty() {
        lines.remove(0); // first line is cut in the middle
    }
    let keep = lines.len().saturating_sub(TAIL_LINES);
    Some(lines[keep..].join("\n"))
}

fn modified_ms(path: &Path) -> Option<i64> {
    let t = std::fs::metadata(path).ok()?.modified().ok()?;
    Some(t.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as i64)
}

pub fn scan(projects_dir: &Path, now: i64, max_age_ms: i64) -> Vec<Seed> {
    let mut seeds = Vec::new();
    let Ok(projects) = std::fs::read_dir(projects_dir) else { return seeds };
    for project in projects.flatten() {
        let Ok(files) = std::fs::read_dir(project.path()) else { continue };
        for file in files.flatten() {
            let path = file.path();
            if !path.is_file() || path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let Some(mtime) = modified_ms(&path) else { continue };
            if now - mtime > max_age_ms {
                continue;
            }
            let Some(text) = read_tail(&path) else { continue };
            let (id, cwd, last_prompt, last_message) = parse_tail(&text);
            let session_id = id.unwrap_or_else(|| path.file_stem().unwrap_or_default().to_string_lossy().to_string());
            seeds.push(Seed { session_id, cwd: cwd.unwrap_or_default(), last_prompt, last_message, modified_ms: mtime });
        }
    }
    seeds.sort_by_key(|s| s.modified_ms);
    seeds
}

pub fn session_from_seed(seed: &Seed, now: i64, stale_after_ms: i64) -> Session {
    let mut s = Session::new(&seed.session_id, seed.modified_ms);
    s.cwd = seed.cwd.clone();
    s.project = project_name(&seed.cwd);
    s.last_prompt = seed.last_prompt.clone();
    s.last_message = seed.last_message.clone();
    s.last_event_at = seed.modified_ms;
    s.status = if now - seed.modified_ms >= stale_after_ms { Status::Stale } else { Status::Idle };
    s.status_since = now;
    s
}
```

`core/src/branch.rs` body:
```rust
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
```
Add `pub mod branch;` to `core/src/lib.rs`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p sb-core`
Expected: all previous tests plus 6 new ones pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Seed sessions from recent transcripts and look up git branches"
```

---

### Task 6: Core crate - settings.json install / uninstall

**Files:**
- Modify: `core/src/claude_settings.rs`
- Test: unit tests in the same file

**Interfaces:**
- Produces (`sb_core::claude_settings`): `MARKER`, `HOOK_EVENTS: &[(&str, u64)]`, `struct Installed { settings: Value, saved_status_line: Option<Value> }`, `install(existing: &Value, relay: &str) -> Installed`, `uninstall(existing: &Value, saved: Option<&Value>) -> Value`, `hooks_installed(v: &Value) -> bool`, `status_line_installed(v: &Value) -> bool`, `status_line_command(relay: &str, original: Option<&Value>) -> String`, `parse_settings(bytes: &[u8]) -> Result<Value, String>`, `pretty(v: &Value) -> String`, `fingerprint(bytes: &[u8]) -> String`, `unified_diff(before: &str, after: &str) -> String`, `write_atomic(path: &Path, next: &Value, expected_fingerprint: &str) -> Result<PathBuf, String>` (returns the backup path).
- `relay` is the relay path with forward slashes, e.g. `C:/Users/WolfgangLinz/AppData/Local/session-buddy/bin/sb-relay.exe`.

- [ ] **Step 1: Write the failing tests**

`core/src/claude_settings.rs`:
```rust
//! Adding and removing session-buddy's entries in ~/.claude/settings.json.
//! Only entries whose command contains MARKER are ever touched.

use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

pub const MARKER: &str = "sb-relay";

/// Every event the island reacts to, with the hook timeout written to settings.json.
pub const HOOK_EVENTS: &[(&str, u64)] = &[
    ("SessionStart", 10),
    ("SessionEnd", 10),
    ("UserPromptSubmit", 10),
    ("PreToolUse", 600),
    ("PostToolUse", 10),
    ("PostToolUseFailure", 10),
    ("PermissionRequest", 120),
    ("Notification", 10),
    ("Stop", 600),
    ("StopFailure", 10),
    ("SubagentStart", 10),
    ("SubagentStop", 10),
];

pub struct Installed {
    pub settings: Value,
    /// The user's own statusLine, when this install replaced it. None when there
    /// was none, or when ours was already in place (keep the saved one then).
    pub saved_status_line: Option<Value>,
}

pub fn install(existing: &Value, relay: &str) -> Installed { todo!() }
pub fn uninstall(existing: &Value, saved: Option<&Value>) -> Value { todo!() }
pub fn hooks_installed(v: &Value) -> bool { todo!() }
pub fn status_line_installed(v: &Value) -> bool { todo!() }
pub fn status_line_command(relay: &str, original: Option<&Value>) -> String { todo!() }
pub fn parse_settings(bytes: &[u8]) -> Result<Value, String> { todo!() }
pub fn pretty(v: &Value) -> String { todo!() }
pub fn fingerprint(bytes: &[u8]) -> String { todo!() }
pub fn unified_diff(before: &str, after: &str) -> String { todo!() }
pub fn write_atomic(path: &Path, next: &Value, expected_fingerprint: &str) -> Result<PathBuf, String> { todo!() }

#[cfg(test)]
mod tests {
    use super::*;

    const RELAY: &str = "C:/Users/w/AppData/Local/session-buddy/bin/sb-relay.exe";

    fn user_settings() -> Value {
        json!({
            "model": "opus",
            "hooks": {
                "PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "my-guard.sh"}]}],
                "Stop": [{"hooks": [{"type": "command", "command": "\"C:/x/coucou-hook.exe\" Stop"}]}]
            },
            "statusLine": {"type": "command", "command": "python ~/.claude/statusline.py", "padding": 0},
            "permissions": {"allow": ["Bash(ls:*)"]}
        })
    }

    #[test]
    fn install_adds_hooks_and_keeps_user_entries() {
        let out = install(&user_settings(), RELAY);
        let hooks = &out.settings["hooks"];
        assert_eq!(hooks["PreToolUse"].as_array().unwrap().len(), 2);
        assert_eq!(hooks["PreToolUse"][0]["hooks"][0]["command"], "my-guard.sh");
        assert_eq!(hooks["PreToolUse"][1]["hooks"][0]["command"], format!("\"{RELAY}\" hook PreToolUse"));
        assert_eq!(hooks["PreToolUse"][1]["hooks"][0]["timeout"], 600);
        assert_eq!(hooks["PermissionRequest"][0]["hooks"][0]["timeout"], 120);
        assert_eq!(hooks["Stop"][0]["hooks"][0]["command"], "\"C:/x/coucou-hook.exe\" Stop", "foreign hooks untouched");
        for (event, _) in HOOK_EVENTS {
            assert!(hooks[*event].as_array().unwrap().iter().any(|e| e.to_string().contains(MARKER)), "{event}");
        }
        assert!(hooks_installed(&out.settings));
        assert!(!hooks_installed(&user_settings()));
    }

    #[test]
    fn install_wraps_the_existing_status_line() {
        let out = install(&user_settings(), RELAY);
        assert_eq!(out.settings["statusLine"]["command"], format!("\"{RELAY}\" statusline | python ~/.claude/statusline.py"));
        assert_eq!(out.settings["statusLine"]["padding"], 0);
        assert_eq!(out.saved_status_line, Some(user_settings()["statusLine"].clone()));
        assert!(status_line_installed(&out.settings));
    }

    #[test]
    fn install_without_status_line_uses_quiet_mode() {
        let out = install(&json!({}), RELAY);
        assert_eq!(out.settings["statusLine"], json!({"type": "command", "command": format!("\"{RELAY}\" statusline --quiet")}));
        assert!(out.saved_status_line.is_none());
    }

    #[test]
    fn install_is_idempotent() {
        let once = install(&user_settings(), RELAY);
        let twice = install(&once.settings, RELAY);
        assert_eq!(pretty(&once.settings), pretty(&twice.settings));
        assert!(twice.saved_status_line.is_none(), "must not overwrite the saved original with our own wrapper");
    }

    #[test]
    fn round_trip_restores_original() {
        let original = user_settings();
        let installed = install(&original, RELAY);
        let back = uninstall(&installed.settings, installed.saved_status_line.as_ref());
        assert_eq!(pretty(&back), pretty(&original));
    }

    #[test]
    fn round_trip_without_status_line_or_hooks() {
        let original = json!({"model": "sonnet"});
        let installed = install(&original, RELAY);
        let back = uninstall(&installed.settings, None);
        assert_eq!(pretty(&back), pretty(&original));
    }

    #[test]
    fn status_line_with_operators_is_grouped() {
        let orig = json!({"type": "command", "command": "cd ~ && node sl.js"});
        assert_eq!(status_line_command(RELAY, Some(&orig)), format!("\"{RELAY}\" statusline | (cd ~ && node sl.js)"));
        assert_eq!(status_line_command(RELAY, None), format!("\"{RELAY}\" statusline --quiet"));
    }

    #[test]
    fn parse_rejects_non_objects_and_accepts_empty() {
        assert_eq!(parse_settings(b"").unwrap(), json!({}));
        assert_eq!(parse_settings(b"  \n").unwrap(), json!({}));
        assert_eq!(parse_settings(b"\xEF\xBB\xBF{\"a\":1}").unwrap(), json!({"a": 1}));
        assert!(parse_settings(b"[1]").is_err());
        assert!(parse_settings(b"{nope").is_err());
    }

    #[test]
    fn diff_shows_added_lines() {
        let d = unified_diff("{\n  \"a\": 1\n}", "{\n  \"a\": 1,\n  \"b\": 2\n}");
        assert!(d.contains("+  \"b\": 2"), "{d}");
    }

    #[test]
    fn write_atomic_backs_up_and_checks_fingerprint() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, b"{\"a\":1}").unwrap();
        let fp = fingerprint(b"{\"a\":1}");
        assert!(write_atomic(&path, &json!({"b": 2}), "stale-fingerprint").is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"a\":1}", "nothing written on mismatch");
        let backup = write_atomic(&path, &json!({"b": 2}), &fp).unwrap();
        assert_eq!(std::fs::read_to_string(&backup).unwrap(), "{\"a\":1}");
        assert!(backup.file_name().unwrap().to_string_lossy().starts_with("settings.json.bak-"));
        assert_eq!(parse_settings(&std::fs::read(&path).unwrap()).unwrap(), json!({"b": 2}));
    }

    #[test]
    fn write_atomic_creates_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("settings.json");
        write_atomic(&path, &json!({"x": 1}), &fingerprint(b"")).unwrap();
        assert!(path.exists());
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p sb-core claude_settings`
Expected: 11 tests fail with `not yet implemented`.

- [ ] **Step 3: Implement**

Replace the `todo!()` bodies:
```rust
fn command_is_ours(v: &Value) -> bool {
    v.get("command").and_then(Value::as_str).map(|c| c.contains(MARKER)).unwrap_or(false)
}

fn entry_is_ours(entry: &Value) -> bool {
    entry
        .get("hooks")
        .and_then(Value::as_array)
        .map(|hooks| hooks.iter().any(command_is_ours))
        .unwrap_or(false)
}

fn hook_command(relay: &str, event: &str) -> String {
    format!("\"{relay}\" hook {event}")
}

pub fn status_line_command(relay: &str, original: Option<&Value>) -> String {
    match original.and_then(|o| o.get("command")).and_then(Value::as_str).map(str::trim).filter(|c| !c.is_empty()) {
        Some(cmd) if cmd.contains(['&', '|', ';']) => format!("\"{relay}\" statusline | ({cmd})"),
        Some(cmd) => format!("\"{relay}\" statusline | {cmd}"),
        None => format!("\"{relay}\" statusline --quiet"),
    }
}

pub fn install(existing: &Value, relay: &str) -> Installed {
    let mut root = existing.as_object().cloned().unwrap_or_default();
    let mut hooks = root.get("hooks").and_then(Value::as_object).cloned().unwrap_or_else(Map::new);
    for (event, timeout) in HOOK_EVENTS {
        let mut list = hooks.get(*event).and_then(Value::as_array).cloned().unwrap_or_default();
        list.retain(|e| !entry_is_ours(e));
        list.push(json!({"hooks": [{"type": "command", "command": hook_command(relay, event), "timeout": timeout}]}));
        hooks.insert((*event).to_string(), Value::Array(list));
    }
    root.insert("hooks".into(), Value::Object(hooks));

    let current = root.get("statusLine").cloned();
    let saved_status_line = match &current {
        Some(sl) if command_is_ours(sl) => None,
        other => other.clone(),
    };
    let original = match &current {
        Some(sl) if command_is_ours(sl) => None,
        other => other.as_ref(),
    };
    if !current.as_ref().map(command_is_ours).unwrap_or(false) {
        let mut sl = Map::new();
        sl.insert("type".into(), json!("command"));
        sl.insert("command".into(), json!(status_line_command(relay, original)));
        if let Some(padding) = original.and_then(|o| o.get("padding")) {
            sl.insert("padding".into(), padding.clone());
        }
        root.insert("statusLine".into(), Value::Object(sl));
    }
    Installed { settings: Value::Object(root), saved_status_line }
}

pub fn uninstall(existing: &Value, saved: Option<&Value>) -> Value {
    let mut root = existing.as_object().cloned().unwrap_or_default();
    if let Some(hooks) = root.get("hooks").and_then(Value::as_object).cloned() {
        let mut out = Map::new();
        for (event, value) in hooks {
            match value.as_array() {
                Some(list) => {
                    let kept: Vec<Value> = list.iter().filter(|e| !entry_is_ours(e)).cloned().collect();
                    if !kept.is_empty() {
                        out.insert(event, Value::Array(kept));
                    }
                }
                None => {
                    out.insert(event, value);
                }
            }
        }
        if out.is_empty() {
            root.shift_remove("hooks");
        } else {
            root.insert("hooks".into(), Value::Object(out));
        }
    }
    if root.get("statusLine").map(command_is_ours).unwrap_or(false) {
        match saved {
            Some(original) => {
                root.insert("statusLine".into(), original.clone());
            }
            None => {
                root.shift_remove("statusLine");
            }
        }
    }
    Value::Object(root)
}

pub fn hooks_installed(v: &Value) -> bool {
    v.get("hooks")
        .and_then(Value::as_object)
        .map(|h| h.values().filter_map(Value::as_array).flatten().any(entry_is_ours))
        .unwrap_or(false)
}

pub fn status_line_installed(v: &Value) -> bool {
    v.get("statusLine").map(command_is_ours).unwrap_or(false)
}

pub fn parse_settings(bytes: &[u8]) -> Result<Value, String> {
    let b = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    if b.iter().all(|c| c.is_ascii_whitespace()) {
        return Ok(json!({}));
    }
    let v: Value = serde_json::from_slice(b)
        .map_err(|e| format!("settings.json is not valid JSON ({e}). Nothing was changed."))?;
    if !v.is_object() {
        return Err("settings.json is not a JSON object. Nothing was changed.".into());
    }
    Ok(v)
}

pub fn pretty(v: &Value) -> String {
    serde_json::to_string_pretty(v).unwrap_or_default()
}

/// FNV-1a: only answers "is this still the file I showed the user?".
pub fn fingerprint(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
    format!("{hash:016x}")
}

pub fn write_atomic(path: &Path, next: &Value, expected_fingerprint: &str) -> Result<PathBuf, String> {
    let dir = path.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let current = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(format!("cannot read {}: {e}", path.display())),
    };
    if fingerprint(&current) != expected_fingerprint {
        return Err(format!("{} changed since the preview. Nothing was written. Review the new diff.", path.display()));
    }
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let backup = path.with_file_name(format!("{name}.bak-{stamp}"));
    if path.exists() {
        std::fs::copy(path, &backup).map_err(|e| format!("backup failed: {e}"))?;
    }
    let mut text = pretty(next);
    text.push('\n');
    let temp = path.with_file_name(format!("{name}.sb-{}", std::process::id()));
    std::fs::write(&temp, text.as_bytes()).map_err(|e| format!("write failed: {e}"))?;
    if let Err(err) = std::fs::rename(&temp, path) {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("write failed: {err}"));
    }
    Ok(backup)
}
```

For `unified_diff`: copy the function `unified_diff` (and any private helpers it calls) from `coucou/windows/src-tauri/src/hooks.rs` (starts at the line `fn unified_diff(before: &str, after: &str) -> String {`, around line 365, and ends before `#[cfg(test)]`) verbatim, and make it `pub`. It has no Windows dependencies.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p sb-core claude_settings`
Expected: 11 passed. If `round_trip_restores_original` fails on key order, check that `serde_json` has the `preserve_order` feature (it does, in `core/Cargo.toml`) and that `uninstall` uses `shift_remove`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Install and uninstall hooks and the status-line tee safely"
```

---

### Task 7: Core crate - usage (5H / 7D) parsing and source selection

**Files:**
- Modify: `core/src/usage.rs`
- Test: unit tests in the same file

**Interfaces:**
- Produces (`sb_core::usage`): `Limit { used_pct: f64, resets_at: Option<Value> }`, `Account { email, org, plan: Option<String> }`, `UsageSource { Statusline, Oauth, None }`, `Usage { five_hour, seven_day: Option<Limit>, source: UsageSource, updated_at: Option<i64>, error: Option<String>, account: Option<Account> }` (Default = all None / `UsageSource::None`), `parse_limit`, `parse_limits(v) -> (Option<Limit>, Option<Limit>)`, `parse_account(claude_json: &Value) -> Option<Account>`, `token_from_credentials(v: &Value) -> Option<String>`, `enum Plan { UseStatusline(Value, i64), Fetch, Keep }`, `decide(rate_limits: Option<&(Value, i64)>, last_fetch: i64, now: i64) -> Plan`, `apply_statusline(u: &mut Usage, v: &Value, at: i64)`, `apply_oauth(u: &mut Usage, v: &Value, at: i64)`, `apply_error(u: &mut Usage, err: String)`. Constants `STATUSLINE_FRESH_MS = 15 min`, `OAUTH_EVERY_MS = 10 min`.
- JSON (camelCase): `{"fiveHour":{"usedPct":42,"resetsAt":"2026-10-01T14:30:00Z"},"sevenDay":...,"source":"oauth","updatedAt":...,"error":null,"account":{"email":...,"org":...,"plan":...}}`.

- [ ] **Step 1: Write the failing tests**

`core/src/usage.rs`:
```rust
//! The account's 5-hour and 7-day limits. Preferred source: `rate_limits` in the
//! status-line JSON. Fallback: Claude Code's own OAuth usage endpoint.

use serde::Serialize;
use serde_json::Value;

pub const STATUSLINE_FRESH_MS: i64 = 15 * 60_000;
pub const OAUTH_EVERY_MS: i64 = 10 * 60_000;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Limit {
    pub used_pct: f64,
    pub resets_at: Option<Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub email: Option<String>,
    pub org: Option<String>,
    pub plan: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UsageSource {
    Statusline,
    Oauth,
    #[default]
    None,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub five_hour: Option<Limit>,
    pub seven_day: Option<Limit>,
    pub source: UsageSource,
    pub updated_at: Option<i64>,
    pub error: Option<String>,
    pub account: Option<Account>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Plan {
    UseStatusline(Value, i64),
    Fetch,
    Keep,
}

pub fn parse_limit(v: &Value) -> Option<Limit> { todo!() }
pub fn parse_limits(v: &Value) -> (Option<Limit>, Option<Limit>) { todo!() }
pub fn parse_account(claude_json: &Value) -> Option<Account> { todo!() }
pub fn token_from_credentials(v: &Value) -> Option<String> { todo!() }
pub fn decide(rate_limits: Option<&(Value, i64)>, last_fetch: i64, now: i64) -> Plan { todo!() }
pub fn apply_statusline(u: &mut Usage, v: &Value, at: i64) { todo!() }
pub fn apply_oauth(u: &mut Usage, v: &Value, at: i64) { todo!() }
pub fn apply_error(u: &mut Usage, err: String) { todo!() }

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_both_shapes() {
        let status = json!({"five_hour": {"used_percentage": 42.0, "resets_at": 1790000000}, "seven_day": {"used_percentage": 18}});
        let (f, s) = parse_limits(&status);
        assert_eq!(f, Some(Limit { used_pct: 42.0, resets_at: Some(json!(1790000000)) }));
        assert_eq!(s, Some(Limit { used_pct: 18.0, resets_at: None }));
        let oauth = json!({"five_hour": {"utilization": 7.5, "resets_at": "2026-10-01T14:30:00Z"}, "seven_day": null});
        let (f, s) = parse_limits(&oauth);
        assert_eq!(f.unwrap().resets_at, Some(json!("2026-10-01T14:30:00Z")));
        assert!(s.is_none());
    }

    #[test]
    fn account_label_fields() {
        let cj = json!({"oauthAccount": {"emailAddress": "wolfgang@private.de", "organizationName": "Wolfgang's Individual Org", "organizationType": "claude_max"}});
        assert_eq!(
            parse_account(&cj),
            Some(Account { email: Some("wolfgang@private.de".into()), org: Some("Wolfgang's Individual Org".into()), plan: Some("Max".into()) })
        );
        let team = json!({"oauthAccount": {"emailAddress": "w@finodata.de", "organizationName": "finodata", "seatTier": "team_standard"}});
        assert_eq!(parse_account(&team).unwrap().plan.as_deref(), Some("Team Standard"));
        assert!(parse_account(&json!({})).is_none());
    }

    #[test]
    fn token_from_both_credential_stores() {
        assert_eq!(token_from_credentials(&json!({"claudeAiOauth": {"accessToken": "sk-ant-oat-x"}})).as_deref(), Some("sk-ant-oat-x"));
        assert!(token_from_credentials(&json!({})).is_none());
    }

    #[test]
    fn prefers_fresh_status_line_then_fetches_every_10_minutes() {
        let now = 100 * 60_000;
        let rl = (json!({"five_hour": {"used_percentage": 1}}), now - 60_000);
        assert_eq!(decide(Some(&rl), 0, now), Plan::UseStatusline(rl.0.clone(), rl.1));
        let old = (rl.0.clone(), now - STATUSLINE_FRESH_MS - 1);
        assert_eq!(decide(Some(&old), now - OAUTH_EVERY_MS, now), Plan::Fetch);
        assert_eq!(decide(None, now - OAUTH_EVERY_MS + 1, now), Plan::Keep);
        assert_eq!(decide(None, i64::MIN / 2, now), Plan::Fetch);
    }

    #[test]
    fn errors_keep_the_last_values() {
        let mut u = Usage::default();
        apply_oauth(&mut u, &json!({"five_hour": {"utilization": 30}}), 5);
        apply_error(&mut u, "usage endpoint returned 429".into());
        assert_eq!(u.five_hour.as_ref().unwrap().used_pct, 30.0);
        assert_eq!(u.updated_at, Some(5));
        assert_eq!(u.error.as_deref(), Some("usage endpoint returned 429"));
        apply_statusline(&mut u, &json!({"five_hour": {"used_percentage": 31}}), 9);
        assert_eq!(u.source, UsageSource::Statusline);
        assert!(u.error.is_none());
        let v = serde_json::to_value(&u).unwrap();
        assert_eq!(v["fiveHour"]["usedPct"], 31.0);
        assert_eq!(v["source"], "statusline");
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p sb-core usage`
Expected: 5 tests fail.

- [ ] **Step 3: Implement**

```rust
pub fn parse_limit(v: &Value) -> Option<Limit> {
    let pct = v.get("used_percentage").or_else(|| v.get("utilization")).and_then(Value::as_f64)?;
    let resets_at = v.get("resets_at").filter(|r| !r.is_null()).cloned();
    Some(Limit { used_pct: pct, resets_at })
}

pub fn parse_limits(v: &Value) -> (Option<Limit>, Option<Limit>) {
    (v.get("five_hour").and_then(parse_limit), v.get("seven_day").and_then(parse_limit))
}

fn pretty_plan(raw: &str) -> String {
    let words: Vec<String> = raw
        .trim_start_matches("claude_")
        .split('_')
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut c = w.chars();
            c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
        })
        .collect();
    words.join(" ")
}

pub fn parse_account(claude_json: &Value) -> Option<Account> {
    let o = claude_json.get("oauthAccount")?;
    let get = |k: &str| o.get(k).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
    let plan = get("seatTier").or_else(|| get("organizationType")).or_else(|| get("billingType")).map(|p| pretty_plan(&p));
    Some(Account { email: get("emailAddress"), org: get("organizationName"), plan })
}

pub fn token_from_credentials(v: &Value) -> Option<String> {
    v.pointer("/claudeAiOauth/accessToken").and_then(Value::as_str).filter(|t| !t.is_empty()).map(str::to_string)
}

pub fn decide(rate_limits: Option<&(Value, i64)>, last_fetch: i64, now: i64) -> Plan {
    if let Some((v, at)) = rate_limits {
        if now - at < STATUSLINE_FRESH_MS {
            return Plan::UseStatusline(v.clone(), *at);
        }
    }
    if now - last_fetch >= OAUTH_EVERY_MS { Plan::Fetch } else { Plan::Keep }
}

pub fn apply_statusline(u: &mut Usage, v: &Value, at: i64) {
    let (f, s) = parse_limits(v);
    u.five_hour = f;
    u.seven_day = s;
    u.source = UsageSource::Statusline;
    u.updated_at = Some(at);
    u.error = None;
}

pub fn apply_oauth(u: &mut Usage, v: &Value, at: i64) {
    let (f, s) = parse_limits(v);
    u.five_hour = f;
    u.seven_day = s;
    u.source = UsageSource::Oauth;
    u.updated_at = Some(at);
    u.error = None;
}

pub fn apply_error(u: &mut Usage, err: String) {
    u.error = Some(err);
}
```

- [ ] **Step 4: Run all core tests**

Run: `cargo test -p sb-core`
Expected: every test in the crate passes (Tasks 3-7).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Parse 5H and 7D limits from the status line or the usage endpoint"
```

---

### Task 8: The Tauri app backend

**Files:**
- Modify: `Cargo.toml` (members += `"src-tauri"`)
- Create: `src-tauri/Cargo.toml`, `src-tauri/build.rs`, `src-tauri/tauri.conf.json`, `src-tauri/tauri.windows.conf.json`, `src-tauri/tauri.macos.conf.json`, `src-tauri/capabilities/default.json`
- Create: `src-tauri/src/main.rs`, `lib.rs`, `ipc.rs`, `island.rs`, `settings.rs`, `install.rs`, `usage_poll.rs`, `tray.rs`, `log.rs`
- Test: `cargo build -p session-buddy` + manual smoke test with the relay

**Interfaces:**
- Consumes: everything from `sb-core` and `sb-common`.
- Produces (Tauri commands, camelCase args from JS):
  - `boot() -> { settings: Settings, version: string }`
  - `snapshot() -> Snapshot` where `Snapshot = { sessions: Session[], usage: Usage, now: number }`
  - `save_settings(settings: Settings)`
  - `set_island_rect(x, y, width, height: f64)`
  - `focus_window(focused: bool)`
  - `reposition()`
  - `ack(requestId: string)`, `answer(requestId: string, answer: object) -> Result<(), string>`, `release(requestId: string)`
  - `install_status() -> InstallStatus { hooksInstalled, statusLineInstalled, settingsPath, relayPath, relayReady }`
  - `install_preview(install: bool) -> InstallPreview { diff, settingsPath, fingerprint }`
  - `install_write(install: bool, fingerprint: string) -> Result<string /*backup path*/, string>`
  - `open_settings_window()`, `log(message: string)`, `quit_app()`
- Produces (events to the `island` window): `sessions` (Snapshot, coalesced every 33 ms), `cues` (Cue[]), `cursor` ({x, y} window-logical), `tray` ("open"), `hotkey` (null), `screen-changed` (null), `settings-changed` (Settings, to all windows).
- `Settings` JSON (camelCase): `soundEnabled: bool, soundVolume: number, autoCloseInterval: number (s), compactInterval: number (s), staleMinutes: number, removeMinutes: number, screen: "primary"|"cursor", autostart: bool, hotkey: string, contextSound: bool`.

- [ ] **Step 1: Manifests and config**

Add `"src-tauri"` to `members` in the root `Cargo.toml`.

`src-tauri/Cargo.toml`:
```toml
[package]
name = "session-buddy"
description = "See and answer all your Claude Code sessions"
version.workspace = true
edition.workspace = true
license.workspace = true

[lib]
name = "session_buddy_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2.5", features = ["tray-icon", "macos-private-api"] }
tauri-plugin-single-instance = "2"
tauri-plugin-autostart = "2"
tauri-plugin-global-shortcut = "2"
serde = { version = "1", features = ["derive"] }
serde_json = { version = "1", features = ["preserve_order"] }
tokio = { version = "1", features = ["net", "io-util", "sync", "time", "rt", "fs"] }
reqwest = { version = "0.12", default-features = false, features = ["json", "rustls-tls"] }
chrono = { version = "0.4", default-features = false, features = ["clock", "std"] }
sb-common = { path = "../common" }
sb-core = { path = "../core" }

[target.'cfg(windows)'.dependencies]
windows = { version = "0.61", features = ["Win32_Foundation", "Win32_UI_WindowsAndMessaging"] }
```

`src-tauri/build.rs`:
```rust
fn main() {
    tauri_build::build()
}
```

`src-tauri/tauri.conf.json`:
```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "session-buddy",
  "version": "0.1.0",
  "identifier": "de.wlankin.sessionbuddy",
  "build": {
    "beforeDevCommand": "npm run dev",
    "devUrl": "http://localhost:1420",
    "beforeBuildCommand": "npm run build",
    "frontendDist": "../dist"
  },
  "app": {
    "withGlobalTauri": false,
    "macOSPrivateApi": true,
    "security": {
      "csp": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ipc: http://ipc.localhost",
      "devCsp": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ipc: http://ipc.localhost ws://localhost:1420 http://localhost:1420"
    },
    "windows": [
      {
        "label": "island",
        "title": "session-buddy",
        "url": "index.html",
        "width": 720,
        "height": 360,
        "resizable": false,
        "decorations": false,
        "transparent": true,
        "shadow": false,
        "alwaysOnTop": true,
        "skipTaskbar": true,
        "focus": false,
        "visible": true,
        "center": false,
        "maximizable": false,
        "minimizable": false,
        "closable": false,
        "acceptFirstMouse": true,
        "visibleOnAllWorkspaces": true,
        "dragDropEnabled": false,
        "additionalBrowserArgs": "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required"
      }
    ]
  },
  "bundle": {
    "active": true,
    "icon": ["icons/32x32.png", "icons/128x128.png", "icons/128x128@2x.png", "icons/icon.icns", "icons/icon.ico"],
    "copyright": "MIT",
    "category": "DeveloperTool",
    "shortDescription": "See and answer all your Claude Code sessions"
  }
}
```

`src-tauri/tauri.windows.conf.json`:
```json
{
  "bundle": {
    "targets": ["nsis"],
    "resources": { "../target/release/sb-relay.exe": "sb-relay.exe" },
    "windows": { "nsis": { "installMode": "currentUser" } }
  }
}
```

`src-tauri/tauri.macos.conf.json`:
```json
{
  "bundle": {
    "targets": ["app", "dmg"],
    "resources": { "../target/release/sb-relay": "sb-relay" },
    "macOS": { "minimumSystemVersion": "13.0" }
  }
}
```

`src-tauri/capabilities/default.json`:
```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Everything that touches the OS goes through session-buddy's own commands.",
  "windows": ["island", "settings"],
  "permissions": ["core:default", "autostart:default"]
}
```

Generate the macOS icon set once (Windows is fine to do this on; it writes `icon.icns` too):
```bash
npx tauri icon src-tauri/icons/128x128@2x.png -o src-tauri/icons
```
Expected: `src-tauri/icons/icon.icns` and `icon.ico` exist.

- [ ] **Step 2: log.rs, settings.rs, tray.rs**

`src-tauri/src/log.rs`:
```rust
//! Plain text log next to the app's data. Stays on this machine.

use std::io::Write;

const MAX_BYTES: u64 = 5 * 1024 * 1024;

pub fn line(message: impl AsRef<str>) {
    let path = sb_common::log_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if std::fs::metadata(&path).map(|m| m.len() > MAX_BYTES).unwrap_or(false) {
        let _ = std::fs::rename(&path, path.with_extension("log.1"));
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{} {}", chrono::Local::now().format("%Y-%m-%d %H:%M:%S"), message.as_ref());
    }
}
```

`src-tauri/src/settings.rs`:
```rust
//! Preferences, plain JSON in the config dir. No secret ever lands here.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub sound_enabled: bool,
    pub sound_volume: f64,
    /// Expanded -> compact after the mouse leaves, seconds.
    pub auto_close_interval: f64,
    /// Compact -> strip after the mouse leaves, seconds.
    pub compact_interval: f64,
    pub stale_minutes: u32,
    pub remove_minutes: u32,
    /// "primary" or "cursor".
    pub screen: String,
    pub autostart: bool,
    pub hotkey: String,
    /// Play a sound when a session crosses 90 % context.
    pub context_sound: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            sound_enabled: true,
            sound_volume: 0.12,
            auto_close_interval: 15.0,
            compact_interval: 6.0,
            stale_minutes: 10,
            remove_minutes: 120,
            screen: "primary".into(),
            autostart: false,
            hotkey: "Ctrl+Alt+Space".into(),
            context_sound: true,
        }
    }
}

fn path() -> PathBuf {
    sb_common::config_dir().join("settings.json")
}

pub fn load() -> Settings {
    std::fs::read(path()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

pub fn save(settings: &Settings) -> std::io::Result<()> {
    std::fs::create_dir_all(sb_common::config_dir())?;
    let json = serde_json::to_vec_pretty(settings).map_err(std::io::Error::other)?;
    std::fs::write(path(), json)
}
```

`src-tauri/src/tray.rs`:
```rust
//! Tray (Windows) / menu bar (macOS) icon: Open, Settings..., Quit.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter};

use crate::island::WINDOW_LABEL;

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings...", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit session-buddy", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &settings, &sep, &quit])?;

    let mut builder = TrayIconBuilder::with_id("session-buddy")
        .tooltip("session-buddy")
        .menu(&menu)
        .on_menu_event(|app: &AppHandle, event| match event.id.as_ref() {
            "quit" => app.exit(0),
            "settings" => crate::show_settings_window(app),
            "open" => {
                let _ = app.emit_to(WINDOW_LABEL, "tray", "open");
            }
            _ => {}
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}
```

- [ ] **Step 3: island.rs (cross-platform window)**

`src-tauri/src/island.rs`:
```rust
//! The island window: a fixed 720x360 transparent panel at the top centre of
//! the screen. Outside the island shape it lets clicks through; a 30 Hz cursor
//! feed drives Mochi's eyes and the hover logic.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Monitor, PhysicalPosition, PhysicalSize, WebviewWindow};

pub const PANEL_W: f64 = 720.0;
pub const PANEL_H: f64 = 360.0;
pub const WINDOW_LABEL: &str = "island";

/// Same margin as the front end (src/island/island.ts HIT_MARGIN).
const HIT_MARGIN: f64 = 14.0;

#[derive(Clone, Copy, Serialize)]
pub struct CursorPayload {
    x: f64,
    y: f64,
}

#[derive(Clone, Copy, Default)]
pub struct IslandRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

pub struct Gate {
    pub rect: Mutex<IslandRect>,
    ignoring: AtomicBool,
}

impl Gate {
    pub fn new() -> Self {
        Self { rect: Mutex::new(IslandRect::default()), ignoring: AtomicBool::new(false) }
    }
}

pub fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(WINDOW_LABEL)
}

fn monitor_contains(m: &Monitor, x: f64, y: f64) -> bool {
    let p = m.position();
    let s = m.size();
    x >= p.x as f64 && x < p.x as f64 + s.width as f64 && y >= p.y as f64 && y < p.y as f64 + s.height as f64
}

fn target_monitor(app: &AppHandle, pref: &str) -> Option<Monitor> {
    if pref == "cursor" {
        if let Ok(c) = app.cursor_position() {
            if let Ok(list) = app.available_monitors() {
                if let Some(m) = list.into_iter().find(|m| monitor_contains(m, c.x, c.y)) {
                    return Some(m);
                }
            }
        }
    }
    app.primary_monitor().ok().flatten().or_else(|| app.available_monitors().ok()?.into_iter().next())
}

/// (x, y, width) of the strip the island hangs from, in physical pixels.
/// macOS keeps windows below the menu bar, so use the work area there.
fn top_edge(m: &Monitor) -> (i32, i32, u32) {
    #[cfg(target_os = "macos")]
    {
        let wa = m.work_area();
        (wa.position.x, wa.position.y, wa.size.width)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let p = m.position();
        (p.x, p.y, m.size().width)
    }
}

pub fn apply_geometry(app: &AppHandle, pref: &str) {
    let Some(win) = window(app) else { return };
    let Some(m) = target_monitor(app, pref) else { return };
    let scale = m.scale_factor();
    let (x0, y0, width) = top_edge(&m);
    let pw = (PANEL_W * scale).round() as u32;
    let ph = (PANEL_H * scale).round() as u32;
    let x = x0 + (width as i32 - pw as i32) / 2;
    let _ = win.set_size(PhysicalSize::new(pw, ph));
    let _ = win.set_position(PhysicalPosition::new(x, y0));
    // Moving across displays can rescale the window: re-assert the size.
    let _ = win.set_size(PhysicalSize::new(pw, ph));
    let _ = win.set_always_on_top(true);
}

fn screen_key(app: &AppHandle) -> Option<(i32, i32, u32, u32, u64)> {
    let pref = app.try_state::<crate::Shared>().map(|s| s.settings.lock().unwrap().screen.clone()).unwrap_or_else(|| "primary".into());
    let m = target_monitor(app, &pref)?;
    let p = m.position();
    let s = m.size();
    Some((p.x, p.y, s.width, s.height, m.scale_factor().to_bits()))
}

/// Clicking the island must never steal focus from Warp.
pub fn prepare(win: &WebviewWindow) {
    #[cfg(windows)]
    win32::make_non_activating(win);
    #[cfg(target_os = "macos")]
    {
        let _ = win.set_focusable(false);
        let _ = win.set_visible_on_all_workspaces(true);
    }
}

/// Lets the window take keyboard focus (hotkey, reply box) and gives it back.
pub fn set_activating(win: &WebviewWindow, on: bool) {
    #[cfg(windows)]
    win32::set_activating(win, on);
    #[cfg(target_os = "macos")]
    {
        let _ = win.set_focusable(on);
    }
    if on {
        let _ = win.set_focus();
    }
}

pub fn spawn_cursor_poll(app: AppHandle, gate: Arc<Gate>) {
    std::thread::spawn(move || {
        let mut last = (f64::MIN, f64::MIN);
        let mut last_screen = None;
        let mut ticks: u32 = 0;
        loop {
            std::thread::sleep(Duration::from_millis(33));
            ticks = ticks.wrapping_add(1);
            if ticks % 15 == 0 {
                let now = screen_key(&app);
                if now.is_some() && now != last_screen {
                    if last_screen.is_some() {
                        crate::log::line("display layout changed, repositioning");
                        let _ = app.emit_to(WINDOW_LABEL, "screen-changed", ());
                    }
                    last_screen = now;
                }
            }
            let Some(win) = window(&app) else { continue };
            let Ok(origin) = win.outer_position() else { continue };
            let scale = win.scale_factor().unwrap_or(1.0);
            let Ok(c) = app.cursor_position() else { continue };
            let x = (c.x - origin.x as f64) / scale;
            let y = (c.y - origin.y as f64) / scale;
            if (x - last.0).abs() < 1.0 && (y - last.1).abs() < 1.0 {
                continue;
            }
            last = (x, y);
            let r = *gate.rect.lock().unwrap();
            let on_island = r.w > 0.0
                && x >= r.x - HIT_MARGIN
                && x <= r.x + r.w + HIT_MARGIN
                && y >= r.y - HIT_MARGIN
                && y <= r.y + r.h + HIT_MARGIN;
            if gate.ignoring.load(Ordering::Relaxed) == on_island {
                gate.ignoring.store(!on_island, Ordering::Relaxed);
                let _ = win.set_ignore_cursor_events(!on_island);
            }
            let _ = win.emit("cursor", CursorPayload { x, y });
        }
    });
}

#[cfg(windows)]
mod win32 {
    // Copy `hwnd_of`, `make_non_activating` and `set_activating` from
    // coucou/windows/src-tauri/src/island.rs verbatim (they are self-contained),
    // together with these imports:
    use tauri::WebviewWindow;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    };

    fn hwnd_of(win: &WebviewWindow) -> Option<HWND> {
        let raw = win.hwnd().ok()?.0 as isize;
        if raw == 0 {
            return None;
        }
        Some(HWND(raw as *mut _))
    }

    /// WS_EX_NOACTIVATE keeps clicks from stealing focus; WS_EX_TOOLWINDOW keeps the island out of Alt-Tab.
    pub fn make_non_activating(win: &WebviewWindow) {
        let Some(hwnd) = hwnd_of(win) else { return };
        unsafe {
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex | WS_EX_NOACTIVATE.0 as isize | WS_EX_TOOLWINDOW.0 as isize);
        }
    }

    pub fn set_activating(win: &WebviewWindow, activating: bool) {
        let Some(hwnd) = hwnd_of(win) else { return };
        unsafe {
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            let want = if activating { ex & !(WS_EX_NOACTIVATE.0 as isize) } else { ex | WS_EX_NOACTIVATE.0 as isize };
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, want);
        }
    }
}
```
(The `win32` module above is complete; drop its first comment block when pasting, it only records where the code came from.)

If `set_focusable` does not exist in the resolved Tauri version, run `cargo update -p tauri` (it needs tauri >= 2.5) and check with Context7 (`/tauri-apps/tauri` "set_focusable").

- [ ] **Step 4: ipc.rs, usage_poll.rs, install.rs**

`src-tauri/src/ipc.rs`:
```rust
//! Listens for the relay: a per-user named pipe on Windows, a Unix socket on macOS.

use std::sync::Arc;
use std::time::Duration;

use sb_core::hub::Hub;

use crate::log;

#[cfg(windows)]
pub fn start(hub: Arc<Hub>) {
    use tokio::net::windows::named_pipe::ServerOptions;
    tauri::async_runtime::spawn(async move {
        let name = sb_common::pipe_name(&sb_common::user_key());
        // first_pipe_instance: refuse to join a pipe somebody else already owns under our name.
        let mut server = match ServerOptions::new().first_pipe_instance(true).create(&name) {
            Ok(s) => s,
            Err(err) => {
                log::line(format!("cannot open the relay pipe: {err}"));
                return;
            }
        };
        loop {
            if server.connect().await.is_err() {
                tokio::time::sleep(Duration::from_millis(200)).await;
                continue;
            }
            let next = match ServerOptions::new().create(&name) {
                Ok(s) => s,
                Err(err) => {
                    log::line(format!("cannot reopen the relay pipe: {err}"));
                    return;
                }
            };
            let connected = std::mem::replace(&mut server, next);
            let hub = hub.clone();
            tauri::async_runtime::spawn(async move { hub.serve(connected).await });
        }
    });
}

#[cfg(unix)]
pub fn start(hub: Arc<Hub>) {
    use std::os::unix::fs::PermissionsExt;
    tauri::async_runtime::spawn(async move {
        let path = sb_common::socket_path();
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::remove_file(&path);
        let listener = match tokio::net::UnixListener::bind(&path) {
            Ok(l) => l,
            Err(err) => {
                log::line(format!("cannot open the relay socket: {err}"));
                return;
            }
        };
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        loop {
            match listener.accept().await {
                Ok((stream, _)) => {
                    let hub = hub.clone();
                    tauri::async_runtime::spawn(async move { hub.serve(stream).await });
                }
                Err(_) => tokio::time::sleep(Duration::from_millis(200)).await,
            }
        }
    });
}
```

`src-tauri/src/usage_poll.rs`:
```rust
//! Keeps `Shared.usage` current: status-line rate limits when fresh, otherwise
//! Claude Code's own usage endpoint with Claude Code's own login token.

use std::time::Duration;

use sb_core::now_ms;
use sb_core::usage::{self, Account, Plan, UsageSource};
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::{log, Shared};

const ENDPOINT: &str = "https://api.anthropic.com/api/oauth/usage";

fn read_account() -> Option<Account> {
    let path = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(|d| std::path::PathBuf::from(d).join(".claude.json"))
        .unwrap_or_else(|| sb_common::home().join(".claude.json"));
    let bytes = std::fs::read(path).ok()?;
    usage::parse_account(&serde_json::from_slice::<Value>(&bytes).ok()?)
}

/// Read fresh on every fetch and never stored, so `/login` to another account is picked up.
fn read_token() -> Option<String> {
    if let Ok(bytes) = std::fs::read(sb_common::claude_dir().join(".credentials.json")) {
        if let Some(t) = serde_json::from_slice::<Value>(&bytes).ok().and_then(|v| usage::token_from_credentials(&v)) {
            return Some(t);
        }
    }
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("security")
            .args(["find-generic-password", "-s", "Claude Code-credentials", "-w"])
            .output()
            .ok()?;
        if out.status.success() {
            let v: Value = serde_json::from_slice(&out.stdout).ok()?;
            return usage::token_from_credentials(&v);
        }
    }
    None
}

async fn fetch(client: &reqwest::Client) -> Result<Value, String> {
    let token = read_token().ok_or_else(|| "Not logged in to Claude Code".to_string())?;
    let resp = client
        .get(ENDPOINT)
        .bearer_auth(token)
        .header("Accept", "application/json")
        .header("anthropic-beta", "oauth-2025-04-20")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("usage endpoint returned {}", resp.status().as_u16()));
    }
    resp.json::<Value>().await.map_err(|e| e.to_string())
}

pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let client = match reqwest::Client::builder().timeout(Duration::from_secs(10)).build() {
            Ok(c) => c,
            Err(err) => {
                log::line(format!("usage client: {err}"));
                return;
            }
        };
        let mut last_fetch = i64::MIN / 2;
        let mut last_source = UsageSource::None;
        loop {
            let now = now_ms();
            let shared = app.state::<Shared>();
            let rate_limits = shared.hub.store.lock().unwrap().rate_limits.clone();
            let account = read_account();
            match usage::decide(rate_limits.as_ref(), last_fetch, now) {
                Plan::UseStatusline(v, at) => usage::apply_statusline(&mut shared.usage.lock().unwrap(), &v, at),
                Plan::Fetch => {
                    last_fetch = now;
                    let result = fetch(&client).await;
                    let mut u = shared.usage.lock().unwrap();
                    match result {
                        Ok(v) => usage::apply_oauth(&mut u, &v, now),
                        Err(e) => usage::apply_error(&mut u, e),
                    }
                }
                Plan::Keep => {}
            }
            let source = {
                let mut u = shared.usage.lock().unwrap();
                u.account = account;
                u.source
            };
            if source != last_source {
                log::line(format!("usage source {source:?}"));
                last_source = source;
            }
            crate::mark_dirty();
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
    });
}
```

`src-tauri/src/install.rs`:
```rust
//! Installing session-buddy into ~/.claude/settings.json (preview, then write),
//! and keeping the relay binary in its fixed place.

use std::path::PathBuf;

use sb_core::claude_settings as cs;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::log;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallStatus {
    pub hooks_installed: bool,
    pub status_line_installed: bool,
    pub settings_path: String,
    pub relay_path: String,
    pub relay_ready: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallPreview {
    pub diff: String,
    pub settings_path: String,
    pub fingerprint: String,
}

fn settings_path() -> PathBuf {
    sb_common::claude_dir().join("settings.json")
}

fn relay_str() -> String {
    sb_common::relay_path().to_string_lossy().replace('\\', "/")
}

fn state_path() -> PathBuf {
    sb_common::config_dir().join("install.json")
}

fn saved_status_line() -> Option<Value> {
    let bytes = std::fs::read(state_path()).ok()?;
    let v: Value = serde_json::from_slice(&bytes).ok()?;
    v.get("savedStatusLine").filter(|x| !x.is_null()).cloned()
}

fn store_saved_status_line(v: Option<&Value>) {
    let _ = std::fs::create_dir_all(sb_common::config_dir());
    let _ = std::fs::write(state_path(), json!({"savedStatusLine": v}).to_string());
}

fn read_current() -> Result<(Vec<u8>, Value), String> {
    let bytes = match std::fs::read(settings_path()) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(format!("cannot read {}: {e}", settings_path().display())),
    };
    let value = cs::parse_settings(&bytes)?;
    Ok((bytes, value))
}

fn next(install: bool, current: &Value) -> (Value, Option<Value>) {
    if install {
        let out = cs::install(current, &relay_str());
        (out.settings, out.saved_status_line)
    } else {
        (cs::uninstall(current, saved_status_line().as_ref()), None)
    }
}

pub fn status() -> InstallStatus {
    let current = read_current().map(|(_, v)| v).unwrap_or_else(|_| json!({}));
    InstallStatus {
        hooks_installed: cs::hooks_installed(&current),
        status_line_installed: cs::status_line_installed(&current),
        settings_path: settings_path().to_string_lossy().to_string(),
        relay_path: sb_common::relay_path().to_string_lossy().to_string(),
        relay_ready: sb_common::relay_path().exists(),
    }
}

pub fn preview(install: bool) -> Result<InstallPreview, String> {
    let (bytes, current) = read_current()?;
    let (after, _) = next(install, &current);
    Ok(InstallPreview {
        diff: cs::unified_diff(&cs::pretty(&current), &cs::pretty(&after)),
        settings_path: settings_path().to_string_lossy().to_string(),
        fingerprint: cs::fingerprint(&bytes),
    })
}

pub fn write(install: bool, fingerprint: &str) -> Result<String, String> {
    let (_, current) = read_current()?;
    let (after, saved) = next(install, &current);
    let backup = cs::write_atomic(&settings_path(), &after, fingerprint)?;
    if install {
        if let Some(original) = saved {
            store_saved_status_line(Some(&original));
        }
    } else {
        store_saved_status_line(None);
    }
    log::line(format!("settings.json {} (backup {})", if install { "installed" } else { "uninstalled" }, backup.display()));
    Ok(backup.to_string_lossy().to_string())
}

/// Copies sb-relay to its fixed path on launch. Bundled: from the app resources.
/// `tauri dev`: from target/release next to the workspace.
pub fn ensure_relay(app: &AppHandle) {
    let dest = sb_common::relay_path();
    let Some(dir) = dest.parent() else { return };
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    let name = dest.file_name().unwrap_or_default().to_owned();
    let mut candidates = Vec::new();
    if let Ok(res) = app.path().resource_dir() {
        candidates.push(res.join(&name));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(d) = exe.parent() {
            candidates.push(d.join(&name));
            candidates.push(d.join("..").join("release").join(&name));
        }
    }
    let Some(src) = candidates.into_iter().find(|p| p.is_file()) else {
        log::line("sb-relay not found next to the app; hooks will not reach the island");
        return;
    };
    let same = match (std::fs::metadata(&src), std::fs::metadata(&dest)) {
        (Ok(a), Ok(b)) => a.len() == b.len() && a.modified().ok() <= b.modified().ok(),
        _ => false,
    };
    if same {
        return;
    }
    match std::fs::copy(&src, &dest) {
        Ok(_) => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755));
            }
            log::line(format!("relay installed at {}", dest.display()));
        }
        // A hook can be running the old copy right now (Windows locks it); next launch retries.
        Err(err) => log::line(format!("relay copy failed: {err}")),
    }
}
```

- [ ] **Step 5: lib.rs and main.rs**

`src-tauri/src/main.rs`:
```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    session_buddy_lib::run()
}
```

`src-tauri/src/lib.rs`:
```rust
//! session-buddy: shows and answers every running Claude Code session.

mod install;
mod ipc;
mod island;
mod log;
mod settings;
mod tray;
mod usage_poll;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use sb_core::hub::Hub;
use sb_core::store::{Cue, Session};
use sb_core::usage::Usage;
use sb_core::{bootstrap, branch, now_ms};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

use install::{InstallPreview, InstallStatus};
use island::{Gate, WINDOW_LABEL};
use settings::Settings;

pub struct Shared {
    pub settings: Mutex<Settings>,
    pub gate: Arc<Gate>,
    pub hub: Arc<Hub>,
    pub usage: Mutex<Usage>,
}

static APP: OnceLock<AppHandle> = OnceLock::new();
static DIRTY: AtomicBool = AtomicBool::new(true);

pub fn mark_dirty() {
    DIRTY.store(true, Ordering::SeqCst);
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    sessions: Vec<Session>,
    usage: Usage,
    now: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootInfo {
    settings: Settings,
    version: String,
}

fn build_snapshot(shared: &Shared) -> Snapshot {
    let sessions = shared.hub.store.lock().unwrap().snapshot();
    let usage = shared.usage.lock().unwrap().clone();
    Snapshot { sessions, usage, now: now_ms() }
}

fn apply_store_limits(shared: &Shared) {
    let s = shared.settings.lock().unwrap().clone();
    let mut st = shared.hub.store.lock().unwrap();
    st.stale_after_ms = s.stale_minutes.max(1) as i64 * 60_000;
    st.remove_after_ms = s.remove_minutes.max(1) as i64 * 60_000;
}

#[tauri::command]
fn boot(shared: State<Shared>) -> BootInfo {
    BootInfo { settings: shared.settings.lock().unwrap().clone(), version: env!("CARGO_PKG_VERSION").to_string() }
}

#[tauri::command]
fn snapshot(shared: State<Shared>) -> Snapshot {
    build_snapshot(&shared)
}

#[tauri::command]
fn save_settings(app: AppHandle, shared: State<Shared>, settings: Settings) {
    let (screen_changed, autostart_changed, hotkey_changed) = {
        let mut current = shared.settings.lock().unwrap();
        let changed = (current.screen != settings.screen, current.autostart != settings.autostart, current.hotkey != settings.hotkey);
        *current = settings.clone();
        changed
    };
    if let Err(err) = settings::save(&settings) {
        log::line(format!("could not save settings: {err}"));
    }
    apply_store_limits(&shared);
    if autostart_changed {
        let manager = app.autolaunch();
        let result = if settings.autostart { manager.enable() } else { manager.disable() };
        if let Err(err) = result {
            log::line(format!("autostart: {err}"));
        }
    }
    if screen_changed {
        island::apply_geometry(&app, &settings.screen);
    }
    if hotkey_changed {
        register_hotkey(&app, &settings.hotkey);
    }
    mark_dirty();
    let _ = app.emit("settings-changed", settings);
}

#[tauri::command]
fn set_island_rect(shared: State<Shared>, x: f64, y: f64, width: f64, height: f64) {
    *shared.gate.rect.lock().unwrap() = island::IslandRect { x, y, w: width, h: height };
}

#[tauri::command]
fn focus_window(app: AppHandle, focused: bool) {
    if let Some(win) = island::window(&app) {
        island::set_activating(&win, focused);
    }
}

#[tauri::command]
fn reposition(app: AppHandle, shared: State<Shared>) {
    let pref = shared.settings.lock().unwrap().screen.clone();
    island::apply_geometry(&app, &pref);
}

#[tauri::command]
fn ack(shared: State<Shared>, request_id: String) {
    shared.hub.ack(&request_id);
}

#[tauri::command]
fn answer(shared: State<Shared>, request_id: String, answer: Value) -> Result<(), String> {
    log::line(format!("answer id={request_id}"));
    shared.hub.answer(&request_id, &answer)
}

#[tauri::command]
fn release(shared: State<Shared>, request_id: String) {
    log::line(format!("release id={request_id}"));
    shared.hub.release(&request_id);
}

#[tauri::command]
fn install_status() -> InstallStatus {
    install::status()
}

#[tauri::command]
fn install_preview(install: bool) -> Result<InstallPreview, String> {
    install::preview(install)
}

#[tauri::command]
fn install_write(install: bool, fingerprint: String) -> Result<String, String> {
    install::write(install, &fingerprint)
}

#[tauri::command]
fn open_settings_window(app: AppHandle) {
    show_settings_window(&app);
}

#[tauri::command]
fn log(message: String) {
    log::line(message);
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

pub fn show_settings_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("settings.html".into()))
        .title("session-buddy settings")
        .inner_size(600.0, 680.0)
        .resizable(true)
        .build();
}

fn register_hotkey(app: &AppHandle, accelerator: &str) {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    if accelerator.trim().is_empty() {
        return;
    }
    let result = gs.on_shortcut(accelerator, |app, _shortcut, event| {
        if event.state == ShortcutState::Pressed {
            let _ = app.emit_to(WINDOW_LABEL, "hotkey", ());
        }
    });
    if let Err(err) = result {
        log::line(format!("hotkey {accelerator} could not be registered: {err}"));
    }
}

fn spawn_bootstrap(app: AppHandle) {
    tauri::async_runtime::spawn_blocking(move || {
        let shared = app.state::<Shared>();
        let (stale, remove) = {
            let st = shared.hub.store.lock().unwrap();
            (st.stale_after_ms, st.remove_after_ms)
        };
        let now = now_ms();
        let seeds = bootstrap::scan(&sb_common::claude_dir().join("projects"), now, stale + remove);
        let count = seeds.len();
        {
            let mut st = shared.hub.store.lock().unwrap();
            for seed in &seeds {
                st.seed(bootstrap::session_from_seed(seed, now, stale));
            }
        }
        log::line(format!("bootstrap: {count} recent session(s)"));
        mark_dirty();
    });
}

fn spawn_loops(app: AppHandle) {
    let emitter = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut every = tokio::time::interval(Duration::from_millis(33));
        loop {
            every.tick().await;
            if DIRTY.swap(false, Ordering::SeqCst) {
                let snap = build_snapshot(&emitter.state::<Shared>());
                let _ = emitter.emit_to(WINDOW_LABEL, "sessions", snap);
            }
        }
    });
    tauri::async_runtime::spawn(async move {
        let mut every = tokio::time::interval(Duration::from_secs(5));
        loop {
            every.tick().await;
            let now = now_ms();
            let todo = {
                let shared = app.state::<Shared>();
                let mut st = shared.hub.store.lock().unwrap();
                if st.tick(now) {
                    mark_dirty();
                }
                st.sessions_needing_branch(now, 30_000)
            };
            for (id, cwd) in todo {
                let app = app.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let found = branch::lookup(&cwd);
                    if app.state::<Shared>().hub.store.lock().unwrap().set_branch(&id, found) {
                        mark_dirty();
                    }
                });
            }
        }
    });
}

pub fn run() {
    let settings = settings::load();
    let hub = Hub::new(|cues: Vec<Cue>| {
        mark_dirty();
        if !cues.is_empty() {
            if let Some(app) = APP.get() {
                let _ = app.emit_to(WINDOW_LABEL, "cues", cues);
            }
        }
    });
    let hotkey = settings.hotkey.clone();
    let shared = Shared {
        settings: Mutex::new(settings),
        gate: Arc::new(Gate::new()),
        hub,
        usage: Mutex::new(Usage::default()),
    };
    apply_store_limits(&shared);

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let _ = app.emit_to(WINDOW_LABEL, "tray", "open");
        }))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(shared)
        .invoke_handler(tauri::generate_handler![
            boot, snapshot, save_settings, set_island_rect, focus_window, reposition, ack, answer, release,
            install_status, install_preview, install_write, open_settings_window, log, quit_app
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            let _ = APP.set(handle.clone());
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            log::line(format!("session-buddy {} starting", env!("CARGO_PKG_VERSION")));
            install::ensure_relay(&handle);
            let shared = handle.state::<Shared>();
            if let Some(win) = island::window(&handle) {
                island::prepare(&win);
            }
            let screen = shared.settings.lock().unwrap().screen.clone();
            island::apply_geometry(&handle, &screen);
            island::spawn_cursor_poll(handle.clone(), shared.gate.clone());
            ipc::start(shared.hub.clone());
            spawn_bootstrap(handle.clone());
            spawn_loops(handle.clone());
            usage_poll::spawn(handle.clone());
            tray::build(&handle)?;
            register_hotkey(&handle, &hotkey);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running session-buddy");
}
```

- [ ] **Step 6: Build**

Create a placeholder `dist/index.html` so `generate_context!` finds the frontend dir before Task 9 builds it:
```bash
mkdir -p dist && cp index.html dist/index.html && cp index.html dist/settings.html
cargo build -p session-buddy
```
Expected: builds with no errors. Fix any Tauri API name drift with Context7 (`/tauri-apps/tauri`), never by removing behaviour. `cargo clippy -p session-buddy -- -D warnings` should be clean.

- [ ] **Step 7: Smoke test the backend with the relay (no UI yet)**

```bash
cargo build --release -p sb-relay
cargo run -p session-buddy &   # leave running; the window is blank for now
sleep 8
echo '{"hook_event_name":"SessionStart","session_id":"smoke","cwd":"C:/Projects/pushdocs"}' | ./target/release/sb-relay hook SessionStart
tail -5 "$LOCALAPPDATA/session-buddy/session-buddy.log"
```
Expected log lines: `session-buddy 0.1.0 starting`, `bootstrap: N recent session(s)`, `usage source ...`. On macOS use `tail -5 ~/Library/Logs/session-buddy.log`. Stop the app afterwards (`kill %1`).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "Add Tauri app backend: relay listener, pollers, commands and window"
```

### Task 9: Front end - types, bridge, state, formatters and view model

**Files:**
- Create: `src/core/types.ts`, `src/core/layout.ts`, `src/core/bridge.ts`, `src/core/state.ts`
- Create: `src/model/format.ts`, `src/model/format.test.ts`, `src/model/viewmodel.ts`, `src/model/viewmodel.test.ts`

**Interfaces:**
- Consumes: Rust JSON from Task 8 (`Snapshot`, `Cue[]`, `Settings`).
- Produces:
  - `types.ts`: `Status`, `Step`, `Agent`, `BackgroundTask`, `Stats`, `QuestionOption`, `Question`, `Interaction`, `Session`, `Limit`, `Account`, `Usage`, `Snapshot`, `CueKind`, `Cue`, `EMPTY_SNAPSHOT`.
  - `layout.ts`: `IslandMode = "strip" | "compact" | "expanded"`, `IslandViewName = "session" | "interaction" | "empty" | "confused" | "greeting"`, `BotStateName`, `BotEmoteName`, constants `PANEL_W=720, PANEL_H=360, NOTCH_W=184, NOTCH_H=32, COMPACT_W=288, GREETING_W=640, STRIP_W=340, STRIP_H=28, COMPACT_ISLAND_W=480, COMPACT_H=64, EXPANDED_W=700, ROUNDED_CORNER=14, EXPANDED_CORNER=22`, `islandSize(mode, view, interactionHeight?)`, `botPosition(mode, view)`, `botGlowColor`, `botGlowOpacity`, `colorForProject`.
  - `bridge.ts`: `IS_TAURI`, `Bridge.{boot, snapshot, saveSettings, setIslandRect, focusWindow, reposition, ack, answer, release, installStatus, installPreview, installWrite, openSettingsWindow, log, quit}`, `onEvent<T>(name, handler)`.
  - `state.ts`: `Settings`, `DEFAULT_SETTINGS`, `State` (fields `mode, view, snapshot, focusId, stateOverride, mouse, mouseInIsland, isPinned, flash, notice, lastActivity, settings`; getters `sessions, focus, mochiSession, effectiveState`; `subscribe`, `notify`).
  - `format.ts`: `Level`, `level`, `fmtPct`, `fmtTokens`, `fmtLines`, `fmtDuration`, `fmtAgo`, `parseReset`, `fmtReset`, `fmtCountdown`, `firstLine`.
  - `viewmodel.ts`: `STATUS_RANK`, `loudest`, `summarize`, `stripLabel`, `botStateFor`, `cycle`, `resolveFocus`, `pendingQueue`, `sessionTitle`, `statusText`, `statusGlyph`, `runningAgents`, `statusLine`, `currentActivity`, `limitsShort`, `accountLabel`, `answersFor`.

- [ ] **Step 1: types.ts and layout.ts**

`src/core/types.ts`:
```ts
// Mirrors the JSON emitted by the Rust app (sb-core store + usage). camelCase.

export type Status = "thinking" | "working" | "needs_you" | "finished" | "error" | "idle" | "stale";

export interface Step { tool: string; label: string; at: number; ok: boolean | null }

export interface Agent {
  id: string;
  agentType: string;
  description: string | null;
  running: boolean;
  currentStep: string | null;
  startedAt: number;
  endedAt: number | null;
}

export interface BackgroundTask { id: string; kind: string; status: string; description: string; agentType: string | null }

export interface Stats {
  linesAdded: number;
  linesRemoved: number;
  contextUsedPct: number | null;
  contextTokens: number | null;
  contextSize: number | null;
  costUsd: number | null;
}

export interface QuestionOption { label: string; description?: string }
export interface Question { question: string; header?: string; options: QuestionOption[]; multiSelect?: boolean }

export type Interaction =
  | { kind: "approval"; requestId: string; tool: string; target: string; agentId: string | null; deadline: number }
  | { kind: "question"; requestId: string; questions: Question[]; deadline: number }
  | { kind: "reply"; requestId: string; message: string; deadline: number };

export interface Session {
  id: string;
  project: string;
  cwd: string;
  branch: string | null;
  termProgram: string | null;
  model: string | null;
  status: Status;
  statusSince: number;
  lastPrompt: string | null;
  lastMessage: string | null;
  steps: Step[];
  agents: Agent[];
  background: BackgroundTask[];
  stats: Stats;
  pending: Interaction[];
  startedAt: number;
  lastEventAt: number;
}

export interface Limit { usedPct: number; resetsAt: string | number | null }
export interface Account { email: string | null; org: string | null; plan: string | null }
export interface Usage {
  fiveHour: Limit | null;
  sevenDay: Limit | null;
  source: "statusline" | "oauth" | "none";
  updatedAt: number | null;
  error: string | null;
  account: Account | null;
}

export interface Snapshot { sessions: Session[]; usage: Usage; now: number }

export type CueKind = "work" | "finish" | "error" | "approval" | "rate" | "context";
export interface Cue { sessionId: string; kind: CueKind }

export const EMPTY_SNAPSHOT: Snapshot = {
  sessions: [],
  usage: { fiveHour: null, sevenDay: null, source: "none", updatedAt: null, error: null, account: null },
  now: 0,
};
```

`src/core/layout.ts`:
```ts
// Island geometry. All values are logical pixels. The window is a fixed
// 720x360 transparent panel; the island is drawn inside it, glued to the top
// edge and horizontally centred.

export type IslandMode = "strip" | "compact" | "expanded";
export type IslandViewName = "session" | "interaction" | "empty" | "confused" | "greeting";

export type BotStateName =
  | "idle" | "working" | "thinking" | "searching" | "approval" | "question"
  | "error" | "finished" | "ratelimit" | "sleeping" | "dizzy";

export type BotEmoteName = "love" | "surprised" | "proud" | "wink" | "yawn" | "happy" | "annoyed";

export const PANEL_W = 720;
export const PANEL_H = 360;

// The launch greeting animates out of a notch-sized shape (src/mochi/greeting.ts).
export const NOTCH_W = 184;
export const NOTCH_H = 32;
export const COMPACT_W = 288;
export const GREETING_W = 640;

export const STRIP_W = 340;
export const STRIP_H = 28;
export const COMPACT_ISLAND_W = 480;
export const COMPACT_H = 64;
export const EXPANDED_W = 700;

export const ROUNDED_CORNER = 14;
export const EXPANDED_CORNER = 22;

const VIEW_HEIGHTS: Record<IslandViewName, number> = {
  session: 320,
  interaction: 300,
  empty: 140,
  confused: 160,
  greeting: 150,
};

export function islandSize(mode: IslandMode, view: IslandViewName, interactionHeight?: number): { w: number; h: number } {
  switch (mode) {
    case "strip":
      return { w: STRIP_W, h: STRIP_H };
    case "compact":
      return { w: COMPACT_ISLAND_W, h: COMPACT_H };
    case "expanded":
      if (view === "greeting") return { w: GREETING_W, h: VIEW_HEIGHTS.greeting };
      if (view === "interaction" && interactionHeight) {
        return { w: EXPANDED_W, h: Math.max(200, Math.min(PANEL_H, Math.round(interactionHeight))) };
      }
      return { w: EXPANDED_W, h: VIEW_HEIGHTS[view] };
  }
}

export interface BotPlacement { cx: number; cy: number; diameter: number; opacity: number }

export function botPosition(mode: IslandMode, view: IslandViewName): BotPlacement {
  switch (mode) {
    case "strip":
      return { cx: 18, cy: 14, diameter: 16, opacity: 1 };
    case "compact":
      return { cx: 34, cy: 32, diameter: 38, opacity: 1 };
    case "expanded":
      if (view === "greeting") return { cx: 320, cy: 90, diameter: 0, opacity: 0 };
      return { cx: 56, cy: 96, diameter: 58, opacity: 1 };
  }
}
```
Then append `botGlowColor`, `botGlowOpacity` copied verbatim from `coucou/windows/src/core/layout.ts` (the two functions starting at `export function botGlowColor(` and `export function botGlowOpacity(`), and this project colour table:
```ts
const PROJECT_COLORS: Record<string, string> = {
  pushdocs: "#60A5FA",
  fetchdocs: "#22C55E",
  bankconnect: "#F5A524",
  invoicerails: "#E879F9",
  gmi: "#F4505E",
  "session-buddy": "#22D3EE",
};

const FALLBACK_COLORS = ["#34D399", "#EAB308", "#818CF8", "#F472B6", "#FB923C", "#2DD4BF"];

export function colorForProject(name: string): string {
  const key = name.toLowerCase().trim();
  const exact = PROJECT_COLORS[key];
  if (exact) return exact;
  for (const [k, c] of Object.entries(PROJECT_COLORS)) {
    if (key.startsWith(k) || key.includes(k)) return c;
  }
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return FALLBACK_COLORS[Math.abs(hash) % FALLBACK_COLORS.length];
}
```

- [ ] **Step 2: bridge.ts and state.ts**

`src/core/bridge.ts`:
```ts
// Thin wrapper over the Tauri commands and events. Outside Tauri (plain
// browser, dev/preview.html) every call dispatches an `sb-invoke` DOM event
// instead, so the preview can react to answers.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Settings } from "./state";
import type { Snapshot } from "./types";

export const IS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function browserInvoke(cmd: string, args?: Record<string, unknown>) {
  window.dispatchEvent(new CustomEvent("sb-invoke", { detail: { cmd, args } }));
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!IS_TAURI) {
    browserInvoke(cmd, args);
    return null;
  }
  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    console.error(`${cmd} failed`, err);
    return null;
  }
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

async function attempt<T>(cmd: string, args?: Record<string, unknown>): Promise<Result<T>> {
  if (!IS_TAURI) {
    browserInvoke(cmd, args);
    return { ok: false, error: "Not running inside session-buddy." };
  }
  try {
    return { ok: true, value: await invoke<T>(cmd, args) };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export interface BootInfo { settings: Settings; version: string }
export interface InstallStatus {
  hooksInstalled: boolean;
  statusLineInstalled: boolean;
  settingsPath: string;
  relayPath: string;
  relayReady: boolean;
}
export interface InstallPreview { diff: string; settingsPath: string; fingerprint: string }

export const Bridge = {
  boot: () => call<BootInfo>("boot"),
  snapshot: () => call<Snapshot>("snapshot"),
  saveSettings: (settings: Settings) => call<void>("save_settings", { settings }),
  setIslandRect: (x: number, y: number, width: number, height: number) =>
    call<void>("set_island_rect", { x, y, width, height }),
  focusWindow: (focused: boolean) => call<void>("focus_window", { focused }),
  reposition: () => call<void>("reposition"),
  ack: (requestId: string) => call<void>("ack", { requestId }),
  /** Resolves to an error message, or null when the answer was delivered. */
  answer: async (requestId: string, answer: unknown): Promise<string | null> => {
    const r = await attempt<void>("answer", { requestId, answer });
    return r.ok || !IS_TAURI ? null : r.error;
  },
  release: (requestId: string) => call<void>("release", { requestId }),
  installStatus: () => call<InstallStatus>("install_status"),
  installPreview: (install: boolean) => attempt<InstallPreview>("install_preview", { install }),
  installWrite: (install: boolean, fingerprint: string) => attempt<string>("install_write", { install, fingerprint }),
  openSettingsWindow: () => call<void>("open_settings_window"),
  log: (message: string) => call<void>("log", { message }),
  quit: () => call<void>("quit_app"),
};

export async function onEvent<T>(name: string, handler: (payload: T) => void) {
  if (!IS_TAURI) return;
  await listen<T>(name, (e) => handler(e.payload));
}
```

`src/core/state.ts`:
```ts
// UI state. Sessions themselves live in Rust; `snapshot` is the latest copy.

import type { BotStateName, IslandMode, IslandViewName } from "./layout";
import { EMPTY_SNAPSHOT, type Session, type Snapshot } from "./types";
import { botStateFor, loudest } from "../model/viewmodel";

export interface Settings {
  soundEnabled: boolean;
  soundVolume: number;
  autoCloseInterval: number;
  compactInterval: number;
  staleMinutes: number;
  removeMinutes: number;
  screen: "primary" | "cursor";
  autostart: boolean;
  hotkey: string;
  contextSound: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  soundEnabled: true,
  soundVolume: 0.12,
  autoCloseInterval: 15,
  compactInterval: 6,
  staleMinutes: 10,
  removeMinutes: 120,
  screen: "primary",
  autostart: false,
  hotkey: "Ctrl+Alt+Space",
  contextSound: true,
};

type Listener = () => void;

class AppState {
  mode: IslandMode = "strip";
  view: IslandViewName = "session";
  snapshot: Snapshot = EMPTY_SNAPSHOT;
  focusId: string | null = null;
  stateOverride: BotStateName | null = null;
  mouse = { x: 0, y: 0 };
  mouseInIsland = { x: 0, y: 0 };
  isPinned = false;
  /** After a session finishes, its last message shows in the compact island until `until`. */
  flash: { sessionId: string; until: number } | null = null;
  /** Short message on the interaction card, e.g. when an answer arrived too late. */
  notice: { text: string; until: number } | null = null;
  lastActivity = performance.now();
  settings: Settings = { ...DEFAULT_SETTINGS };

  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  notify() {
    for (const fn of this.listeners) fn();
  }

  get sessions(): Session[] {
    return this.snapshot.sessions;
  }

  get focus(): Session | null {
    return this.sessions.find((s) => s.id === this.focusId) ?? this.sessions[0] ?? null;
  }

  /** The strip shows the loudest session; compact and expanded show the focused one. */
  get mochiSession(): Session | null {
    return this.mode === "strip" ? loudest(this.sessions) : this.focus;
  }

  get effectiveState(): BotStateName {
    return this.stateOverride ?? botStateFor(this.mochiSession);
  }
}

export const State = new AppState();
```

- [ ] **Step 3: Write the failing tests for format.ts**

`src/model/format.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { firstLine, fmtAgo, fmtCountdown, fmtDuration, fmtLines, fmtReset, fmtTokens, level, parseReset } from "./format";

describe("format", () => {
  it("levels at 70 and 90", () => {
    expect(level(69.9)).toBe("ok");
    expect(level(70)).toBe("warn");
    expect(level(90)).toBe("crit");
    expect(level(null)).toBe("ok");
  });

  it("tokens", () => {
    expect(fmtTokens(950)).toBe("950");
    expect(fmtTokens(122_000)).toBe("122k");
    expect(fmtTokens(1_000_000)).toBe("1.0M");
    expect(fmtTokens(null)).toBe("?");
  });

  it("lines use a plain hyphen", () => {
    expect(fmtLines(128, 34)).toBe("+128 -34");
  });

  it("durations and ages", () => {
    expect(fmtDuration(42_000)).toBe("42s");
    expect(fmtDuration(252_000)).toBe("4m 12s");
    expect(fmtDuration(3_900_000)).toBe("1h 5m");
    expect(fmtAgo(30_000)).toBe("just now");
    expect(fmtAgo(5 * 60_000)).toBe("5m ago");
    expect(fmtAgo(3 * 3600_000)).toBe("3h ago");
    expect(fmtCountdown(105_000)).toBe("1:45");
    expect(fmtCountdown(-5)).toBe("0:00");
  });

  it("parses reset times in seconds, millis and ISO", () => {
    expect(parseReset(1_790_000_000)).toBe(1_790_000_000_000);
    expect(parseReset(1_790_000_000_000)).toBe(1_790_000_000_000);
    expect(parseReset("2026-10-01T14:30:00Z")).toBe(Date.parse("2026-10-01T14:30:00Z"));
    expect(parseReset("nope")).toBeNull();
    expect(parseReset(null)).toBeNull();
  });

  it("formats resets as time today or weekday + time", () => {
    const now = new Date(2026, 9, 1, 9, 0).getTime(); // Thu 1 Oct 2026, 09:00 local
    expect(fmtReset(new Date(2026, 9, 1, 14, 30).getTime(), now)).toBe("14:30");
    expect(fmtReset(new Date(2026, 9, 5, 9, 0).getTime(), now)).toBe("Mon 09:00");
    expect(fmtReset(null, now)).toBe("");
  });

  it("first non-empty line, clipped", () => {
    expect(firstLine("\n\n  Hello there  \nsecond")).toBe("Hello there");
    expect(firstLine("x".repeat(200), 10)).toBe("xxxxxxxxx\u2026");
    expect(firstLine(null)).toBe("");
  });
});
```

- [ ] **Step 4: Run to verify they fail**

Run: `npm install` (first time) then `npx vitest run src/model/format.test.ts`
Expected: FAIL, cannot resolve `./format`.

- [ ] **Step 5: Implement format.ts**

`src/model/format.ts`:
```ts
// Small formatters shared by every view. Plain hyphens only.

export type Level = "ok" | "warn" | "crit";

export function level(pct: number | null | undefined): Level {
  if (pct == null) return "ok";
  return pct >= 90 ? "crit" : pct >= 70 ? "warn" : "ok";
}

export const fmtPct = (p: number): string => String(Math.round(p));

export function fmtTokens(n: number | null | undefined): string {
  if (n == null) return "?";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export const fmtLines = (added: number, removed: number): string => `+${added} -${removed}`;

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function fmtAgo(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

export function parseReset(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

const pad = (n: number) => String(n).padStart(2, "0");
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function fmtReset(v: string | number | null | undefined, now: number): string {
  const t = parseReset(v);
  if (t == null) return "";
  const d = new Date(t);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return t - now < 24 * 3600_000 ? hm : `${DAYS[d.getDay()]} ${hm}`;
}

export function fmtCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

export function firstLine(text: string | null | undefined, max = 120): string {
  if (!text) return "";
  const line = (text.split(/\r?\n/).find((l) => l.trim()) ?? "").trim();
  return line.length > max ? `${line.slice(0, max - 1)}\u2026` : line;
}
```

- [ ] **Step 6: Run to verify format tests pass**

Run: `npx vitest run src/model/format.test.ts`
Expected: 7 passed.

- [ ] **Step 7: Write the failing tests for viewmodel.ts**

`src/model/viewmodel.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import type { Interaction, Session, Usage } from "../core/types";
import {
  accountLabel, answersFor, botStateFor, currentActivity, cycle, limitsShort, loudest, pendingQueue,
  resolveFocus, sessionTitle, statusLine, stripLabel, summarize,
} from "./viewmodel";

let n = 0;
function mk(p: Partial<Session> = {}): Session {
  n += 1;
  return {
    id: `s${n}`, project: "pushdocs", cwd: "C:/Projects/pushdocs", branch: null, termProgram: "WarpTerminal",
    model: null, status: "idle", statusSince: 0, lastPrompt: null, lastMessage: null, steps: [], agents: [],
    background: [], pending: [], startedAt: n, lastEventAt: n,
    stats: { linesAdded: 0, linesRemoved: 0, contextUsedPct: null, contextTokens: null, contextSize: null, costUsd: null },
    ...p,
  };
}

const approval = (id: string): Interaction => ({ kind: "approval", requestId: id, tool: "Bash", target: "Bash · ls", agentId: null, deadline: 0 });

describe("viewmodel", () => {
  it("loudest prefers needs_you, then error, then working", () => {
    const a = mk({ status: "working" });
    const b = mk({ status: "needs_you", pending: [approval("r1")] });
    const c = mk({ status: "error" });
    expect(loudest([a, b, c])?.id).toBe(b.id);
    expect(loudest([a, c])?.id).toBe(c.id);
    expect(loudest([])).toBeNull();
  });

  it("strip label counts", () => {
    expect(stripLabel(summarize([]))).toBe("No sessions");
    const one = [mk({ status: "working" })];
    expect(stripLabel(summarize(one))).toBe("1 session · 1 working");
    const four = [mk({ status: "working" }), mk({ status: "thinking" }), mk({ status: "needs_you" }), mk()];
    expect(stripLabel(summarize(four))).toBe("4 sessions · 2 working · 1 needs you");
  });

  it("maps status to Mochi", () => {
    expect(botStateFor(null)).toBe("idle");
    expect(botStateFor(mk({ status: "needs_you", pending: [approval("r")] }))).toBe("approval");
    expect(botStateFor(mk({ status: "needs_you", pending: [{ kind: "reply", requestId: "r", message: "?", deadline: 0 }] }))).toBe("question");
    expect(botStateFor(mk({ status: "stale" }))).toBe("sleeping");
    expect(botStateFor(mk({ status: "finished" }))).toBe("finished");
  });

  it("cycles with wrap-around", () => {
    const list = [mk(), mk(), mk()];
    expect(cycle(list, list[2].id, 1)).toBe(list[0].id);
    expect(cycle(list, list[0].id, -1)).toBe(list[2].id);
    expect(cycle(list, null, 1)).toBe(list[0].id);
    expect(cycle([], null, 1)).toBeNull();
  });

  it("focus jumps to a session that just started waiting", () => {
    const a = mk({ status: "working" });
    const b = mk({ status: "working" });
    const bWaiting = { ...b, status: "needs_you" as const, pending: [approval("r1")] };
    expect(resolveFocus(a.id, [a, b], [a, bWaiting])).toEqual({ focusId: b.id, newlyPending: b.id });
    // Already waiting before: no jump.
    expect(resolveFocus(a.id, [a, bWaiting], [a, bWaiting])).toEqual({ focusId: a.id, newlyPending: null });
    // Focused session ended: fall back to the loudest.
    expect(resolveFocus("gone", [a], [a, bWaiting]).focusId).toBe(b.id);
  });

  it("pending queue order: focused session first, then others in list order", () => {
    const a = mk({ status: "needs_you", pending: [approval("a1"), approval("a2")] });
    const b = mk({ status: "needs_you", pending: [approval("b1")] });
    expect(pendingQueue([a, b], b.id).map((x) => x.item.requestId)).toEqual(["b1", "a1", "a2"]);
    expect(pendingQueue([a, b], null).map((x) => x.item.requestId)).toEqual(["a1", "a2", "b1"]);
  });

  it("titles and status lines", () => {
    expect(sessionTitle(mk({ project: "pushdocs", branch: "PDD-1981" }))).toBe("pushdocs · PDD-1981");
    expect(sessionTitle(mk({ project: "x", branch: null }))).toBe("x");
    const s = mk({
      status: "working", statusSince: 0,
      agents: [
        { id: "a", agentType: "Explore", description: null, running: true, currentStep: null, startedAt: 0, endedAt: null },
        { id: "b", agentType: "Plan", description: null, running: false, currentStep: null, startedAt: 0, endedAt: 1 },
      ],
    });
    expect(statusLine(s, 252_000)).toBe("working · 1 agent · 4m 12s");
    expect(statusLine(mk({ status: "idle" }), 0)).toBe("idle");
  });

  it("current activity", () => {
    expect(currentActivity(mk({ status: "working", steps: [{ tool: "Edit", label: "Edit · a.php", at: 0, ok: null }] }))).toBe("Edit · a.php");
    expect(currentActivity(mk({ status: "needs_you", pending: [approval("r")] }))).toBe("Waiting for you: Bash · ls");
    expect(currentActivity(mk({ status: "finished", lastMessage: "Done.\nMore" }))).toBe("Done.");
    expect(currentActivity(mk({ status: "thinking", lastPrompt: "fix it" }))).toBe("Thinking: fix it");
  });

  it("limits and account", () => {
    const u: Usage = { fiveHour: { usedPct: 42, resetsAt: null }, sevenDay: { usedPct: 91, resetsAt: null }, source: "oauth", updatedAt: 1, error: null, account: { email: "w@x.de", org: "finodata", plan: "Team" } };
    expect(limitsShort(u)).toEqual({ text: "5H 42% · 7D 91%", level: "crit" });
    expect(limitsShort({ ...u, fiveHour: null, sevenDay: null })).toEqual({ text: "", level: "ok" });
    expect(accountLabel(u)).toBe("w@x.de · finodata · Team");
    expect(accountLabel({ ...u, account: null })).toBe("");
  });

  it("builds AskUserQuestion answers as strings", () => {
    const qs = [
      { question: "Pick a color?", options: [{ label: "Red" }, { label: "Blue" }] },
      { question: "Which files?", options: [{ label: "a" }, { label: "b" }], multiSelect: true },
    ];
    expect(answersFor(qs, { "Pick a color?": ["Blue"] }, {})).toBeNull();
    expect(answersFor(qs, { "Pick a color?": ["Blue"], "Which files?": ["a", "b"] }, {})).toEqual({ "Pick a color?": "Blue", "Which files?": "a, b" });
    expect(answersFor(qs, { "Which files?": ["a"] }, { "Pick a color?": "  green  ", "Which files?": "c" })).toEqual({ "Pick a color?": "green", "Which files?": "a, c" });
  });
});
```

- [ ] **Step 8: Run to verify they fail**

Run: `npx vitest run src/model/viewmodel.test.ts`
Expected: FAIL, cannot resolve `./viewmodel`.

- [ ] **Step 9: Implement viewmodel.ts**

`src/model/viewmodel.ts`:
```ts
// Pure functions from sessions to what the island shows. No DOM, no state.

import type { BotStateName } from "../core/layout";
import type { Interaction, Question, Session, Status, Usage } from "../core/types";
import { firstLine, fmtDuration, fmtPct, level, type Level } from "./format";

export const STATUS_RANK: Record<Status, number> = {
  needs_you: 6, error: 5, working: 4, thinking: 3, finished: 2, idle: 1, stale: 0,
};

export function loudest(sessions: Session[]): Session | null {
  let best: Session | null = null;
  for (const s of sessions) {
    if (!best) { best = s; continue; }
    const d = STATUS_RANK[s.status] - STATUS_RANK[best.status];
    if (d > 0 || (d === 0 && s.lastEventAt > best.lastEventAt)) best = s;
  }
  return best;
}

export interface Summary { total: number; busy: number; needsYou: number }

export function summarize(sessions: Session[]): Summary {
  return {
    total: sessions.length,
    busy: sessions.filter((s) => s.status === "working" || s.status === "thinking").length,
    needsYou: sessions.filter((s) => s.status === "needs_you").length,
  };
}

export function stripLabel(s: Summary): string {
  if (s.total === 0) return "No sessions";
  const parts = [`${s.total} session${s.total === 1 ? "" : "s"}`];
  if (s.busy) parts.push(`${s.busy} working`);
  if (s.needsYou) parts.push(`${s.needsYou} need${s.needsYou === 1 ? "s" : ""} you`);
  return parts.join(" · ");
}

export function botStateFor(s: Session | null): BotStateName {
  if (!s) return "idle";
  switch (s.status) {
    case "needs_you":
      return s.pending[0]?.kind === "approval" ? "approval" : "question";
    case "error": return "error";
    case "working": return "working";
    case "thinking": return "thinking";
    case "finished": return "finished";
    case "stale": return "sleeping";
    default: return "idle";
  }
}

export function cycle(sessions: Session[], currentId: string | null, dir: 1 | -1): string | null {
  if (sessions.length === 0) return null;
  const i = sessions.findIndex((s) => s.id === currentId);
  if (i < 0) return sessions[0].id;
  return sessions[(i + dir + sessions.length) % sessions.length].id;
}

export function resolveFocus(prevId: string | null, prev: Session[], next: Session[]): { focusId: string | null; newlyPending: string | null } {
  const before = new Map(prev.map((s) => [s.id, s.pending.length]));
  const newly = next.find((s) => s.pending.length > 0 && (before.get(s.id) ?? 0) === 0);
  if (newly) return { focusId: newly.id, newlyPending: newly.id };
  if (prevId && next.some((s) => s.id === prevId)) return { focusId: prevId, newlyPending: null };
  return { focusId: loudest(next)?.id ?? null, newlyPending: null };
}

export function pendingQueue(sessions: Session[], focusId: string | null): { session: Session; item: Interaction }[] {
  const ordered = [...sessions].sort((a, b) => (a.id === focusId ? -1 : b.id === focusId ? 1 : 0));
  return ordered.flatMap((session) => session.pending.map((item) => ({ session, item })));
}

export const sessionTitle = (s: Session): string => (s.branch ? `${s.project} · ${s.branch}` : s.project);

const STATUS_TEXT: Record<Status, string> = {
  thinking: "thinking", working: "working", needs_you: "needs you", finished: "finished",
  error: "error", idle: "idle", stale: "stale",
};
export const statusText = (s: Session): string => STATUS_TEXT[s.status];

const GLYPHS: Record<Status, string> = {
  thinking: "\u25CF", working: "\u25CF", needs_you: "!", finished: "\u2713", error: "\u00D7", idle: "\u25CB", stale: "\u25CC",
};
export const statusGlyph = (status: Status): string => GLYPHS[status];

export const runningAgents = (s: Session): number => s.agents.filter((a) => a.running).length;

export function statusLine(s: Session, now: number): string {
  const parts = [statusText(s)];
  const agents = runningAgents(s);
  if (agents) parts.push(`${agents} agent${agents === 1 ? "" : "s"}`);
  if (s.status === "working" || s.status === "thinking") parts.push(fmtDuration(now - s.statusSince));
  return parts.join(" · ");
}

export function currentActivity(s: Session): string {
  const p = s.pending[0];
  if (p) {
    if (p.kind === "approval") return `Waiting for you: ${p.target}`;
    if (p.kind === "question") return `Question: ${firstLine(p.questions[0]?.question)}`;
    return `Asked: ${firstLine(p.message)}`;
  }
  switch (s.status) {
    case "working": {
      const running = s.agents.find((a) => a.running && a.currentStep);
      const last = s.steps[s.steps.length - 1];
      return last?.label ?? (running ? `${running.agentType} · ${running.currentStep}` : "");
    }
    case "thinking": return s.lastPrompt ? `Thinking: ${firstLine(s.lastPrompt)}` : "Thinking";
    case "finished":
    case "error": return firstLine(s.lastMessage);
    case "idle": return s.lastPrompt ? `Last: ${firstLine(s.lastPrompt)}` : "";
    case "stale": return "No activity for a while";
    default: return "";
  }
}

export function limitsShort(u: Usage): { text: string; level: Level } {
  const parts: string[] = [];
  let worst = 0;
  if (u.fiveHour) { parts.push(`5H ${fmtPct(u.fiveHour.usedPct)}%`); worst = Math.max(worst, u.fiveHour.usedPct); }
  if (u.sevenDay) { parts.push(`7D ${fmtPct(u.sevenDay.usedPct)}%`); worst = Math.max(worst, u.sevenDay.usedPct); }
  return { text: parts.join(" · "), level: parts.length ? level(worst) : "ok" };
}

export function accountLabel(u: Usage): string {
  const a = u.account;
  if (!a) return "";
  return [a.email, a.org, a.plan].filter(Boolean).join(" · ");
}

/** AskUserQuestion `answers`: one string per question, multi-select joined with ", ". Null while incomplete. */
export function answersFor(questions: Question[], picks: Record<string, string[]>, other: Record<string, string>): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const q of questions) {
    const labels = picks[q.question] ?? [];
    const typed = other[q.question]?.trim() ?? "";
    let value: string;
    if (q.multiSelect) value = [...labels, ...(typed ? [typed] : [])].join(", ");
    else value = typed || labels[0] || "";
    if (!value) return null;
    out[q.question] = value;
  }
  return out;
}
```

- [ ] **Step 10: Run all front-end tests and the type check**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 17 tests pass. `tsc` may report errors only from files that do not exist yet (none at this point: `main.ts` is the stub). Fix any type error in the new files.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "Add front-end types, bridge, state, formatters and view model"
```

---

### Task 10: Front end - the island shell with strip and compact views

**Files:**
- Create: `src/island/fsm.ts` (from coucou, renamed states), `src/island/island.ts`, `src/main.ts`
- Create: `src/views/views.ts`, `src/views/parts.ts`, `src/views/strip.ts`, `src/views/compact.ts`
- Create: `src/style.css`
- Create (temporary, replaced in Tasks 11 and 12): `src/views/expanded.ts`, `src/views/cards.ts`

**Interfaces:**
- Consumes: Task 9 modules, copied `anim.ts`, `sound.ts`, `engine.ts`, `greeting.ts`, `dom.ts`, `icons.ts`.
- Produces:
  - `views.ts`: `ViewActions { focus(id), cycle(dir: 1 | -1), expand(), collapse(), answer(requestId, answer: unknown), release(requestId), openSettings(), wantKeyboard(on: boolean), relayout() }`, `ViewHost { el, sync(), tick?(nowMs), measure?(): number, key?(e: KeyboardEvent): boolean }`, `buildViews(actions): Map<IslandViewName, ViewHost>`.
  - `parts.ts`: `bar(pct: number | null, width?: number): HTMLElement`, `statusDot(s: Session): HTMLElement`, `btn(label, kind: "primary" | "secondary" | "danger", onClick, title?): HTMLButtonElement`, `keyed(container: HTMLElement, key: string, build: () => Node[]): void`.
  - `expanded.ts`: `buildSessionView(actions): ViewHost`; `cards.ts`: `buildInteraction(actions): ViewHost`.
  - `Island` public: `launch()`, `onCursor(x, y)`, `onSnapshot(snap)`, `onCues(cues)`, `open()`, `toggleFromHotkey()`, `applySettings()`.

- [ ] **Step 1: fsm.ts**

Copy `coucou/windows/src/island/fsm.ts` to `src/island/fsm.ts`, then:
1. Replace the header comment with `// Island open/close state machine (from Coucou). The resting state is the strip: the island never hides.`
2. Rename the state `"hidden"` to `"strip"` everywhere (type `FsmState = "strip" | "petit" | "home" | "coucou"`, initial `state: FsmState = "strip"`, every `case "hidden"` and `transition("hidden")`).
3. Rename `petitToHiddenDelay` to `compactToStripDelay` (default `6`), `schedulePetitHide` to `scheduleCompactRest`, the timer field `petitHide` to `compactRest` (and its string in the `clear(...)` union).
4. Delete the `forceHidden()` method.

Run: `npx tsc --noEmit` - Expected: no errors from `fsm.ts`.

- [ ] **Step 2: parts.ts and views.ts (with temporary expanded/cards)**

`src/views/parts.ts`:
```ts
// Small building blocks shared by the views.

import { h, clear } from "./dom";
import { colorForProject } from "../core/layout";
import type { Session } from "../core/types";
import { level } from "../model/format";
import { statusGlyph } from "../model/viewmodel";

export function bar(pct: number | null, width = 64): HTMLElement {
  const fill = h("i", { style: `width:${Math.max(0, Math.min(100, pct ?? 0))}%` });
  return h("span", { class: `bar ${level(pct)}`, style: `width:${width}px` }, fill);
}

export function statusDot(s: Session): HTMLElement {
  return h("span", { class: `sglyph ${s.status}`, style: `--c:${colorForProject(s.project)}`, text: statusGlyph(s.status) });
}

export function btn(label: string, kind: "primary" | "secondary" | "danger", onClick: () => void, title?: string): HTMLButtonElement {
  return h("button", { class: `btn ${kind}`, title, onclick: (e: Event) => { e.stopPropagation(); onClick(); } }, h("span", { text: label }));
}

/** Rebuilds `container` only when `key` changed, so CSS animations are not restarted on every sync. */
export function keyed(container: HTMLElement, key: string, build: () => Node[]) {
  if (container.dataset.key === key) return;
  container.dataset.key = key;
  clear(container);
  container.append(...build());
}
```

`src/views/views.ts`:
```ts
// Expanded-island views and the contract every view host follows.

import { h } from "./dom";
import type { IslandViewName } from "../core/layout";
import { buildSessionView } from "./expanded";
import { buildInteraction } from "./cards";

export interface ViewActions {
  focus(id: string): void;
  cycle(dir: 1 | -1): void;
  expand(): void;
  collapse(): void;
  answer(requestId: string, answer: unknown): void;
  release(requestId: string): void;
  openSettings(): void;
  /** Ask the OS for keyboard focus (hotkey, reply box) or give it back. */
  wantKeyboard(on: boolean): void;
  /** Content height changed: re-run the island geometry. */
  relayout(): void;
}

export interface ViewHost {
  el: HTMLElement;
  sync(): void;
  tick?(nowMs: number): void;
  measure?(): number;
  /** Return true when the key was handled. */
  key?(e: KeyboardEvent): boolean;
}

function simple(cls: string, title: string, sub: string): ViewHost {
  const el = h("div", { class: `view ${cls}` }, h("div", { class: "title", text: title }), h("div", { class: "sub", text: sub }));
  return { el, sync() {} };
}

export function buildViews(actions: ViewActions): Map<IslandViewName, ViewHost> {
  return new Map<IslandViewName, ViewHost>([
    ["session", buildSessionView(actions)],
    ["interaction", buildInteraction(actions)],
    ["empty", simple("empty-view", "No Claude Code sessions yet", "Start claude in Warp or any terminal. Sessions appear here on their first event.")],
    ["confused", simple("confused-view", "Ouch.", "Give Mochi a second.")],
    ["greeting", { el: h("div", { class: "view" }), sync() {} }],
  ]);
}
```

Temporary `src/views/expanded.ts`:
```ts
import { h } from "./dom";
import type { ViewActions, ViewHost } from "./views";

export function buildSessionView(_actions: ViewActions): ViewHost {
  return { el: h("div", { class: "view", text: "session view (Task 11)" }), sync() {} };
}
```
Temporary `src/views/cards.ts`:
```ts
import { h } from "./dom";
import type { ViewActions, ViewHost } from "./views";

export function buildInteraction(_actions: ViewActions): ViewHost {
  return { el: h("div", { class: "view", text: "interaction view (Task 12)" }), sync() {} };
}
```

- [ ] **Step 3: strip.ts and compact.ts**

`src/views/strip.ts`:
```ts
// The resting island: a slim bar that is always on screen.

import { h, clear } from "./dom";
import { colorForProject } from "../core/layout";
import { State } from "../core/state";
import { limitsShort, stripLabel, summarize } from "../model/viewmodel";
import type { ViewHost } from "./views";

export function buildStrip(): ViewHost {
  const label = h("span", { class: "strip-label" });
  const dots = h("span", { class: "strip-dots" });
  const limits = h("span", { class: "strip-limits" });
  const el = h("div", { class: "layer strip" }, label, dots, limits);
  let dotsKey = "";
  return {
    el,
    sync() {
      const sessions = State.sessions;
      label.textContent = stripLabel(summarize(sessions));
      const key = sessions.map((s) => `${s.id}:${s.status}`).join("|");
      if (key !== dotsKey) {
        dotsKey = key;
        clear(dots);
        for (const s of sessions) {
          dots.append(h("i", { class: `sdot ${s.status}`, style: `--c:${colorForProject(s.project)}`, title: s.project }));
        }
      }
      const l = limitsShort(State.snapshot.usage);
      limits.textContent = l.text;
      limits.className = `strip-limits ${l.level}`;
    },
  };
}
```

`src/views/compact.ts`:
```ts
// Hover / event state: one session card, flip with the wheel or the arrows.

import { h, svg } from "./dom";
import { ICONS } from "./icons";
import { State } from "../core/state";
import { fmtLines, fmtPct, level } from "../model/format";
import { currentActivity, sessionTitle, statusLine } from "../model/viewmodel";
import { statusDot } from "./parts";
import type { ViewActions, ViewHost } from "./views";

export function buildCompact(actions: ViewActions): ViewHost {
  const title = h("span", { class: "c-title" });
  const lines = h("span", { class: "c-lines" });
  const ctx = h("span", { class: "c-ctx" });
  const page = h("span", { class: "c-page" });
  const prev = h("button", { class: "icon-btn", title: "Previous session", onclick: (e: Event) => { e.stopPropagation(); actions.cycle(-1); } }, svg(ICONS.chevronLeft, 10, { stroke: 2.4 }));
  const next = h("button", { class: "icon-btn", title: "Next session", onclick: (e: Event) => { e.stopPropagation(); actions.cycle(1); } }, svg(ICONS.chevronRight, 10, { stroke: 2.4 }));
  const pager = h("span", { class: "c-pager" }, prev, page, next);
  const status = h("span", { class: "c-status" });
  const activity = h("span", { class: "c-activity" });
  const el = h(
    "div",
    { class: "layer compact" },
    h("div", { class: "c-row1" }, title, lines, ctx, pager),
    h("div", { class: "c-row2" }, status, activity),
  );

  return {
    el,
    sync() {
      const s = State.focus;
      const all = State.sessions;
      if (!s) {
        title.textContent = "No sessions yet";
        lines.textContent = "";
        ctx.textContent = "";
        pager.style.display = "none";
        status.replaceChildren(document.createTextNode("Start claude in any terminal"));
        activity.textContent = "";
        return;
      }
      title.textContent = sessionTitle(s);
      lines.textContent = s.stats.linesAdded || s.stats.linesRemoved ? fmtLines(s.stats.linesAdded, s.stats.linesRemoved) : "";
      const pct = s.stats.contextUsedPct;
      ctx.textContent = pct == null ? "" : `ctx ${fmtPct(pct)}%`;
      ctx.className = `c-ctx ${level(pct)}`;
      pager.style.display = all.length > 1 ? "" : "none";
      page.textContent = `${all.indexOf(s) + 1}/${all.length}`;
      status.replaceChildren(statusDot(s), document.createTextNode(statusLine(s, Date.now())));
      const flashing = State.flash?.sessionId === s.id && !!s.lastMessage;
      activity.textContent = flashing ? (s.lastMessage ?? "") : currentActivity(s);
      activity.classList.toggle("shimmer", !flashing && (s.status === "working" || s.status === "thinking"));
      activity.classList.toggle("flash", flashing);
    },
    tick() {
      // Keeps the "4m 12s" counter moving while the compact island is visible.
      const s = State.focus;
      if (s && (s.status === "working" || s.status === "thinking")) {
        const text = statusLine(s, Date.now());
        if (status.lastChild?.textContent !== text) status.replaceChildren(statusDot(s), document.createTextNode(text));
      }
    },
  };
}
```

- [ ] **Step 4: island.ts**

`src/island/island.ts`:
```ts
// The island: DOM shell, sizing animation, Mochi placement, mouse, wheel and keys.
// Forked from Coucou's island.ts. File drop, chat and integration pills are gone,
// and the island never hides: it rests as a strip.

import { Tracked, Spring, clamp } from "../core/anim";
import { Bridge, IS_TAURI } from "../core/bridge";
import {
  EXPANDED_CORNER, GREETING_W, PANEL_W, ROUNDED_CORNER, STRIP_W, botGlowColor, botGlowOpacity, botPosition,
  colorForProject, islandSize, type IslandMode, type IslandViewName,
} from "../core/layout";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import type { Cue, CueKind, Snapshot } from "../core/types";
import { BotEngine, hexToRGB } from "../mochi/engine";
import { Greeting } from "../mochi/greeting";
import { cycle, pendingQueue, resolveFocus } from "../model/viewmodel";
import { h } from "../views/dom";
import { buildCompact } from "../views/compact";
import { buildStrip } from "../views/strip";
import { buildViews, type ViewActions, type ViewHost } from "../views/views";
import { IslandStateMachine } from "./fsm";

const BOT_OVERHANG = 40;
/** Same margin as the Rust hit test (src-tauri/src/island.rs). */
const HIT_MARGIN = 14;
const FLASH_MS = 6000;
const WHEEL_GAP_MS = 180;

const CUE_SOUNDS: Record<CueKind, string> = {
  work: "work", finish: "finish", error: "error", approval: "approval", rate: "rate", context: "question",
};

const modeOrder = (m: IslandMode) => (m === "strip" ? 0 : m === "compact" ? 1 : 2);

export class Island {
  readonly fsm = new IslandStateMachine();

  private root: HTMLElement;
  private islandEl!: HTMLElement;
  private clipEl!: HTMLElement;
  private contentEl!: HTMLElement;
  private botCanvas!: HTMLCanvasElement;
  private botGlow!: HTMLElement;
  private greetingCanvas!: HTMLCanvasElement;
  private countdown!: HTMLElement;

  private strip!: ViewHost;
  private compact!: ViewHost;
  private views!: Map<IslandViewName, ViewHost>;

  private width = new Tracked(STRIP_W);
  private height = new Tracked(0);
  private radius = new Tracked(ROUNDED_CORNER);
  private botCx = new Spring(18);
  private botCy = new Spring(14);
  private botSize = new Spring(10);

  private engine = new BotEngine();
  private greeting = new Greeting();

  private running = false;
  private lastFrame = 0;
  private dirty = true;
  private canvasPx = 0;

  private wasInIsland = false;
  private pushedRect = { x: -1, y: -1, w: -1, h: -1 };
  private homeCollapseAt: number | null = null;

  private botHovering = false;
  private botHoverTimer: number | null = null;
  private lastLoveTime = 0;
  private botHoverStart = { x: 0, y: 0 };

  private confusedRecovery: number | null = null;
  private prevViewBeforeConfused: IslandViewName = "session";

  private acked = new Set<string>();
  private lastWheel = 0;
  private keyboard = false;

  constructor(root: HTMLElement) {
    this.root = root;
    this.build();
    this.wireFsm();
    this.wireInput();
    this.engine.onDizzy = () => this.handleDizzy();
    this.greeting.onComplete = () => this.fsm.greetComplete();
    State.subscribe(() => {
      this.dirty = true;
      this.ensureRunning();
    });
  }

  // ── DOM ──────────────────────────────────────────────────────────────────

  private actions(): ViewActions {
    return {
      focus: (id) => {
        State.focusId = id;
        Sound.play("blip");
        State.notify();
        this.animateGeometry(false);
      },
      cycle: (dir) => this.cycleFocus(dir),
      expand: () => this.fsm.forceHome(),
      collapse: () => this.collapse(),
      answer: (requestId, answer) => void this.answer(requestId, answer),
      release: (requestId) => {
        Sound.play("blip");
        void Bridge.release(requestId);
      },
      openSettings: () => void Bridge.openSettingsWindow(),
      wantKeyboard: (on) => this.setKeyboard(on),
      relayout: () => this.animateGeometry(false),
    };
  }

  private build() {
    const actions = this.actions();
    this.botGlow = h("div", { id: "bot-glow" });
    this.botCanvas = h("canvas", { id: "bot-canvas" });
    this.greetingCanvas = h("canvas", { id: "greeting-canvas" });
    this.countdown = h("div", { id: "countdown" });

    this.strip = buildStrip();
    this.compact = buildCompact(actions);
    this.views = buildViews(actions);
    const viewsEl = h("div", { id: "views" });
    for (const v of this.views.values()) viewsEl.append(v.el);
    this.contentEl = h("div", { id: "content" }, viewsEl);

    this.clipEl = h("div", { id: "island-clip" }, this.greetingCanvas, this.strip.el, this.compact.el, this.contentEl);
    this.islandEl = h("div", { id: "island" }, this.clipEl, this.botGlow, this.botCanvas, this.countdown);

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.greetingCanvas.width = Math.round(GREETING_W * dpr);
    this.greetingCanvas.height = Math.round(150 * dpr);
    this.greetingCanvas.style.width = `${GREETING_W}px`;
    this.greetingCanvas.style.height = "150px";

    this.root.append(this.islandEl);
    this.applyGeometry();
  }

  // ── FSM ──────────────────────────────────────────────────────────────────

  private wireFsm() {
    this.fsm.homeToPetitDelay = State.settings.autoCloseInterval;
    this.fsm.compactToStripDelay = State.settings.compactInterval;
    this.fsm.onTransition = (from, to) => {
      switch (to) {
        case "strip":
          this.setMode("strip");
          break;
        case "petit":
          if (from === "coucou") this.greeting.interrupt();
          else if (from === "strip") Sound.play("peek");
          this.setMode("compact");
          if (from === "coucou") State.view = this.defaultView();
          if (!this.wasInIsland) this.fsm.mouseLeft();
          break;
        case "home":
          this.expand(this.defaultView());
          if (!this.wasInIsland) this.fsm.mouseLeft();
          break;
        case "coucou":
          this.expand("greeting");
          this.greeting.start();
          break;
      }
      State.notify();
    };
  }

  launch() {
    this.fsm.launch();
  }

  private defaultView(): IslandViewName {
    if (pendingQueue(State.sessions, State.focusId).length) return "interaction";
    return State.sessions.length ? "session" : "empty";
  }

  // ── Mode / view ──────────────────────────────────────────────────────────

  private setMode(mode: IslandMode) {
    const prev = State.mode;
    if (mode === prev) return;
    State.mode = mode;
    if (mode === "expanded") Sound.play("open");
    if (prev === "expanded") {
      Sound.play("close");
      State.isPinned = false;
      this.fsm.pinned = false;
      this.setKeyboard(false);
    }
    if (mode !== "expanded") this.engine.resetMorph();
    this.animateGeometry(modeOrder(mode) < modeOrder(prev));
    State.notify();
  }

  private expand(view: IslandViewName) {
    State.view = view;
    if (State.mode !== "expanded") this.setMode("expanded");
    else this.animateGeometry(false);
    State.lastActivity = performance.now();
    this.homeCollapseAt = null;
    State.notify();
  }

  private setView(view: IslandViewName) {
    if (State.mode !== "expanded") {
      this.fsm.forceHome();
      State.view = view;
      this.animateGeometry(false);
      State.notify();
      return;
    }
    State.view = view;
    State.lastActivity = performance.now();
    this.animateGeometry(false);
    State.notify();
  }

  private collapse() {
    State.isPinned = false;
    this.fsm.pinned = false;
    this.fsm.forcePetit();
  }

  /** Something needs the user: open on this view and stay open until it is answered. */
  private alert(view: IslandViewName) {
    this.fsm.pinned = State.isPinned;
    this.fsm.forceHome();
    this.expand(view);
  }

  open() {
    this.fsm.forceHome();
  }

  toggleFromHotkey() {
    if (State.mode === "expanded") {
      this.collapse();
      return;
    }
    this.fsm.forceHome();
    this.setKeyboard(true);
  }

  private setKeyboard(on: boolean) {
    if (on === this.keyboard) return;
    this.keyboard = on;
    void Bridge.focusWindow(on);
  }

  private cycleFocus(dir: 1 | -1) {
    const id = cycle(State.sessions, State.focusId, dir);
    if (!id || id === State.focusId) return;
    State.focusId = id;
    Sound.play("blip");
    if (State.mode === "expanded" && State.view === "empty") this.setView("session");
    State.notify();
  }

  // ── Data from Rust ───────────────────────────────────────────────────────

  onSnapshot(snap: Snapshot) {
    const prev = State.snapshot.sessions;
    State.snapshot = snap;
    const { focusId, newlyPending } = resolveFocus(State.focusId, prev, snap.sessions);
    State.focusId = focusId;

    const queue = pendingQueue(snap.sessions, focusId);
    const live = new Set(queue.map((q) => q.item.requestId));
    for (const id of live) {
      if (!this.acked.has(id)) {
        this.acked.add(id);
        void Bridge.ack(id);
      }
    }
    for (const id of [...this.acked]) if (!live.has(id)) this.acked.delete(id);

    if (newlyPending) {
      State.isPinned = true;
      this.alert("interaction");
    } else if (queue.length === 0 && State.view === "interaction") {
      State.isPinned = false;
      this.fsm.pinned = false;
      this.setKeyboard(false);
      if (State.mode === "expanded") this.setView(snap.sessions.length ? "session" : "empty");
      else State.view = "session";
    } else if (State.mode === "expanded" && State.view === "empty" && snap.sessions.length) {
      this.setView("session");
    }
    State.notify();
    this.animateGeometry(false);
  }

  onCues(cues: Cue[]) {
    for (const c of cues) {
      if (c.kind === "context" && !State.settings.contextSound) continue;
      Sound.play(CUE_SOUNDS[c.kind]);
      if (c.kind === "finish") {
        State.flash = { sessionId: c.sessionId, until: performance.now() + FLASH_MS };
        if (c.sessionId === State.mochiSession?.id) this.engine.triggerEmote("happy");
      }
      if (c.kind !== "approval" && State.mode === "strip") this.fsm.reveal();
    }
    State.notify();
  }

  private async answer(requestId: string, answer: unknown) {
    const deny = typeof answer === "object" && answer !== null && (answer as { behavior?: string }).behavior === "deny";
    Sound.play(deny ? "blip" : "approve");
    const error = await Bridge.answer(requestId, answer);
    if (error) {
      State.notice = { text: error, until: performance.now() + 2600 };
      Sound.play("error");
      State.notify();
    }
  }

  // ── Geometry ─────────────────────────────────────────────────────────────

  private targetSize(): { w: number; h: number; r: number } {
    const { w, h } = islandSize(State.mode, State.view, this.views.get("interaction")?.measure?.());
    return { w, h, r: State.mode === "expanded" ? EXPANDED_CORNER : ROUNDED_CORNER };
  }

  private animateGeometry(shrinking: boolean) {
    const { w, h, r } = this.targetSize();
    if (shrinking) {
      this.width.curveTowards(w);
      this.height.curveTowards(h);
      this.radius.curveTowards(r);
    } else {
      this.width.springTo(w);
      this.height.springTo(h);
      this.radius.springTo(r);
    }
    this.ensureRunning();
  }

  private applyGeometry() {
    const w = this.width.value;
    const hh = this.height.value;
    const r = this.radius.value;
    this.islandEl.style.width = `${w}px`;
    this.islandEl.style.height = `${hh}px`;
    this.islandEl.style.borderRadius = `0 0 ${r}px ${r}px`;
    this.islandEl.style.transform = "translateX(-50%)";
    this.greetingCanvas.style.left = `${(w - GREETING_W) / 2}px`;
    const rect = { x: (PANEL_W - w) / 2, y: 0, w, h: hh };
    const p = this.pushedRect;
    if (Math.abs(p.x - rect.x) > 0.5 || Math.abs(p.w - rect.w) > 0.5 || Math.abs(p.h - rect.h) > 0.5) {
      this.pushedRect = rect;
      void Bridge.setIslandRect(rect.x, rect.y, rect.w, rect.h);
    }
  }

  private islandRect() {
    const w = this.width.value;
    return { x: (PANEL_W - w) / 2, y: 0, w, h: this.height.value };
  }

  // ── Input ────────────────────────────────────────────────────────────────

  private wireInput() {
    this.islandEl.addEventListener("mousedown", (e) => {
      Sound.resume();
      State.lastActivity = performance.now();
      const onButton = (e.target as Element | null)?.closest("button, input, textarea, .tab");
      if (State.mode !== "expanded") {
        if (!onButton) this.fsm.click();
        return;
      }
      if (this.isBotHit(e.clientX, e.clientY)) {
        this.cancelBotHover();
        this.engine.slap();
      }
    });

    this.islandEl.addEventListener(
      "wheel",
      (e) => {
        if ((e.target as Element | null)?.closest(".scrollable")) return;
        e.preventDefault();
        const now = performance.now();
        if (now - this.lastWheel < WHEEL_GAP_MS) return;
        this.lastWheel = now;
        const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
        if (delta !== 0) this.cycleFocus(delta > 0 ? 1 : -1);
      },
      { passive: false },
    );

    window.addEventListener("keydown", (e) => {
      State.lastActivity = performance.now();
      if (this.views.get(State.view)?.key?.(e)) return;
      if (e.key === "Escape") {
        if (State.mode === "expanded") this.collapse();
        this.setKeyboard(false);
        return;
      }
      const typing = (e.target as Element | null)?.closest("input, textarea");
      if (typing) return;
      if (e.key === "ArrowRight" || (e.key === "Tab" && !e.shiftKey)) {
        e.preventDefault();
        this.cycleFocus(1);
      } else if (e.key === "ArrowLeft" || (e.key === "Tab" && e.shiftKey)) {
        e.preventDefault();
        this.cycleFocus(-1);
      } else if (/^[1-9]$/.test(e.key)) {
        const s = State.sessions[Number(e.key) - 1];
        if (s) this.actions().focus(s.id);
      }
    });

    if (!IS_TAURI) {
      window.addEventListener("mousemove", (e) => this.onCursor(e.clientX, e.clientY));
    }
  }

  onCursor(x: number, y: number) {
    State.mouse = { x, y };
    const rect = this.islandRect();
    State.mouseInIsland = { x: x - rect.x, y: y - rect.y };
    const inIsland =
      x >= rect.x - HIT_MARGIN && x <= rect.x + rect.w + HIT_MARGIN &&
      y >= rect.y - HIT_MARGIN && y <= rect.y + rect.h + HIT_MARGIN;
    if (inIsland && !this.wasInIsland) {
      Sound.resume();
      if (this.fsm.state === "coucou") this.greeting.hover();
      this.fsm.mouseEntered();
      this.homeCollapseAt = null;
    }
    if (!inIsland && this.wasInIsland) {
      this.fsm.mouseLeft();
      if (this.fsm.state === "home" && !State.isPinned) {
        this.homeCollapseAt = performance.now() + State.settings.autoCloseInterval * 1000;
      }
    }
    this.wasInIsland = inIsland;

    const overBot = State.mode === "expanded" && State.stateOverride == null && this.isBotHit(x, y);
    if (overBot && !this.botHovering) this.botHoverIn(x, y);
    if (!overBot && this.botHovering) this.cancelBotHover();
    this.botHovering = overBot;
    if (this.botHovering) {
      const d = Math.hypot(x - this.botHoverStart.x, y - this.botHoverStart.y);
      if (d > 40) {
        this.botHoverStart = { x, y };
        this.scheduleLove();
      }
    }
    this.ensureRunning();
  }

  private isBotHit(x: number, y: number): boolean {
    const rect = this.islandRect();
    const cx = rect.x + this.botCx.value;
    const cy = rect.y + this.botCy.value;
    const radius = this.botSize.value / 2;
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius;
  }

  private botHoverIn(x: number, y: number) {
    if (performance.now() / 1000 - this.lastLoveTime < 6) return;
    this.botHoverStart = { x, y };
    this.engine.blink();
    this.engine.tgEs = 1.08;
    Sound.play("hover");
    this.scheduleLove();
  }

  private scheduleLove() {
    if (this.botHoverTimer != null) window.clearTimeout(this.botHoverTimer);
    this.botHoverTimer = window.setTimeout(() => {
      this.botHoverTimer = null;
      if (!this.botHovering || State.stateOverride != null) return;
      if (performance.now() / 1000 - this.lastLoveTime < 6) return;
      this.lastLoveTime = performance.now() / 1000;
      this.engine.triggerEmote("love");
      Sound.play("love");
    }, 1900);
  }

  private cancelBotHover() {
    if (this.botHoverTimer != null) window.clearTimeout(this.botHoverTimer);
    this.botHoverTimer = null;
    this.engine.tgEs = 1;
  }

  /** Three slaps: dizzy + confused view for 3.3 s, then back. */
  private handleDizzy() {
    this.prevViewBeforeConfused = State.view;
    State.stateOverride = "dizzy";
    this.engine.setState("dizzy");
    Sound.play("dizzy");
    this.alert("confused");
    if (this.confusedRecovery != null) window.clearTimeout(this.confusedRecovery);
    this.confusedRecovery = window.setTimeout(() => {
      this.confusedRecovery = null;
      State.stateOverride = null;
      this.engine.setState(State.effectiveState);
      if (State.view === "confused") {
        this.setView(this.prevViewBeforeConfused === "confused" ? this.defaultView() : this.prevViewBeforeConfused);
      }
      this.engine.triggerEmote("happy");
    }, 3300);
  }

  // ── Frame loop ───────────────────────────────────────────────────────────

  private ensureRunning() {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    requestAnimationFrame(this.frame);
  }

  private frame = (nowMs: number) => {
    const dt = Math.min(0.05, (nowMs - this.lastFrame) / 1000);
    this.lastFrame = nowMs;

    this.width.step(dt, nowMs);
    this.height.step(dt, nowMs);
    this.radius.step(dt, nowMs);
    this.applyGeometry();

    if (State.flash && nowMs > State.flash.until) {
      State.flash = null;
      this.dirty = true;
    }
    if (State.notice && nowMs > State.notice.until) {
      State.notice = null;
      this.dirty = true;
    }
    if (this.dirty) {
      this.dirty = false;
      this.syncDom();
    }

    this.updateBotTargets();
    this.botCx.step(dt);
    this.botCy.step(dt);
    this.botSize.step(dt);

    const greetingActive = State.mode === "expanded" && State.view === "greeting";
    if (greetingActive) {
      const gctx = this.greetingCanvas.getContext("2d");
      if (gctx) {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.greeting.draw(gctx);
      }
    } else {
      this.drawBot(dt);
    }

    if (State.mode === "compact") this.compact.tick?.(nowMs);
    if (State.mode === "expanded") this.views.get(State.view)?.tick?.(nowMs);
    this.updateCountdown(nowMs);

    const settling = this.width.animating || this.height.animating || this.radius.animating;
    const busy =
      settling || !this.botCx.settled || !this.botCy.settled || !this.botSize.settled ||
      greetingActive || this.engine.busy || State.flash != null || State.notice != null ||
      State.mode !== "strip";

    if (!busy) {
      this.running = false;
      Sound.idle();
      return;
    }
    // Mochi breathes forever in the strip; 15 fps is plenty there and keeps CPU near zero.
    if (State.mode === "strip" && !settling) window.setTimeout(() => requestAnimationFrame(this.frame), 66);
    else requestAnimationFrame(this.frame);
  };

  private updateBotTargets() {
    const p = botPosition(State.mode, State.view);
    this.botCx.target = p.cx;
    this.botCy.target = p.cy;
    this.botSize.target = p.diameter / 0.6;
    const greetingActive = State.mode === "expanded" && State.view === "greeting";
    this.botCanvas.style.opacity = p.opacity > 0 && !greetingActive ? "1" : "0";
    if (State.mode === "expanded" && !greetingActive) {
      const d = p.diameter;
      const color = botGlowColor(State.effectiveState);
      this.botGlow.style.display = "block";
      this.botGlow.style.width = `${d * 2.2}px`;
      this.botGlow.style.height = `${d * 2.2}px`;
      this.botGlow.style.left = `${this.botCx.value - d * 1.1}px`;
      this.botGlow.style.top = `${this.botCy.value - d * 1.1}px`;
      this.botGlow.style.background = `radial-gradient(circle, ${color} 0%, transparent 62%)`;
      this.botGlow.style.opacity = String(botGlowOpacity(State.effectiveState));
    } else {
      this.botGlow.style.display = "none";
    }
  }

  private drawBot(dt: number) {
    const size = this.botSize.value;
    const w = Math.max(1, Math.round(size));
    const hCss = w + BOT_OVERHANG;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (this.canvasPx !== w) {
      this.canvasPx = w;
      this.botCanvas.width = Math.round(w * dpr);
      this.botCanvas.height = Math.round(hCss * dpr);
      this.botCanvas.style.width = `${w}px`;
      this.botCanvas.style.height = `${hCss}px`;
    }
    this.botCanvas.style.left = `${this.botCx.value - w / 2}px`;
    this.botCanvas.style.top = `${this.botCy.value - BOT_OVERHANG / 2 - hCss / 2}px`;
    const ctx = this.botCanvas.getContext("2d");
    if (!ctx) return;
    const s = State.mochiSession;
    this.engine.bodyColor = s ? hexToRGB(colorForProject(s.project)) : null;
    this.engine.particleOverhang = BOT_OVERHANG;
    this.engine.lookX = Math.tanh((State.mouse.x - (this.islandRect().x + this.botCx.value)) / 260);
    this.engine.lookY = -Math.tanh((State.mouse.y - this.botCy.value) / 200);
    this.engine.update(dt);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hCss);
    this.engine.draw(ctx, w, hCss);
  }

  private updateCountdown(nowMs: number) {
    if (State.mode !== "expanded" || State.isPinned || this.homeCollapseAt == null) {
      this.countdown.style.width = "0px";
      return;
    }
    const windowS = Math.min(10, State.settings.autoCloseInterval * 0.6);
    const remaining = (this.homeCollapseAt - nowMs) / 1000;
    this.countdown.style.width = remaining < windowS ? `${Math.max(0, clamp(remaining / windowS, 0, 1) * 160)}px` : "0px";
  }

  // ── DOM sync ─────────────────────────────────────────────────────────────

  private syncDom() {
    const expanded = State.mode === "expanded";
    const greetingActive = expanded && State.view === "greeting";
    this.contentEl.style.opacity = expanded && !greetingActive ? "1" : "0";
    this.contentEl.style.pointerEvents = expanded && !greetingActive ? "auto" : "none";
    this.greetingCanvas.style.display = greetingActive ? "block" : "none";

    this.strip.el.classList.toggle("on", State.mode === "strip");
    this.compact.el.classList.toggle("on", State.mode === "compact");
    if (State.mode === "strip") this.strip.sync();
    if (State.mode === "compact") this.compact.sync();

    for (const [name, view] of this.views) {
      const on = expanded && name === State.view;
      view.el.classList.toggle("on", on);
      if (on) view.sync();
    }
    if (expanded && State.view === "interaction") this.animateGeometry(false);

    this.engine.setState(State.effectiveState);
  }

  applySettings() {
    Sound.setEnabled(State.settings.soundEnabled);
    Sound.setVolume(State.settings.soundVolume);
    this.fsm.homeToPetitDelay = State.settings.autoCloseInterval;
    this.fsm.compactToStripDelay = State.settings.compactInterval;
    State.notify();
  }
}
```

Before relying on them, confirm the copied `engine.ts` really exposes `onDizzy`, `tgEs`, `bodyColor`, `particleOverhang`, `lookX`, `lookY`, `busy`, `resetMorph`, `blink`, `slap`, `triggerEmote`, `setState`, `update`, `draw`, and `greeting.ts` exposes `onComplete`, `start`, `hover`, `interrupt`, `draw` (they do in coucou; Coucou's island.ts used all of them). Also confirm `Tracked` has `animating` and `Spring` has `settled` in `anim.ts`.

- [ ] **Step 5: main.ts**

`src/main.ts`:
```ts
// Entry point: boot the bridge, wire the island, start the greeting.

import "./style.css";
import { Bridge, IS_TAURI, onEvent } from "./core/bridge";
import { Sound } from "./core/sound";
import { State, type Settings } from "./core/state";
import type { Cue, Snapshot } from "./core/types";
import { Island } from "./island/island";

declare global {
  interface Window {
    __sb?: { snapshot(s: Snapshot): void; cues(c: Cue[]): void };
  }
}

async function main() {
  const root = document.getElementById("root");
  if (!root) return;
  void Sound.preload();
  const island = new Island(root);

  const boot = await Bridge.boot();
  if (boot) State.settings = { ...State.settings, ...boot.settings };
  island.applySettings();

  await onEvent<{ x: number; y: number }>("cursor", ({ x, y }) => island.onCursor(x, y));
  await onEvent<Snapshot>("sessions", (s) => island.onSnapshot(s));
  await onEvent<Cue[]>("cues", (c) => island.onCues(c));
  await onEvent<string>("tray", (what) => {
    if (what === "open") island.open();
  });
  await onEvent<null>("hotkey", () => island.toggleFromHotkey());
  await onEvent<null>("screen-changed", () => void Bridge.reposition());
  await onEvent<Settings>("settings-changed", (s) => {
    State.settings = { ...State.settings, ...s };
    island.applySettings();
  });

  const snap = await Bridge.snapshot();
  if (snap) island.onSnapshot(snap);
  island.launch();

  if (!IS_TAURI) {
    document.addEventListener("click", () => Sound.resume(), { once: true });
    window.__sb = { snapshot: (s) => island.onSnapshot(s), cues: (c) => island.onCues(c) };
  }
}

void main();
```

- [ ] **Step 6: style.css**

Build the base from Coucou's stylesheet with this one-off script (not committed):
```bash
cat > /tmp/extract-css.mjs <<'EOF'
import fs from "node:fs";
const src = fs.readFileSync(process.argv[2], "utf8");
const wanted = [":root", "*", "html", "body", "#root", "#island", "#island-clip", "#greeting-canvas", "#bot-glow",
  "#bot-canvas", "#countdown", "#content", "#views", ".view", ".view.on", ".card", ".card.wash::after", ".dot",
  ".btn", ".btn:active", ".btn.primary", ".btn.secondary", ".btn.secondary:hover", ".btn .kbd", ".btn.primary .kbd",
  ".btn.secondary .kbd", ".icon-btn", ".shimmer", "@keyframes shimmer", ".code", ".title", ".sub", ".who-row", ".who-row .n",
  ".tab", ".tab:hover", ".tab.on", ".tabs"];
let out = "", i = 0;
while (i < src.length) {
  const open = src.indexOf("{", i);
  if (open < 0) break;
  const selector = src.slice(i, open).replace(/\/\*[\s\S]*?\*\//g, "").trim();
  let depth = 1, j = open + 1;
  while (j < src.length && depth) { if (src[j] === "{") depth++; else if (src[j] === "}") depth--; j++; }
  const parts = selector.split(",").map((s) => s.trim());
  if (parts.some((p) => wanted.includes(p))) out += `${selector} ${src.slice(open, j)}\n\n`;
  i = j;
}
process.stdout.write(out);
EOF
node /tmp/extract-css.mjs /c/Projects/coucou/windows/src/style.css > src/style.css
grep -c "{" src/style.css
```
Expected: roughly 35-45 rule blocks. In `src/style.css`, set the first comment to `/* session-buddy: Coucou's palette and type scale, plus the session views. */` and remove any `#wake-strip` / `#upload-*` / `.pill*` / `#mini-grid` rules if the script pulled one in through a shared selector list.

Then append:
```css
/* ── Layers inside the island ─────────────────────────────────────────── */
.layer {
  position: absolute;
  inset: 0;
  opacity: 0;
  pointer-events: none;
  transition: opacity 160ms ease;
}
.layer.on {
  opacity: 1;
  pointer-events: auto;
}

/* Strip: 340 x 28, Mochi at the left. */
.strip {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px 0 36px;
  font: 500 11.5px var(--font);
  color: var(--dim);
  white-space: nowrap;
}
.strip-label { color: var(--ink-2); overflow: hidden; text-overflow: ellipsis; }
.strip-dots { display: inline-flex; gap: 4px; }
.strip-limits { margin-left: auto; font-variant-numeric: tabular-nums; }
.strip-limits.warn, .c-ctx.warn { color: var(--amber); }
.strip-limits.crit, .c-ctx.crit { color: var(--red-text); }

.sdot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--c);
  opacity: 0.85;
}
.sdot.stale, .sdot.idle { opacity: 0.35; }
.sdot.needs_you { animation: sb-pulse 1.1s ease-in-out infinite; }
.sdot.error { background: var(--red); }

@keyframes sb-pulse {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.6); opacity: 0.55; }
}

/* Compact: 480 x 64. */
.compact {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 3px;
  padding: 0 12px 0 66px;
  min-width: 0;
}
.c-row1, .c-row2 {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  white-space: nowrap;
}
.c-title { font: 600 13px var(--font); color: var(--ink); overflow: hidden; text-overflow: ellipsis; }
.c-lines, .c-ctx, .c-page { font: 500 11.5px var(--mono); color: var(--dim); font-variant-numeric: tabular-nums; }
.c-lines { color: var(--green-2); }
.c-pager { margin-left: auto; display: inline-flex; align-items: center; gap: 2px; }
.c-status { display: inline-flex; align-items: center; gap: 5px; font: 500 11.5px var(--font); color: var(--dim-2); flex: 0 0 auto; }
.c-activity { font: 500 12px var(--font); color: var(--dim); overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.c-activity.flash { color: var(--ink-2); }

.sglyph {
  display: inline-grid;
  place-items: center;
  width: 12px;
  font: 700 10px var(--font);
  color: var(--c);
}
.sglyph.working, .sglyph.thinking { animation: sb-breathe 1.6s ease-in-out infinite; }
.sglyph.needs_you { color: var(--amber); }
.sglyph.error { color: var(--red); }
.sglyph.finished { color: var(--green-2); }
.sglyph.idle, .sglyph.stale { color: var(--dim-4); }

@keyframes sb-breathe {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}

/* Bars (context, limits). */
.bar {
  display: inline-block;
  height: 5px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.08);
  overflow: hidden;
  vertical-align: middle;
}
.bar > i { display: block; height: 100%; background: var(--green-2); border-radius: 3px; }
.bar.warn > i { background: var(--amber); }
.bar.crit > i { background: var(--red); }

/* Expanded content sits right of Mochi. */
#content {
  position: absolute;
  inset: 0;
  padding: 10px 16px 12px 112px;
}
.view { overflow: hidden; }
.scrollable { overflow-y: auto; }
.empty-view, .confused-view { padding-top: 34px; }
```

- [ ] **Step 7: Build and look at it in the browser**

Run: `npx tsc --noEmit && npx vitest run && npm run dev`
Open `http://127.0.0.1:1420/` in a browser.
Expected: the greeting plays, then the island settles into the strip ("No sessions"). Hovering the top centre opens the compact card ("No sessions yet"); clicking it opens the expanded "No Claude Code sessions yet" view. In the devtools console:
```js
window.__sb.snapshot({ sessions: [{ id: "a", project: "pushdocs", cwd: "C:/Projects/pushdocs", branch: "PDD-1981", termProgram: "WarpTerminal", model: "Opus 5.5", status: "working", statusSince: Date.now() - 252000, lastPrompt: "fix it", lastMessage: null, steps: [{ tool: "Edit", label: "Edit · DatevClient.php", at: 0, ok: null }], agents: [], background: [], stats: { linesAdded: 128, linesRemoved: 34, contextUsedPct: 61, contextTokens: 122000, contextSize: 200000, costUsd: 1 }, pending: [], startedAt: 1, lastEventAt: 1 }], usage: { fiveHour: { usedPct: 42, resetsAt: null }, sevenDay: { usedPct: 18, resetsAt: null }, source: "oauth", updatedAt: 1, error: null, account: null }, now: Date.now() })
```
Expected: strip shows `1 session · 1 working` and `5H 42% · 7D 18%`; compact shows `pushdocs · PDD-1981  +128 -34  ctx 61%` and `working · 4m 12s`, with the step shimmering on the second row. Mochi turns blue (pushdocs).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "Add island shell with resting strip and compact session card"
```

### Task 11: Front end - expanded session view

**Files:**
- Modify (replace the temporary file): `src/views/expanded.ts`
- Modify: `src/style.css` (append)

**Interfaces:**
- Consumes: `State`, `parts.ts` (`bar`, `keyed`, `statusDot`), `viewmodel.ts`, `format.ts`, `colorForProject`.
- Produces: `buildSessionView(actions: ViewActions): ViewHost`.

- [ ] **Step 1: Implement the view**

`src/views/expanded.ts`:
```ts
// Expanded island: session tabs, header with lines / context / model, the
// account's limits, and three columns of what is happening right now.
// Every row has a fixed height and lives in normal flow: nothing is absolutely
// positioned, so lines can never overlap.

import { h } from "./dom";
import { colorForProject } from "../core/layout";
import { State } from "../core/state";
import type { Limit, Session, Usage } from "../core/types";
import { firstLine, fmtAgo, fmtLines, fmtPct, fmtReset, fmtTokens } from "../model/format";
import { accountLabel, sessionTitle, statusGlyph } from "../model/viewmodel";
import { bar, keyed, statusDot } from "./parts";
import type { ViewActions, ViewHost } from "./views";

const STEP_ROWS = 7;
const AGENT_ROWS = 5;

const present = (xs: (Node | null | undefined | false)[]): Node[] => xs.filter(Boolean) as Node[];

function tabs(actions: ViewActions, sessions: Session[], focusId: string | null): Node[] {
  return sessions.map((s, i) =>
    h(
      "button",
      {
        class: `tab ${s.status}${s.id === focusId ? " on" : ""}`,
        title: `${i + 1}  ${s.cwd}`,
        onclick: (e: Event) => {
          e.stopPropagation();
          actions.focus(s.id);
        },
      },
      h("span", { class: `sglyph ${s.status}`, style: `--c:${colorForProject(s.project)}`, text: statusGlyph(s.status) }),
      h("span", { class: "tab-name", text: s.project }),
    ),
  );
}

function header(s: Session): Node[] {
  const meta: Node[] = [];
  if (s.stats.linesAdded || s.stats.linesRemoved) {
    meta.push(h("span", { class: "x-lines", text: fmtLines(s.stats.linesAdded, s.stats.linesRemoved) }));
  }
  const pct = s.stats.contextUsedPct;
  if (pct != null) {
    meta.push(
      h(
        "span",
        { class: "x-ctx" },
        h("span", { class: "lbl", text: "ctx " }),
        bar(pct, 70),
        h("span", { text: ` ${fmtPct(pct)}% (${fmtTokens(s.stats.contextTokens)}/${fmtTokens(s.stats.contextSize)})` }),
      ),
    );
  }
  if (s.model) meta.push(h("span", { class: "x-model", text: s.model }));
  return [
    h("div", { class: "x-title" }, statusDot(s), h("span", { class: "x-name", text: sessionTitle(s) }), h("span", { class: "x-cwd", text: s.cwd })),
    h("div", { class: "x-meta" }, ...meta),
  ];
}

function limit(name: string, l: Limit | null, now: number): Node | null {
  if (!l) return null;
  const reset = fmtReset(l.resetsAt, now);
  return h(
    "span",
    { class: "x-limit" },
    h("span", { class: "lbl", text: `${name} ` }),
    bar(l.usedPct, 80),
    h("span", { text: ` ${fmtPct(l.usedPct)}%` }),
    reset ? h("span", { class: "x-reset", text: ` (${reset})` }) : null,
  );
}

function limitsRow(u: Usage, now: number): Node[] {
  if (!u.fiveHour && !u.sevenDay) {
    return [h("span", { class: "x-reset", text: u.error ? `Limits unavailable: ${u.error}` : "Limits n/a" })];
  }
  const stale = u.error && u.updatedAt ? h("span", { class: "x-reset", text: ` updated ${fmtAgo(now - u.updatedAt)}` }) : null;
  return present([limit("5H", u.fiveHour, now), limit("7D", u.sevenDay, now), h("span", { class: "x-account", text: accountLabel(u) }), stale]);
}

function stepsCol(s: Session): Node[] {
  const head = h("div", { class: "x-h", text: "STEPS" });
  const recent = s.steps.slice(-STEP_ROWS);
  if (!recent.length) {
    return [head, h("div", { class: "x-none", text: s.lastPrompt ? "No tool calls yet" : "Waiting for the first prompt" })];
  }
  const last = recent.length - 1;
  return [
    head,
    ...recent.map((st, i) => {
      const current = i === last && st.ok === null && s.status === "working";
      const icon = st.ok === false ? "\u00D7" : st.ok === true ? "\u2713" : current ? "\u203A" : "\u00B7";
      return h(
        "div",
        { class: `x-row${st.ok === false ? " fail" : ""}` },
        h("span", { class: "x-icon", text: icon }),
        h("span", { class: current ? "x-label shimmer" : "x-label", text: st.label }),
      );
    }),
  ];
}

function sideCol(s: Session, now: number): Node[] {
  const out: Node[] = [];
  const running = s.agents.filter((a) => a.running).length;
  const agents = [...s.agents]
    .sort((a, b) => Number(b.running) - Number(a.running) || b.startedAt - a.startedAt)
    .slice(0, AGENT_ROWS);
  out.push(h("div", { class: "x-h", text: `AGENTS (${running})` }));
  if (!agents.length) out.push(h("div", { class: "x-none", text: "No sub-agents" }));
  for (const a of agents) {
    const what = a.running
      ? a.currentStep ?? a.description ?? "starting"
      : `${a.description ?? "done"} · ${fmtAgo(now - (a.endedAt ?? now))}`;
    out.push(
      h(
        "div",
        { class: `x-row ${a.running ? "run" : "done"}` },
        h("span", { class: "x-icon", text: a.running ? "\u25CF" : "\u2713" }),
        h("span", { class: "x-atype", text: a.agentType }),
        h("span", { class: "x-label", text: what }),
      ),
    );
  }
  const agentIds = new Set(s.agents.map((a) => a.id));
  const bg = s.background.filter((b) => !agentIds.has(b.id));
  if (bg.length) {
    out.push(h("div", { class: "x-h", text: `BACKGROUND (${bg.length})` }));
    for (const b of bg.slice(0, 3)) {
      out.push(
        h(
          "div",
          { class: "x-row run" },
          h("span", { class: "x-icon", text: "\u25CF" }),
          h("span", { class: "x-atype", text: b.kind }),
          h("span", { class: "x-label", text: `${b.description} · ${b.status}` }),
        ),
      );
    }
  }
  return out;
}

export function buildSessionView(actions: ViewActions): ViewHost {
  const tabsEl = h("div", { class: "x-tabs" });
  const headEl = h("div", { class: "x-head" });
  const limitsEl = h("div", { class: "x-limits" });
  const promptEl = h("div", { class: "x-prompt" });
  const stepsEl = h("div", { class: "x-col x-steps" });
  const sideEl = h("div", { class: "x-col x-side" });
  const el = h("div", { class: "view session-view" }, tabsEl, headEl, limitsEl, promptEl, h("div", { class: "x-body" }, stepsEl, sideEl));

  return {
    el,
    sync() {
      const all = State.sessions;
      const s = State.focus;
      const now = Date.now();
      const minute = Math.floor(now / 60_000);
      keyed(tabsEl, `${all.map((x) => `${x.id}:${x.status}`).join("|")}#${s?.id ?? ""}`, () => tabs(actions, all, s?.id ?? null));
      keyed(limitsEl, JSON.stringify([State.snapshot.usage, minute]), () => limitsRow(State.snapshot.usage, now));
      if (!s) {
        keyed(headEl, "none", () => [h("div", { class: "x-title", text: "No sessions" })]);
        promptEl.textContent = "";
        keyed(stepsEl, "none", () => []);
        keyed(sideEl, "none", () => []);
        return;
      }
      keyed(headEl, JSON.stringify([s.id, s.status, s.branch, s.cwd, s.stats, s.model]), () => header(s));
      promptEl.textContent = s.lastPrompt ? `Prompt: ${firstLine(s.lastPrompt, 140)}` : "";
      keyed(stepsEl, JSON.stringify([s.id, s.status, s.steps.slice(-STEP_ROWS)]), () => stepsCol(s));
      keyed(sideEl, JSON.stringify([s.id, s.agents, s.background, minute]), () => sideCol(s, now));
    },
  };
}
```

- [ ] **Step 2: Styles**

Append to `src/style.css`:
```css
/* ── Expanded session view ───────────────────────────────────────────── */
.session-view { display: flex; flex-direction: column; gap: 6px; height: 100%; }
.x-tabs { display: flex; gap: 4px; overflow: hidden; flex: 0 0 24px; }
.x-tabs .tab {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 132px;
  height: 22px;
  padding: 0 9px;
  border: 0;
  border-radius: 11px;
  background: transparent;
  color: var(--dim);
  font: 500 11.5px var(--font);
  cursor: pointer;
}
.x-tabs .tab.on { background: var(--tab-on); color: var(--ink); }
.x-tabs .tab:hover { color: var(--ink-2); }
.tab-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.x-head { display: flex; flex-direction: column; gap: 3px; }
.x-title { display: flex; align-items: center; gap: 6px; min-width: 0; white-space: nowrap; }
.x-name { font: 600 14px var(--font); color: var(--ink); }
.x-cwd { font: 400 11px var(--mono); color: var(--dim-4); overflow: hidden; text-overflow: ellipsis; }
.x-meta { display: flex; align-items: center; gap: 14px; font: 500 11.5px var(--mono); color: var(--dim); white-space: nowrap; }
.x-lines { color: var(--green-2); }
.x-model { color: var(--dim-2); font-family: var(--font); }
.lbl { color: var(--dim-3); }

.x-limits { display: flex; align-items: center; gap: 14px; font: 500 11px var(--mono); color: var(--dim); white-space: nowrap; overflow: hidden; }
.x-reset { color: var(--dim-4); }
.x-account { margin-left: auto; font-family: var(--font); color: var(--dim-3); overflow: hidden; text-overflow: ellipsis; }

.x-prompt { font: 400 11.5px var(--font); color: var(--dim-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-height: 15px; }

.x-body { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; min-height: 0; flex: 1 1 auto; }
.x-col { display: flex; flex-direction: column; min-width: 0; overflow: hidden; }
.x-h { font: 700 9.5px var(--font); letter-spacing: 0.08em; color: var(--dim-4); height: 16px; line-height: 16px; margin-top: 2px; }
.x-row { display: flex; align-items: center; gap: 6px; height: 20px; min-width: 0; flex: 0 0 20px; }
.x-icon { width: 10px; flex: 0 0 10px; text-align: center; font: 700 10px var(--font); color: var(--dim-3); }
.x-row.fail .x-icon, .x-row.fail .x-label { color: var(--red-text); }
.x-row.run .x-icon { color: var(--green-2); animation: sb-breathe 1.6s ease-in-out infinite; }
.x-label { font: 500 12px var(--font); color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.x-atype { font: 600 11px var(--font); color: var(--dim-2); flex: 0 0 auto; }
.x-none { font: 400 11.5px var(--font); color: var(--dim-4); height: 20px; line-height: 20px; }
```

- [ ] **Step 3: Check it in the browser**

Run: `npx tsc --noEmit && npm run dev`, open `http://127.0.0.1:1420/`, paste the snapshot from Task 10 Step 7 but with 10 steps, two agents (one running with `currentStep`) and one `background` entry of kind `"bash"`. Click the island.
Expected: tabs row, header `pushdocs · PDD-1981` with `+128 -34`, ctx bar `61% (122k/200k)`, `Opus 5.5`; limits row; prompt line; STEPS shows the last 7 rows, each on its own line, the last one shimmering with `›`; AGENTS (1) with the running agent's step and the finished one with "done ... ago"; BACKGROUND (1). Resize nothing overlaps; long labels end in `…`.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "Add expanded session view with tabs, limits, steps and agents"
```

---

### Task 12: Front end - interaction cards (approve, answer, reply)

**Files:**
- Modify (replace the temporary file): `src/views/cards.ts`
- Modify: `src/style.css` (append)

**Interfaces:**
- Consumes: `pendingQueue`, `answersFor`, `sessionTitle` (viewmodel), `fmtCountdown`, `btn`, `statusDot`, `ViewActions.answer/release/wantKeyboard/relayout`.
- Produces: `buildInteraction(actions): ViewHost` with `sync`, `tick`, `measure`, `key`.
- Answer payloads (exactly what Task 4's `Hub::answer` accepts): `{behavior: "allow" | "deny"}`, `{answers: Record<string, string>}`, `{reply: string}`.

- [ ] **Step 1: Implement the cards**

`src/views/cards.ts`:
```ts
// The card for whatever is waiting for the user: a permission request, an
// AskUserQuestion prompt, or a plain-text question at the end of a turn.
// One card at a time, oldest first; the rest are counted, never replaced.

import { h } from "./dom";
import { State } from "../core/state";
import type { Interaction, Session } from "../core/types";
import { fmtCountdown } from "../model/format";
import { answersFor, pendingQueue, sessionTitle } from "../model/viewmodel";
import { btn, statusDot } from "./parts";
import type { ViewActions, ViewHost } from "./views";

const KIND_LABEL: Record<Interaction["kind"], string> = {
  approval: "Permission",
  question: "Question",
  reply: "Claude asks",
};

const present = (xs: (Node | null | undefined | false)[]): Node[] => xs.filter(Boolean) as Node[];

export function buildInteraction(actions: ViewActions): ViewHost {
  const head = h("div", { class: "i-head" });
  const body = h("div", { class: "i-body" });
  const notice = h("div", { class: "i-notice" });
  const countdown = h("span", { class: "i-countdown" });
  const foot = h("div", { class: "i-foot" });
  const el = h("div", { class: "view interaction-view" }, head, body, notice, foot);

  let shownId = "";
  let current: { session: Session; item: Interaction } | null = null;
  let picks: Record<string, string[]> = {};
  let other: Record<string, string> = {};
  let submit: HTMLButtonElement | null = null;

  const focusField = (field: HTMLInputElement | HTMLTextAreaElement) => {
    actions.wantKeyboard(true);
    window.setTimeout(() => field.focus(), 120);
  };

  const terminalBtn = (requestId: string) => btn("Answer in terminal", "secondary", () => actions.release(requestId));

  function refreshSubmit() {
    if (!submit || current?.item.kind !== "question") return;
    submit.disabled = answersFor(current.item.questions, picks, other) == null;
  }

  function renderApproval(session: Session, item: Extract<Interaction, { kind: "approval" }>) {
    const agent = item.agentId ? session.agents.find((a) => a.id === item.agentId) : undefined;
    body.replaceChildren(
      ...present([
        h("div", { class: "title", text: `Allow ${item.tool}?` }),
        agent ? h("div", { class: "sub", text: `Requested by sub-agent ${agent.agentType}` }) : null,
        h("pre", { class: "code scrollable i-target", text: item.target }),
      ]),
    );
    foot.replaceChildren(
      countdown,
      h("span", { class: "grow" }),
      terminalBtn(item.requestId),
      btn("Deny", "danger", () => actions.answer(item.requestId, { behavior: "deny" })),
      btn("Allow", "primary", () => actions.answer(item.requestId, { behavior: "allow" })),
    );
  }

  function renderQuestion(item: Extract<Interaction, { kind: "question" }>) {
    const blocks = item.questions.map((q) => {
      const opts = h("div", { class: "i-options" });
      const otherInput = h("input", { class: "i-other", placeholder: "Other..." });
      const renderOpts = () => {
        opts.replaceChildren(
          ...q.options.map((o) => {
            const on = (picks[q.question] ?? []).includes(o.label);
            return h(
              "button",
              {
                class: `opt${on ? " on" : ""}`,
                title: o.description ?? "",
                onclick: (e: Event) => {
                  e.stopPropagation();
                  const cur = picks[q.question] ?? [];
                  picks[q.question] = q.multiSelect ? (on ? cur.filter((x) => x !== o.label) : [...cur, o.label]) : [o.label];
                  if (!q.multiSelect) {
                    other[q.question] = "";
                    otherInput.value = "";
                  }
                  renderOpts();
                  refreshSubmit();
                },
              },
              ...present([h("span", { class: "opt-label", text: o.label }), o.description ? h("span", { class: "opt-desc", text: o.description }) : null]),
            );
          }),
        );
      };
      otherInput.addEventListener("mousedown", () => focusField(otherInput));
      otherInput.addEventListener("input", () => {
        other[q.question] = otherInput.value;
        if (!q.multiSelect && otherInput.value.trim()) {
          picks[q.question] = [];
          renderOpts();
        }
        refreshSubmit();
      });
      renderOpts();
      return h(
        "div",
        { class: "i-q" },
        ...present([
          q.header ? h("span", { class: "chip", text: q.header }) : null,
          h("div", { class: "i-qtext", text: q.question }),
          q.multiSelect ? h("div", { class: "sub", text: "Pick any" }) : null,
          opts,
          otherInput,
        ]),
      );
    });
    body.replaceChildren(h("div", { class: "i-questions scrollable" }, ...blocks));
    submit = btn("Submit", "primary", () => {
      const answers = answersFor(item.questions, picks, other);
      if (answers) actions.answer(item.requestId, { answers });
    });
    foot.replaceChildren(countdown, h("span", { class: "grow" }), terminalBtn(item.requestId), submit);
    refreshSubmit();
  }

  function renderReply(item: Extract<Interaction, { kind: "reply" }>) {
    const box = h("textarea", { class: "i-reply", rows: 2, placeholder: "Reply to Claude (Enter sends, Shift+Enter adds a line)" });
    const send = () => {
      const text = box.value.trim();
      if (text) actions.answer(item.requestId, { reply: text });
    };
    box.addEventListener("mousedown", () => focusField(box));
    box.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });
    body.replaceChildren(h("div", { class: "i-message scrollable", text: item.message }), box);
    foot.replaceChildren(countdown, h("span", { class: "grow" }), terminalBtn(item.requestId), btn("Send", "primary", send));
  }

  return {
    el,
    sync() {
      const queue = pendingQueue(State.sessions, State.focusId);
      current = queue[0] ?? null;
      notice.textContent = State.notice?.text ?? "";
      notice.style.display = State.notice ? "" : "none";
      if (!current) {
        if (shownId) {
          shownId = "";
          head.replaceChildren();
          body.replaceChildren();
          foot.replaceChildren();
        }
        return;
      }
      const { session, item } = current;
      head.replaceChildren(
        ...present([
          statusDot(session),
          h("span", { class: "i-who", text: sessionTitle(session) }),
          h("span", { class: "i-kind", text: KIND_LABEL[item.kind] }),
          queue.length > 1 ? h("span", { class: "i-queue", text: `+${queue.length - 1} waiting` }) : null,
        ]),
      );
      if (item.requestId === shownId) return;
      shownId = item.requestId;
      picks = {};
      other = {};
      submit = null;
      if (item.kind === "approval") renderApproval(session, item);
      else if (item.kind === "question") renderQuestion(item);
      else renderReply(item);
      actions.relayout();
    },
    tick() {
      if (!current) return;
      const text = `Back to the terminal in ${fmtCountdown(current.item.deadline - Date.now())}`;
      if (countdown.textContent !== text) countdown.textContent = text;
    },
    measure() {
      return el.scrollHeight + 22;
    },
    key(e) {
      if (!current || current.item.kind !== "question") return false;
      if (e.key === "Enter" && !(e.target as Element | null)?.closest("textarea")) {
        submit?.click();
        return true;
      }
      return false;
    },
  };
}
```

- [ ] **Step 2: Styles**

Append to `src/style.css`:
```css
/* ── Interaction cards ───────────────────────────────────────────────── */
.interaction-view { display: flex; flex-direction: column; gap: 8px; }
.i-head { display: flex; align-items: center; gap: 7px; font: 500 12px var(--font); color: var(--dim); white-space: nowrap; }
.i-who { color: var(--ink-2); font-weight: 600; }
.i-kind { color: var(--amber); }
.i-queue { margin-left: auto; color: var(--dim-3); }
.i-body { display: flex; flex-direction: column; gap: 6px; min-height: 0; }
.i-target { max-height: 96px; white-space: pre-wrap; word-break: break-all; }
.i-questions { display: flex; flex-direction: column; gap: 10px; max-height: 210px; padding-right: 4px; }
.i-q { display: flex; flex-direction: column; gap: 5px; }
.i-qtext { font: 600 13px var(--font); color: var(--ink); }
.chip { align-self: flex-start; font: 700 9.5px var(--font); letter-spacing: 0.06em; text-transform: uppercase; color: var(--cyan); }
.i-options { display: flex; flex-wrap: wrap; gap: 6px; }
.opt {
  display: inline-flex;
  flex-direction: column;
  align-items: flex-start;
  max-width: 260px;
  padding: 5px 10px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 9px;
  background: var(--card);
  color: var(--ink-2);
  cursor: pointer;
  text-align: left;
}
.opt.on { border-color: var(--cyan); background: rgba(34, 211, 238, 0.12); }
.opt-label { font: 600 12px var(--font); }
.opt-desc { font: 400 11px var(--font); color: var(--dim-2); }
.i-other, .i-reply {
  width: 100%;
  padding: 6px 9px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 9px;
  background: var(--card-flat);
  color: var(--ink);
  font: 400 12.5px var(--font);
  outline: none;
  resize: none;
  user-select: text;
}
.i-other:focus, .i-reply:focus { border-color: var(--cyan); }
.i-message { max-height: 110px; font: 400 12.5px/1.45 var(--font); color: var(--ink-2); white-space: pre-wrap; padding-right: 4px; user-select: text; }
.i-foot { display: flex; align-items: center; gap: 8px; }
.i-countdown { font: 500 11px var(--font); color: var(--dim-4); }
.i-notice { font: 500 11.5px var(--font); color: var(--red-text); }
.grow { flex: 1 1 auto; }
.btn.danger { background: rgba(244, 80, 94, 0.16); color: var(--red-text); }
.btn:disabled { opacity: 0.4; cursor: default; }
```

- [ ] **Step 3: Check it in the browser**

Run `npm run dev`, then in the console send a snapshot with three pending items across two sessions (an `approval` with a long `target`, a `question` with two questions where the second has `multiSelect: true`, and a `reply`). Listen for the outgoing calls:
```js
window.addEventListener("sb-invoke", (e) => console.log(e.detail));
```
Expected:
- The island opens on its own to the approval card, `+2 waiting` in the header, countdown ticking.
- Allow logs `{cmd: "answer", args: {requestId, answer: {behavior: "allow"}}}`.
- After removing that item from the snapshot (send it again without it), the question card shows; Submit is disabled until each question has a pick or "Other" text; multi-select toggles; Submit logs `answers` with string values (`"a, b"` for the multi-select).
- The reply card: Enter in the textarea logs `{reply: "..."}`; Shift+Enter adds a line; "Answer in terminal" logs `release`.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "Add interaction cards for approvals, questions and replies"
```

---

### Task 13: Settings window

**Files:**
- Create: `settings.html`, `src/settings/main.ts`, `src/settings/settings.css`

**Interfaces:**
- Consumes: `Bridge.{boot, saveSettings, installStatus, installPreview, installWrite, quit}`, `DEFAULT_SETTINGS`, `Settings`.

- [ ] **Step 1: Implement**

`settings.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>session-buddy settings</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/settings/main.ts"></script>
  </body>
</html>
```

`src/settings/main.ts`:
```ts
// The settings window: Claude Code install (always preview, then write),
// sounds, island timing, sessions, start-up.

import "./settings.css";
import { Bridge } from "../core/bridge";
import { DEFAULT_SETTINGS, type Settings } from "../core/state";
import { h } from "../views/dom";

let settings: Settings = { ...DEFAULT_SETTINGS };
const save = () => void Bridge.saveSettings(settings);
const present = (xs: (Node | null | undefined | false)[]): Node[] => xs.filter(Boolean) as Node[];

function row(label: string, control: HTMLElement, hint?: string): HTMLElement {
  return h("label", { class: "row" }, h("span", { class: "lbl" }, ...present([document.createTextNode(label), hint ? h("small", { text: hint }) : null])), control);
}

function checkbox(get: () => boolean, set: (v: boolean) => void): HTMLInputElement {
  const el = h("input", { type: "checkbox" });
  el.checked = get();
  el.addEventListener("change", () => {
    set(el.checked);
    save();
  });
  return el;
}

function numberInput(get: () => number, set: (v: number) => void, min: number, max: number, step = 1): HTMLInputElement {
  const el = h("input", { type: "number", min, max, step });
  el.value = String(get());
  el.addEventListener("change", () => {
    const v = Math.min(max, Math.max(min, Number(el.value) || min));
    el.value = String(v);
    set(v);
    save();
  });
  return el;
}

function line(label: string, value: string): HTMLElement {
  return h("div", { class: "kv" }, h("span", { class: "k", text: label }), h("span", { class: "v", text: value }));
}

function installSection(): HTMLElement {
  const status = h("div", { class: "status" });
  const buttons = h("div", { class: "actions" });
  const diff = h("pre", { class: "diff" });
  const msg = h("div", { class: "msg" });
  const box = h(
    "section",
    {},
    h("h2", { text: "Claude Code" }),
    h("p", { class: "note", text: "Adds session-buddy's hooks and wraps your status line. A dated backup of settings.json is taken first; only session-buddy's own entries are ever added or removed. New Claude Code sessions pick it up; restart running ones." }),
    status,
    buttons,
    diff,
    msg,
  );

  const refresh = async () => {
    const st = await Bridge.installStatus();
    status.replaceChildren(
      line("Hooks", st?.hooksInstalled ? "installed" : "not installed"),
      line("Status line", st?.statusLineInstalled ? "wrapped (your own status line still runs)" : "not installed"),
      line("settings.json", st?.settingsPath ?? "?"),
      line("Relay", st ? `${st.relayPath}${st.relayReady ? "" : "  (missing: restart session-buddy)"}` : "?"),
    );
    buttons.replaceChildren(
      ...present([
        h("button", { class: "primary", text: st?.hooksInstalled ? "Reinstall..." : "Install...", onclick: () => void preview(true) }),
        st?.hooksInstalled || st?.statusLineInstalled ? h("button", { text: "Uninstall...", onclick: () => void preview(false) }) : null,
      ]),
    );
  };

  const preview = async (install: boolean) => {
    msg.textContent = "";
    const r = await Bridge.installPreview(install);
    if (!r.ok) {
      msg.textContent = r.error;
      return;
    }
    diff.textContent = r.value.diff || "(no changes)";
    buttons.replaceChildren(
      h("button", {
        class: "primary",
        text: `Write ${r.value.settingsPath}`,
        onclick: async () => {
          const w = await Bridge.installWrite(install, r.value.fingerprint);
          msg.textContent = w.ok ? `Done. Backup: ${w.value}` : w.error;
          diff.textContent = "";
          await refresh();
        },
      }),
      h("button", { text: "Cancel", onclick: () => { diff.textContent = ""; void refresh(); } }),
    );
  };

  void refresh();
  return box;
}

async function main() {
  const boot = await Bridge.boot();
  if (boot) settings = { ...settings, ...boot.settings };
  const app = document.getElementById("app");
  if (!app) return;

  const volume = h("input", { type: "range", min: 0, max: 0.2, step: 0.01 });
  volume.value = String(settings.soundVolume);
  volume.addEventListener("change", () => {
    settings.soundVolume = Number(volume.value);
    save();
  });

  const screen = h("select", {}, h("option", { value: "primary", text: "Primary display" }), h("option", { value: "cursor", text: "Display under the cursor" }));
  screen.value = settings.screen;
  screen.addEventListener("change", () => {
    settings.screen = screen.value === "cursor" ? "cursor" : "primary";
    save();
  });

  const hotkey = h("input", { type: "text", value: settings.hotkey, placeholder: "Ctrl+Alt+Space" });
  hotkey.addEventListener("change", () => {
    settings.hotkey = hotkey.value.trim();
    save();
  });

  app.append(
    h("h1", { text: "session-buddy" }),
    installSection(),
    h(
      "section",
      {},
      h("h2", { text: "Sounds" }),
      row("Sounds", checkbox(() => settings.soundEnabled, (v) => (settings.soundEnabled = v))),
      row("Volume", volume),
      row("Context warning", checkbox(() => settings.contextSound, (v) => (settings.contextSound = v)), "when a session passes 90 %"),
    ),
    h(
      "section",
      {},
      h("h2", { text: "Island" }),
      row("Expanded closes after", numberInput(() => settings.autoCloseInterval, (v) => (settings.autoCloseInterval = v), 3, 120), "seconds"),
      row("Card shrinks to the strip after", numberInput(() => settings.compactInterval, (v) => (settings.compactInterval = v), 2, 120), "seconds"),
      row("Screen", screen),
      row("Hotkey", hotkey, "opens the island from anywhere, e.g. Ctrl+Alt+Space"),
    ),
    h(
      "section",
      {},
      h("h2", { text: "Sessions" }),
      row("Grey out after", numberInput(() => settings.staleMinutes, (v) => (settings.staleMinutes = v), 1, 240), "minutes without events"),
      row("Remove after", numberInput(() => settings.removeMinutes, (v) => (settings.removeMinutes = v), 5, 1440), "minutes greyed out"),
    ),
    h(
      "section",
      {},
      h("h2", { text: "Start-up" }),
      row("Start with the system", checkbox(() => settings.autostart, (v) => (settings.autostart = v))),
    ),
    h("footer", {}, h("span", { text: `Version ${boot?.version ?? "?"}` }), h("button", { text: "Quit session-buddy", onclick: () => void Bridge.quit() })),
  );
}

void main();
```

`src/settings/settings.css`:
```css
:root { color-scheme: dark; --font: system-ui, "Segoe UI Variable Text", "Segoe UI", sans-serif; --mono: "Cascadia Mono", Consolas, ui-monospace, monospace; }
* { box-sizing: border-box; }
body { margin: 0; padding: 22px 26px 30px; background: #111214; color: #f1f2f4; font: 13px var(--font); }
h1 { margin: 0 0 14px; font-size: 18px; }
h2 { margin: 0 0 8px; font-size: 13px; letter-spacing: 0.04em; text-transform: uppercase; color: #9398a1; }
section { padding: 14px 0; border-top: 1px solid rgba(255, 255, 255, 0.06); }
.note { margin: 0 0 10px; color: #8e939c; line-height: 1.45; }
.row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 5px 0; }
.lbl { display: flex; flex-direction: column; }
.lbl small { color: #6b7079; }
.kv { display: flex; gap: 10px; padding: 2px 0; font-size: 12px; }
.kv .k { width: 92px; color: #6b7079; flex: 0 0 auto; }
.kv .v { font-family: var(--mono); word-break: break-all; }
.actions { display: flex; gap: 8px; margin: 10px 0; }
button { padding: 6px 12px; border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 8px; background: #1d1f23; color: #f1f2f4; font: 500 12.5px var(--font); cursor: pointer; }
button.primary { background: #f1f2f4; color: #111214; border-color: transparent; }
input[type="number"], input[type="text"], select { width: 180px; padding: 5px 8px; border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 7px; background: #0e0f11; color: #f1f2f4; font: 12.5px var(--font); }
.diff { max-height: 260px; overflow: auto; padding: 10px; border-radius: 8px; background: #0b0c0e; font: 11.5px/1.45 var(--mono); white-space: pre; }
.diff:empty { display: none; }
.msg { color: #22d3ee; font-size: 12px; word-break: break-all; }
footer { display: flex; align-items: center; justify-content: space-between; padding-top: 16px; color: #6b7079; }
```

- [ ] **Step 2: Type check and build**

Run: `npx tsc --noEmit && npx vitest run && npm run build`
Expected: no type errors, tests pass, `dist/index.html`, `dist/settings.html` and `dist/sounds/*.wav` (28 files) exist. (`npm run build` also builds `sb-relay` through `prebuild`.)

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "Add settings window with install preview, sounds, timing and sessions"
```

---

### Task 14: Browser preview with fake sessions

**Files:**
- Create: `dev/preview.html`, `dev/preview.ts`, `dev/fixtures.ts`

**Interfaces:**
- Consumes: `window.__sb` from `src/main.ts`, `sb-invoke` events from `bridge.ts`, `Snapshot` types.

- [ ] **Step 1: Implement**

`dev/preview.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>session-buddy preview</title>
    <style>
      body.preview { background: #2b2d33 !important; }
    </style>
  </head>
  <body class="preview">
    <div id="root"></div>
    <script type="module" src="/src/main.ts"></script>
    <script type="module" src="/dev/preview.ts"></script>
  </body>
</html>
```

`dev/fixtures.ts`:
```ts
// Four sessions that exercise every part of the island.

import type { Session, Snapshot } from "../src/core/types";

const base = (id: string, project: string, now: number, p: Partial<Session>): Session => ({
  id, project, cwd: `C:\\Projects\\${project}`, branch: null, termProgram: "WarpTerminal", model: "Opus 5.5",
  status: "idle", statusSince: now, lastPrompt: null, lastMessage: null, steps: [], agents: [], background: [],
  stats: { linesAdded: 0, linesRemoved: 0, contextUsedPct: 12, contextTokens: 24_000, contextSize: 200_000, costUsd: 0.2 },
  pending: [], startedAt: now, lastEventAt: now, ...p,
});

export function demoSnapshot(now: number): Snapshot {
  return {
    now,
    usage: {
      fiveHour: { usedPct: 42, resetsAt: now + 3 * 3600_000 },
      sevenDay: { usedPct: 74, resetsAt: now + 4 * 24 * 3600_000 },
      source: "statusline", updatedAt: now, error: null,
      account: { email: "wolfgang@example.com", org: "Personal", plan: "Max" },
    },
    sessions: [
      base("a", "pushdocs", now, {
        branch: "PDD-1981", status: "working", statusSince: now - 252_000, lastPrompt: "fix the DATEV 409 handling",
        steps: [
          { tool: "Read", label: "Read · DatevClient.php", at: now, ok: true },
          { tool: "Grep", label: "Search · KeyConflictFault", at: now, ok: true },
          { tool: "Bash", label: "Run · php artisan test --filter Datev", at: now, ok: false },
          { tool: "Edit", label: "Edit · DatevClient.php", at: now, ok: null },
        ],
        agents: [
          { id: "ag1", agentType: "Explore", description: "Find callers", running: true, currentStep: "Search · 409", startedAt: now, endedAt: null },
          { id: "ag2", agentType: "Plan", description: "Plan the fix", running: false, currentStep: null, startedAt: now - 200_000, endedAt: now - 60_000 },
        ],
        background: [{ id: "bg1", kind: "bash", status: "running", description: "npm run build", agentType: null }],
        stats: { linesAdded: 128, linesRemoved: 34, contextUsedPct: 61, contextTokens: 122_000, contextSize: 200_000, costUsd: 1.9 },
      }),
      base("b", "bankconnect", now, {
        branch: "BCD-1120", status: "needs_you",
        pending: [{ kind: "approval", requestId: "r-b1", tool: "Bash", target: "Bash · php artisan migrate --database=testing", agentId: null, deadline: now + 110_000 }],
      }),
      base("c", "fetchdocs", now, {
        status: "needs_you",
        pending: [{
          kind: "question", requestId: "r-c1", deadline: now + 540_000,
          questions: [
            { question: "Which driver should the import use?", header: "Driver", options: [{ label: "Serial", description: "One work item at a time" }, { label: "Parallel" }] },
            { question: "Which checks should run?", header: "Checks", multiSelect: true, options: [{ label: "PHPStan" }, { label: "Pest" }, { label: "Pint" }] },
          ],
        }],
      }),
      base("d", "InvoiceRails", now, {
        status: "finished", lastMessage: "All 312 tests pass. Shall I open the PR?",
        stats: { linesAdded: 12, linesRemoved: 3, contextUsedPct: 93, contextTokens: 186_000, contextSize: 200_000, costUsd: 4.1 },
      }),
    ],
  };
}
```

`dev/preview.ts`:
```ts
// Drives the island with fake sessions: steps keep arriving, answers remove
// their card, and a "finished" cue fires every 15 s.

import type { Snapshot } from "../src/core/types";
import { demoSnapshot } from "./fixtures";

async function island(): Promise<NonNullable<Window["__sb"]>> {
  for (;;) {
    if (window.__sb) return window.__sb;
    await new Promise((r) => setTimeout(r, 50));
  }
}

const sb = await island();
let snap: Snapshot = demoSnapshot(Date.now());
const push = () => sb.snapshot({ ...snap, now: Date.now() });
push();

window.addEventListener("sb-invoke", (e) => {
  const { cmd, args } = (e as CustomEvent<{ cmd: string; args?: { requestId?: string } }>).detail;
  console.log("[preview]", cmd, args);
  if ((cmd === "answer" || cmd === "release") && args?.requestId) {
    snap = {
      ...snap,
      sessions: snap.sessions.map((s) => {
        const pending = s.pending.filter((p) => p.requestId !== args.requestId);
        return pending.length === s.pending.length ? s : { ...s, pending, status: pending.length ? s.status : "working", statusSince: Date.now() };
      }),
    };
    push();
  }
});

let n = 0;
setInterval(() => {
  n += 1;
  snap = {
    ...snap,
    sessions: snap.sessions.map((s) =>
      s.id !== "a"
        ? s
        : { ...s, steps: [...s.steps.map((x) => (x.ok === null ? { ...x, ok: true } : x)), { tool: "Read", label: `Read · File${n}.php`, at: Date.now(), ok: null }].slice(-50) },
    ),
  };
  push();
}, 1500);

setInterval(() => sb.cues([{ sessionId: "d", kind: "finish" }]), 15_000);
```

- [ ] **Step 2: Run it**

Run: `npm run dev` and open `http://127.0.0.1:1420/dev/preview.html`.
Expected: after the greeting the island opens on the bankconnect approval (`+1 waiting`); Allow moves to the fetchdocs question; Submit returns to the session view; pushdocs keeps adding steps one per row with no overlap; the wheel over the island cycles pushdocs > bankconnect > fetchdocs > InvoiceRails; InvoiceRails shows the red ctx bar; the strip (after the mouse leaves for 6 s + 15 s) reads `4 sessions · 1 working` and `5H 42% · 7D 74%` in orange.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "Add browser preview driven by fake sessions"
```

---

### Task 15: Packaging and README

**Files:**
- Create: `README.md`
- Test: `npm run pack` on Windows

- [ ] **Step 1: README**

`README.md`:
```markdown
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
```

- [ ] **Step 2: Full test and package run (Windows)**

Run:
```bash
cargo test --workspace && npx vitest run && npx tsc --noEmit && npm run pack
ls target/release/bundle/nsis/
```
Expected: all tests pass; an installer `session-buddy_0.1.0_x64-setup.exe` exists.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "Add README and packaging configuration"
```

---

### Task 16: Windows acceptance next to Coucou (project-scoped hooks)

Manual, with the user. Nothing global is changed in this task.

- [ ] **Step 1: Install the build and prepare three test folders**

Install the NSIS build from Task 15 and launch session-buddy. In Coucou's tray menu choose **Pause** (Coucou then hands every permission request straight back, so it cannot race session-buddy).

```bash
R="$LOCALAPPDATA/session-buddy/bin/sb-relay.exe"; R="${R//\\//}"
for d in sb-a sb-b sb-c; do
  mkdir -p "/c/Projects/sb-acceptance/$d/.claude"
  node -e '
    const relay = process.argv[1];
    const ev = {SessionStart:10,SessionEnd:10,UserPromptSubmit:10,PreToolUse:600,PostToolUse:10,PostToolUseFailure:10,PermissionRequest:120,Notification:10,Stop:600,StopFailure:10,SubagentStart:10,SubagentStop:10};
    const hooks = {};
    for (const [e,t] of Object.entries(ev)) hooks[e] = [{hooks:[{type:"command",command:`"${relay}" hook ${e}`,timeout:t}]}];
    const statusLine = {type:"command",command:`"${relay}" statusline | python ~/.claude/statusline.py`};
    process.stdout.write(JSON.stringify({hooks,statusLine},null,2));
  ' "$R" > "/c/Projects/sb-acceptance/$d/.claude/settings.local.json"
done
git -C /c/Projects/sb-acceptance/sb-a init -q -b PDD-0001 && git -C /c/Projects/sb-acceptance/sb-a commit -q --allow-empty -m init
```
Ask the user to open three Warp tabs in `C:\Projects\sb-acceptance\sb-a`, `sb-b`, `sb-c` and run `claude` in each.

- [ ] **Step 2: Go through the checklist with the user**

| # | Do | Expect |
|---|---|---|
| 1 | Start the three sessions | Strip: `3 sessions`, three dots |
| 2 | Scroll over the compact island | Flips sb-a / sb-b / sb-c; sb-a shows branch `PDD-0001` |
| 3 | In sb-a: "create hello.txt with 20 lines, then edit 5 of them" | Steps one per row, no overlap; `+/-` lines and ctx % appear after the first status-line refresh |
| 4 | In sb-b: "use two Explore agents in parallel to list the files in C:\Projects\pushdocs\app" | AGENTS (2) with their current steps, then done |
| 5 | In sb-b: "run `sleep 40` in the background, then tell me when it is done" | BACKGROUND row while it runs |
| 6 | In sb-c (default permission mode): "run curl -I https://example.com" | Card "Allow Bash?" with the exact command; Allow continues the session |
| 7 | Repeat 6 and press Deny | Claude reports the denial |
| 8 | "Ask me with AskUserQuestion which colour I like, Red or Blue" | Question card; pick Blue, Submit; Claude says Blue; no picker in the terminal |
| 9 | "Ask me a yes/no question in plain text, then stop" | Reply card with Claude's question; type "yes", Enter; Claude continues |
| 10 | Repeat 6, click "Answer in terminal" | Card disappears, the terminal shows its own prompt immediately |
| 11 | Repeat 6, press Esc in the terminal instead | Card disappears within a second |
| 12 | Settings > Sessions > Grey out after = 1; close the sb-c tab | sb-c turns grey after about 1 min. Set it back to 10 |
| 13 | Quit session-buddy, run a prompt in sb-a | Claude Code unaffected; status line still renders |
| 14 | Restart session-buddy | The running sessions reappear right away (transcript bootstrap) |

- [ ] **Step 3: Verify where the limits come from**

Run: `grep "usage source" "$LOCALAPPDATA/session-buddy/session-buddy.log" | tail -3`
- `Statusline`: Claude Code sends `rate_limits` in the status-line JSON for this account.
- `Oauth`: it does not; the fallback is in use.
Append the result to the spec under section 4.3 as `Verified <today, YYYY-MM-DD> on Windows / <Team or personal>: <Statusline|Oauth>.` and commit:
```bash
git add docs/specs/2026-10-01-session-buddy-design.md
git commit -m "Record where 5H and 7D limits come from on Windows"
```

- [ ] **Step 4: Fix anything that failed**

For each failed row, open a fix with superpowers:systematic-debugging, add a test in the owning task's style (Rust store / hub tests or vitest), fix, re-run the row. Commit each fix separately.

---

### Task 17: Switch-over on Windows (requires the user's go-ahead)

Ask the user explicitly before Step 1: "Task 16 passed. Shall I remove Coucou and install session-buddy globally now?" Do nothing until they say yes.

- [ ] **Step 1: Remove Coucou's hooks with Coucou's own diff**

Coucou tray > Settings... > Claude Code > Uninstall hooks... Let the user review the diff and confirm. Then verify:
```bash
grep -c "coucou-hook" ~/.claude/settings.json
```
Expected: `0`. If Coucou's settings window cannot do it, show the user this exact command and its output before running it (it backs up first):
```bash
cp ~/.claude/settings.json ~/.claude/settings.json.bak-coucou-$(date +%Y%m%d-%H%M%S)
node -e '
const fs = require("fs"); const p = require("os").homedir() + "/.claude/settings.json";
const s = JSON.parse(fs.readFileSync(p, "utf8"));
for (const [e, list] of Object.entries(s.hooks || {})) {
  const kept = list.filter((x) => !JSON.stringify(x).includes("coucou-hook"));
  if (kept.length) s.hooks[e] = kept; else delete s.hooks[e];
}
fs.writeFileSync(p, JSON.stringify(s, null, 2) + "\n");'
```

- [ ] **Step 2: Uninstall Coucou**

Quit Coucou from its tray menu, then run `"%LOCALAPPDATA%\Coucou\uninstall.exe"` (the user clicks through it). Verify `ls "$LOCALAPPDATA/Coucou"` no longer lists `coucou.exe`. Leave `C:\Projects\coucou` (the source) alone.

- [ ] **Step 3: Remove the acceptance folders**

```bash
rm -rf /c/Projects/sb-acceptance
```

- [ ] **Step 4: Install session-buddy globally**

session-buddy tray > Settings... > Install... > review the diff with the user (hooks for 12 events, status line becomes `"<relay>" statusline | python ~/.claude/statusline.py`) > Write. Turn on "Start with the system".
Verify:
```bash
grep -c "sb-relay" ~/.claude/settings.json
node -e 'console.log(require(require("os").homedir()+"/.claude/settings.json").statusLine.command)'
```
Expected: `13` (12 hooks + status line) and the wrapped status-line command.

- [ ] **Step 5: Smoke test**

The user opens a new Warp tab and runs `claude`; the session appears on the strip; their usual status line still shows in the terminal.

- [ ] **Step 6: Commit nothing; report**

No repo change. Tell the user where the backups are (the `settings.json.bak-*` paths printed by both installers).

---

### Task 18: macOS build and acceptance (on the user's Mac)

Manual, done by the user on the Mac with Claude Code there. The personal (non-company) account is the one to verify.

- [ ] **Step 1: Prerequisites and build**

```bash
xcode-select --install            # once
curl https://sh.rustup.rs -sSf | sh   # once
git clone https://github.com/wl-lankin/session-buddy.git && cd session-buddy
npm install
cargo test --workspace && npx vitest run
npm run pack
cp -R target/release/bundle/macos/session-buddy.app /Applications/
open /Applications/session-buddy.app
```
Expected: tests pass on macOS too (including `socket_is_in_config_dir`); the island appears below the menu bar, centred; no Dock icon; a menu bar icon.

- [ ] **Step 2: Install and check the account**

Menu bar icon > Settings... > Install... > review > Write. Start `claude` in Warp. When macOS asks about the "Claude Code-credentials" Keychain item, choose "Always Allow".
Expected: within a minute the expanded island's limits row shows the personal account's email, org and plan, with 5H / 7D values. `grep "usage source" ~/Library/Logs/session-buddy.log | tail -1` tells whether they came from the status line or the endpoint; record it in the spec as in Task 16 Step 3.

- [ ] **Step 3: Run checklist rows 1, 3, 4, 6, 8, 9, 10, 13 from Task 16 on the Mac**

Expected: same results. Fix failures as in Task 16 Step 4, then push only when the user asks.

---

## Appendix: Spike fixture

If `core/tests/fixtures/spike-events.jsonl` cannot be copied from the scratchpad, recreate it by running this in a scratch folder with a project-scoped `.claude/settings.json` whose hooks pipe every event into `events.jsonl` as `{"ev":"<Event>","payload":<stdin JSON>}`:

```bash
claude -p "Do exactly this, nothing else: 1) Launch one subagent (Agent tool, general-purpose) whose task is: 'Run the shell command: echo hello-from-subagent, then reply DONE'. 2) Then call the AskUserQuestion tool once with question 'Pick a color?' header 'Color' and options Red / Blue. 3) Reply with the exact answer you received for the color question." --model claude-haiku-4-5-20251001 --allowedTools "Agent,Bash,AskUserQuestion,PowerShell"
```

The test in Task 3 relies on: an `Agent` PreToolUse with `description` "Run shell command and reply DONE" and `subagent_type` "general-purpose"; a `SubagentStart` with `agent_id` "ad7c4b5d237f7193a"; a Bash PreToolUse carrying that `agent_id`; a `SubagentStop`; and a final `Stop` with `"background_tasks": []`. If a re-recorded fixture has a different agent id, update the two literals in `subagent_attribution_from_spike`.
