// Drives the island with fake sessions: steps keep arriving, answers remove
// their card, the limits block cycles through ok / stale / error every 10 s.
// Finishes: one session at 9 s (single card), three in a row every 20 s (one
// merged card). A plan (ExitPlanMode, answered only in the terminal) shows from
// 13 s to 19 s. The waiting cards arrive at 30 s; while they wait, finishes
// only flash and never cover them.

import type { SessionMessage as Message, Snapshot } from "../src/core/types";
import { State } from "../src/core/state";
import { demoAction, demoChat, demoControlChat, demoManaged, demoSnapshot, demoUsage } from "./fixtures";

async function island(): Promise<NonNullable<Window["__sb"]>> {
  for (;;) {
    if (window.__sb) return window.__sb;
    await new Promise((r) => setTimeout(r, 50));
  }
}

const sb = await island();
// ?quiet=1 leaves out the plan, the waiting cards and the finishes, so a view can be tried in peace.
const QUIET = new URLSearchParams(location.search).get("quiet") === "1";
const full = demoSnapshot(Date.now());
let snap: Snapshot = { ...full, sessions: full.sessions.map((s) => (s.pending.length ? { ...s, pending: [], status: "working" } : s)) };
const push = () => sb.snapshot({ ...snap, now: Date.now() });
push();

// ?chat=demo starts with a finished conversation; without it the chat is off until the switch is used
// (the bubble button or "/" opens it, the answers come from the scripted fake in src/core/chatfake.ts).
// Session control: ?chat=control (a control conversation), ?chat=empty (a fresh chat), &mode=control, &roots=0|1
// (project folders set up or not), ?action=1|2|single (confirmation cards), ?managed=idle|working (a session Buddy started).
const params = new URLSearchParams(location.search);
const chatParam = params.get("chat");
const control = params.get("mode") === "control" || chatParam === "control";
const roots = chatParam === "control" ? params.get("roots") !== "0" : params.get("roots") === "1";
if (control) State.settings = { ...State.settings, chatMode: "control" };
State.settings = { ...State.settings, chatProjectRoots: roots ? ["/Users/alex/Projects"] : [] };
if (chatParam === "demo") {
  State.settings = { ...State.settings, chatEnabled: true };
  for (const a of demoChat(Date.now())) sb.chat(a);
} else if (chatParam === "control") {
  State.settings = { ...State.settings, chatEnabled: true, chatModel: "sonnet" };
  for (const a of demoControlChat(Date.now(), roots)) sb.chat(a);
} else if (chatParam === "empty") {
  State.settings = { ...State.settings, chatEnabled: true };
  sb.chat({
    type: "status", at: Date.now(),
    status: { enabled: true, state: "ready", claudeFound: true, provider: "claude", model: "haiku", webSearch: !control, mode: control ? "control" : "web", controlReady: roots },
  });
}

const showAction = (project = "nexa-web") => {
  snap = { ...snap, actions: [...snap.actions, demoAction(Date.now() + snap.actions.length, project, params.get("action") !== "single")] };
  push();
};
const actionParam = params.get("action");
if (actionParam) {
  setTimeout(showAction, 800);
  if (actionParam === "2") setTimeout(() => showAction("fetchdocs"), 900);
}
window.addEventListener("sb-fake-start", (e) => showAction((e as CustomEvent<{ project: string }>).detail.project));

const managedParam = params.get("managed");
if (managedParam) snap = { ...snap, sessions: [...snap.sessions, demoManaged(Date.now(), managedParam === "working" ? "working" : "idle")] };
push();

const PLAN = [
  "## Plan: fix the DATEV 409 handling",
  "",
  "1. Treat `KeyConflictFault` as success: the GUID was **already used**.",
  "2. Add a Pest test for the 409 path",
  "   - fake the gateway response",
  "   - assert no retry is queued",
  "",
  "```",
  "php artisan test --filter Datev",
  "```",
].join("\n");
const setPlan = (plan: string | null) => {
  snap = { ...snap, sessions: snap.sessions.map((s) => (s.id === "a" ? { ...s, plan } : s)) };
  push();
};
if (!QUIET) {
  setTimeout(() => setPlan(PLAN), 13_000);
  setTimeout(() => setPlan(null), 19_000);
}

if (!QUIET) setTimeout(() => {
  const waiting = new Map(full.sessions.filter((s) => s.pending.length).map((s) => [s.id, s]));
  snap = { ...snap, sessions: snap.sessions.map((s) => (waiting.has(s.id) ? { ...s, pending: waiting.get(s.id)!.pending, status: "needs_you" } : s)) };
  push();
}, 30_000);

