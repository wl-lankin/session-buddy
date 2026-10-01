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
