// Five sessions that exercise every part of the island, plus the account states
// the limits block can be in.

import type { ActionRequest, Session, Snapshot, Usage } from "../src/core/types";
import type { ChatAction, ChatEvent } from "../src/model/chat";

const base = (id: string, project: string, now: number, p: Partial<Session>): Session => ({
  id, project, cwd: `C:\\Projects\\${project}`, branch: null, termProgram: "WarpTerminal", model: "Opus 5.5",
  status: "idle", statusSince: now, lastPrompt: null, lastMessage: null, steps: [], agents: [], background: [],
  stats: { linesAdded: 0, linesRemoved: 0, contextUsedPct: 12, contextTokens: 24_000, contextSize: 200_000, costUsd: 0.2 },
  pending: [], startedAt: now, lastEventAt: now, pid: null, live: true, plan: null, managed: false, ...p,
});

const ACCOUNT = { email: "wolfgang.linz@example-company.de", org: "Example Company GmbH", plan: "Team" };

/** The limits block: fresh values, values kept after a failed refresh, and no values at all. */
export function demoUsage(now: number, kind: "ok" | "stale" | "error"): Usage {
  const fiveHour = { usedPct: 42, resetsAt: now + 3 * 3600_000, severity: "normal" };
  const sevenDay = { usedPct: 74, resetsAt: now + 4 * 24 * 3600_000, severity: "warning" };
  const limits = {
    fiveHour,
    sevenDay,
    limits: [
      { kind: "session", label: "5H", ...fiveHour },
      { kind: "weekly_all", label: "7D", ...sevenDay },
      { kind: "weekly_scoped", label: "7D Fable", usedPct: 12, resetsAt: sevenDay.resetsAt, severity: "normal" },
    ],
    extra: { enabled: true, usedMinor: 1240, limitMinor: 5000, currency: "EUR", exponent: 2, disabledReason: null, percent: 24.8 },
  };
  switch (kind) {
    case "ok":
      return { ...limits, source: "statusline", updatedAt: now, error: null, oauthUpdatedAt: now, oauthError: null, account: ACCOUNT };
    case "stale":
      return { ...limits, source: "oauth", updatedAt: now - 14 * 60_000, error: "HTTP 429 from the usage endpoint", oauthUpdatedAt: now - 14 * 60_000, oauthError: "HTTP 429 from the usage endpoint", account: ACCOUNT };
    case "error":
      return { fiveHour: null, sevenDay: null, limits: [], extra: null, source: "none", updatedAt: null, error: "No OAuth token found in the credentials file", oauthUpdatedAt: null, oauthError: null, account: null };
  }
}

export function demoSnapshot(now: number): Snapshot {
  return {
    now,
    actions: [],
    usage: demoUsage(now, "ok"),
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
      // A long project and branch: the branch chip must stay visible while the name shrinks.
      base("e", "session-buddy-island-redesign-playground", now, {
        cwd: "C:\\Projects\\session-buddy-island-redesign-playground\\src\\views\\expanded",
        branch: "SB-1-blocks-with-side-panel-layout", status: "finished", model: "Opus 5.5 (1M context)",
        lastPrompt: "fix the island layout: this is a long typed prompt that has to end in an ellipsis instead of wrapping onto a second line of the block",
        lastMessage: "Layout done: tabs, session and account blocks.\nThe branch chip never truncates below 24 characters.\nA third line the card does not show.",
        steps: [
          { tool: "Bash", label: "Run · cargo test --workspace", at: now, ok: true },
          { tool: "Edit", label: "Edit · expanded.ts", at: now, ok: true },
          { tool: "Edit", label: "Edit · style.css", at: now, ok: true },
          { tool: "Bash", label: "Run · npx vitest run", at: now, ok: true },
          { tool: "Bash", label: "Run · npx tsc --noEmit", at: now, ok: true },
          { tool: "Bash", label: "Run · npm run pack", at: now, ok: false },
          { tool: "Read", label: "Read · tauri.conf.json", at: now, ok: true },
        ],
        agents: [{ id: "ag3", agentType: "general-purpose", description: "Review the diff", running: false, currentStep: null, startedAt: now - 300_000, endedAt: now - 120_000 }],
        stats: { linesAdded: 11366, linesRemoved: 21, contextUsedPct: 67, contextTokens: 670_000, contextSize: 1_000_000, costUsd: 9.4 },
      }),
    ],
  };
}

