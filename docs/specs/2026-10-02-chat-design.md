# Buddy Chat

A small desktop chat inside the island. A headless Claude Code (Haiku) runs in the background, the island shows a normal chat, never a terminal. Off by default.

## Why this shape

- `claude -p --input-format stream-json --output-format stream-json --include-partial-messages` is a long-lived headless process: JSON lines in on stdin, JSON lines out on stdout. No PTY, no terminal emulation.
- Probed with CLI 2.1.287: cold start 0.6 s, first token about 1.5 s, Haiku 4.5 (`--model haiku`). A web search turn takes about 10 s.
- Events seen on stdout: `system` (init, status, hook_started/hook_response, thinking_tokens), `stream_event` (Anthropic raw events: `content_block_delta` with `delta.text` or `delta.thinking`), `assistant` (complete message, `content[]` holds `text` and `tool_use` blocks with `name` and `input`), `user` (`tool_result` blocks for the tool calls), `rate_limit_event`, and `result` (`subtype: success|error_*`, `duration_ms`, `total_cost_usd`, `result` text) which ends a turn.
- Input line: `{"type":"user","message":{"role":"user","content":"<text>"}}`.

## Process

```
claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages
       --model haiku --tools "WebSearch,WebFetch" --allowedTools "WebSearch,WebFetch"
       --no-session-persistence --strict-mcp-config
       --append-system-prompt "<short style prompt>"
```

- cwd: a private folder under the app data dir (`<app support>/session-buddy/chat`), so no project is touched and no project instructions leak in.
- env: `SB_CHAT=1`. The relay (`sb-relay hook`) exits silently when `SB_CHAT` is set, otherwise the chat would show up as a session in the island.
- `--no-session-persistence`: nothing is written to `~/.claude/projects`, so the chat never shows up as a "recent" session.
- Tools: read-only web access only. No Bash, no Edit, no Write. `--tools` limits what exists, `--allowedTools` pre-approves it: nobody can answer a permission prompt in headless mode, so without it every search is refused.
- The binary is found like this: setting `chatClaudePath` if set, else `~/.local/bin/claude`, `/opt/homebrew/bin/claude`, `/usr/local/bin/claude`, `~/.claude/local/claude`, `~/.npm-global/bin/claude`, else the first hit of `command -v claude` in a login shell (macOS) or `where claude` (Windows). A GUI app has a short PATH, so do not rely on it. On Windows the file may be `claude.exe` or `claude.cmd`.

## Lifecycle

- Setting `chatEnabled` (default `false`). When off, nothing runs and the Chat view shows a switch to turn it on.
- Lazy: the process starts on the first `chat_send`, or on `chat_wake` (sent when the Chat view opens, so the cold start is hidden while the user types).
- Idle stop: after `chatIdleMinutes` (default 10, 0 = never) without a turn the process is stopped; status goes to `off`. The front end keeps the transcript and shows a divider "Chat went to sleep" before the next message: the new process has no memory of the old turns.
- `chat_reset` kills the process and starts a fresh conversation. App quit kills the child. A crash reports an `error` status and the next send restarts it.
- Turning `chatEnabled` off stops the process at once.

## Settings (Rust `Settings` + TS `Settings`)

| field | type | default |
|---|---|---|
| `chatEnabled` | bool | false |
| `chatIdleMinutes` | number | 10 |
| `chatModel` | string | `"haiku"` |
| `chatClaudePath` | string | `""` |

camelCase on the wire, like the other settings.

## Tauri commands (backend, `src-tauri/src/chat.rs`)

| command | args | result |
|---|---|---|
| `chat_send` | `text: string` | `Ok(())` or `Err(message)`; starts the process if needed |
| `chat_wake` | none | starts the process if enabled and not running |
| `chat_interrupt` | none | stops the running answer; keeps the conversation if the CLI supports an interrupt control request, else restarts and the front end shows a context-reset divider |
| `chat_reset` | none | kills the process, clears state |
| `chat_status` | none | `ChatStatus` |

`ChatStatus = { enabled: boolean; state: "off"|"starting"|"ready"|"busy"|"error"; claudeFound: boolean; detail?: string }`

