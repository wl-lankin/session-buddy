// Messages to a session (session-messages-design.md): what the composer says about delivery,
// which message rows show under it, and the snapshot diff that tells a delivery. No DOM.

import type { Session, SessionMessage } from "../core/types";
import { isManaged } from "./managed";

export const MESSAGE_MAX = 4000;
/** The last delivered message stays visible this long. */
export const DELIVERED_SHOW_MS = 2 * 60_000;
/** The composer grows to this many lines, then scrolls. */
export const COMPOSER_MAX_LINES = 4;

export type MessageCheck = { ok: true; text: string } | { ok: false; error: string };

/** Empty and too long text is refused here; a long text is never cut silently. */
export function checkMessage(raw: string): MessageCheck {
  const text = raw.trim();
  if (!text) return { ok: false, error: "Nothing to send" };
  if (text.length > MESSAGE_MAX) return { ok: false, error: `Too long: ${text.length} of ${MESSAGE_MAX} characters` };
  return { ok: true, text };
}

export interface Composer {
  disabled: boolean;
  /** The line under the composer: the delivery mode, or why the composer waits. */
  helper: string;
  /** The Stop button belongs to the session (managed sessions only). */
  canStop: boolean;
}

/** The delivery mode follows the session: direct for managed ones, the next hook event otherwise. */
export function composer(s: Session | null): Composer {
  if (!s) return { disabled: true, helper: "", canStop: false };
  const ended = !s.live;
  if (isManaged(s)) {
    if (ended) return { disabled: true, helper: "This session has ended", canStop: false };
    if (s.status === "working" || s.status === "thinking") return { disabled: true, helper: "Working... you can send the next prompt when it is done", canStop: true };
    if (s.status === "needs_you") return { disabled: true, helper: "Waiting for your answer above... then you can send the next prompt", canStop: true };
    return { disabled: false, helper: "Sent directly", canStop: true };
  }
  if (ended) return { disabled: true, helper: "This session has ended", canStop: false };
  switch (s.status) {
    case "stale":
      return { disabled: true, helper: "No sign of life from this session: a message would not arrive", canStop: false };
    case "working":
    case "thinking":
    case "needs_you":
      return { disabled: false, helper: "Delivered at the session's next step", canStop: false };
    default:
      return { disabled: false, helper: "Delivered when it starts working again", canStop: false };
  }
}

export type MessageRow =
  | { kind: "queued"; id: string; text: string }
  | { kind: "delivered"; id: string; text: string; label: string }
  | { kind: "expired"; id: string; text: string; label: string };

const pad = (n: number) => String(n).padStart(2, "0");

/** Local time as "12:03". */
export const fmtClock = (ms: number): string => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export function deliveredLabel(m: SessionMessage): string {
  const at = m.deliveredAt != null ? ` ${fmtClock(m.deliveredAt)}` : "";
  const how = m.via === "mid-turn" ? " - mid-turn" : m.via === "stop" ? " - when it finished" : "";
  return `Delivered${at}${how}`;
}

/** Every queued message, the last delivered one for a short while, the last expired one with its text. */
export function messageRows(messages: SessionMessage[] | undefined, now: number): MessageRow[] {
  const list = messages ?? [];
  const rows: MessageRow[] = list.filter((m) => m.state === "queued").map((m) => ({ kind: "queued", id: m.id, text: m.text }));
  const delivered = [...list].reverse().find((m) => m.state === "delivered");
  if (delivered && now - (delivered.deliveredAt ?? delivered.queuedAt) < DELIVERED_SHOW_MS) {
    rows.push({ kind: "delivered", id: delivered.id, text: delivered.text, label: deliveredLabel(delivered) });
  }
  const expired = [...list].reverse().find((m) => m.state === "expired");
  if (expired) rows.push({ kind: "expired", id: expired.id, text: expired.text, label: "Not delivered, the session ended" });
  return rows;
}

export const queuedCount = (s: Session | null | undefined): number => s?.messages?.filter((m) => m.state === "queued").length ?? 0;

/** Messages that turned delivered between two snapshots, once. A session that was not there before reports none. */
export function newlyDelivered(prev: Session[], next: Session[]): string[] {
  const before = new Map(prev.map((s) => [s.id, new Map((s.messages ?? []).map((m) => [m.id, m.state]))]));
  const out: string[] = [];
  for (const s of next) {
    const old = before.get(s.id);
    if (!old) continue;
    for (const m of s.messages ?? []) {
      if (m.state !== "delivered") continue;
      const was = old.get(m.id);
      if (was === "queued" || was === undefined) out.push(m.id);
    }
  }
  return out;
}
