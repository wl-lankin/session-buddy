import { describe, expect, it } from "vitest";
import { cardWorthy, finishLines, finishTitle, mergeFinish, planFinish, playsSound, type FinishItem } from "./finish";

const item = (sessionId: string, project: string, at: number, turnMs: number | null = 61_000): FinishItem => ({ sessionId, project, at, turnMs });

describe("mergeFinish", () => {
  it("starts a new card when none is shown", () => {
    const old = [item("a", "pushdocs", 0)];
    expect(mergeFinish(old, item("b", "fetchdocs", 10_000), false)).toEqual([item("b", "fetchdocs", 10_000)]);
  });

  it("adds to the card on screen", () => {
    const shown = [item("a", "pushdocs", 0)];
    expect(mergeFinish(shown, item("b", "fetchdocs", 2_000), true).map((x) => x.sessionId)).toEqual(["a", "b"]);
  });

  it("a session finishing again replaces its own entry", () => {
    const shown = [item("a", "pushdocs", 0), item("b", "fetchdocs", 1_000)];
    const next = mergeFinish(shown, item("a", "pushdocs", 3_000, 5_000), true);
    expect(next.map((x) => x.sessionId)).toEqual(["b", "a"]);
    expect(next[1].turnMs).toBe(5_000);
  });
});

describe("planFinish", () => {
  const base = { style: "card" as const, mode: "strip" as const, view: "session" as const, anyPending: false, busy: false, turnMs: 61_000, minSeconds: 60 };
  const short = { card: false, emote: true, jump: false, flash: false, reveal: false };

  it("shows the card from the strip, compact and the session view", () => {
    expect(planFinish(base)).toEqual({ card: true, emote: true, jump: true, flash: false, reveal: false });
    expect(planFinish({ ...base, mode: "compact" }).card).toBe(true);
    expect(planFinish({ ...base, mode: "expanded", view: "session" }).card).toBe(true);
    expect(planFinish({ ...base, mode: "expanded", view: "finished" }).card).toBe(true);
  });

  it("a short turn gets the sound and a short emote only", () => {
    expect(planFinish({ ...base, turnMs: 59_999 })).toEqual(short);
    expect(planFinish({ ...base, turnMs: 60_000 }).card).toBe(true);
    expect(planFinish({ ...base, turnMs: null })).toEqual(short);
    expect(planFinish({ ...base, minSeconds: 0, turnMs: 0 }).card).toBe(true);
  });

  it("agents or background tasks still running: no card yet", () => {
    expect(planFinish({ ...base, busy: true, turnMs: 600_000 })).toEqual(short);
  });

  it("never covers a waiting card", () => {
    expect(planFinish({ ...base, anyPending: true })).toEqual({ card: false, emote: true, jump: true, flash: true, reveal: true });
    expect(planFinish({ ...base, mode: "expanded", view: "interaction", anyPending: true }).card).toBe(false);
  });

  it("leaves other expanded views alone and flashes instead", () => {
    expect(planFinish({ ...base, mode: "expanded", view: "confused" })).toEqual({ card: false, emote: true, jump: true, flash: true, reveal: false });
    expect(planFinish({ ...base, mode: "expanded", view: "greeting" }).card).toBe(false);
  });

  it("animation only: Mochi and the flash, no card, no mode change, whatever the turn", () => {
    expect(planFinish({ ...base, style: "animation" })).toEqual({ card: false, emote: true, jump: true, flash: true, reveal: false });
    expect(planFinish({ ...base, style: "animation", busy: true, turnMs: 1 })).toEqual({ card: false, emote: true, jump: true, flash: true, reveal: false });
  });

  it("off: nothing but the sound", () => {
    expect(planFinish({ ...base, style: "off" })).toEqual({ card: false, emote: false, jump: false, flash: false, reveal: false });
  });
});

describe("cardWorthy", () => {
  it("needs a known, long enough turn and nothing running", () => {
    expect(cardWorthy({ busy: false, turnMs: 90_000, minSeconds: 60 })).toBe(true);
    expect(cardWorthy({ busy: true, turnMs: 90_000, minSeconds: 60 })).toBe(false);
    expect(cardWorthy({ busy: false, turnMs: 30_000, minSeconds: 60 })).toBe(false);
    expect(cardWorthy({ busy: false, turnMs: null, minSeconds: 60 })).toBe(false);
  });
});

describe("card text", () => {
  it("one session: project and turn duration", () => {
    expect(finishTitle([item("a", "pushdocs", 0, 252_000)])).toBe("pushdocs finished · 4m 12s");
    expect(finishTitle([item("a", "pushdocs", 0, null)])).toBe("pushdocs finished");
  });

  it("several sessions: a count", () => {
    expect(finishTitle([item("a", "pushdocs", 0), item("b", "fetchdocs", 1), item("c", "InvoiceRails", 2)])).toBe("3 sessions finished");
  });

  it("the first two non-empty lines of the message", () => {
    expect(finishLines("\nAll 312 tests pass.\n\n  Shall I open the PR?\nThird line")).toBe("All 312 tests pass.\nShall I open the PR?");
    expect(finishLines(null)).toBe("");
  });
});

describe("playsSound", () => {
  it("keeps a deferred finish silent so the sound plays once, on the real completion", () => {
    expect(playsSound({ kind: "finish", busy: true })).toBe(false);
    expect(playsSound({ kind: "finish", busy: false })).toBe(true);
    expect(playsSound({ kind: "finish" })).toBe(true);
    expect(playsSound({ kind: "approval", busy: true })).toBe(true);
  });
});

describe("finishLines with a limit", () => {
  it("keeps one line, or every non-empty line", () => {
    const msg = "One\n\n  Two  \nThree\nFour";
    expect(finishLines(msg, 1)).toBe("One");
    expect(finishLines(msg, Infinity)).toBe("One\nTwo\nThree\nFour");
  });
});
