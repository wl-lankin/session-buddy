// Plan mode: Claude Code asks to approve a plan (ExitPlanMode) in its own
// terminal dialog. The island answers it with feedback (a pending `plan` interaction) or, with
// that off, shows the plan read-only. Pure, no DOM.

import type { Session } from "../core/types";

/** The focused session when it has a plan to show; none while a real interaction waits anywhere. */
export function planSession(sessions: Session[], focusId: string | null): Session | null {
  if (sessions.some((s) => s.pending.length > 0)) return null;
  return sessions.find((s) => s.id === focusId && s.plan != null) ?? null;
}

/** A session whose plan just appeared or changed: the island plays the sound and opens the card once. */
export function newPlan(prev: Session[], next: Session[]): string | null {
  const before = new Map(prev.map((s) => [s.id, s.plan ?? null]));
  return next.find((s) => s.plan != null && before.get(s.id) !== s.plan)?.id ?? null;
}

/** Claude receives at most this much feedback text. */
export const FEEDBACK_MAX = 2000;

/** The trimmed feedback, cut to FEEDBACK_MAX; null while there is nothing to send. */
export function feedbackText(raw: string): string | null {
  const t = raw.trim().slice(0, FEEDBACK_MAX).trimEnd();
  return t ? t : null;
}

/** The answer that rejects the plan and hands the text to Claude. */
export function feedbackAnswer(raw: string): { feedback: string } | null {
  const feedback = feedbackText(raw);
  return feedback ? { feedback } : null;
}

export const TERMINAL_ANSWER = { terminal: true } as const;

/** Cmd/Ctrl+Enter sends; plain Enter (and Shift+Enter) is just a new line. */
export function sendsFeedback(e: { key: string; metaKey: boolean; ctrlKey: boolean }): boolean {
  return e.key === "Enter" && (e.metaKey || e.ctrlKey);
}

/** Which view a plan needs: the answerable card (a pending plan interaction anywhere), the read-only view, or none. */
export function planViewFor(sessions: Session[], focusId: string | null): "interaction" | "readonly" | null {
  if (sessions.some((s) => s.pending.some((p) => p.kind === "plan"))) return "interaction";
  return planSession(sessions, focusId) ? "readonly" : null;
}
