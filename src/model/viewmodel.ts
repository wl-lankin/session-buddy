// Pure functions from sessions to what the island shows. No DOM, no state.

import type { BotStateName } from "../core/layout";
import type { Agent, Extra, Interaction, Question, Session, Status, Usage } from "../core/types";
import { firstLine, fmtAgo, fmtDuration, fmtMoney, fmtPct, level, type Level } from "./format";

export const STATUS_RANK: Record<Status, number> = {
  needs_you: 6, error: 5, working: 4, thinking: 3, finished: 2, idle: 1, stale: 0,
};

export function loudest(sessions: Session[]): Session | null {
  let best: Session | null = null;
  for (const s of sessions) {
    if (!best) { best = s; continue; }
    const d = STATUS_RANK[s.status] - STATUS_RANK[best.status];
    if (d > 0 || (d === 0 && s.lastEventAt > best.lastEventAt)) best = s;
  }
  return best;
}

export interface Summary { total: number; busy: number; needsYou: number }

/** Counts the Claude Code sessions actually running: recent ones from transcripts and stale ones are left out. */
export function summarize(sessions: Session[]): Summary {
  const counted = sessions.filter((s) => s.live && s.status !== "stale");
  return {
    total: counted.length,
    busy: counted.filter((s) => s.status === "working" || s.status === "thinking").length,
    needsYou: counted.filter((s) => s.status === "needs_you").length,
  };
}

export function stripLabel(s: Summary): string {
  if (s.total === 0) return "No sessions";
  const parts = [`${s.total} session${s.total === 1 ? "" : "s"}`];
  if (s.busy) parts.push(`${s.busy} working`);
  if (s.needsYou) parts.push(`${s.needsYou} need${s.needsYou === 1 ? "s" : ""} you`);
  return parts.join(" · ");
}

export function botStateFor(s: Session | null): BotStateName {
  if (!s) return "idle";
  switch (s.status) {
    case "needs_you":
      return s.pending[0]?.kind === "approval" ? "approval" : "question";
    case "error": return "error";
    case "working": return "working";
    case "thinking": return "thinking";
    case "finished": return "finished";
    case "stale": return "sleeping";
    default: return "idle";
  }
}

export function cycle(sessions: Session[], currentId: string | null, dir: 1 | -1): string | null {
  if (sessions.length === 0) return null;
  const i = sessions.findIndex((s) => s.id === currentId);
  if (i < 0) return sessions[0].id;
  return sessions[(i + dir + sessions.length) % sessions.length].id;
}

/**
 * Focus jumps to a session that just started waiting only when nothing was pending before;
 * otherwise the card the user is reading stays and the new item just joins the queue.
 */
export function resolveFocus(prevId: string | null, prev: Session[], next: Session[]): { focusId: string | null; newlyPending: string | null } {
  const before = new Map(prev.map((s) => [s.id, s.pending.length]));
  const anyBefore = prev.some((s) => s.pending.length > 0);
  const newly = anyBefore ? undefined : next.find((s) => s.pending.length > 0 && (before.get(s.id) ?? 0) === 0);
  if (newly) return { focusId: newly.id, newlyPending: newly.id };
  if (prevId && next.some((s) => s.id === prevId)) return { focusId: prevId, newlyPending: null };
  return { focusId: loudest(next)?.id ?? null, newlyPending: null };
}

/**
 * Everything waiting for the user. The card already on screen (`shownId`) stays at the head until it
 * resolves; then the focused session's items, then the other sessions in list order.
 */
export function pendingQueue(sessions: Session[], focusId: string | null, shownId: string | null = null): { session: Session; item: Interaction }[] {
  const ordered = [...sessions].sort((a, b) => (a.id === focusId ? -1 : b.id === focusId ? 1 : 0));
  const queue = ordered.flatMap((session) => session.pending.map((item) => ({ session, item })));
  const i = shownId ? queue.findIndex((q) => q.item.requestId === shownId) : -1;
  if (i > 0) queue.unshift(...queue.splice(i, 1));
  return queue;
}

export const sessionTitle = (s: Session): string => (s.branch ? `${s.project} · ${s.branch}` : s.project);