## Events (backend to window `island`)

One event name, `chat-event`, payload is a tagged union (`type`):

```ts
type ChatEvent =
  | { type: "status"; state: "off"|"starting"|"ready"|"busy"|"error"; detail?: string }
  | { type: "turn"; id: string }                                   // a turn began (id is new per chat_send)
  | { type: "thinking"; id: string }                               // reasoning started, no text yet
  | { type: "delta"; id: string; text: string }                    // answer text, in order
  | { type: "tool"; id: string; callId: string; tool: "WebSearch"|"WebFetch"|string;
      label: string; state: "running"|"done"|"error" }             // label: the query or the host
  | { type: "done"; id: string; text: string; durationMs: number; costUsd?: number }  // full answer
  | { type: "error"; id?: string; message: string };
```

The backend normalises the CLI's lines into these. `delta` must not repeat text. `label` is short (query or hostname), never a full URL with query string.

## Front end (`src/`)

New island view `chat`, opened by a bubble button in the expanded tab row (next to "Recent"), and by pressing `/` while the island has keyboard focus.

States of the view:

1. **Off:** a calm card: what it is, what runs (a background Claude Code with Haiku, only while you use it, web search only), a primary "Turn on chat" switch, link to Settings.
2. **Empty:** greeting from Buddy and 3-4 suggestion chips, built from the live sessions ("What is <focused project> doing right now?", "What needs my attention?", "Search the web for ...", "Explain the last error"). A click fills and sends.
3. **Conversation:** user bubbles right, assistant left, streamed, rendered with the Markdown renderer (extend it with http(s) links and tables only if cheap), code blocks with a copy button, tool pills ("Searching the web: ..." running with a spinner, then done), a faint "Chat went to sleep" divider after an idle stop.
4. **Composer:** auto-growing textarea, Enter sends, Shift+Enter adds a line, Escape leaves the field, a Stop button replaces Send while busy, a **context chip** "+ Session" that attaches the focused session (project, branch, model, last prompt, last answer, the last steps) to the next message as a block the user can see and remove. The attached block is sent to the CLI but the bubble shows only a small chip, not the whole block. This is the part only Session Buddy can do.
5. **Header:** title, a status dot (off/starting/ready/busy/error), a power switch (same as the setting), "New chat" button.

Unread: when an answer finishes while another view is shown or the island is collapsed, the chat button gets a dot, and Buddy plays a short emote. A collapsed island stays collapsed (no pop-up).

Sizes: the view has a fixed natural height like the other views (about 440 logical px at the default width); respect the enlarge button.

## Buddy

The existing `BotStateName`/`BotEmoteName` set is reused; the chat drives `State.stateOverride` and emotes only while the chat view is on screen (and clears them after), never while a real session needs the user.

| chat moment | Buddy |
|---|---|
| chat off | `sleeping` |
| process starting | yawn emote, then `idle` |
| user is typing in the composer | eyes look down toward the composer (lookY), `idle` |
| message sent, no token yet | `thinking` |
| WebSearch / WebFetch running | `searching` |
| answer streaming | `working` |
| answer done | `finished` state, `happy` emote for a moment |
| error | `error` |
| unread answer, view elsewhere | `proud` emote once |

Position: a small Buddy (diameter about 40) at the left of the chat header, so it never covers messages. Add a `chat` entry to `botPosition`.

Sounds (existing files, see `sounds/`): `send` on send, `search` when a search starts, `finish` when done, `error` on error, `pop` for the chat button dot.

## Settings window

A "Chat" section: the on/off switch, idle minutes, and a read-only line showing whether the `claude` CLI was found (from `chat_status`). Text: Haiku, web search only, nothing is written to disk.

## Privacy and limits (README)

- Chat messages go to Anthropic through Claude Code with the user's own login, like any Claude Code use. Nothing else leaves the machine.
- Haiku usage counts against the user's plan.
- No transcripts are written by Session Buddy or by the CLI (`--no-session-persistence`); the transcript lives in memory in the island until the app quits or the user starts a new chat.
- Tools are limited to `WebSearch` and `WebFetch`.

## Out of scope for now

Persisted history, file attachments, switching model per message, voice.
