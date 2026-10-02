import { describe, expect, it } from "vitest";
import type { Session } from "../core/types";
import { cleanPrompt, isManaged, newDrafts, PROMPT_MAX, pruneDrafts, workerLine } from "./managed";

const s = (over: Partial<Session> = {}): Session => ({ id: "w", managed: true, live: true, status: "idle", ...over } as Session);

describe("isManaged", () => {
  it("is true only for sessions Buddy started", () => {
    expect(isManaged(s())).toBe(true);
    expect(isManaged(s({ managed: false }))).toBe(false);
    expect(isManaged(null)).toBe(false);
  });
});

describe("workerLine", () => {
  it("is hidden for ordinary sessions", () => {
    expect(workerLine(s({ managed: false })).visible).toBe(false);
    expect(workerLine(null).visible).toBe(false);
  });
  it("takes a prompt while the session is idle or finished", () => {
    for (const status of ["idle", "finished", "error"] as const) {
      expect(workerLine(s({ status }))).toMatchObject({ visible: true, disabled: false, canStop: true, placeholder: "Send a prompt to this session" });
    }
  });
  it("waits with a hint while the session works, and can still be stopped", () => {
    for (const status of ["working", "thinking"] as const) {
      const l = workerLine(s({ status }));
      expect(l).toMatchObject({ visible: true, disabled: true, canStop: true });
      expect(l.placeholder).toMatch(/Working/);
    }
  });
  it("waits while the session needs the user", () => {
    expect(workerLine(s({ status: "needs_you" }))).toMatchObject({ disabled: true, canStop: true });
  });
  it("is dead for a session that ended", () => {
    expect(workerLine(s({ live: false }))).toMatchObject({ disabled: true, canStop: false });
  });
});

describe("cleanPrompt", () => {
  it("trims, rejects empty text and caps the length", () => {
    expect(cleanPrompt("  fix it \n")).toBe("fix it");
    expect(cleanPrompt("   ")).toBeNull();
    expect(cleanPrompt("x".repeat(PROMPT_MAX + 50))?.length).toBe(PROMPT_MAX);
  });
});

describe("drafts", () => {
  it("forgets sessions that are gone", () => {
    const d = newDrafts();
    d.text.set("a", "hi");
    d.error.set("b", "busy");
    pruneDrafts(d, [s({ id: "a" })]);
    expect([...d.text.keys()]).toEqual(["a"]);
    expect(d.error.size).toBe(0);
  });
});
