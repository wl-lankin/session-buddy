// Renders the island in one fixed state for the README screenshots
// (scripts/screenshots.mjs). Pick it with ?state=strip|compact|expanded|approval|
// question|reply|plan|finished|finished-merged. Made-up demo data only. Nothing
// here cycles: the page drives the island once, waits for it to settle and sets
// document.body.dataset.ready = "1".

import "../src/style.css";
import { State } from "../src/core/state";
import type { Interaction, Session, Snapshot, Usage } from "../src/core/types";
import { Island } from "../src/island/island";

// Mochi's blinks and particles use Math.random: seed it so every run draws the same face.
let seed = 7;
Math.random = () => {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};

const NOW = Date.now();
const MIN = 60_000;

const base = (id: string, project: string, p: Partial<Session>): Session => ({
  id, project, cwd: `C:\\Code\\${project}`, branch: null, termProgram: "WarpTerminal", model: "Opus 5.5",
  status: "idle", statusSince: NOW, lastPrompt: null, lastMessage: null, steps: [], agents: [], background: [],
  stats: { linesAdded: 0, linesRemoved: 0, contextUsedPct: 14, contextTokens: 28_000, contextSize: 200_000, costUsd: 0.3 },
  pending: [], startedAt: NOW - 40 * MIN, lastEventAt: NOW, pid: null, live: true, plan: null, ...p,
});

const USAGE: Usage = {
  fiveHour: { usedPct: 38, resetsAt: NOW + 2 * 3600_000 + 14 * MIN },
  sevenDay: { usedPct: 61, resetsAt: NOW + 3 * 24 * 3600_000 },
  limits: [
    { kind: "session", label: "5H", usedPct: 38, resetsAt: NOW + 2 * 3600_000 + 14 * MIN, severity: "normal" },
    { kind: "weekly_all", label: "7D", usedPct: 61, resetsAt: NOW + 3 * 24 * 3600_000, severity: "normal" },
    { kind: "weekly_scoped", label: "7D Fable", usedPct: 17, resetsAt: NOW + 3 * 24 * 3600_000, severity: "normal" },
  ],
  extra: { enabled: true, usedMinor: 1240, limitMinor: 5000, currency: "EUR", exponent: 2, disabledReason: null, percent: 24.8 },
  source: "statusline",
  updatedAt: NOW,
  error: null,
  account: { email: "alex.morgan@example.com", org: null, plan: "Max" },
};

function sessions(): Session[] {
  return [
    base("shop", "shop-api", {
      branch: "retry-hooks", status: "working", statusSince: NOW - 3 * MIN - 12_000,
      lastPrompt: "retry failed payment webhooks with backoff",
      lastMessage: "Retries now back off after 1, 5 and 30 minutes and give up after the third attempt.\nThe webhook test still fails: it needs a fake clock.",
      steps: [
        { tool: "Read", label: "Read · WebhookController.ts", at: NOW - 50_000, ok: true },
        { tool: "Grep", label: "Search · retryPolicy", at: NOW - 40_000, ok: true },
        { tool: "Edit", label: "Edit · webhooks/retry.ts", at: NOW - 30_000, ok: true },
        { tool: "Bash", label: "Run · npm test -- webhooks", at: NOW - 20_000, ok: false },
        { tool: "Edit", label: "Edit · webhooks/retry.ts", at: NOW - 5_000, ok: null },
      ],
      agents: [
        { id: "ag1", agentType: "Explore", description: "Find webhook callers", running: true, currentStep: "Search · onPaymentFailed", startedAt: NOW - 90_000, endedAt: null },
        { id: "ag2", agentType: "Plan", description: "Plan the retry queue", running: false, currentStep: null, startedAt: NOW - 8 * MIN, endedAt: NOW - 5 * MIN },
        { id: "ag3", agentType: "Explore", description: "Map the webhook routes", running: false, currentStep: null, startedAt: NOW - 12 * MIN, endedAt: NOW - 10 * MIN },
        { id: "ag4", agentType: "general-purpose", description: null, running: false, currentStep: null, startedAt: NOW - 14 * MIN, endedAt: NOW - 13 * MIN },
      ],
      background: [{ id: "bg1", kind: "bash", status: "running", description: "npm run dev", agentType: null }],
      stats: { linesAdded: 142, linesRemoved: 37, contextUsedPct: 46, contextTokens: 92_000, contextSize: 200_000, costUsd: 1.6 },
    }),
    base("billing", "billing-ui", {
      branch: "fix/invoice-totals", status: "thinking", statusSince: NOW - 40_000,
      lastPrompt: "the invoice total rounds the tax twice, fix it",
      steps: [{ tool: "Read", label: "Read · InvoiceTotal.vue", at: NOW - 30_000, ok: true }],
      stats: { linesAdded: 8, linesRemoved: 5, contextUsedPct: 22, contextTokens: 44_000, contextSize: 200_000, costUsd: 0.5 },
    }),
    base("docs", "docs-site", {
      branch: "main", status: "idle", statusSince: NOW - 12 * MIN,
      lastPrompt: "add a getting started page",
      lastMessage: "Added docs/getting-started.md and linked it from the sidebar.\nThe build passes.",
      stats: { linesAdded: 96, linesRemoved: 2, contextUsedPct: 18, contextTokens: 36_000, contextSize: 200_000, costUsd: 0.4 },
    }),
    base("mobile", "mobile-app", {
      branch: "feat/dark-mode", status: "working", statusSince: NOW - 9 * MIN, model: "Sonnet 5",
      lastPrompt: "add a dark mode toggle to the profile screen",
      steps: [{ tool: "Edit", label: "Edit · ProfileScreen.tsx", at: NOW - 10_000, ok: null }],
      stats: { linesAdded: 61, linesRemoved: 12, contextUsedPct: 33, contextTokens: 66_000, contextSize: 200_000, costUsd: 0.9 },
    }),
    // Seen only in transcripts since the start: hidden behind the "Recent" pill.
    base("old-api", "api-gateway", { live: false, status: "idle", startedAt: NOW - 90 * MIN, lastPrompt: "bump the rate limiter" }),
    base("old-infra", "infra", { live: false, status: "stale", startedAt: NOW - 100 * MIN }),
  ];
}

