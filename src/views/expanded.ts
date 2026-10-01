// Expanded island, in blocks: the session tabs on top; below them the session
// (header, prompt, steps and agents) and, on the right, the account's limits.
// Every row has a fixed height and lives in normal flow: nothing is absolutely
// positioned, so lines can never overlap.

import { h } from "./dom";
import { colorForProject } from "../core/layout";
import { State } from "../core/state";
import type { Limit, Session, Usage } from "../core/types";
import { firstLine, fmtAgo, fmtPct, fmtReset, fmtTokens, level } from "../model/format";
import { accountTitle, modelName, recentClass, statusGlyph, tabLabel, TAB_COMPACT_ABOVE } from "../model/viewmodel";
import { bar, keyed, linesChanged, sessionName, statusDot } from "./parts";
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
        class: `tab ${s.status}${recentClass(s)}${s.id === focusId ? " on" : ""}${sessions.length > TAB_COMPACT_ABOVE ? " many" : ""}`,
        title: `${i + 1}  ${s.project}  ${s.cwd}`,
        onclick: (e: Event) => {
          e.stopPropagation();
          actions.focus(s.id);
        },
      },
      h("span", { class: `sglyph ${s.status}`, style: `--c:${colorForProject(s.project)}`, text: statusGlyph(s.status) }),
      h("span", { class: "tab-name", text: tabLabel(s.project, s.id === focusId, sessions.length) }),
    ),
  );
}

function header(s: Session): Node[] {
  const meta: Node[] = [];
  if (s.stats.linesAdded || s.stats.linesRemoved) {
    meta.push(h("span", { class: "x-lines" }, ...linesChanged(s.stats.linesAdded, s.stats.linesRemoved)));
  }
  const pct = s.stats.contextUsedPct;
  if (pct != null) {
    meta.push(
      h(
        "span",
        { class: "x-ctx" },
        h("span", { class: "lbl", text: "ctx " }),
        bar(pct, 70),
        h("span", { text: ` ${fmtPct(pct)}%` }),
        h("span", { class: "x-tokens", text: ` ${fmtTokens(s.stats.contextTokens)}/${fmtTokens(s.stats.contextSize)}` }),
      ),
    );
  }
  return present([
    h(
      "div",
      { class: "x-title" },
      statusDot(s),
      sessionName(s, "x-name"),
      s.model ? h("span", { class: "x-model", text: modelName(s.model) }) : null,
    ),
    h("div", { class: "x-cwd", text: s.cwd, title: s.cwd }),
    meta.length ? h("div", { class: "x-meta" }, ...meta) : null,
  ]);
}

/** Lets an email address break after "@" and ".", never in the middle of a word. */
function breakable(text: string): Node[] {
  return text.split(/(?<=[@.])/).flatMap((part, i) => (i ? [h("wbr"), document.createTextNode(part)] : [document.createTextNode(part)]));
}

function limit(name: string, l: Limit | null, now: number): Node[] {
  if (!l) return [];
  const reset = fmtReset(l.resetsAt, now);
  return present([
    h(
      "div",
      { class: "a-limit" },
      h("span", { class: "a-name", text: name }),
      bar(l.usedPct, 62),
      h("span", { class: `a-pct ${level(l.usedPct)}`, text: `${fmtPct(l.usedPct)}%` }),
    ),
    reset ? h("div", { class: "a-reset", text: `resets ${reset}` }) : null,
  ]);
}

function accountBlock(u: Usage, now: number): Node[] {
  const out: Node[] = [h("div", { class: "x-h", text: "LIMITS" })];
  if (!u.fiveHour && !u.sevenDay) {
    out.push(h("div", { class: "a-na", text: u.error ? "Limits unavailable" : "Limits n/a" }));
    if (u.error) out.push(h("div", { class: "a-error", text: u.error, title: u.error }));
  } else {
    out.push(...limit("5H", u.fiveHour, now), ...limit("7D", u.sevenDay, now));
    if (u.error) {
      const ago = u.updatedAt ? `updated ${fmtAgo(now - u.updatedAt)}` : "not updated";
      out.push(h("div", { class: "a-error", text: ago, title: u.error }));
    }
  }
  const a = u.account;
  if (a?.email || a?.plan) {
    out.push(
      h(
        "div",
        { class: "a-account", title: accountTitle(u) },
        ...present([a.email ? h("div", { class: "a-email" }, ...breakable(a.email)) : null, a.plan ? h("div", { class: "a-plan", text: a.plan }) : null]),
      ),
    );
  }
  return out;
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
  const promptEl = h("div", { class: "x-prompt" });
  const stepsEl = h("div", { class: "x-col x-steps" });
  const sideEl = h("div", { class: "x-col x-side" });
  const accountEl = h("div", { class: "blk x-account" });
  const sessionEl = h("div", { class: "blk x-session" }, headEl, promptEl, h("div", { class: "x-divider" }), h("div", { class: "x-body" }, stepsEl, sideEl));
  const el = h(
    "div",
    { class: "view session-view" },
    h("div", { class: "blk x-tabs-blk" }, tabsEl),
    h("div", { class: "x-main" }, sessionEl, accountEl),
  );

  return {
    el,
    sync() {
      const all = State.sessions;
      const s = State.focus;
      const now = Date.now();
      const minute = Math.floor(now / 60_000);
      keyed(tabsEl, `${all.map((x) => `${x.id}:${x.status}:${x.project}:${x.live}`).join("|")}#${s?.id ?? ""}`, () => tabs(actions, all, s?.id ?? null));
      keyed(accountEl, JSON.stringify([State.snapshot.usage, minute]), () => accountBlock(State.snapshot.usage, now));
      if (!s) {
        keyed(headEl, "none", () => [h("div", { class: "x-title" }, h("span", { class: "x-name", text: "No sessions" }))]);
        keyed(promptEl, "", () => []);
        keyed(stepsEl, "none", () => []);
        keyed(sideEl, "none", () => []);
        return;
      }
      keyed(headEl, JSON.stringify([s.id, s.status, s.project, s.branch, s.cwd, s.stats, s.model]), () => header(s));
      const prompt = s.lastPrompt ? firstLine(s.lastPrompt, 160) : "";
      keyed(promptEl, prompt, () => (prompt ? [h("span", { class: "lbl", text: "Prompt " }), document.createTextNode(prompt)] : []));
      promptEl.title = s.lastPrompt ?? "";
      keyed(stepsEl, JSON.stringify([s.id, s.status, s.steps.slice(-STEP_ROWS)]), () => stepsCol(s));
      keyed(sideEl, JSON.stringify([s.id, s.agents, s.background, minute]), () => sideCol(s, now));
    },
  };
}
