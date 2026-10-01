// Expanded island, in blocks: the session tabs on top; below them the session
// (header, prompt, steps and agents) and, on the right, the account's limits.
// Every row has a fixed height and lives in normal flow: nothing is absolutely
// positioned, so lines can never overlap. The tab row, the header, the cwd and
// the account never truncate: the island widens for them (needs()).

import { h } from "./dom";
import { colorForProject, VIEW_HEIGHT_SESSION } from "../core/layout";
import { State } from "../core/state";
import type { Extra, LimitRow, Session, Usage } from "../core/types";
import { firstLine, fmtAgo, fmtPct, fmtReset, fmtTokens } from "../model/format";
import { accountTitle, agentGroups, emailParts, extraView, finishedAgentLabel, FINISHED_AGENT_ROWS, modelName, oauthNote, recentClass, recentCount, rowLevel, statusGlyph, TAB_COMPACT_ABOVE } from "../model/viewmodel";
import { accountWidth } from "../model/size";
import { bar, enlargeButton, keyed, linesChanged, rowNatural, sessionName, statusDot } from "./parts";
import type { ViewActions, ViewHost } from "./views";

const STEP_ROWS = 7;
/** Step rows are 20 px; the column's heading takes 18. */
const STEP_ROW_H = 20;
const STEP_HEAD_H = 18;
const AGENT_ROWS = 4;
const BG_ROWS = 2;

const present = (xs: (Node | null | undefined | false)[]): Node[] => xs.filter(Boolean) as Node[];

/** The pill at the end of the tab row that shows or hides the recent sessions. */
function recentPill(actions: ViewActions, count: number, on: boolean): Node {
  return h("button", {
    class: `tab recent-pill${on ? " on" : ""}`,
    title: on ? "Hide the recent sessions" : "Sessions from the last hours that have sent no event yet",
    text: `Recent (${count})`,
    onclick: (e: Event) => {
      e.stopPropagation();
      actions.toggleRecent();
    },
  });
}

function tabs(actions: ViewActions, sessions: Session[], focusId: string | null, recent: number): Node[] {
  const pill = recent ? [recentPill(actions, recent, State.showRecent)] : [];
  return [...tabButtons(actions, sessions, focusId), ...pill];
}

function tabButtons(actions: ViewActions, sessions: Session[], focusId: string | null): Node[] {
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
      h("span", { class: "tab-name", text: s.project }),
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

/** An email address may break only before its "@": "wolfgang.linz" / "@finodata.de". */
function breakable(text: string): Node[] {
  const parts = emailParts(text);
  if (!parts) return [document.createTextNode(text)];
  // A hyphen is a break opportunity too: show it as a non-breaking hyphen (U+2011) so "@" stays the only one.
  const keep = (t: string) => t.replace(/-/g, "\u2011");
  return [h("span", { class: "a-email-part", text: keep(parts[0]) }), h("wbr"), h("span", { class: "a-email-part", text: keep(parts[1]) })];
}

/** One limit row: bar, percentage and the reset time. Scoped rows ("7D Fable") are slightly smaller. */
function limit(row: LimitRow, now: number): Node[] {
  const reset = fmtReset(row.resetsAt, now);
  const scoped = row.kind === "weekly_scoped";
  const lvl = rowLevel(row.usedPct, row.severity);
  return present([
    h(
      "div",
      { class: scoped ? "a-limit scoped" : "a-limit" },
      h("span", { class: "a-name", text: row.label, title: row.label }),
      bar(row.usedPct, 0, lvl),
      h("span", { class: `a-pct ${lvl}`, text: `${fmtPct(row.usedPct)}%` }),
    ),
    reset ? h("div", { class: scoped ? "a-reset scoped" : "a-reset", text: `resets ${reset}` }) : null,
  ]);
}

function extraRow(e: Extra): Node[] {
  const v = extraView(e);
  if (!v.on) {
    const text = v.reason ? `Extra usage off - ${v.reason}` : "Extra usage off";
    return [h("div", { class: "a-extra off", text, title: text })];
  }
  return [
    h(
      "div",
      { class: "a-extra" },
      h("div", { class: "a-extra-head" }, h("span", { class: "a-extra-name", text: "Extra usage" }), v.pct == null ? null : h("span", { class: `a-pct ${v.level}`, text: `${fmtPct(v.pct)}%` })),
      v.pct == null ? null : bar(v.pct, 0, v.level),
      h("div", { class: "a-extra-amt", text: v.text, title: v.text }),
    ),
  ];
}

function accountBlock(u: Usage, now: number): Node[] {
  const out: Node[] = [h("div", { class: "x-h", text: "LIMITS" })];
  if (!u.limits.length && !u.extra) {
    out.push(h("div", { class: "a-na", text: u.error ? "Limits unavailable" : "Limits n/a" }));
    if (u.error) out.push(h("div", { class: "a-error", text: u.error, title: u.error }));
  } else {
    for (const row of u.limits) out.push(...limit(row, now));
    if (u.extra) out.push(...extraRow(u.extra));
    if (u.error) {
      const ago = u.updatedAt ? `updated ${fmtAgo(now - u.updatedAt)}` : "not updated";
      out.push(h("div", { class: "a-error", text: ago, title: u.error }));
    } else {
      // The windows are fine (status line), but the scoped limits and extra usage may be old.
      const note = oauthNote(u, now);
      if (note) out.push(h("div", { class: "a-stale", text: note.text, title: note.title ?? undefined }));
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

function stepsCol(s: Session, rows: number): Node[] {
  const head = h("div", { class: "x-h", text: "STEPS" });
  const recent = s.steps.slice(-rows);
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
        h("span", { class: current ? "x-label shimmer" : "x-label", text: st.label, title: st.label }),
      );
    }),
  ];
}

