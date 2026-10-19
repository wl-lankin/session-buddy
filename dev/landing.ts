// The demo on wolfgang-linz.de/session-buddy: the real island over a terminal with four
// Claude Code sessions. One asks for a permission, one asks a question, one ends its turn
// with a question, one finishes. Each waits for the visitor, on the island or in the
// terminal, like in the app; then the story starts over. Silent: no sounds are loaded.
// Build with `npm run landing`.

import "../src/style.css";
import "./landing.css";
import { Island } from "../src/island/island";
import { State } from "../src/core/state";
import type { Cue, Interaction, Session, Snapshot, Step } from "../src/core/types";
import { demoUsage } from "./fixtures";

type Id = "inkwell" | "orbo" | "portfolio" | "cubory";
type Item =
  | { step: [tool: string, label: string, term: string] }
  | { ask: (now: number) => Interaction }
  | { gate: string }
  | { flag: string }
  | { finish: string; turnMs: number };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TICK = 1400;

const PROMPTS: Record<Id, string> = {
  inkwell: "add a reading-time badge to the status bar",
  orbo: "build the 1.1 release",
  portfolio: "add a page for Session Buddy",
  cubory: "fix the STEP import for Windows paths",
};

const SCRIPT: Record<Id, Item[]> = {
  orbo: [
    { step: ["Edit", "Edit · tauri.conf.json", "⏺ Update(tauri.conf.json)\n  ⎿  version 1.0.0 → 1.1.0"] },
    {
      ask: (now) => ({ kind: "approval", requestId: `orbo-${now}`, tool: "Bash", target: "Bash · cargo build --release", agentId: null, deadline: now + 110_000 }),
    },
    { step: ["Bash", "Run · cargo build --release", "⏺ Bash(cargo build --release)\n  ⎿  <span class=ok>Finished</span> release [optimized] in 41.2s"] },
    { step: ["Bash", "Run · npm run tauri build", "⏺ Bash(npm run tauri build)\n  ⎿  Bundling Orbo_1.1.0_universal.dmg"] },
    { flag: "orbo" },
    { step: ["Write", "Write · CHANGELOG.md", "⏺ Write(CHANGELOG.md)\n  ⎿  Wrote 18 lines"] },
  ],
  portfolio: [
    { step: ["Read", "Read · index.html", "⏺ Read(index.html)\n  ⎿  Read 803 lines"] },
    { step: ["Read", "Read · orbo/index.html", "⏺ Read(orbo/index.html)\n  ⎿  Read 229 lines"] },
    { gate: "orbo" },
    {
      ask: (now) => ({
        kind: "question", requestId: `portfolio-${now}`, deadline: now + 540_000,
        questions: [{
          question: "How should the page show the island?", header: "Hero",
          options: [
            { label: "Live demo", description: "The real island, clickable" },
            { label: "Screenshots", description: "Static images of each view" },
          ],
        }],
      }),
    },
    { step: ["Write", "Write · session-buddy/index.html", "⏺ Write(session-buddy/index.html)\n  ⎿  Wrote 214 lines"] },
    { flag: "portfolio" },
    { step: ["Edit", "Edit · sitemap.xml", "⏺ Update(sitemap.xml)\n  ⎿  Added 1 url"] },
  ],
  cubory: [
    { step: ["Grep", "Search · normalize_path", "⏺ Search(pattern: \"normalize_path\")\n  ⎿  Found 6 files"] },
    { step: ["Edit", "Edit · import/step.rs", "⏺ Update(src/import/step.rs)\n  ⎿  Updated with 9 additions and 3 removals"] },
    { step: ["Bash", "Run · cargo test", "⏺ Bash(cargo test)\n  ⎿  <span class=ok>test result: ok.</span> 214 passed"] },
    { gate: "portfolio" },
    { ask: (now) => ({ kind: "reply", requestId: `cubory-${now}`, message: "All 214 tests pass. Shall I open the PR?", deadline: now + 540_000 }) },
    { step: ["Bash", "Run · gh pr create", "⏺ Bash(gh pr create --fill)\n  ⎿  <span class=cy>github.com/wl-lankin/cubory/pull/88</span>"] },
    { flag: "cubory" },
  ],
  inkwell: [
    { step: ["Read", "Read · app.js", "⏺ Read(app.js)\n  ⎿  Read 812 lines"] },
    { step: ["Grep", "Search · wordCount", "⏺ Search(pattern: \"wordCount\")\n  ⎿  Found 3 files"] },
    { step: ["Edit", "Edit · app.js", "⏺ Update(app.js)\n  ⎿  Updated app.js with 14 additions"] },
    { step: ["Edit", "Edit · styles.css", "⏺ Update(styles.css)\n  ⎿  Updated styles.css with 6 additions"] },
    { step: ["Bash", "Run · npm test", "⏺ Bash(npm test)\n  ⎿  <span class=ok>✓ 48 passed</span>"] },
    { gate: "cubory" },
    { finish: "Done. The status bar now shows the reading time next to the word count.", turnMs: 252_000 },
  ],
};

