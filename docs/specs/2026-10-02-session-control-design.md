# Session control from the chat

The chat can start and steer Claude Code sessions: "start a session in Nexa with Sonnet and have it fix the inbox search". The user stays in charge: every action is confirmed in the island first.

## Decisions

- Background sessions first (no terminal), terminal tabs second.
- The chat has two modes. **Web** (today): WebSearch and WebFetch, no control tools. **Control**: the control tools, no web tools. Never both: a web page must not be able to talk the chat into starting a session.
- Control is off until the user turns the mode on and has listed at least one project folder.

## Pieces

### 1. Background sessions ("workers"), `src-tauri/src/workers.rs`

Claude Code 2.1.287 has first-party background sessions, so nothing is hand-rolled: a session is `claude --bg --model <alias> -n "Buddy: <project>" -- "<prompt>"`, run in the project folder. The CLI's daemon owns the process (it survives Session Buddy). It is NOT muted (no SB_CHAT): its hooks reach the island like any session, so it shows up in the tabs with steps, agents, limits and, importantly, permission requests and questions as the usual Allow/Deny cards (probed: the session runs in a daemon pty, `PermissionRequest` hooks fire, a hook answer is honoured). Nobody has to approve anything in a terminal.

Probed with the real CLI (2.1.287):
- `claude --bg ...` prints `backgrounded · <id> · <name>`; `<id>` is the first 8 characters of the session id the hooks report. `--model` and the working directory are honoured. A folder Claude Code does not trust yet is refused ("Workspace not trusted"); the tool says so without the path.
- `claude agents --json` lists interactive and background sessions: `id` (short, background only), `sessionId`, `cwd`, `kind`, `name`, `startedAt`, `pid` (while running), `status` (`busy`, `idle`, `waiting`), `state` (`working`, `blocked`, `done`, `stopped`). `--all` adds finished ones.
- `claude stop <id>` stops it and keeps the conversation; `claude rm <id>` deletes it.
- `claude logs <id>` is the raw terminal screen with escape sequences, not usable as text. "Recent output" for `get_session` is the session's last assistant message and steps from the hooks.
- `claude --bg --resume <session-id> -- "<prompt>"` WITHOUT other flags continues a stopped session under the same id with its saved options. While the session is still running (even idle) it starts a copy instead, and with extra flags it also starts a copy. So a follow-up prompt is: refuse when the session is busy or waiting; when idle, `stop` it, wait until it is gone, then resume with the prompt; if the CLI still reports another id, stop that copy and report an error.
- Without a TTY the permission mode is `default`: a permission prompt waits (`status: waiting`) until the island (or an attached terminal) answers. No permission flag is ever passed.

Tracking: an in-memory record of the ids this run started, plus `claude agents --json` (read at start-up, before each tool and after each start). A session is managed when its name starts with `Buddy: ` (survives an app restart, no file on disk). The session id from `agents` is flagged in the store, so the snapshot carries `managed: true` whichever arrives first, the flag or the first hook. Only managed sessions can be steered.

- Limit: `chatMaxWorkers` (default 3) counts managed sessions that are running and not idle (`busy`, `waiting`); idle ones cost no parallel work.
- Models: the fixed set haiku, sonnet, opus. Never `--dangerously-skip-permissions`, never `--permission-mode bypassPermissions`.
- Workers are not stopped when the app quits: the daemon owns them, the user can `claude attach` or stop them from the island.
- `worker_attach(session_id)` opens Terminal.app on `claude attach <id>` (macOS; the shell and AppleScript quoting are covered by tests, only a validated id and the quoted binary path enter the script).

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

How an action is confirmed (verified headless with the real CLI): the chat child gets `--permission-prompt-tool mcp__buddy__approve` and `--allowedTools` for the three read tools only. The CLI hides `approve` from the model and calls it with `{tool_name, input, tool_use_id}` whenever the model uses an action tool; the app validates, shows the card, and answers `{"behavior":"allow","updatedInput":{...}}` (the CLI runs the tool with `updatedInput`, so the folder the user chose arrives that way) or `{"behavior":"deny","message":"denied by the user"}`. An allow is stored as a one-time grant for exactly those arguments (10 minutes); the action tool itself refuses to run without a matching grant, so nothing runs without a click even if the permission path were bypassed.

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
  rows: { label: string; value: string }[];   // Project, Model
  body: string | null;                 // the full prompt, scrollable
  folder: { path: string; options: string[] } | null;   // the folder to use, other matches for the model's name
  host: { value: string; options: { id: string; label: string }[] } | null;  // "Runs in"
  deadline: number;                    // epoch ms, like the other interactions
}
```

`rows` carry Project and Model; the folder is shown from `folder`, with a "Choose..." button (`pick_folder(startDir?)`). The answer is `{ allow: boolean, folder?: string, host?: string }`. A chosen folder must exist and be a directory; it is trusted even outside the project roots.

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

Stored as `chatMode` (`web` default, `control`), `chatProjectRoots` (existing directories only, canonical, at most 20; checked on save), `chatMaxWorkers` (3, range 1 to 6) and `chatSessionHost` (`background` default). `ChatStatus` also reports `mode` and `controlReady` (control needs at least one existing project root); a mode change restarts the chat process.

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
