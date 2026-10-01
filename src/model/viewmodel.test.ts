import { describe, expect, it } from "vitest";
import type { Interaction, Session, Usage } from "../core/types";
import {
  accountLabel, accountTitle, answersFor, botStateFor, currentActivity, cycle, limitsShort, loudest, modelName, orderSessions, pendingQueue,
  resolveFocus, sessionTitle, statusLine, stripLabel, summarize, tabLabel,
} from "./viewmodel";

let n = 0;
function mk(p: Partial<Session> = {}): Session {
  n += 1;
  return {
    id: `s${n}`, project: "pushdocs", cwd: "C:/Projects/pushdocs", branch: null, termProgram: "WarpTerminal",
    model: null, status: "idle", statusSince: 0, lastPrompt: null, lastMessage: null, steps: [], agents: [],
    background: [], pending: [], startedAt: n, lastEventAt: n,
    stats: { linesAdded: 0, linesRemoved: 0, contextUsedPct: null, contextTokens: null, contextSize: null, costUsd: null },
    ...p,
  };
}

const approval = (id: string): Interaction => ({ kind: "approval", requestId: id, tool: "Bash", target: "Bash · ls", agentId: null, deadline: 0 });

describe("viewmodel", () => {
  it("loudest prefers needs_you, then error, then working", () => {
    const a = mk({ status: "working" });
    const b = mk({ status: "needs_you", pending: [approval("r1")] });
    const c = mk({ status: "error" });
    expect(loudest([a, b, c])?.id).toBe(b.id);
    expect(loudest([a, c])?.id).toBe(c.id);
    expect(loudest([])).toBeNull();
  });

  it("strip label counts", () => {
    expect(stripLabel(summarize([]))).toBe("No sessions");
    const one = [mk({ status: "working" })];
    expect(stripLabel(summarize(one))).toBe("1 session · 1 working");
    const four = [mk({ status: "working" }), mk({ status: "thinking" }), mk({ status: "needs_you" }), mk()];
    expect(stripLabel(summarize(four))).toBe("4 sessions · 2 working · 1 needs you");
  });

  it("maps status to Mochi", () => {
    expect(botStateFor(null)).toBe("idle");
    expect(botStateFor(mk({ status: "needs_you", pending: [approval("r")] }))).toBe("approval");
    expect(botStateFor(mk({ status: "needs_you", pending: [{ kind: "reply", requestId: "r", message: "?", deadline: 0 }] }))).toBe("question");
    expect(botStateFor(mk({ status: "stale" }))).toBe("sleeping");
    expect(botStateFor(mk({ status: "finished" }))).toBe("finished");
  });

  it("cycles with wrap-around", () => {
    const list = [mk(), mk(), mk()];
    expect(cycle(list, list[2].id, 1)).toBe(list[0].id);
    expect(cycle(list, list[0].id, -1)).toBe(list[2].id);
    expect(cycle(list, null, 1)).toBe(list[0].id);
    expect(cycle([], null, 1)).toBeNull();
  });

  it("focus jumps to a session that just started waiting", () => {
    const a = mk({ status: "working" });
    const b = mk({ status: "working" });
    const bWaiting = { ...b, status: "needs_you" as const, pending: [approval("r1")] };
    expect(resolveFocus(a.id, [a, b], [a, bWaiting])).toEqual({ focusId: b.id, newlyPending: b.id });
    // Already waiting before: no jump.
    expect(resolveFocus(a.id, [a, bWaiting], [a, bWaiting])).toEqual({ focusId: a.id, newlyPending: null });
    // Focused session ended: fall back to the loudest.
    expect(resolveFocus("gone", [a], [a, bWaiting]).focusId).toBe(b.id);
  });

  it("pending queue order: focused session first, then others in list order", () => {
    const a = mk({ status: "needs_you", pending: [approval("a1"), approval("a2")] });
    const b = mk({ status: "needs_you", pending: [approval("b1")] });
    expect(pendingQueue([a, b], b.id).map((x) => x.item.requestId)).toEqual(["b1", "a1", "a2"]);
    expect(pendingQueue([a, b], null).map((x) => x.item.requestId)).toEqual(["a1", "a2", "b1"]);
  });

  it("B arrives while A is shown -> A stays current", () => {
    const a = mk({ status: "needs_you", pending: [approval("a1")] });
    const b = mk({ status: "working" });
    const bWaiting = { ...b, status: "needs_you" as const, pending: [approval("b1")] };
    // Something was already pending: no jump, no alert.
    expect(resolveFocus(a.id, [a, b], [a, bWaiting])).toEqual({ focusId: a.id, newlyPending: null });
    // Even with focus on B (e.g. the user switched tabs), the card on screen stays at the head.
    expect(pendingQueue([a, bWaiting], b.id, "a1").map((x) => x.item.requestId)).toEqual(["a1", "b1"]);
    expect(pendingQueue([a, bWaiting], a.id, "a1")[0].item.requestId).toBe("a1");
  });

  it("A resolves -> B becomes current", () => {
    const aDone = mk({ status: "working", pending: [] });
    const b = mk({ status: "needs_you", pending: [approval("b1")] });
    const queue = pendingQueue([aDone, b], aDone.id, "a1");
    expect(queue.map((x) => x.item.requestId)).toEqual(["b1"]);
    expect(queue[0].session.id).toBe(b.id);
  });

  it("titles and status lines", () => {
    expect(sessionTitle(mk({ project: "pushdocs", branch: "PDD-1981" }))).toBe("pushdocs · PDD-1981");
    expect(sessionTitle(mk({ project: "x", branch: null }))).toBe("x");
    const s = mk({
      status: "working", statusSince: 0,
      agents: [
        { id: "a", agentType: "Explore", description: null, running: true, currentStep: null, startedAt: 0, endedAt: null },
        { id: "b", agentType: "Plan", description: null, running: false, currentStep: null, startedAt: 0, endedAt: 1 },
      ],
    });
    expect(statusLine(s, 252_000)).toBe("working · 1 agent · 4m 12s");
    expect(statusLine(mk({ status: "idle" }), 0)).toBe("idle");
  });

  it("current activity", () => {
    expect(currentActivity(mk({ status: "working", steps: [{ tool: "Edit", label: "Edit · a.php", at: 0, ok: null }] }))).toBe("Edit · a.php");
    expect(currentActivity(mk({ status: "needs_you", pending: [approval("r")] }))).toBe("Waiting for you: Bash · ls");
    expect(currentActivity(mk({ status: "finished", lastMessage: "Done.\nMore" }))).toBe("Done.");
    expect(currentActivity(mk({ status: "thinking", lastPrompt: "fix it" }))).toBe("Thinking: fix it");
  });

  it("limits and account", () => {
    const u: Usage = { fiveHour: { usedPct: 42, resetsAt: null }, sevenDay: { usedPct: 91, resetsAt: null }, source: "oauth", updatedAt: 1, error: null, account: { email: "w@x.de", org: "finodata", plan: "Team" } };
    expect(limitsShort(u)).toEqual({ text: "5H 42% · 7D 91%", level: "crit" });
    expect(limitsShort({ ...u, fiveHour: null, sevenDay: null })).toEqual({ text: "", level: "ok" });
    expect(accountLabel(u)).toBe("w@x.de · Team");
    expect(accountTitle(u)).toBe("w@x.de · finodata · Team");
    expect(accountLabel({ ...u, account: null })).toBe("");
    expect(accountTitle({ ...u, account: null })).toBe("");
  });

  it("orders live sessions first by start, then idle and stale ones", () => {
    const APP = 1_000;
    const idleOld = mk({ status: "idle", startedAt: 1, lastEventAt: 500 });
    const working = mk({ status: "working", startedAt: 5, lastEventAt: 2_000 });
    const stale = mk({ status: "stale", startedAt: 2, lastEventAt: 100 });
    const idleActive = mk({ status: "idle", startedAt: 3, lastEventAt: 1_500 });
    const waiting = mk({ status: "needs_you", startedAt: 4, lastEventAt: 10 });
    const ids = (xs: Session[]) => xs.map((x) => x.id);
    expect(ids(orderSessions([idleOld, working, stale, idleActive, waiting], APP))).toEqual(
      ids([idleActive, waiting, working, idleOld, stale]),
    );
    expect(ids(orderSessions([], APP))).toEqual([]);
  });

  it("cycling follows the same order as the tabs", () => {
    const a = mk({ status: "idle", startedAt: 1, lastEventAt: 1 });
    const b = mk({ status: "working", startedAt: 2, lastEventAt: 5_000 });
    const ordered = orderSessions([a, b], 1_000);
    expect(cycle(ordered, ordered[0].id, 1)).toBe(a.id);
    expect(cycle(ordered, ordered[0].id, -1)).toBe(a.id);
    expect(ordered[0].id).toBe(b.id);
  });

  it("tab labels shrink for inactive tabs above five sessions", () => {
    expect(tabLabel("pushdocs", false, 5)).toBe("pushdocs");
    expect(tabLabel("pushdocs", false, 6)).toBe("pus");
    expect(tabLabel("pushdocs", true, 9)).toBe("pushdocs");
    expect(tabLabel("ab", false, 9)).toBe("ab");
  });

  it("maps raw model ids to display names", () => {
    expect(modelName("claude-opus-5-5")).toBe("Opus 5.5");
    expect(modelName("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(modelName("claude-opus-4-20250514")).toBe("Opus 4");
    expect(modelName("Opus 5.5")).toBe("Opus 5.5");
    expect(modelName("claude-weird")).toBe("claude-weird");
    expect(modelName(null)).toBe("");
  });

  it("builds AskUserQuestion answers as strings", () => {
    const qs = [
      { question: "Pick a color?", options: [{ label: "Red" }, { label: "Blue" }] },
      { question: "Which files?", options: [{ label: "a" }, { label: "b" }], multiSelect: true },
    ];
    expect(answersFor(qs, { "Pick a color?": ["Blue"] }, {})).toBeNull();
    expect(answersFor(qs, { "Pick a color?": ["Blue"], "Which files?": ["a", "b"] }, {})).toEqual({ "Pick a color?": "Blue", "Which files?": "a, b" });
    expect(answersFor(qs, { "Which files?": ["a"] }, { "Pick a color?": "  green  ", "Which files?": "c" })).toEqual({ "Pick a color?": "green", "Which files?": "a, c" });
  });
});