const APPROVAL: Interaction = {
  kind: "approval", requestId: "r-approval", tool: "Bash", target: "Bash · npm run db:migrate -- --env=staging", agentId: null, deadline: NOW + 110_000,
};
const QUESTION: Interaction = {
  kind: "question", requestId: "r-question", deadline: NOW + 9 * MIN,
  questions: [
    { question: "Where should failed webhooks be retried?", header: "Queue", options: [
      { label: "In-process", description: "Simple, lost on restart" },
      { label: "Redis queue", description: "Survives restarts, needs Redis" },
      { label: "Database table", description: "No new service, polled every 10 s" },
    ] },
    { question: "Which checks should run before the PR?", header: "Checks", multiSelect: true, options: [{ label: "Unit tests" }, { label: "Lint" }, { label: "Type check" }] },
  ],
};
const REPLY: Interaction = {
  kind: "reply", requestId: "r-reply", deadline: NOW + 9 * MIN,
  message: "The tax is rounded once per line and again on the total. Should the total keep the per-line rounding (matches the PDF) or round only once at the end?",
};
const PLAN = [
  "## Plan: retry failed payment webhooks",
  "",
  "1. Add a `webhook_retries` table with the **next attempt** time",
  "2. Back off exponentially: 1 min, 5 min, 30 min, then give up",
  "   - log the final failure with the event id",
  "   - alert when more than 20 events wait",
  "3. Cover the retry path with unit tests",
  "",
  "```",
  "npm test -- webhooks",
  "```",
].join("\n");

const snap = (list: Session[]): Snapshot => ({ sessions: list, usage: USAGE, now: NOW });
const withSession = (list: Session[], id: string, p: Partial<Session>) => list.map((s) => (s.id === id ? { ...s, ...p } : s));
const frames = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function run() {
  const root = document.getElementById("root");
  if (!root) return;
  // Long timers so nothing closes or shrinks while the screenshot is taken.
  State.settings = { ...State.settings, soundEnabled: false, autoCloseInterval: 3600, compactInterval: 3600 };
  const island = new Island(root);
  island.applySettings();
  // Mochi looks down towards the content instead of at the top-left corner.
  State.mouse = { x: 300, y: 260 };

  const state = new URLSearchParams(location.search).get("state") ?? "expanded";
  const list = sessions();
  switch (state) {
    case "strip":
      // A session that waits for the user, without a card (that would open the island).
      island.onSnapshot(snap(withSession(list, "docs", { status: "needs_you" })));
      break;
    case "compact":
      island.onSnapshot(snap(list));
      island.fsm.reveal();
      break;
    case "expanded":
      island.onSnapshot(snap(list));
      island.open();
      break;
    case "approval":
    case "question":
    case "reply": {
      const [id, item] = state === "approval" ? ["shop", APPROVAL] as const : state === "question" ? ["shop", QUESTION] as const : ["billing", REPLY] as const;
      island.onSnapshot(snap(list));
      island.onSnapshot(snap(withSession(list, id, { status: "needs_you", pending: [item] })));
      break;
    }
    case "plan":
      island.onSnapshot(snap(list));
      island.onSnapshot(snap(withSession(list, "shop", { plan: PLAN })));
      break;
    case "finished":
    case "finished-merged": {
      let done = withSession(list, "docs", { status: "finished" });
      done = withSession(done, "billing", { status: "finished", lastMessage: "Fixed: tax is now rounded once, on the total.\nAll 48 tests pass." });
      done = withSession(done, "mobile", { status: "finished", lastMessage: "The profile screen has a dark mode toggle now." });
      island.onSnapshot(snap(done));
      // The cursor rests on the card, so the finished card does not count down.
      island.onCursor(560, 120);
      State.mouse = { x: 300, y: 260 };
      island.onCues(
        state === "finished"
          ? [{ sessionId: "docs", kind: "finish", turnMs: 4 * MIN + 12_000 }]
          : [
              { sessionId: "docs", kind: "finish", turnMs: 4 * MIN + 12_000 },
              { sessionId: "billing", kind: "finish", turnMs: 95_000 },
              { sessionId: "mobile", kind: "finish", turnMs: 61 * MIN },
            ],
      );
      break;
    }
  }

  await document.fonts.ready;
  // Let the springs settle (and the celebration jump land) before the picture is taken.
  await sleep(1600);
  await frames();
  document.body.dataset.ready = "1";
}

void run();
