# Session control from the chat

The chat can start and steer Claude Code sessions: "start a session in Nexa with Sonnet and have it fix the inbox search". The user stays in charge: every action is confirmed in the island first.

## Decisions

- Background sessions first (no terminal), terminal tabs second.
- The chat has two modes. **Web** (today): WebSearch and WebFetch, no control tools. **Control**: the control tools, no web tools. Never both: a web page must not be able to talk the chat into starting a session.
- Control is off until the user turns the mode on and has listed at least one project folder.

## Pieces

### 1. Background sessions ("workers"), `src-tauri/src/workers.rs`

A worker is a headless `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --model <alias>` child in the project folder, started by Session Buddy. It is NOT marked SB_CHAT: its hooks reach the island like any session, so it shows up in the tabs with steps, agents, limits and, importantly, permission requests and questions as the usual Allow/Deny cards. Nobody has to approve anything in a terminal.

- The manager keeps `worker id -> { child, session_id (from the `system init` line), project, model, started_at, state, recent output }`; the output is the assistant text per turn, last ones only (cap the memory), never written to disk.
- `send_prompt` writes a stream-json user line to the child's stdin. One prompt at a time per worker: a second one while the worker is busy is refused with a clear message.
- Stop: the interrupt control request first (works, see the chat spec), then kill after a short grace period. All workers are killed when the app quits.
- Limit: `chatMaxWorkers` (default 3) at once.
- The binary lookup, spawn flags helpers and the idle handling are shared with `chat.rs` where that is natural (extract, do not copy).
- Never `--dangerously-skip-permissions`, never `--permission-mode bypassPermissions`. Models are the fixed set haiku, sonnet, opus.
- A worker is flagged in the session JSON: `managed: true`.

### 2. MCP tools for the chat, served by the relay

The chat child gets `--mcp-config` pointing at the relay binary in a new subcommand: `sb-relay mcp`, a stdio MCP server (JSON-RPC 2.0 lines: `initialize`, `tools/list`, `tools/call`, `ping`; protocol version `2024-11-05` or the one the CLI asks for) that forwards each tool call to the app over the existing per-user pipe/socket and returns the app's answer. No new port, no token: the socket is already per-user. The hook guard for `SB_CHAT` applies to `hook` only; `mcp` must work under it.

Tools (names as the model sees them: `mcp__buddy__<name>`):

| tool | reads or acts | confirmation |
|---|---|---|
| `list_sessions` | all sessions: id, project, branch, status, model, managed, last prompt (clipped), pending request kind and target | none |
| `get_session(id)` | one session: the above plus the last steps and, for workers, the recent output | none |
| `list_projects` | the folders the user allows: name and path | none |
| `start_session(project, model, prompt)` | starts a worker | yes |
| `send_prompt(session_id, text)` | prompt to a worker | yes |
| `stop_session(session_id)` | stop a worker | yes |

The chat can never answer a permission request or a question of a session: that stays with the user. No tool for it.

Safety rules the app enforces, not the model:
- `project` (what the model asks for) is a folder name or path that resolves, after canonicalisation (symlinks resolved), to a folder inside one of `chatProjectRoots` (direct children or deeper). Everything else is refused with the list of allowed roots. Only a folder the user chose in the dialog on the card may lie elsewhere; it must exist and be a directory.
- `model` must be one of the fixed set; `prompt` and `text` at most 4000 characters, no control characters except newlines.
- The confirmation shows the full prompt, the resolved folder and the model. The tool call waits for the answer (like a permission request, up to 110 s) and returns "denied by the user" or the result.
- Tool results are data, clipped; an error text never contains a path outside the roots.

### 3. Confirmation in the island

An action request is an interaction without a session. It reaches the front end as `Snapshot.actions: ActionRequest[]` (empty normally) and is answered through the existing `answer` command with `{ "allow": true|false }`:

```ts
interface ActionRequest {
  requestId: string;
  title: string;                       // "Start a session"
  rows: { label: string; value: string }[];   // Project, Folder, Model
  body: string | null;                 // the full prompt, scrollable
  deadline: number;                    // epoch ms, like the other interactions
}
```

The island opens on it like on an approval (pinned until answered, Buddy in the `approval` state, same sounds) with Allow / Deny and "Answer in terminal" not offered.

### 4. Chat

- Header: a mode switch "Web | Control" next to the model picker (setting `chatMode`, default "web"); switching restarts the chat process (new context divider). In Control mode without any project root the chat shows a calm hint with a link to Settings. The web suggestion chips are replaced by control ones ("What are my sessions doing?", "Start a session in <project>").
- The control mode system prompt: it is Buddy, it has the tools above, it asks before acting only through the tools (the app confirms), it reports briefly, it never invents session ids.
- Tool pills for the control tools with readable labels ("Starting a session in Nexa", "Sent a prompt to Nexa", "Stopped Nexa") and a "denied" look when the user said no.
- Ollama: allowed in Control mode (tool use works with capable local models; weak ones may fail; not our problem to hide).

### 5. Island: managed sessions

- A small marker on managed sessions in the tabs and the session header ("Buddy" glyph) and, in the session view, a composer line "Send a prompt to this session" and a Stop button, calling `worker_send(sessionId, text)` and `worker_stop(sessionId)` directly. These are the user's own actions: no confirmation card.
- While a worker runs a turn its status already shows via the hooks.

### 6. Settings

Chat section, "Control": folders the chat may start sessions in (add / remove, validated: must exist and be a directory), max parallel background sessions, and the default place sessions run in (`chatSessionHost`: `background` (default), `terminal` (Terminal.app), `iterm`, `warp`, `wt` on Windows; only the ones that exist on this machine are offered). Everything else about control lives in the chat header.

The folder is the user's call. Two ways to choose it, both with the native folder dialog (Tauri dialog plugin, add its capability; the dialog is opened by the island, never by the model):

- In Settings the "Add folder" button picks the project roots the chat may suggest folders from.
- On the confirmation card the "Folder" row has a "Choose..." button. A folder the user picks there themselves is trusted even outside the roots: the rule "inside a root" only restricts what the MODEL asks for. When the model's project name matches several folders the card lists them as options too.

The card also shows "Runs in" with the default host and lets the user change it for this one start before pressing Allow. Terminal hosts are phase 2; until then the choice shows only "Background".

## Phase 2: terminal sessions

`start_session` gets an optional `host` argument (default `chatSessionHost`); with a terminal host: after confirmation open the user's terminal in the folder and run `claude --model <alias> "<prompt>"`: Terminal.app and iTerm2 through AppleScript (escape the command properly, the prompt is passed as one single-quoted shell word), Windows through `wt.exe`, Warp only opens the folder. The session appears through its hooks; steering such sessions is limited to reading. Setting: preferred terminal.

## Limits

- Workers die with the app. Not restarted.
- A worker's transcript lives only in memory and in Claude Code's own session files.
- Cost counts against the user's plan like any Claude Code session.
