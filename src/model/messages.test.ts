import { describe, expect, it } from "vitest";
import type { Session, SessionMessage } from "../core/types";
import { checkMessage, composer, DELIVERED_SHOW_MS, deliveredLabel, fmtClock, messageRows, MESSAGE_MAX, newlyDelivered, queuedCount } from "./messages";

const s = (over: Partial<Session> = {}): Session => ({ id: "a", managed: false, live: true, status: "idle", messages: [], ...over } as Session);
const m = (over: Partial<SessionMessage> = {}): SessionMessage => ({ id: "m1", text: "hi", state: "queued", queuedAt: 1000, deliveredAt: null, via: null, ...over });

describe("checkMessage", () => {
  it("trims and accepts text", () => {
    expect(checkMessage("  do it \n")).toEqual({ ok: true, text: "do it" });
  });
  it("refuses empty text", () => {
    expect(checkMessage("  \n ").ok).toBe(false);
  });
  it("refuses too long text instead of cutting it", () => {
    expect(checkMessage("x".repeat(MESSAGE_MAX)).ok).toBe(true);
    const r = checkMessage("x".repeat(MESSAGE_MAX + 1));
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/Too long/);
  });
});

describe("composer", () => {
  it("says the delivery mode of a working session", () => {
    for (const status of ["working", "thinking", "needs_you"] as const) {
      expect(composer(s({ status }))).toMatchObject({ disabled: false, helper: "Delivered at the session's next step", canStop: false });
    }
  });
  it("says the message waits for an idle or finished session", () => {
    for (const status of ["idle", "finished", "error"] as const) {
      expect(composer(s({ status }))).toMatchObject({ disabled: false, helper: "Delivered when it starts working again" });
    }
  });
  it("is disabled for a stale or ended session", () => {
    expect(composer(s({ status: "stale" })).disabled).toBe(true);
    expect(composer(s({ live: false })).disabled).toBe(true);
    expect(composer(null).disabled).toBe(true);
  });
  it("sends managed sessions directly, with Stop, and waits while they work", () => {
    expect(composer(s({ managed: true }))).toMatchObject({ disabled: false, helper: "Sent directly", canStop: true });
    for (const status of ["working", "thinking", "needs_you"] as const) {
      expect(composer(s({ managed: true, status }))).toMatchObject({ disabled: true, canStop: true });
    }
    expect(composer(s({ managed: true, live: false }))).toMatchObject({ disabled: true, canStop: false });
  });
});

describe("fmtClock and deliveredLabel", () => {
  const at = new Date(2026, 9, 2, 12, 3).getTime();
  it("formats local time with two digits", () => {
    expect(fmtClock(at)).toBe("12:03");
    expect(fmtClock(new Date(2026, 9, 2, 7, 5).getTime())).toBe("07:05");
  });
  it("names the way it was delivered", () => {
    expect(deliveredLabel(m({ state: "delivered", deliveredAt: at, via: "mid-turn" }))).toBe("Delivered 12:03 - mid-turn");
    expect(deliveredLabel(m({ state: "delivered", deliveredAt: at, via: "stop" }))).toBe("Delivered 12:03 - when it finished");
    expect(deliveredLabel(m({ state: "delivered", deliveredAt: at, via: null }))).toBe("Delivered 12:03");
  });
});

describe("messageRows", () => {
  it("shows every queued message", () => {
    const rows = messageRows([m({ id: "1" }), m({ id: "2" })], 2000);
    expect(rows.map((r) => r.kind)).toEqual(["queued", "queued"]);
  });
  it("shows only the last delivered message, and only for a while", () => {
    const list = [m({ id: "1", state: "delivered", deliveredAt: 1000, via: "stop" }), m({ id: "2", state: "delivered", deliveredAt: 5000, via: "mid-turn" })];
    const rows = messageRows(list, 6000);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "delivered", id: "2" });
    expect(messageRows(list, 5000 + DELIVERED_SHOW_MS)).toEqual([]);
  });
  it("keeps the text of the last expired message", () => {
    const rows = messageRows([m({ id: "1", state: "expired", text: "copy me" })], 9e9);
    expect(rows).toEqual([{ kind: "expired", id: "1", text: "copy me", label: "Not delivered, the session ended" }]);
  });
  it("hides cancelled messages and copes with a missing list", () => {
    expect(messageRows([m({ state: "cancelled" })], 2000)).toEqual([]);
    expect(messageRows(undefined, 2000)).toEqual([]);
  });
});

describe("queuedCount", () => {
  it("counts the queued messages", () => {
    expect(queuedCount(s({ messages: [m({ id: "1" }), m({ id: "2", state: "delivered" }), m({ id: "3" })] }))).toBe(2);
    expect(queuedCount(null)).toBe(0);
  });
});

describe("newlyDelivered", () => {
  const queued = s({ messages: [m()] });
  const delivered = s({ messages: [m({ state: "delivered", deliveredAt: 2000, via: "mid-turn" })] });
  it("fires once when a queued message turns delivered", () => {
    expect(newlyDelivered([queued], [delivered])).toEqual(["m1"]);
    expect(newlyDelivered([delivered], [delivered])).toEqual([]);
  });
  it("stays quiet for the first snapshot, a new session, a cancel or an expiry", () => {
    expect(newlyDelivered([], [delivered])).toEqual([]);
    expect(newlyDelivered([s({ id: "other" })], [delivered])).toEqual([]);
    expect(newlyDelivered([queued], [s({ messages: [m({ state: "cancelled" })] })])).toEqual([]);
    expect(newlyDelivered([queued], [s({ messages: [m({ state: "expired" })] })])).toEqual([]);
  });
  it("catches a message that was queued and delivered between two snapshots", () => {
    expect(newlyDelivered([s()], [delivered])).toEqual(["m1"]);
  });
});
