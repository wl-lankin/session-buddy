// What happens when a session finishes: card, Mochi, flash. Pure, no DOM.

import type { IslandMode, IslandViewName } from "../core/layout";
import { fmtDuration } from "./format";

export type FinishStyle = "card" | "animation" | "off";

/** The finished card stays this long unless the mouse is on it, seconds. */
export const FINISH_CARD_S = 6;

export interface FinishItem {
  sessionId: string;
  project: string;
  /** How long the turn took; null when its start was not seen. */
  turnMs: number | null;
  at: number;
}

/** Finishes while the card is on screen join it (a session finishing again replaces its entry); otherwise a new card starts. */
export function mergeFinish(items: FinishItem[], next: FinishItem, shown: boolean): FinishItem[] {
  if (!shown) return [next];
  return [...items.filter((x) => x.sessionId !== next.sessionId), next];
}

export interface FinishPlan {
  /** Open the expanded island on the finished card. */
  card: boolean;
  /** Mochi: proud plus a small jump. */
  emote: boolean;
  /** The compact island shows the last message for a while. */
  flash: boolean;
  /** Strip to compact. */
  reveal: boolean;
}

export function planFinish(o: { style: FinishStyle; mode: IslandMode; view: IslandViewName; anyPending: boolean }): FinishPlan {
  if (o.style === "off") return { card: false, emote: false, flash: false, reveal: false };
  if (o.style === "animation") return { card: false, emote: true, flash: true, reveal: false };
  // Never cover a waiting card, and leave the greeting / confused views alone.
  const card = !o.anyPending && (o.mode !== "expanded" || o.view === "session" || o.view === "finished");
  return { card, emote: true, flash: !card, reveal: !card && o.mode === "strip" };
}

export function finishTitle(items: FinishItem[]): string {
  if (items.length !== 1) return `${items.length} sessions finished`;
  const [one] = items;
  return one.turnMs == null ? `${one.project} finished` : `${one.project} finished · ${fmtDuration(one.turnMs)}`;
}

/** The first two non-empty lines of Claude's last message. */
export function finishLines(message: string | null | undefined): string {
  if (!message) return "";
  return message
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join("\n");
}
