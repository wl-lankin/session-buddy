// Sessions Buddy started itself ("managed"): the marker and the composer drafts. No DOM.

import type { Session } from "../core/types";

export const MANAGED_TITLE = "Started by Buddy";

export const isManaged = (s: Session | null | undefined): boolean => s?.managed === true;

/** Keys the draft text and the error by session, so switching tabs keeps each one's own line. */
export interface WorkerDrafts { text: Map<string, string>; error: Map<string, string> }

export const newDrafts = (): WorkerDrafts => ({ text: new Map(), error: new Map() });

/** Drops the entries of sessions that are gone. */
export function pruneDrafts(d: WorkerDrafts, alive: Session[]) {
  const ids = new Set(alive.map((s) => s.id));
  for (const map of [d.text, d.error]) for (const id of [...map.keys()]) if (!ids.has(id)) map.delete(id);
}