// A plan that can be answered: feedback rejects it, "Approve in terminal" hands it over.
if (!QUIET) setTimeout(() => {
  const item = { kind: "plan" as const, requestId: "r-plan", plan: PLAN, deadline: Date.now() + 9 * 60_000 };
  snap = { ...snap, sessions: snap.sessions.map((s) => (s.id === "a" ? { ...s, plan: PLAN, pending: [item], status: "needs_you" as const } : s)) };
  push();
}, 45_000);

const setManaged = (patch: Partial<Snapshot["sessions"][number]>) => {
  snap = { ...snap, sessions: snap.sessions.map((s) => (s.id === "w1" ? { ...s, ...patch } : s)) };
  push();
};

window.addEventListener("sb-invoke", (e) => {
  const { cmd, args } = (e as CustomEvent<{ cmd: string; args?: { requestId?: string; answer?: { allow?: boolean }; sessionId?: string; messageId?: string; text?: string } }>).detail;
  console.log("[preview]", cmd, JSON.stringify(args));
  if (cmd === "answer" && args?.requestId && snap.actions.some((a) => a.requestId === args.requestId)) {
    const allowed = args.answer?.allow === true;
    snap = { ...snap, actions: snap.actions.filter((a) => a.requestId !== args.requestId) };
    if (allowed && !snap.sessions.some((s) => s.id === "w1")) snap = { ...snap, sessions: [...snap.sessions, demoManaged(Date.now(), "working")] };
    push();
  }
  if (cmd === "session_message_send" && args?.sessionId === "w1") {
    setManaged({ status: "working", statusSince: Date.now() });
    setTimeout(() => setManaged({ status: "idle", statusSince: Date.now(), lastMessage: "Done. I changed the sort order and added a test." }), 4000);
  } else if (cmd === "session_message_send" && args?.sessionId && !/fail/i.test(String(args.text ?? ""))) {
    // Queues the text, then flips it to delivered after a moment, as the hooks would.
    const sessionId = args.sessionId;
    const id = `fake-${Date.now()}`;
    const patch = (fn: (m: Message) => Message) => {
      snap = { ...snap, sessions: snap.sessions.map((s) => (s.id === sessionId ? { ...s, messages: s.messages.map(fn) } : s)) };
      push();
    };
    const queuedAt = Date.now();
    snap = {
      ...snap,
      sessions: snap.sessions.map((s) =>
        s.id === sessionId ? { ...s, messages: [...s.messages, { id, text: String(args.text ?? ""), state: "queued" as const, queuedAt, deliveredAt: null, via: null }].slice(-5) } : s,
      ),
    };
    push();
    setTimeout(() => patch((m) => (m.id === id && m.state === "queued" ? { ...m, state: "delivered", deliveredAt: Date.now(), via: "mid-turn" } : m)), 4000);
  }
  if (cmd === "session_message_cancel" && args?.sessionId) {
    snap = { ...snap, sessions: snap.sessions.map((s) => (s.id === args.sessionId ? { ...s, messages: s.messages.map((m) => (m.id === args.messageId && m.state === "queued" ? { ...m, state: "cancelled" as const } : m)) } : s)) };
    push();
  }
  if (cmd === "worker_stop") {
    snap = { ...snap, sessions: snap.sessions.filter((s) => s.id !== "w1") };
    push();
  }
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

const usageKinds = ["ok", "stale", "error"] as const;
let u = 0;
setInterval(() => {
  u = (u + 1) % usageKinds.length;
  console.log("[preview] limits:", usageKinds[u]);
  snap = { ...snap, usage: demoUsage(Date.now(), usageKinds[u]) };
  push();
}, 10_000);

const finishes = () => {
  sb.cues([{ sessionId: "d", kind: "finish", turnMs: 252_000 }]);
  setTimeout(() => sb.cues([{ sessionId: "e", kind: "finish", turnMs: 3_725_000 }]), 1_500);
  setTimeout(() => sb.cues([{ sessionId: "a", kind: "finish" }]), 3_000);
};
// A single finish first (after the greeting), so the one-session card is visible too.
if (!QUIET) {
  setTimeout(() => sb.cues([{ sessionId: "e", kind: "finish", turnMs: 95_000 }]), 9_000);
  setInterval(finishes, 20_000);
}
