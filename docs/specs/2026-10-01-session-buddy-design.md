# session-buddy - design spec

Date: 2026-10-01
Status: approved in brainstorming, pending spec review

## 1. Purpose

A desktop companion that shows **all running Claude Code sessions** at a glance and lets the user act on them without switching to the terminal. Built for daily work with several parallel sessions in Warp, on Windows 11 and macOS.

Success means:

- Every live session is listed, each with its own state, and the user can flip through them.
- The user sees what each session, each of its sub-agents and each background task is doing right now.
- Permission requests, `AskUserQuestion` prompts and plain-text questions can be answered from the island.
- Context window, lines changed, branch and the account's 5H / 7D limits are visible.
- Claude Code is never blocked or slowed down by session-buddy.

## 2. Origin and scope

session-buddy is a fork of the Windows Tauri app in `C:\Projects\coucou\windows` (MIT, Louis Raille). The MIT license and asset license are carried over with attribution.

**Kept from Coucou:** Mochi (Canvas 2D engine, emotes, greeting animation, poke / dizzy / hearts), all 28 sounds unchanged, the hook relay design (never blocks), the settings merge with dated backup and diff, tray, autostart.

**Removed:** Anthropic API key and chat, all integrations (Resend, n8n, Vercel, GitHub, Notion, Cal.com, Stripe) and their pills, file drop and upload sequence, window context capture, keyring, the French UI labels, the three-row absolute ticker (cause of overlapping step lines), "jump to terminal".

**Not included (YAGNI):** jump to terminal, chat, integrations, telemetry, auto-update, code signing, notch placement on macOS.

## 3. Platforms

One Tauri 2 codebase for Windows 10/11 and macOS 15+. The island sits at the top centre of the screen on both (no notch integration). Builds happen natively on each OS (`npm run pack` on Windows, `npm run pack` on macOS); there is no cross-compilation. Any terminal is supported; Warp is the primary one. There is no terminal filter (the Coucou macOS app ignored non-VS Code sessions; session-buddy does not).

## 4. Architecture

```
session-buddy/
  src/          TypeScript front end, no framework: Mochi, island, views, settings window
  common/       sb-common: paths and pipe/socket names shared by app and relay
  core/         sb-core: session store, hub (relay protocol), transcript bootstrap,
                usage parsing, settings.json merge - pure Rust, no Tauri, fully unit tested
  src-tauri/    Rust app: window, IPC listener, pollers, commands, tray
  hook/         sb-relay binary: hook relay + status-line wrapper
  dev/          browser preview with fake sessions
  docs/         spec and implementation plan
```

### 4.1 Relay (`sb-relay`)

One small binary with two modes.

