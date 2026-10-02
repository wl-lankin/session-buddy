import { describe, expect, it } from "vitest";
import type { Session } from "../core/types";
import { controlSuggestions, modeChoice, modeSwitch } from "./chatcontrol";

const s = (project: string, over: Partial<Session> = {}): Session => ({ id: project, project, live: true, status: "working", ...over } as Session);

describe("mode switch", () => {
  it("marks the active mode", () => {
    expect(modeSwitch("control", false).options.map((o) => [o.id, o.active])).toEqual([["web", false], ["control", true]]);
  });
  it("locks while an answer is produced, like the model picker", () => {
    expect(modeSwitch("web", true).disabled).toBe(true);
    expect(modeSwitch("web", false).disabled).toBe(false);
    expect(modeChoice("web", "control", true)).toBeNull();
  });
  it("a click asks for another mode only", () => {
    expect(modeChoice("web", "control", false)).toBe("control");
    expect(modeChoice("web", "web", false)).toBeNull();
  });
});

describe("controlSuggestions", () => {
  it("offers the sessions overview and a start in each live project, focused first", () => {
    const list = controlSuggestions([s("pushdocs"), s("nexa"), s("fetchdocs")], "nexa");
    expect(list.map((x) => x.label)).toEqual([
      "What are my sessions doing?", "Start a session in nexa", "Start a session in pushdocs", "Which projects can you use?",
    ]);
    expect(list[0].context).toEqual({ kind: "overview" });
    expect(list[1].prompt).toContain("nexa");
  });
  it("ignores stale and recent sessions and repeats no project", () => {
    const list = controlSuggestions([s("a", { status: "stale" }), s("b", { live: false }), s("c"), s("c", { id: "c2" })], null);
    expect(list.filter((x) => x.id.startsWith("start:")).map((x) => x.label)).toEqual(["Start a session in c"]);
  });
  it("still has something to offer without sessions", () => {
    expect(controlSuggestions([], null).map((x) => x.id)).toEqual(["projects"]);
  });
});