const STATUS_TEXT: Record<Status, string> = {
  thinking: "thinking", working: "working", needs_you: "needs you", finished: "finished",
  error: "error", idle: "idle", stale: "stale",
};
export const statusText = (s: Session): string => STATUS_TEXT[s.status];

const GLYPHS: Record<Status, string> = {
  thinking: "●", working: "●", needs_you: "!", finished: "✓", error: "×", idle: "○", stale: "◌",
};
export const statusGlyph = (status: Status): string => GLYPHS[status];

export const runningAgents = (s: Session): number => s.agents.filter((a) => a.running).length;

export function statusLine(s: Session, now: number): string {
  const parts = [statusText(s)];
  const agents = runningAgents(s);
  if (agents) parts.push(`${agents} agent${agents === 1 ? "" : "s"}`);
  if (s.status === "working" || s.status === "thinking") parts.push(fmtDuration(now - s.statusSince));
  return parts.join(" · ");
}

export function currentActivity(s: Session): string {
  const p = s.pending[0];
  if (p) {
    if (p.kind === "approval") return `Waiting for you: ${p.target}`;
    if (p.kind === "question") return `Question: ${firstLine(p.questions[0]?.question)}`;
    return `Asked: ${firstLine(p.message)}`;
  }
  switch (s.status) {
    case "working": {
      const running = s.agents.find((a) => a.running && a.currentStep);
      const last = s.steps[s.steps.length - 1];
      return last?.label ?? (running ? `${running.agentType} · ${running.currentStep}` : "");
    }
    case "thinking": return s.lastPrompt ? `Thinking: ${firstLine(s.lastPrompt)}` : "Thinking";
    case "finished":
    case "error": return firstLine(s.lastMessage);
    case "idle": return s.lastPrompt ? `Last: ${firstLine(s.lastPrompt)}` : "";
    case "stale": return "No activity for a while";
    default: return "";
  }
}

export function limitsShort(u: Usage): { text: string; level: Level } {
  const parts: string[] = [];
  let worst = 0;
  if (u.fiveHour) { parts.push(`5H ${fmtPct(u.fiveHour.usedPct)}%`); worst = Math.max(worst, u.fiveHour.usedPct); }
  if (u.sevenDay) { parts.push(`7D ${fmtPct(u.sevenDay.usedPct)}%`); worst = Math.max(worst, u.sevenDay.usedPct); }
  return { text: parts.join(" · "), level: parts.length ? level(worst) : "ok" };
}

/** Visible text of the account label: email and plan only, the org lives in the tooltip. */
export function accountLabel(u: Usage): string {
  const a = u.account;
  if (!a) return "";
  return [a.email, a.plan].filter(Boolean).join(" · ");
}

/** "wolfgang.linz@finodata.de" -> ["wolfgang.linz", "@finodata.de"]: the only place the address may wrap. */
export function emailParts(email: string): [string, string] | null {
  const at = email.indexOf("@");
  return at > 0 ? [email.slice(0, at), email.slice(at)] : null;
}

export function accountTitle(u: Usage): string {
  const a = u.account;
  if (!a) return "";
  return [a.email, a.org, a.plan].filter(Boolean).join(" · ");
}