/**
 * A chat that went through a sleep: one answer with a context chip and Markdown, one with a web search.
 * Replay it with island.chatDispatch / window.__sb.chat. "empty" is a fresh chat, "off" the Off card.
 */
export function demoChat(now: number, kind: "full" | "empty" | "off" = "full"): ChatAction[] {
  const at = (s: number) => now - (600 - s) * 1000;
  const ev = (s: number, event: ChatEvent): ChatAction => ({ type: "event", event, at: at(s), viewing: true });
  if (kind !== "full") return [{ type: "status", status: { enabled: kind === "empty", state: kind === "empty" ? "ready" : "off", claudeFound: true, provider: "claude", model: "haiku", webSearch: true, mode: "web", controlReady: false }, at: at(0) }];
  const first = "**pushdocs** is fixing the DATEV 409 handling.\n\n1. It read `DatevClient.php` and searched for the fault\n2. The last test run failed, so it is editing the client again\n\nNothing needs you right now. To rerun the failing test yourself:\n\n```bash\nphp artisan test --filter Datev\n```";
  const second = "Claude Code 2.1 starts about twice as fast and has a tidier `/permissions` screen.\n\nSee the [release notes](https://docs.claude.com/en/release-notes/claude-code) for the full list.";
  return [
    { type: "status", status: { enabled: true, state: "ready", claudeFound: true, provider: "claude", model: "haiku", webSearch: true, mode: "web", controlReady: false }, at: at(0) },
    { type: "send", text: "What is pushdocs doing right now?", context: { kind: "session", label: "pushdocs \u00B7 PDD-1981" }, at: at(10) },
    ev(11, { type: "turn", id: "t1" }),
    ev(12, { type: "delta", id: "t1", text: first }),
    ev(13, { type: "done", id: "t1", text: first, durationMs: 2300 }),
    ev(300, { type: "status", state: "off" }),
    { type: "send", text: "What is new in Claude Code?", context: null, at: at(500) },
    ev(501, { type: "status", state: "starting" }),
    ev(502, { type: "status", state: "ready" }),
    ev(503, { type: "turn", id: "t2" }),
    ev(504, { type: "tool", id: "t2", callId: "c1", tool: "WebSearch", label: "claude code release notes", state: "done" }),
    ev(505, { type: "delta", id: "t2", text: second }),
    ev(506, { type: "done", id: "t2", text: second, durationMs: 9800 }),
  ];
}

/** A session Buddy started: it shows the marker and the prompt line. */
export function demoManaged(now: number, status: Session["status"] = "idle"): Session {
  return base("w1", "nexa-web", now, {
    cwd: "/Users/alex/Projects/nexa-web", branch: "main", status, managed: true, termProgram: null, model: "Sonnet 4.5",
    lastPrompt: "Fix the inbox search: it ignores umlauts and the sort order is wrong.",
    lastMessage: "Done. The search now folds umlauts and sorts by the newest message.\nI added two Pest tests for it.",
    steps: [
      { tool: "Read", label: "Read \u00B7 InboxSearch.php", at: now, ok: true },
      { tool: "Edit", label: "Edit \u00B7 InboxSearch.php", at: now, ok: true },
      { tool: "Bash", label: "Run \u00B7 php artisan test --filter Inbox", at: now, ok: status === "working" ? null : true },
    ],
  });
}

