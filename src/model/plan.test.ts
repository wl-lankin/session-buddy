import { describe, expect, it } from "vitest";
import type { Interaction, Session } from "../core/types";
import { newPlan, planSession } from "./plan";

const sess = (id: string, plan: string | null, pending: Interaction[] = []): Session => ({
  id, project: id, cwd: "", branch: null, termProgram: null, model: null, status: "thinking", statusSince: 0,
  lastPrompt: null, lastMessage: null, steps: [], agents: [], background: [],
  stats: { linesAdded: 0, linesRemoved: 0, contextUsedPct: null, contextTokens: null, contextSize: null, costUsd: null },
  pending, startedAt: 0, lastEventAt: 0, pid: null, live: true, plan,
});

const approval: Interaction = { kind: "approval", requestId: "r1", tool: "Bash", target: "ls", agentId: null, deadline: 0 };

describe("planSession", () => {
  it("prefers the focused session, then any session with a plan", () => {
    const list = [sess("a", "plan a"), sess("b", "plan b"), sess("c", null)];
    expect(planSession(list, "b")?.id).toBe("b");
    expect(planSession(list, "c")?.id).toBe("a");
    expect(planSession([sess("c", null)], "c")).toBeNull();
  });

  it("an empty plan still counts: the dialog is open in the terminal", () => {
    expect(planSession([sess("a", "")], null)?.id).toBe("a");
  });

  it("real pending interactions always win", () => {
    expect(planSession([sess("a", "plan"), sess("b", null, [approval])], "a")).toBeNull();
  });
});

describe("newPlan", () => {
  it("reports a plan that just appeared, once", () => {
    const before = [sess("a", null)];
    const after = [sess("a", "## Plan")];
    expect(newPlan(before, after)).toBe("a");
    expect(newPlan(after, after)).toBeNull();
  });

  it("a different plan is new again; a cleared one is not", () => {
    expect(newPlan([sess("a", "one")], [sess("a", "two")])).toBe("a");
    expect(newPlan([sess("a", "one")], [sess("a", null)])).toBeNull();
  });

  it("a session that appears with a plan counts", () => {
    expect(newPlan([], [sess("x", "p")])).toBe("x");
  });
});