/** "claude-opus-5-5" -> "Opus 5.5". Display names from the status line pass through untouched. */
export function modelName(raw: string | null): string {
  if (!raw) return "";
  const m = /^claude-([a-z]+)-(\d+(?:-\d{1,2})?)(?:-\d{8})?$/.exec(raw);
  if (!m) return raw;
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2].replace("-", ".")}`;
}

/** Live sessions first, then recent ones seeded from transcripts; each group by start time. */
export function orderSessions(sessions: Session[]): Session[] {
  return [...sessions].sort((a, b) => Number(b.live) - Number(a.live) || a.startedAt - b.startedAt);
}

/**
 * What the tab row, strip dots, compact pager, cycling and number keys show: the live sessions,
 * plus the recent ones (seeded from transcripts) when the "Recent" pill is on. `sessions` comes
 * ordered live first, so the recent ones stay at the end.
 */
export function visibleSessions(sessions: Session[], showRecent: boolean): Session[] {
  return showRecent ? sessions : sessions.filter((s) => s.live);
}

export const recentCount = (sessions: Session[]): number => sessions.filter((s) => !s.live).length;

/** Recent sessions (no event since the app started) are shown dimmed. */
export const recentClass = (s: Session): string => (s.live ? "" : " recent");

/** More sessions than this and inactive tabs get tighter padding; their names shrink to fit the row. */
export const TAB_COMPACT_ABOVE = 5;

/** The agents column: running agents newest first, finished ones newest first. */
export function agentGroups(agents: Agent[]): { running: Agent[]; finished: Agent[] } {
  const newest = (a: Agent, b: Agent) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt) || b.startedAt - a.startedAt;
  return {
    running: agents.filter((a) => a.running).sort((a, b) => b.startedAt - a.startedAt),
    finished: agents.filter((a) => !a.running).sort(newest),
  };
}

/** How many finished agents the unfolded summary lists. */
export const FINISHED_AGENT_ROWS = 5;

/** A finished agent's row: its description, else its type ("agent" only when nothing better is known). */
export function finishedAgentLabel(a: Agent): string {
  const d = a.description?.trim();
  if (d) return a.agentType && a.agentType !== "agent" ? `${a.agentType} · ${d}` : d;
  return a.agentType || "agent";
}

/** AskUserQuestion `answers`: one string per question, multi-select joined with ", ". Null while incomplete. */
export function answersFor(questions: Question[], picks: Record<string, string[]>, other: Record<string, string>): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const q of questions) {
    const labels = picks[q.question] ?? [];
    const typed = other[q.question]?.trim() ?? "";
    let value: string;
    if (q.multiSelect) value = [...labels, ...(typed ? [typed] : [])].join(", ");
    else value = typed || labels[0] || "";
    if (!value) return null;
    out[q.question] = value;
  }
  return out;
}

/** A limit row's colour: the worse of its percentage and the severity the endpoint reported. */
export function rowLevel(pct: number, severity: string | null | undefined): Level {
  const bySeverity: Level = severity === "critical" ? "crit" : severity === "warning" ? "warn" : "ok";
  const byPct = level(pct);
  return byPct === "crit" || bySeverity === "crit" ? "crit" : byPct === "warn" || bySeverity === "warn" ? "warn" : "ok";
}

/** The endpoint data (scoped limits, extra usage) counts as old after this long without an answer. */
export const OAUTH_STALE_MS = 20 * 60_000;

/** A dim note under the scoped and extra rows when the endpoint failed or has not answered for a while. */
export function oauthNote(u: Usage, now: number): { text: string; title: string | null } | null {
  if (!u.extra && !u.limits.some((r) => r.kind === "weekly_scoped")) return null;
  const old = u.oauthUpdatedAt != null && now - u.oauthUpdatedAt > OAUTH_STALE_MS;
  if (!u.oauthError && !old) return null;
  const text = u.oauthUpdatedAt != null ? `updated ${fmtAgo(now - u.oauthUpdatedAt)}` : u.oauthError ?? "not updated";
  return { text, title: u.oauthError };
}

const EXTRA_REASONS: Record<string, string> = { out_of_credits: "no credits", user_disabled: "turned off" };

export type ExtraView =
  | { on: true; text: string; pct: number | null; level: Level }
  | { on: false; reason: string | null };

/** What the "Extra usage" row shows: "€12.40 / €50.00" with a percentage, "€12.40 used" without a limit, or off with a short reason. */
export function extraView(e: Extra, locale?: string): ExtraView {
  if (!e.enabled) return { on: false, reason: e.disabledReason ? (EXTRA_REASONS[e.disabledReason] ?? e.disabledReason.replace(/_/g, " ")) : null };
  const used = fmtMoney(e.usedMinor, e.currency, e.exponent, locale);
  if (e.limitMinor == null) return { on: true, text: `${used} used`, pct: null, level: "ok" };
  const pct = e.percent ?? (e.limitMinor > 0 ? (e.usedMinor * 100) / e.limitMinor : 0);
  return { on: true, text: `${used} / ${fmtMoney(e.limitMinor, e.currency, e.exponent, locale)}`, pct, level: level(pct) };
}