**Hook mode** (`sb-relay hook <EventName>`), registered for: `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `Notification`, `Stop`, `StopFailure`, `SubagentStart`, `SubagentStop`.

- Reads the hook JSON from stdin and adds `term_program`. (The git branch is looked up by the app, off the hook path, at most every 30 s per session.)
- Connects to the app (Windows: named pipe `\\.\pipe\session-buddy-<user>`; macOS: Unix socket `~/Library/Application Support/session-buddy/sb.sock`) with a 100 ms connect timeout. No app means exit 0 with no output.
- Fire-and-forget for all events except the three blocking cases below.

**Blocking cases** (only when the app is reachable and acknowledges within 800 ms that a human can see the card):

| Event | Wait deadline | Output on answer |
|---|---|---|
| `PermissionRequest` | 110 s | `hookSpecificOutput.decision.behavior` = `allow` / `deny` |
| `PreToolUse` with `tool_name == "AskUserQuestion"` | 540 s | `permissionDecision: "allow"` + `updatedInput` = original input + `answers` (keyed by question text, value always a string: the option label, multi-select labels joined with `", "`, or the free text for "Other"; this matches the tool's `answers: Record<string, string>` schema) |
| `Stop` where `last_assistant_message` ends with `?` (after trimming) and `stop_hook_active == false` | 540 s | `{"decision":"block","reason":"<user reply>"}` |

"Answer in terminal", deadline expiry, app crash or a closed pipe all produce **no output**, so Claude Code continues with its normal terminal flow. Verified on 2026-10-01 (Claude Code 2.1.286): a `PreToolUse` hook returning `updatedInput.answers` for `AskUserQuestion` delivers the answer and suppresses the terminal picker.

**Status-line mode** (`sb-relay statusline`), installed as `statusLine.command`:

The installed command is a pipe: `"<relay>" statusline | <original command>`. The relay copies stdin to stdout first (so the user's own status line gets exactly the same JSON, run by the same shell Claude Code uses), then forwards the JSON to the app (skipped if unreachable). With no original command it is `"<relay>" statusline --quiet`, which prints nothing. The original `statusLine` value is saved in `<config>/install.json` and restored on uninstall.

### 4.2 Session store (Rust, single source of truth)

Keyed by `session_id`. Each session:

- `project` (last path component of `cwd`), `cwd`, `branch`, `term_program`, `model`
- `status`: `thinking | working | needs_you | finished | error | idle | stale`
- `last_prompt`, `last_message` (Claude's last assistant message)
- `steps`: ring buffer of the last 50 main-thread steps (`tool`, `target`, `at`, `ok`)
- `agents`: map `agent_id -> { agent_type, description, status, current_step, started_at, ended_at }`. Tool events carrying `agent_id` are attributed to that agent, not to the main thread. Description comes from the `Agent` tool's `tool_input.description` / `tool_response.agentId`.
- `background_tasks`: latest `background_tasks` array from `Stop` / `SubagentStop` (`id, type, status, description, agent_type`)
- `stats`: `lines_added`, `lines_removed`, `context_used_pct`, `context_tokens`, `context_size`, `cost_usd` (from status-line JSON)
- `pending`: FIFO queue of open interactions (`approval | question | reply`), each with its relay request id and deadline
- `started_at`, `last_event_at`

Lifecycle: created on the first event of an unknown `session_id`; `stale` after 10 min with no events and no pending interaction; removed on `SessionEnd` or after 2 h stale (both intervals configurable). `finished` falls back to `idle` after 30 s but the session stays listed.

**Bootstrap after app start:** scan `~/.claude/projects/*/*.jsonl` modified in the last 2 h, read the last ~200 lines of each, and seed `project`, `cwd`, `last_prompt`, `last_message`, `status` (`idle`, or `stale` if older than 10 min).

The store emits a full snapshot to the front end on every change (throttled to 30 fps). The front end holds no session state of its own, so reloading the window loses nothing.

### 4.3 Usage (5H / 7D limits)

Per account currently logged in to Claude Code on that machine, never tied to a specific org:

1. Preferred: a `rate_limits` field in the status-line JSON, if Claude Code provides it.
2. Fallback: `GET https://api.anthropic.com/api/oauth/usage` with the OAuth access token Claude Code itself stores, read fresh on each fetch and never persisted:
   - Windows: `~/.claude/.credentials.json` -> `claudeAiOauth.accessToken`
   - macOS: Keychain generic password, service `Claude Code-credentials` (one "Always Allow" prompt)
   - Cached 10 min; on error keep the last value and show its age.
3. Account label from `~/.claude.json` `oauthAccount` (email, org name, plan), shown next to the limits.

To verify during implementation: whether the status-line JSON carries `rate_limits` for personal (Pro/Max) and Team accounts. The fallback makes the feature independent of the answer.

### 4.4 Settings and install

Settings window (from tray / menu bar): install / uninstall hooks, install / uninstall status-line wrapper, sounds on/off and volume, stale and removal intervals, global hotkey, screen (primary / under cursor), autostart.

`~/.claude/settings.json` changes always: dated backup, merge (only session-buddy's own entries added or removed, user hooks untouched), diff shown, written only after a click. The original `statusLine` value is stored in the app's config and restored on uninstall. Uninstall followed by install leaves the file byte-identical to the pre-install state apart from session-buddy's entries.

## 5. User interface

All UI text in English. Each session gets a stable colour; Mochi takes the colour of the active session.

### 5.1 Strip (resting state, never hidden)

About 220 x 28 px at the top centre:

```
( .. )  4 sessions . 2 working . 1 needs you        5H 42% . 7D 18%
```

Mini Mochi mirrors the "loudest" session (needs_you > error > working > thinking > finished > idle > stale). A dot per session, pulsing when it needs the user.

### 5.2 Compact (hover or any event)

```
( .. )   pushdocs . PDD-1981  +128 -34  ctx 61%        < 2/4 >
         * working . 3 agents . > Edit . DatevClient.php
```

Scroll wheel or arrow keys flip sessions. Collapses back to the strip after the configured delay.

### 5.3 Expanded (click)

- Session tabs with status glyph (`*` working, `!` needs you, check finished, `x` error, grey stale).
- Header: project, branch, `+added -removed`, context bar with tokens (`122k/200k`), model.
- Limits row: 5H and 7D bars with reset times and account label.
- Last prompt.
- Steps column: fixed-height rows in a scrolling list (no absolute positioning, no overlap); current step shimmers.
- Agents column: each sub-agent with type, description, current step or "done Xm ago".
- Background column: background tasks with type, description, status.

Bars are orange at >= 70 %, red at >= 90 %. Optional sound when a session crosses 90 % context.

### 5.4 Interactions

- A pending interaction opens the island on that session, plays the approval sound and pins it:
  - Approval: tool + exact target (command, file path, URL), Deny / Allow.
  - `AskUserQuestion`: each question with its options as buttons (multi-select supported) plus an "Other" free-text field, Submit.
  - Plain-text question: Claude's last message, reply box, Send.
  - Every card has "Answer in terminal".
- Several pending interactions queue per session and across sessions; nothing replaces another.
- Keys: left / right or Tab switch sessions, 1-9 jump, Esc collapses, Enter submits the focused card. Global hotkey, default `Ctrl+Alt+Space` on both systems (on macOS that is Control+Option+Space; Option+Cmd+Space is taken by Finder search), configurable in Settings, opens the island and gives it keyboard focus. Without the hotkey the island never takes focus, so keys only work after it.
- Finished: Mochi jumps, finish sound, Claude's last message shown briefly.
- Mochi keeps all existing behaviour (hover, poke, dizzy, hearts, greeting on launch). Sounds play exactly as in Coucou.

## 6. Error handling

| Situation | Behaviour |
|---|---|
| App not running | Relay and wrapper exit within 100 ms; hook output empty; status line from the user's script. |
| App hangs or crashes during a pending interaction | Relay deadline expires, no output, terminal takes over. |
| App restarts | Sessions rebuilt from transcript bootstrap and later events. |
| Session killed without `SessionEnd` | `stale` after 10 min, removed after 2 h. |
| Late answer after deadline | Discarded; card shows "answered in terminal". |
| Usage fetch fails / no token | Last value with age, or "n/a". |
| Malformed hook JSON | Logged, ignored. |

Log file: Windows `%LOCALAPPDATA%\session-buddy\session-buddy.log`, macOS `~/Library/Logs/session-buddy.log`. No telemetry. The only network call is the usage fallback to `api.anthropic.com`.

## 7. Testing

- Rust unit tests: session store (event replay -> state, sub-agent attribution, background tasks, stale and removal, pending queue), settings merge / unmerge round trip, relay protocol (deadlines, app missing, answer shapes for all three blocking cases).
- Fixtures: recorded `events.jsonl` files from real sessions (including the 2026-10-01 spike capture).
- Front end: vitest for the view model (loudest session, ordering, formatters, bar thresholds).
- `dev/preview.html`: drives the island with fake sessions in a plain browser.
- Manual acceptance before switch-over: 3 parallel Warp sessions on Windows with sub-agents, a permission request, an `AskUserQuestion` and a plain-text question; the same on macOS.

## 8. Switch-over

Windows:

1. Build session-buddy; test it next to Coucou using project-scoped hooks in a test folder.
2. Quit Coucou, run `%LOCALAPPDATA%\Coucou\uninstall.exe`, remove Coucou's 10 hook entries from `~/.claude/settings.json` (backup + diff).
3. Install session-buddy hooks and status-line wrapper globally (backup + diff), enable autostart.

macOS: clone, build, launch, Settings -> Install hooks.
