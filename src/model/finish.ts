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
  /** Mochi: proud. */
  emote: boolean;
  /** Mochi: a small jump with the proud face. */
  jump: boolean;
  /** The compact island shows the last message for a while. */
  flash: boolean;
  /** Strip to compact. */
  reveal: boolean;
}

const NOTHING: FinishPlan = { card: false, emote: false, jump: false, flash: false, reveal: false };
/** A short turn, or one that left agents or background tasks running: the sound and a short emote. */
const SHORT: FinishPlan = { card: false, emote: true, jump: false, flash: false, reveal: false };

/** The card is worth showing: nothing is still running and the work took at least `minSeconds`. */
export function cardWorthy(o: { busy: boolean; turnMs: number | null; minSeconds: number }): boolean {
  return !o.busy && o.turnMs != null && o.turnMs >= o.minSeconds * 1000;
}

export function planFinish(o: {
  style: FinishStyle;
  mode: IslandMode;
  view: IslandViewName;
  anyPending: boolean;
  busy: boolean;
  turnMs: number | null;
  minSeconds: number;
}): FinishPlan {
  if (o.style === "off") return NOTHING;
  if (o.style === "animation") return { card: false, emote: true, jump: true, flash: true, reveal: false };
  if (!cardWorthy(o)) return SHORT;
  // Never cover a waiting card, and leave the greeting / confused views alone.
  const card = !o.anyPending && (o.mode !== "expanded" || o.view === "session" || o.view === "finished");
  return { card, emote: true, jump: true, flash: !card, reveal: !card && o.mode === "strip" };
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
