import { describe, expect, it } from "vitest";
import type { Interaction, Session } from "../core/types";
import { FEEDBACK_MAX, TERMINAL_ANSWER, feedbackAnswer, newPlan, planSession, planViewFor, sendsFeedback } from "./plan";

const sess = (id: string, plan: string | null, pending: Interaction[] = []): Session => ({
  id, project: id, cwd: "", branch: null, termProgram: null, model: null, status: "thinking", statusSince: 0,
  lastPrompt: null, lastMessage: null, steps: [], agents: [], background: [],
  stats: { linesAdded: 0, linesRemoved: 0, contextUsedPct: null, contextTokens: null, contextSize: null, costUsd: null },
  pending, startedAt: 0, lastEventAt: 0, pid: null, live: true, plan, managed: false, messages: [],
});

const approval: Interaction = { kind: "approval", requestId: "r1", tool: "Bash", target: "ls", agentId: null, deadline: 0 };

describe("planSession", () => {
  it("only the focused session's plan: another session's plan never takes over", () => {
    const list = [sess("a", "plan a"), sess("b", "plan b"), sess("c", null)];
    expect(planSession(list, "b")?.id).toBe("b");
    expect(planSession(list, "c")).toBeNull();
    expect(planSession(list, null)).toBeNull();
  });

  it("an empty plan still counts: the dialog is open in the terminal", () => {
    expect(planSession([sess("a", "")], "a")?.id).toBe("a");
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

const planItem = (id: string): Interaction => ({ kind: "plan", requestId: id, plan: "## P", deadline: 0 });

describe("feedback", () => {
  it("is empty until there is text", () => {
    expect(feedbackAnswer("")).toBeNull();
    expect(feedbackAnswer("  \n ")).toBeNull();
    expect(feedbackAnswer("  use Redis \n")).toEqual({ feedback: "use Redis" });
  });

  it("is clipped to 2000 characters", () => {
    const f = feedbackAnswer("x".repeat(2500))?.feedback ?? "";
    expect(f).toHaveLength(FEEDBACK_MAX);
    expect(FEEDBACK_MAX).toBe(2000);
  });

  it("hand-over answer is the terminal flag", () => {
    expect(TERMINAL_ANSWER).toEqual({ terminal: true });
  });

  it("only Cmd/Ctrl+Enter sends", () => {
    const k = (key: string, metaKey = false, ctrlKey = false) => ({ key, metaKey, ctrlKey });
    expect(sendsFeedback(k("Enter", true))).toBe(true);
    expect(sendsFeedback(k("Enter", false, true))).toBe(true);
    expect(sendsFeedback(k("Enter"))).toBe(false);
    expect(sendsFeedback(k("Escape", true))).toBe(false);
  });
});

describe("planViewFor", () => {
  it("a pending plan interaction shows the answerable card, even without focus", () => {
    expect(planViewFor([sess("a", "p", [planItem("r1")]), sess("b", null)], "b")).toBe("interaction");
  });

  it("only plan text shows the read-only view, for the focused session", () => {
    expect(planViewFor([sess("a", "p")], "a")).toBe("readonly");
    expect(planViewFor([sess("a", "p")], null)).toBeNull();
  });

  it("another interaction hides the read-only view", () => {
    expect(planViewFor([sess("a", "p"), sess("b", null, [approval])], "a")).toBeNull();
  });

  it("an empty state shows nothing", () => {
    expect(planViewFor([sess("a", null)], "a")).toBeNull();
  });
});