/** Sessions whose finished agents are unfolded in the agents column. */
const openFinished = new Set<string>();

function sideCol(actions: ViewActions, s: Session, now: number): Node[] {
  const out: Node[] = [];
  const { running, finished } = agentGroups(s.agents);
  out.push(h("div", { class: "x-h", text: `AGENTS (${running.length})` }));
  if (!running.length && !finished.length) out.push(h("div", { class: "x-none", text: "No sub-agents" }));
  for (const a of running.slice(0, AGENT_ROWS)) {
    out.push(
      h(
        "div",
        { class: "x-row run" },
        h("span", { class: "x-icon", text: "\u25CF" }),
        h("span", { class: "x-atype", text: a.agentType }),
        h("span", { class: "x-label", text: a.currentStep ?? a.description ?? "starting", title: a.currentStep ?? a.description ?? undefined }),
      ),
    );
  }
  if (running.length > AGENT_ROWS) out.push(h("div", { class: "x-none", text: `+${running.length - AGENT_ROWS} more running` }));
  if (finished.length) {
    const open = openFinished.has(s.id);
    out.push(
      h(
        "button",
        {
          class: `x-row done x-fold${open ? " open" : ""}`,
          title: open ? "Hide the finished agents" : "Show the last finished agents",
          onclick: (e: Event) => {
            e.stopPropagation();
            if (open) openFinished.delete(s.id);
            else openFinished.add(s.id);
            actions.redraw();
          },
        },
        h("span", { class: "x-icon", text: "\u2713" }),
        h("span", { class: "x-label", text: `${finished.length} finished` }),
        h("span", { class: "x-chev", text: open ? "\u25B4" : "\u25BE" }),
      ),
    );
    if (open) {
      for (const a of finished.slice(0, FINISHED_AGENT_ROWS)) {
        out.push(
          h(
            "div",
            { class: "x-row done x-sub" },
            h("span", { class: "x-label", text: finishedAgentLabel(a) }),
            h("span", { class: "x-ago", text: fmtAgo(now - (a.endedAt ?? now)) }),
          ),
        );
      }
    }
  }
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
          h("span", { class: "x-label", text: `${b.description} · ${b.status}`, title: b.description }),
        ),
      );
    }
    if (bg.length > BG_ROWS) out.push(h("div", { class: "x-none", text: `+${bg.length - BG_ROWS} more` }));
  }
  return out;
}


/** Width of `text` in the font `el` uses. */
let measureCtx: CanvasRenderingContext2D | null = null;
function textWidth(el: HTMLElement, text: string): number {
  measureCtx ??= document.createElement("canvas").getContext("2d");
  if (!measureCtx) return 0;
  measureCtx.font = getComputedStyle(el).font;
  return measureCtx.measureText(text).width;
}

/** The account block's padding and border (10 + 10 + 2) and a pixel of slack. */
const ACCOUNT_CHROME = 23;

