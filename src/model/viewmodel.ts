// Pure functions from sessions to what the island shows. No DOM, no state.

import type { BotStateName } from "../core/layout";
import type { Interaction, Question, Session, Status, Usage } from "../core/types";
import { firstLine, fmtDuration, fmtPct, level, type Level } from "./format";

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

export function summarize(sessions: Session[]): Summary {
  return {
    total: sessions.length,
    busy: sessions.filter((s) => s.status === "working" || s.status === "thinking").length,
    needsYou: sessions.filter((s) => s.status === "needs_you").length,
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

export function resolveFocus(prevId: string | null, prev: Session[], next: Session[]): { focusId: string | null; newlyPending: string | null } {
  const before = new Map(prev.map((s) => [s.id, s.pending.length]));
  const newly = next.find((s) => s.pending.length > 0 && (before.get(s.id) ?? 0) === 0);
  if (newly) return { focusId: newly.id, newlyPending: newly.id };
  if (prevId && next.some((s) => s.id === prevId)) return { focusId: prevId, newlyPending: null };
  return { focusId: loudest(next)?.id ?? null, newlyPending: null };
}

export function pendingQueue(sessions: Session[], focusId: string | null): { session: Session; item: Interaction }[] {
  const ordered = [...sessions].sort((a, b) => (a.id === focusId ? -1 : b.id === focusId ? 1 : 0));
  return ordered.flatMap((session) => session.pending.map((item) => ({ session, item })));
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

export function accountLabel(u: Usage): string {
  const a = u.account;
  if (!a) return "";
  return [a.email, a.org, a.plan].filter(Boolean).join(" · ");
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
