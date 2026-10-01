// Drives the island with fake sessions: steps keep arriving, answers remove
// their card, the limits block cycles through ok / stale / error every 10 s.
// Finishes: one session at 9 s (single card), three in a row every 20 s (one
// merged card). The waiting cards arrive at 30 s; while they wait, finishes
// only flash and never cover them.

import type { Snapshot } from "../src/core/types";
import { demoSnapshot, demoUsage } from "./fixtures";

async function island(): Promise<NonNullable<Window["__sb"]>> {
  for (;;) {
    if (window.__sb) return window.__sb;
    await new Promise((r) => setTimeout(r, 50));
  }
}

const sb = await island();
const full = demoSnapshot(Date.now());
let snap: Snapshot = { ...full, sessions: full.sessions.map((s) => (s.pending.length ? { ...s, pending: [], status: "working" } : s)) };
const push = () => sb.snapshot({ ...snap, now: Date.now() });
push();

setTimeout(() => {
  const waiting = new Map(full.sessions.filter((s) => s.pending.length).map((s) => [s.id, s]));
  snap = { ...snap, sessions: snap.sessions.map((s) => (waiting.has(s.id) ? { ...s, pending: waiting.get(s.id)!.pending, status: "needs_you" } : s)) };
  push();
}, 30_000);

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
setTimeout(() => sb.cues([{ sessionId: "e", kind: "finish", turnMs: 95_000 }]), 9_000);
setInterval(finishes, 20_000);