const LONG_PROMPT = [
  "Fix the inbox search in nexa-web.",
  "",
  "Problems I see:",
  "1. Searching for \"Müller\" does not find \"Mueller\" and the other way around.",
  "2. The result list is sorted by id, it should be the newest message first.",
  "3. A search with only whitespace returns every message and is slow.",
  "",
  "Please:",
  "- find where the query is built (probably app/Search/InboxSearch.php)",
  "- fold umlauts and ss/ß on both sides, in a way that works with the existing MySQL collation",
  "- sort by sent_at descending",
  "- treat an empty or whitespace-only query as no search",
  "- add Pest tests for all three cases",
  "",
  "Do not touch the migrations and do not change the public API of the search class. Run the test suite before you finish and tell me what you changed in two or three sentences.",
].join("\n");

/** The confirmation the chat raises for "Start a session". `many` gives a project name that matches several folders. */
export function demoAction(now: number, project = "nexa-web", many = true): ActionRequest {
  const options = many ? ["/Users/alex/Projects/nexa-web", "/Users/alex/Work/client-sites/nexa-web", "/Users/alex/Projects/archive/nexa-web-2023"] : [];
  return {
    requestId: `act-${Math.round(now)}`,
    title: "Start a session",
    rows: [
      { label: "Project", value: project },
      { label: "Folder", value: "/Users/alex/Projects/nexa-web" },
      { label: "Model", value: "Sonnet" },
    ],
    body: LONG_PROMPT,
    folder: { path: "/Users/alex/Projects/nexa-web", options },
    host: { value: "background", options: [{ id: "background", label: "Background" }] },
    deadline: now + 110_000,
  };
}

/** A control-mode chat: a session overview, a start the user allowed, a stop the user denied. */
export function demoControlChat(now: number, ready = true): ChatAction[] {
  const at = (s: number) => now - (600 - s) * 1000;
  const ev = (s: number, event: ChatEvent): ChatAction => ({ type: "event", event, at: at(s), viewing: true });
  const tool = (s: number, id: string, callId: string, name: string, label: string, state: "running" | "done" | "denied" | "error"): ChatAction =>
    ev(s, { type: "tool", id, callId, tool: `mcp__buddy__${name}`, label, state });
  const status = { enabled: true, state: "ready" as const, claudeFound: true, provider: "claude" as const, model: "sonnet", webSearch: false, mode: "control" as const, controlReady: ready };
  const first = "Two sessions are working, **bankconnect** waits for a permission.";
  const second = "Started. **nexa-web** runs in the background.";
  const third = "Okay, I left **nexa-web** running.";
  return [
    { type: "status", status, at: at(0) },
    { type: "send", text: "What are my sessions doing?", context: { kind: "overview", label: "All sessions" }, at: at(10) },
    ev(11, { type: "turn", id: "t1" }),
    tool(12, "t1", "c1", "list_sessions", "Looking at your sessions", "done"),
    ev(13, { type: "delta", id: "t1", text: first }),
    ev(14, { type: "done", id: "t1", text: first, durationMs: 2100 }),
    { type: "send", text: "Start a session in nexa-web to fix the inbox search", context: null, at: at(60) },
    ev(61, { type: "turn", id: "t2" }),
    tool(62, "t2", "c2", "list_projects", "Looking at your projects", "done"),
    tool(63, "t2", "c3", "start_session", "Started a session in nexa-web", "done"),
    ev(64, { type: "delta", id: "t2", text: second }),
    ev(65, { type: "done", id: "t2", text: second, durationMs: 11_400 }),
    { type: "send", text: "Stop it again", context: null, at: at(120) },
    ev(121, { type: "turn", id: "t3" }),
    tool(122, "t3", "c4", "stop_session", "Stopping nexa-web", "denied"),
    ev(123, { type: "delta", id: "t3", text: third }),
    ev(124, { type: "done", id: "t3", text: third, durationMs: 6200 }),
  ];
}
