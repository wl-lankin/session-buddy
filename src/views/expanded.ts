// Expanded island: session tabs, header with lines / context / model, the
// account's limits, and three columns of what is happening right now.
// Every row has a fixed height and lives in normal flow: nothing is absolutely
// positioned, so lines can never overlap.

import { h } from "./dom";
import { colorForProject } from "../core/layout";
import { State } from "../core/state";
import type { Limit, Session, Usage } from "../core/types";
import { firstLine, fmtAgo, fmtLines, fmtPct, fmtReset, fmtTokens } from "../model/format";
import { accountLabel, sessionTitle, statusGlyph } from "../model/viewmodel";
import { bar, keyed, statusDot } from "./parts";
import type { ViewActions, ViewHost } from "./views";

const STEP_ROWS = 7;
const AGENT_ROWS = 4;
const BG_ROWS = 2;

const present = (xs: (Node | null | undefined | false)[]): Node[] => xs.filter(Boolean) as Node[];

function tabs(actions: ViewActions, sessions: Session[], focusId: string | null): Node[] {
  return sessions.map((s, i) =>
    h(
      "button",
      {
        class: `tab ${s.status}${s.id === focusId ? " on" : ""}`,
        title: `${i + 1}  ${s.cwd}`,
        onclick: (e: Event) => {
          e.stopPropagation();
          actions.focus(s.id);
        },
      },
      h("span", { class: `sglyph ${s.status}`, style: `--c:${colorForProject(s.project)}`, text: statusGlyph(s.status) }),
      h("span", { class: "tab-name", text: s.project }),
    ),
  );
}

function header(s: Session): Node[] {
  const meta: Node[] = [];
  if (s.stats.linesAdded || s.stats.linesRemoved) {
    meta.push(h("span", { class: "x-lines", text: fmtLines(s.stats.linesAdded, s.stats.linesRemoved) }));
  }
  const pct = s.stats.contextUsedPct;
  if (pct != null) {
    meta.push(
      h(
        "span",
        { class: "x-ctx" },
        h("span", { class: "lbl", text: "ctx " }),
        bar(pct, 70),
        h("span", { text: ` ${fmtPct(pct)}% (${fmtTokens(s.stats.contextTokens)}/${fmtTokens(s.stats.contextSize)})` }),
      ),
    );
  }
  if (s.model) meta.push(h("span", { class: "x-model", text: s.model }));
  return [
    h("div", { class: "x-title" }, statusDot(s), h("span", { class: "x-name", text: sessionTitle(s) }), h("span", { class: "x-cwd", text: s.cwd })),
    h("div", { class: "x-meta" }, ...meta),
  ];
}

function limit(name: string, l: Limit | null, now: number): Node | null {
  if (!l) return null;
  const reset = fmtReset(l.resetsAt, now);
  return h(
    "span",
    { class: "x-limit" },
    h("span", { class: "lbl", text: `${name} ` }),
    bar(l.usedPct, 80),
    h("span", { text: ` ${fmtPct(l.usedPct)}%` }),
    reset ? h("span", { class: "x-reset", text: ` (${reset})` }) : null,
  );
}

function limitsRow(u: Usage, now: number): Node[] {
  if (!u.fiveHour && !u.sevenDay) {
    return [h("span", { class: "x-reset", text: u.error ? `Limits unavailable: ${u.error}` : "Limits n/a" })];
  }
  const stale = u.error && u.updatedAt ? h("span", { class: "x-reset", text: ` updated ${fmtAgo(now - u.updatedAt)}` }) : null;
  return present([limit("5H", u.fiveHour, now), limit("7D", u.sevenDay, now), h("span", { class: "x-account", text: accountLabel(u) }), stale]);
}

function stepsCol(s: Session): Node[] {
  const head = h("div", { class: "x-h", text: "STEPS" });
  const recent = s.steps.slice(-STEP_ROWS);
  if (!recent.length) {
    return [head, h("div", { class: "x-none", text: s.lastPrompt ? "No tool calls yet" : "Waiting for the first prompt" })];
  }
  const last = recent.length - 1;
  return [
    head,
    ...recent.map((st, i) => {
      const current = i === last && st.ok === null && s.status === "working";
      const icon = st.ok === false ? "\u00D7" : st.ok === true ? "\u2713" : current ? "\u203A" : "\u00B7";
      return h(
        "div",
        { class: `x-row${st.ok === false ? " fail" : ""}` },
        h("span", { class: "x-icon", text: icon }),
        h("span", { class: current ? "x-label shimmer" : "x-label", text: st.label }),
      );
    }),
  ];
}