export function buildSessionView(actions: ViewActions): ViewHost {
  const tabsEl = h("div", { class: "x-tabs" });
  const enlarge = enlargeButton(() => actions.toggleEnlarge());
  const headEl = h("div", { class: "x-head" });
  const promptEl = h("div", { class: "x-prompt" });
  const answerEl = h("button", {
    class: "x-answer",
    onclick: (e: Event) => {
      e.stopPropagation();
      const id = State.focus?.id ?? null;
      State.answerOpenFor = State.answerOpenFor === id ? null : id;
      actions.redraw();
    },
  });
  const answerFull = h("div", { class: "x-answer-full scrollable" });
  const stepsEl = h("div", { class: "x-col x-steps" });
  const sideEl = h("div", { class: "x-col x-side" });
  const accountEl = h("div", { class: "blk x-account" });
  const sessionEl = h(
    "div",
    { class: "blk x-session" },
    headEl,
    promptEl,
    answerEl,
    answerFull,
    h("div", { class: "x-divider" }),
    h("div", { class: "x-body" }, stepsEl, sideEl),
  );
  const el = h(
    "div",
    { class: "view session-view" },
    h("div", { class: "blk x-tabs-blk" }, tabsEl, enlarge.el),
    h("div", { class: "x-main" }, sessionEl, accountEl),
  );
  let acctW = accountWidth(0);

  /** The account column fits the email (and plan) on one line, up to its maximum. */
  const fitAccount = (u: Usage) => {
    const probe = accountEl.querySelector<HTMLElement>(".a-email") ?? accountEl;
    const texts = [u.account?.email, u.account?.plan].filter((t): t is string => !!t);
    const want = accountWidth(Math.max(0, ...texts.map((t) => textWidth(probe, t))) + ACCOUNT_CHROME);
    if (want !== acctW) {
      acctW = want;
      el.style.setProperty("--acct-w", `${want}px`);
    }
  };

  return {
    el,
    measure() {
      // The fixed rows, plus the unfolded last answer (its max-height caps it unless the island is enlarged).
      if (answerFull.style.display === "none") return VIEW_HEIGHT_SESSION;
      const cs = getComputedStyle(answerFull);
      const margins = parseFloat(cs.marginTop) + parseFloat(cs.marginBottom);
      const cap = parseFloat(cs.maxHeight);
      const natural = answerFull.scrollHeight + 2;
      return VIEW_HEIGHT_SESSION + margins + (Number.isFinite(cap) ? Math.min(natural, cap) : natural);
    },
    needs() {
      const island = el.closest<HTMLElement>("#island");
      const w = island?.offsetWidth ?? 0;
      // While the island is still small (strip, compact) the columns are clamped: no measurement.
      if (w < 480) return [];
      if (!State.focus) return [0];
      const title = headEl.querySelector<HTMLElement>(".x-title");
      const cwd = headEl.querySelector<HTMLElement>(".x-cwd");
      // A wider account column takes its width from the session block.
      const acctDelta = acctW - accountEl.offsetWidth;
      const out = [w + rowNatural(tabsEl, ".tab-name") - tabsEl.clientWidth];
      if (title && title.clientWidth > 0) out.push(w + acctDelta + rowNatural(title, ".sname-project, .branch-name, .x-model") - title.clientWidth);
      // scrollWidth never drops below the box, so the cwd's own text width tells whether it could shrink.
      if (cwd && cwd.clientWidth > 0) out.push(w + acctDelta + Math.ceil(textWidth(cwd, cwd.textContent ?? "")) - cwd.clientWidth);
      return out;
    },
    sync() {
      enlarge.refresh();
      const all = State.sessions;
      const s = State.focus;
      const now = Date.now();
      const minute = Math.floor(now / 60_000);
      const recent = recentCount(State.allSessions);
      keyed(tabsEl, `${all.map((x) => `${x.id}:${x.status}:${x.project}:${x.live}`).join("|")}#${s?.id ?? ""}#${recent}:${State.showRecent}`, () =>
        tabs(actions, all, s?.id ?? null, recent),
      );
      keyed(accountEl, JSON.stringify([State.snapshot.usage, minute]), () => accountBlock(State.snapshot.usage, now));
      fitAccount(State.snapshot.usage);
      // The unfolded answer belongs to one session: it folds when the focus moves on.
      if (State.answerOpenFor && State.answerOpenFor !== s?.id) State.answerOpenFor = null;
      if (!s) {
        const none = State.allSessions.length ? "No live sessions" : "No sessions";
        keyed(headEl, none, () => [h("div", { class: "x-title" }, h("span", { class: "x-name", text: none }))]);
        keyed(promptEl, "", () => []);
        answerEl.style.display = "none";
        answerFull.style.display = "none";
        keyed(stepsEl, "none", () => []);
        keyed(sideEl, "none", () => []);
        return;
      }
      keyed(headEl, JSON.stringify([s.id, s.status, s.project, s.branch, s.cwd, s.stats, s.model]), () => header(s));
      const prompt = s.lastPrompt ? firstLine(s.lastPrompt, 160) : "";
      keyed(promptEl, prompt, () => (prompt ? [h("span", { class: "lbl", text: "Prompt " }), document.createTextNode(prompt)] : []));
      promptEl.title = s.lastPrompt ?? "";

      const message = s.lastMessage?.trim() ?? "";
      const open = message !== "" && State.answerOpenFor === s.id;
      const first = message ? firstLine(message, 200) : "";
      answerEl.style.display = message ? "" : "none";
      answerEl.classList.toggle("open", open);
      answerEl.title = open ? "Fold the last answer" : message;
      keyed(answerEl, `${first}#${open}`, () => [
        h("span", { class: "lbl", text: "Last answer " }),
        h("span", { class: "x-answer-text", text: first }),
        h("span", { class: "x-chev", text: open ? "\u25B4" : "\u25BE" }),
      ]);
      answerFull.style.display = open ? "" : "none";
      const full = open ? message : "";
      if (answerFull.textContent !== full) answerFull.textContent = full;

      // An enlarged island shows more steps instead of empty space.
      const rows = Math.max(STEP_ROWS, Math.floor((stepsEl.clientHeight - STEP_HEAD_H) / STEP_ROW_H));
      keyed(stepsEl, JSON.stringify([s.id, s.status, rows, s.steps.slice(-rows)]), () => stepsCol(s, rows));
      keyed(sideEl, JSON.stringify([s.id, s.agents, s.background, minute, openFinished.has(s.id)]), () => sideCol(actions, s, now));
    },
  };
}