const ORDER: Id[] = ["inkwell", "orbo", "portfolio", "cubory"];
const BRANCH: Record<Id, string> = { inkwell: "main", orbo: "release/1.1", portfolio: "session-buddy-page", cubory: "fix/step-paths" };

interface Run { session: Session; pos: number; lines: string[]; waiting: Interaction | null; released: boolean }
let runs = {} as Record<Id, Run>;
let flags = new Set<string>();
let active: Id = "inkwell";
let island: Island;

function fresh(id: Id, now: number): Run {
  const session: Session = {
    id, project: id, cwd: `/Users/wolfgang/Projects/${id}`, branch: BRANCH[id], termProgram: "Terminal",
    model: id === "portfolio" ? "Sonnet 5.5" : "Opus 5.5", status: id === "portfolio" ? "thinking" : "working",
    statusSince: now - (40 + ORDER.indexOf(id) * 70) * 1000, lastPrompt: PROMPTS[id], lastMessage: null, steps: [], agents: [], background: [],
    stats: { linesAdded: 0, linesRemoved: 0, contextUsedPct: 18 + ORDER.indexOf(id) * 9, contextTokens: 40_000, contextSize: 200_000, costUsd: 0.4 },
    pending: [], startedAt: now, lastEventAt: now, pid: null, live: true, plan: null, managed: false, messages: [],
  };
  if (id === "inkwell") session.agents = [{ id: "ag1", agentType: "Explore", description: "Find the status bar", running: true, currentStep: "Search · statusbar", startedAt: now, endedAt: null }];
  if (id === "orbo") session.background = [{ id: "bg1", kind: "bash", status: "running", description: "cargo watch", agentType: null }];
  const welcome = `<span class=acc>✻</span> Welcome to <b>Claude Code</b>\n  <span class=mut>cwd: ~/Projects/${id}</span>\n `;
  return { session, pos: 0, lines: [welcome, `<span class=mut>&gt;</span> <span class=you>${esc(PROMPTS[id])}</span>`], waiting: null, released: false };
}

function snapshot(): Snapshot {
  const now = Date.now();
  return { now, actions: [], usage: { ...demoUsage(now, "ok"), account: { email: "you@example.com", org: null, plan: "Max" } }, sessions: ORDER.map((id) => runs[id].session) };
}
const push = () => island.onSnapshot(snapshot());
const cue = (c: Cue) => island.onCues([c]);
const tell = (msg: Record<string, unknown>) => parent !== window && parent.postMessage({ sb: true, ...msg }, "*");

/* ---------- the terminal behind the island ---------- */
const tabsEl = document.getElementById("termTabs")!;
const bodyEl = document.getElementById("termBody")!;

function renderTerm() {
  tabsEl.innerHTML = ORDER.map((id) => {
    const s = runs[id].session;
    return `<button class="term-tab${id === active ? " on" : ""}" data-id="${id}"><span class="dot ${s.status}"></span>${id}</button>`;
  }).join("");
  const r = runs[active];
  const busy = r.session.status === "working" || r.session.status === "thinking";
  bodyEl.innerHTML = r.lines.slice(-14).map((l) => `<div class="ln">${l}</div>`).join("")
    + (r.waiting ? box(active, r.waiting) : "")
    + (busy && !r.waiting ? `<div class="ln spin"><span class=acc>✻</span> <span class=mut>${r.session.status === "thinking" ? "Thinking" : "Working"}… (esc to interrupt)</span></div>` : "")
    + (!busy && !r.waiting ? `<div class="ln prompt">&gt; <span class=mut>▍</span></div>` : "");
}

