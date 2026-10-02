// The confirmation card for the chat's actions (an ActionRequest has no session):
// what the user chose, the answer sent back, the queue and the keyboard rule. No DOM.

import type { ActionRequest, Interaction, Session } from "../core/types";

/** What the user may change on the card before pressing Allow. */
export interface ActionDraft { folder: string | null; host: string | null }

/** The `answer` payload the backend expects. */
export interface ActionAnswer { allow: boolean; folder?: string; host?: string }

export const initialDraft = (a: ActionRequest): ActionDraft => ({ folder: a.folder?.path ?? null, host: a.host?.value ?? null });

/** A folder from the dialog or the option list; an empty answer (dialog cancelled) changes nothing. */
export function withFolder(d: ActionDraft, path: string | null | undefined): ActionDraft {
  const p = path?.trim();
  return p ? { ...d, folder: p } : d;
}

/** Only a host the request offers can be chosen. */
export function withHost(a: ActionRequest, d: ActionDraft, id: string): ActionDraft {
  return a.host?.options.some((o) => o.id === id) ? { ...d, host: id } : d;
}

/** Deny sends nothing but the verdict; Allow sends the folder and host the card shows. */
export function buildAnswer(a: ActionRequest, d: ActionDraft, allow: boolean): ActionAnswer {
  if (!allow) return { allow: false };
  const out: ActionAnswer = { allow: true };
  if (a.folder && d.folder) out.folder = d.folder;
  if (a.host && d.host) out.host = d.host;
  return out;
}

/** The rows above the prompt; Folder and Runs in have their own editable lines. */
export function visibleRows(a: ActionRequest): { label: string; value: string }[] {
  const own = new Set([...(a.folder ? ["folder"] : []), ...(a.host ? ["runs in", "host"] : [])]);
  return a.rows.filter((r) => !own.has(r.label.trim().toLowerCase()));
}

/** The select is only worth showing with a real choice; one host is just a label. */
export const hostChoice = (a: ActionRequest): boolean => (a.host?.options.length ?? 0) > 1;

export function hostLabel(a: ActionRequest, d: ActionDraft): string {
  const id = d.host ?? a.host?.value;
  return a.host?.options.find((o) => o.id === id)?.label ?? id ?? "";
}

/** The folder options to pick from, without the one already shown. */
export const folderOptions = (a: ActionRequest, d: ActionDraft): string[] => (a.folder?.options ?? []).filter((p) => p !== d.folder);

export type QueueEntry =
  | { kind: "action"; action: ActionRequest }
  | { kind: "session"; session: Session; item: Interaction };

/**
 * Everything waiting for the user in one line. The chat's own requests come first (the user just
 * asked for them), then the sessions' items in their order; the card on screen stays at the head.
 */
export function combinedQueue(actions: ActionRequest[], sessionQueue: { session: Session; item: Interaction }[], shownId: string | null): QueueEntry[] {
  const all: QueueEntry[] = [
    ...actions.map((action): QueueEntry => ({ kind: "action", action })),
    ...sessionQueue.map((q): QueueEntry => ({ kind: "session", ...q })),
  ];
  const idOf = (e: QueueEntry) => (e.kind === "action" ? e.action.requestId : e.item.requestId);
  const i = shownId ? all.findIndex((e) => idOf(e) === shownId) : -1;
  if (i > 0) all.unshift(...all.splice(i, 1));
  return all;
}

/** Ids in `next` that were not there before. */
export const newActionIds = (prev: ActionRequest[], next: ActionRequest[]): string[] => {
  const seen = new Set(prev.map((a) => a.requestId));
  return next.filter((a) => !seen.has(a.requestId)).map((a) => a.requestId);
};

/**
 * Escape denies; Enter never answers by itself (a focused button clicks natively), so a stray Enter
 * while typing elsewhere cannot allow anything. A select keeps its own Escape.
 */
export function actionKey(key: string, targetTag: string): "deny" | null {
  return key === "Escape" && targetTag.toUpperCase() !== "SELECT" ? "deny" : null;
}