function sideCol(s: Session, now: number): Node[] {
  const out: Node[] = [];
  const running = s.agents.filter((a) => a.running).length;
  const sorted = [...s.agents].sort((a, b) => Number(b.running) - Number(a.running) || b.startedAt - a.startedAt);
  const agents = sorted.slice(0, AGENT_ROWS);
  out.push(h("div", { class: "x-h", text: `AGENTS (${running})` }));
  if (!agents.length) out.push(h("div", { class: "x-none", text: "No sub-agents" }));
  for (const a of agents) {
    const what = a.running
      ? a.currentStep ?? a.description ?? "starting"
      : `${a.description ?? "done"} · ${fmtAgo(now - (a.endedAt ?? now))}`;
    out.push(
      h(
        "div",
        { class: `x-row ${a.running ? "run" : "done"}` },
        h("span", { class: "x-icon", text: a.running ? "\u25CF" : "\u2713" }),
        h("span", { class: "x-atype", text: a.agentType }),
        h("span", { class: "x-label", text: what }),
      ),
    );
  }
  if (sorted.length > agents.length) out.push(h("div", { class: "x-none", text: `+${sorted.length - agents.length} more` }));
  const agentIds = new Set(s.agents.map((a) => a.id));
  const bg = s.background.filter((b) => !agentIds.has(b.id));
  if (bg.length) {
    out.push(h("div", { class: "x-h", text: `BACKGROUND (${bg.length})` }));
    for (const b of bg.slice(0, BG_ROWS)) {
      out.push(
        h(
          "div",
          { class: "x-row run" },
          h("span", { class: "x-icon", text: "\u25CF" }),
          h("span", { class: "x-atype", text: b.kind }),
          h("span", { class: "x-label", text: `${b.description} · ${b.status}` }),
        ),
      );
    }
    if (bg.length > BG_ROWS) out.push(h("div", { class: "x-none", text: `+${bg.length - BG_ROWS} more` }));
  }
  return out;
}

export function buildSessionView(actions: ViewActions): ViewHost {
  const tabsEl = h("div", { class: "x-tabs" });
  const headEl = h("div", { class: "x-head" });
  const limitsEl = h("div", { class: "x-limits" });
  const promptEl = h("div", { class: "x-prompt" });
  const stepsEl = h("div", { class: "x-col x-steps" });
  const sideEl = h("div", { class: "x-col x-side" });
  const el = h("div", { class: "view session-view" }, tabsEl, headEl, limitsEl, promptEl, h("div", { class: "x-body" }, stepsEl, sideEl));

  return {
    el,
    sync() {
      const all = State.sessions;
      const s = State.focus;
      const now = Date.now();
      const minute = Math.floor(now / 60_000);
      keyed(tabsEl, `${all.map((x) => `${x.id}:${x.status}`).join("|")}#${s?.id ?? ""}`, () => tabs(actions, all, s?.id ?? null));
      keyed(limitsEl, JSON.stringify([State.snapshot.usage, minute]), () => limitsRow(State.snapshot.usage, now));
      if (!s) {
        keyed(headEl, "none", () => [h("div", { class: "x-title", text: "No sessions" })]);
        promptEl.textContent = "";
        keyed(stepsEl, "none", () => []);
        keyed(sideEl, "none", () => []);
        return;
      }
      keyed(headEl, JSON.stringify([s.id, s.status, s.branch, s.cwd, s.stats, s.model]), () => header(s));
      promptEl.textContent = s.lastPrompt ? `Prompt: ${firstLine(s.lastPrompt, 140)}` : "";
      keyed(stepsEl, JSON.stringify([s.id, s.status, s.steps.slice(-STEP_ROWS)]), () => stepsCol(s));
      keyed(sideEl, JSON.stringify([s.id, s.agents, s.background, minute]), () => sideCol(s, now));
    },
  };
}