// Claude Code's own prompt for the waiting interaction, answerable right here, as in the real terminal.
function box(id: Id, it: Interaction): string {
  if (it.kind === "approval") {
    return `<div class="box"><b>Bash command</b><div class="q">  ${esc(it.target.replace(/^Bash · /, ""))}</div>Do you want to proceed?
      <button class="sel" data-a="allow" data-id="${id}">1. Yes</button><button data-a="deny" data-id="${id}">2. No, and tell Claude what to do differently</button></div>`;
  }
  if (it.kind === "question") {
    const q = it.questions[0];
    return `<div class="box"><b>${esc(q.header ?? "Question")}</b><div class="q">${esc(q.question)}</div>
      ${q.options.map((o, i) => `<button class="${i ? "" : "sel"}" data-a="pick:${esc(o.label)}" data-id="${id}">${i + 1}. ${esc(o.label)}</button>`).join("")}</div>`;
  }
  if (it.kind === "reply") {
    return `<div class="ln">⏺ ${esc(it.message)}</div><div class="box"><button class="sel" data-a="reply:Yes, open it" data-id="${id}">Yes, open it</button><button data-a="reply:Not yet" data-id="${id}">Not yet</button><div class="hint">Type a reply, or answer on the island.</div></div>`;
  }
  return "";
}

tabsEl.addEventListener("click", (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>(".term-tab");
  if (!t) return;
  active = t.dataset.id as Id;
  renderTerm();
});
bodyEl.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("button[data-a]");
  if (!b) return;
  const id = b.dataset.id as Id;
  const a = b.dataset.a!;
  const answer = a === "allow" ? { behavior: "allow" } : a === "deny" ? { behavior: "deny" }
    : a.startsWith("pick:") ? { answers: { q: a.slice(5) } } : { reply: a.slice(6) };
  settle(id, answer, "terminal");
});

/* ---------- answers ---------- */

function settle(id: Id, answer: unknown, via: "island" | "terminal") {
  const r = runs[id];
  const it = r.waiting;
  if (!it) return;
  r.waiting = null;
  r.released = false;
  r.session = { ...r.session, pending: [], status: "working", statusSince: Date.now() };
  const where = via === "island" ? "<span class=cy>from Session Buddy</span>" : "in the terminal";
  const a = (answer ?? {}) as { behavior?: string; answers?: Record<string, string>; reply?: string };
  if (it.kind === "approval") r.lines.push(a.behavior === "deny" ? `  ⎿  <span class=bad>Denied</span> ${where}` : `  ⎿  <span class=ok>Allowed</span> ${where}`);
  if (it.kind === "question") r.lines.push(`  ⎿  Answered ${where}: <span class=you>${esc(Object.values(a.answers ?? {}).join(", ") || "…")}</span>`);
  if (it.kind === "reply") r.lines.push(`<span class=mut>&gt;</span> <span class=you>${esc(a.reply || "…")}</span> <span class=mut>(${via === "island" ? "from Session Buddy" : "typed"})</span>`);
  push();
  renderTerm();
  tell({ event: "answered", id, via });
}

window.addEventListener("sb-invoke", (e) => {
  const { cmd, args } = (e as CustomEvent<{ cmd: string; args?: { requestId?: string; answer?: unknown; sessionId?: string } }>).detail;
  const byRequest = (rid?: string) => ORDER.find((id) => runs[id].waiting?.requestId === rid);
  if (cmd === "answer") {
    const id = byRequest(args?.requestId);
    if (id) settle(id, args?.answer, "island");
  } else if (cmd === "release") {
    // "Answer in terminal": the island lets go, the terminal tab comes to the front and keeps the prompt.
    const id = byRequest(args?.requestId);
    if (!id) return;
    runs[id].released = true;
    runs[id].session = { ...runs[id].session, pending: [] };
    active = id;
    push();
    renderTerm();
  } else if (cmd === "set_island_rect") {
    // The page around the iframe only lets the island and the terminal take the pointer.
    const r = args as unknown as { x: number; y: number; width: number; height: number };
    island_rect = { x: r.x, y: r.y, w: r.width, h: r.height };
    tellRects();
  } else if (cmd === "focus_terminal" && args?.sessionId && args.sessionId in runs) {
    active = args.sessionId as Id;
    renderTerm();
  }
});

