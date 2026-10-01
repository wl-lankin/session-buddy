// Plan mode: Claude Code asks to approve a plan (ExitPlanMode) in its own
// terminal dialog. The island only shows the plan, read-only. Pure, no DOM.

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
