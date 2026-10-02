import { describe, expect, it } from "vitest";
import type { Session } from "../core/types";
import { isManaged, newDrafts, pruneDrafts } from "./managed";

const s = (over: Partial<Session> = {}): Session => ({ id: "w", managed: true, live: true, status: "idle", ...over } as Session);

describe("isManaged", () => {
  it("is true only for sessions Buddy started", () => {
    expect(isManaged(s())).toBe(true);
    expect(isManaged(s({ managed: false }))).toBe(false);
    expect(isManaged(null)).toBe(false);
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
