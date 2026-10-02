// Sessions Buddy started itself ("managed"): the marker and what the prompt line below
// the session header may do. No DOM.

import type { Session } from "../core/types";

export const MANAGED_TITLE = "Started by Buddy";

export const isManaged = (s: Session | null | undefined): boolean => s?.managed === true;

/** The prompt text the backend allows (4000 characters, newlines kept); null when it is empty. */
export const PROMPT_MAX = 4000;
export function cleanPrompt(raw: string): string | null {
  const t = raw.trim();
  return t ? t.slice(0, PROMPT_MAX) : null;
}

export interface WorkerLine {
  /** The prompt line and the Stop button belong to this session. */
  visible: boolean;
  /** The prompt cannot be sent now. */
  disabled: boolean;
  placeholder: string;
  canStop: boolean;
}

const BUSY = "Working... you can send the next prompt when it is done";
const WAITING = "Waiting for your answer above... then you can send the next prompt";

/** One prompt at a time: the line waits while the session works or waits for the user. */
export function workerLine(s: Session | null): WorkerLine {
  if (!s || !isManaged(s)) return { visible: false, disabled: true, placeholder: "", canStop: false };
  const ended = !s.live;
  if (s.status === "working" || s.status === "thinking") return { visible: true, disabled: true, placeholder: BUSY, canStop: true };
  if (s.status === "needs_you") return { visible: true, disabled: true, placeholder: WAITING, canStop: true };
  return {
    visible: true,
    disabled: ended,
    placeholder: ended ? "This session has ended" : "Send a prompt to this session",
    canStop: !ended,
  };
}

/** Keys the draft text and the error by session, so switching tabs keeps each one's own line. */
export interface WorkerDrafts { text: Map<string, string>; error: Map<string, string> }

export const newDrafts = (): WorkerDrafts => ({ text: new Map(), error: new Map() });

/** Drops the entries of sessions that are gone. */
export function pruneDrafts(d: WorkerDrafts, alive: Session[]) {
  const ids = new Set(alive.map((s) => s.id));
  for (const map of [d.text, d.error]) for (const id of [...map.keys()]) if (!ids.has(id)) map.delete(id);
}
