// Island sizing decisions: manual enlarge (grip, button), its automatic reset,
// the auto width of the expanded island and the OS window around it. Pure, no DOM.

import { EXPANDED_W, PANEL_H, PANEL_W } from "../core/layout";

/** Logical size of the screen the island is on. */
export interface Screen { w: number; h: number }

/** A manual height may reach this share of the screen height. */
export const MAX_H_SHARE = 0.8;
/** The enlarge button's reading height, when the screen allows it. */
export const LARGE_H = 640;
/** The auto width never goes past this share of the screen width. */
export const MAX_W_SHARE = 0.7;
/** The account column grows with a long email between these widths. */
export const ACCOUNT_MIN_W = 190;
export const ACCOUNT_MAX_W = 300;
/** No pointer over the island for this long: back to the natural size. */
export const IDLE_RESET_MS = 120_000;
/** Room around the island inside the OS window, and the step the window grows in. */
const PANEL_PAD = 40;
const PANEL_STEP = 40;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Highest manual height: 80 % of the screen, never below the natural height. */
export function maxHeight(natural: number, screen: Screen): number {
  return Math.max(natural, Math.floor(screen.h * MAX_H_SHARE));
}

/** A dragged height, between the view's natural height and 80 % of the screen. */
export function clampHeight(h: number, natural: number, screen: Screen): number {
  return Math.round(clamp(h, natural, maxHeight(natural, screen)));
}

/** The enlarge button's size: 640 px tall, or less on a small screen; never below the natural height. */
export function largeHeight(natural: number, screen: Screen): number {
  return clampHeight(LARGE_H, natural, screen);
}

/** The expanded width: what the untruncatable rows need, at least 920, at most 70 % of the screen. */
export function autoWidth(needed: number[], screen: Screen): number {
  const most = Math.max(EXPANDED_W, Math.floor(screen.w * MAX_W_SHARE));
  const want = Math.ceil(Math.max(EXPANDED_W, ...needed.filter(Number.isFinite)));
  return clamp(want, EXPANDED_W, most);
}

/** The account column: wide enough for the email on one line, within its bounds. */
export function accountWidth(content: number): number {
  return Math.ceil(clamp(content, ACCOUNT_MIN_W, ACCOUNT_MAX_W));
}

/** The OS window for an island of w x h: the default panel, or larger in 40 px steps. */
export function panelFor(w: number, h: number): { w: number; h: number } {
  const fit = (v: number, min: number) => Math.max(min, Math.ceil((v + PANEL_PAD) / PANEL_STEP) * PANEL_STEP);
  return { w: fit(w, PANEL_W), h: fit(h, PANEL_H) };
}

/** What an enlarged island belongs to; when any of it changes, the island goes back to its natural size. */
export interface SizeAnchor {
  /** Focused session. */
  focusId: string | null;
  /** The interaction card on screen, if any. */
  requestId: string | null;
}

export function shouldResetSize(o: {
  anchor: SizeAnchor;
  now: SizeAnchor;
  expanded: boolean;
  lastPointerAt: number;
  nowMs: number;
}): boolean {
  return (
    !o.expanded ||
    o.anchor.focusId !== o.now.focusId ||
    o.anchor.requestId !== o.now.requestId ||
    o.nowMs - o.lastPointerAt >= IDLE_RESET_MS
  );
}