let island_rect = { x: 0, y: 0, w: 0, h: 0 };
function tellRects() {
  const t = document.getElementById("term")!.getBoundingClientRect();
  tell({ event: "rects", island: island_rect, term: { x: t.x, y: t.y, w: t.width, h: t.height } });
}
window.addEventListener("resize", tellRects);

/* ---------- the story ---------- */
async function advance(id: Id) {
  const r = runs[id];
  const item = SCRIPT[id][r.pos];
  if (!item || r.waiting) return;
  if ("gate" in item) {
    if (!flags.has(item.gate)) return;
    r.pos++;
    return advance(id);
  }
  r.pos++;
  const now = Date.now();
  if ("flag" in item) {
    flags.add(item.flag);
    return advance(id);
  }
  if ("step" in item) {
    const [tool, label, term] = item.step;
    const steps: Step[] = [...r.session.steps.map((s) => (s.ok === null ? { ...s, ok: true } : s)), { tool, label, at: now, ok: null }].slice(-30);
    const add = tool === "Edit" || tool === "Write" ? 6 + Math.round(Math.random() * 18) : 0;
    r.session = {
      ...r.session, status: "working", steps, lastEventAt: now,
      stats: { ...r.session.stats, linesAdded: r.session.stats.linesAdded + add, linesRemoved: r.session.stats.linesRemoved + (add ? 2 : 0), contextUsedPct: Math.min(88, (r.session.stats.contextUsedPct ?? 0) + 2) },
    };
    r.lines.push(term);
  } else if ("ask" in item) {
    const it = item.ask(now);
    r.waiting = it;
    r.session = { ...r.session, steps: r.session.steps.map((s) => (s.ok === null ? { ...s, ok: true } : s)), pending: [it], status: "needs_you", statusSince: now };
    cue({ sessionId: id, kind: "approval" });
    tell({ event: "waiting", id, kind: it.kind });
  } else if ("finish" in item) {
    r.session = { ...r.session, status: "finished", statusSince: now, lastMessage: item.finish, steps: r.session.steps.map((s) => (s.ok === null ? { ...s, ok: true } : s)), agents: r.session.agents.map((a) => ({ ...a, running: false, endedAt: now })) };
    r.lines.push(`⏺ ${esc(item.finish)}`);
    push();
    cue({ sessionId: id, kind: "finish", turnMs: item.turnMs });
    tell({ event: "finished", id });
    flags.add("done");
  }
  push();
}

async function story() {
  for (;;) {
    const now = Date.now();
    runs = Object.fromEntries(ORDER.map((id) => [id, fresh(id, now)])) as Record<Id, Run>;
    flags = new Set();
    active = "inkwell";
    push();
    renderTerm();
    tell({ event: "start" });
    while (!flags.has("done")) {
      await wait(TICK);
      // Every session takes one step per beat, slightly apart, so the island shows a steady trickle.
      for (const id of ORDER) {
        await advance(id);
        renderTerm();
        await wait(260);
      }
      // Sessions that finished their part go idle after a while, like real ones between prompts.
      for (const x of ORDER) {
        const r = runs[x];
        if (r.pos >= SCRIPT[x].length && !r.waiting && r.session.status === "working" && Date.now() - r.session.lastEventAt > 6000) {
          r.session = { ...r.session, status: "idle", statusSince: Date.now(), steps: r.session.steps.map((s) => (s.ok === null ? { ...s, ok: true } : s)) };
          push();
        }
      }
      renderTerm();
    }
    await wait(22_000);
  }
}

/* ---------- boot ---------- */
State.settings = { ...State.settings, soundEnabled: false, updateCheck: false, chatEnabled: false, finishMinSeconds: 30 };
const root = document.getElementById("root")!;
island = new Island(root);
island.applySettings();
runs = Object.fromEntries(ORDER.map((id) => [id, fresh(id, Date.now())])) as Record<Id, Run>;
push();
renderTerm();
island.launch();
// The island only hears mousemove: leaving the iframe must read as leaving the island.
document.documentElement.addEventListener("mouseleave", () => window.dispatchEvent(new MouseEvent("mousemove", { clientX: -999, clientY: -999 })));
void wait(4200).then(story);
