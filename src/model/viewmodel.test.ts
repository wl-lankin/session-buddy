import { describe, expect, it } from "vitest";
import type { Agent, Extra, Interaction, Session, Usage } from "../core/types";
import {
  accountLabel, accountTitle, answersFor, botStateFor, currentActivity, cycle, limitParts, loudest, modelName, orderSessions, pendingQueue, recentClass,
  agentGroups, emailParts, extraView, oauthNote, rowLevel, finishedAgentLabel, recentCount, resolveFocus, sessionTitle, statusLine, stripLabel, summarize, visibleSessions,
} from "./viewmodel";

let n = 0;
function mk(p: Partial<Session> = {}): Session {
  n += 1;
  return {
    id: `s${n}`, project: "pushdocs", cwd: "C:/Projects/pushdocs", branch: null, termProgram: "WarpTerminal",
    model: null, status: "idle", statusSince: 0, lastPrompt: null, lastMessage: null, steps: [], agents: [],
    background: [], pending: [], startedAt: n, lastEventAt: n, pid: null, live: true, plan: null, managed: false, messages: [],
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

  it("strip counts only live sessions that are not stale", () => {
    const sessions = [
      mk({ status: "working" }), mk(), mk({ status: "stale" }),
      mk({ live: false }), mk({ live: false, status: "stale" }), mk({ status: "thinking" }),
    ];
    expect(summarize(sessions)).toEqual({ total: 3, busy: 2, needsYou: 0 });
    expect(stripLabel(summarize(sessions))).toBe("3 sessions · 2 working");
    expect(stripLabel(summarize([mk({ live: false }), mk({ live: false })]))).toBe("No sessions");
    expect(recentClass(mk({ live: false }))).toBe(" recent");
    expect(recentClass(mk())).toBe("");
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
    const u: Usage = { fiveHour: { usedPct: 42, resetsAt: null, severity: "normal" }, sevenDay: { usedPct: 91, resetsAt: null, severity: "normal" }, limits: [], extra: null, source: "oauth", updatedAt: 1, error: null, oauthUpdatedAt: 1, oauthError: null, account: { email: "w@x.de", org: "finodata", plan: "Team" } };
    expect(limitParts(u)).toEqual([{ text: "5H 42%", level: "ok" }, { text: "7D 91%", level: "crit" }]);
    expect(limitParts({ ...u, sevenDay: { ...u.sevenDay!, usedPct: 73 } })[1]).toEqual({ text: "7D 73%", level: "warn" });
    expect(limitParts({ ...u, fiveHour: null, sevenDay: null })).toEqual([]);
    expect(accountLabel(u)).toBe("w@x.de · Team");
    expect(accountTitle(u)).toBe("w@x.de · finodata · Team");
    expect(accountLabel({ ...u, account: null })).toBe("");
    expect(accountTitle({ ...u, account: null })).toBe("");
  });

  it("orders live sessions first by start, then recent ones from transcripts", () => {
    const recentOld = mk({ live: false, status: "idle", startedAt: 1 });
    const working = mk({ status: "working", startedAt: 5 });
    const recentStale = mk({ live: false, status: "stale", startedAt: 2 });
    const idle = mk({ status: "idle", startedAt: 3 });
    const staleLive = mk({ status: "stale", startedAt: 4 });
    const ids = (xs: Session[]) => xs.map((x) => x.id);
    expect(ids(orderSessions([recentOld, working, recentStale, idle, staleLive]))).toEqual(
      ids([idle, staleLive, working, recentOld, recentStale]),
    );
    expect(ids(orderSessions([]))).toEqual([]);
  });

  it("visible sessions: live only, recent ones at the end when asked for", () => {
    const recent = mk({ live: false, startedAt: 1 });
    const working = mk({ status: "working", startedAt: 3 });
    const staleLive = mk({ status: "stale", startedAt: 2 });
    const ordered = orderSessions([recent, working, staleLive]);
    const ids = (xs: Session[]) => xs.map((x) => x.id);
    expect(ids(visibleSessions(ordered, false))).toEqual([staleLive.id, working.id]);
    expect(ids(visibleSessions(ordered, true))).toEqual([staleLive.id, working.id, recent.id]);
    expect(visibleSessions([], true)).toEqual([]);
    expect(recentCount(ordered)).toBe(1);
    expect(recentCount([working])).toBe(0);
  });

  it("cycling and number keys skip recent sessions unless they are shown", () => {
    const recent = mk({ live: false, startedAt: 1 });
    const a = mk({ status: "working", startedAt: 2 });
    const b = mk({ status: "idle", startedAt: 3 });
    const shown = visibleSessions(orderSessions([recent, a, b]), false);
    expect(cycle(shown, b.id, 1)).toBe(a.id);
    expect(cycle(shown, a.id, -1)).toBe(b.id);
    expect(shown[2]).toBeUndefined();
  });

  it("cycling follows the same order as the tabs", () => {
    const a = mk({ live: false, startedAt: 1 });
    const b = mk({ status: "working", startedAt: 2 });
    const ordered = orderSessions([a, b]);
    expect(cycle(ordered, ordered[0].id, 1)).toBe(a.id);
    expect(cycle(ordered, ordered[0].id, -1)).toBe(a.id);
    expect(ordered[0].id).toBe(b.id);
  });

  it("an email splits only before the @", () => {
    expect(emailParts("wolfgang.linz@finodata.de")).toEqual(["wolfgang.linz", "@finodata.de"]);
    expect(emailParts("no-at-sign")).toBeNull();
    expect(emailParts("@odd")).toBeNull();
  });

  it("groups agents: running newest first, finished newest first", () => {
    const ag = (id: string, p: Partial<Agent>): Agent => ({ id, agentType: "Explore", description: null, running: false, currentStep: null, startedAt: 0, endedAt: null, ...p });
    const { running, finished } = agentGroups([
      ag("r1", { running: true, startedAt: 1 }),
      ag("f1", { endedAt: 10, startedAt: 2 }),
      ag("r2", { running: true, startedAt: 5 }),
      ag("f2", { endedAt: 30, startedAt: 3 }),
    ]);
    expect(running.map((a) => a.id)).toEqual(["r2", "r1"]);
    expect(finished.map((a) => a.id)).toEqual(["f2", "f1"]);
    expect(agentGroups([])).toEqual({ running: [], finished: [] });
  });

  it("a finished agent reads as its description, else its type, never the generic agent when the type is known", () => {
    const ag = (agentType: string, description: string | null): Agent => ({ id: "a", agentType, description, running: false, currentStep: null, startedAt: 0, endedAt: 1 });
    expect(finishedAgentLabel(ag("Explore", "Find callers"))).toBe("Explore · Find callers");
    expect(finishedAgentLabel(ag("agent", "Find callers"))).toBe("Find callers");
    expect(finishedAgentLabel(ag("Plan", null))).toBe("Plan");
    expect(finishedAgentLabel(ag("Plan", "  "))).toBe("Plan");
    expect(finishedAgentLabel(ag("agent", null))).toBe("agent");
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

  it("row colours follow the percentage or the reported severity, whichever is worse", () => {
    expect(rowLevel(10, "normal")).toBe("ok");
    expect(rowLevel(10, undefined)).toBe("ok");
    expect(rowLevel(75, "normal")).toBe("warn");
    expect(rowLevel(10, "warning")).toBe("warn");
    expect(rowLevel(10, "critical")).toBe("crit");
    expect(rowLevel(95, "warning")).toBe("crit");
  });

  it("notes stale or failed endpoint data under the scoped and extra rows", () => {
    const now = 100 * 60_000;
    const extra: Extra = { enabled: true, usedMinor: 1, limitMinor: null, currency: "EUR", exponent: 2, disabledReason: null, percent: null };
    const base: Usage = { fiveHour: null, sevenDay: null, limits: [], extra, source: "statusline", updatedAt: now, error: null, oauthUpdatedAt: now - 60_000, oauthError: null, account: null };
    expect(oauthNote(base, now), "fresh").toBeNull();
    expect(oauthNote({ ...base, oauthUpdatedAt: now - 21 * 60_000 }, now)).toEqual({ text: "updated 21m ago", title: null });
    expect(oauthNote({ ...base, oauthError: "usage endpoint returned 429" }, now)).toEqual({ text: "updated 1m ago", title: "usage endpoint returned 429" });
    expect(oauthNote({ ...base, oauthUpdatedAt: null, oauthError: "Not logged in to Claude Code" }, now)).toEqual({ text: "Not logged in to Claude Code", title: "Not logged in to Claude Code" });
    expect(oauthNote({ ...base, extra: null, oauthError: "x" }, now), "nothing from the endpoint to qualify").toBeNull();
    const scoped = { kind: "weekly_scoped", label: "7D Fable", usedPct: 1, resetsAt: null, severity: "normal" };
    expect(oauthNote({ ...base, extra: null, limits: [scoped], oauthError: "x" }, now)).not.toBeNull();
  });

  it("extra usage: with a limit, without one, and off", () => {
    const on: Extra = { enabled: true, usedMinor: 1240, limitMinor: 5000, currency: "EUR", exponent: 2, disabledReason: null, percent: 24.8 };
    expect(extraView(on, "en-US")).toEqual({ on: true, text: "€12.40 / €50.00", pct: 24.8, level: "ok" });
    expect(extraView({ ...on, usedMinor: 4600, percent: 92 }, "en-US")).toMatchObject({ pct: 92, level: "crit" });
    expect(extraView({ ...on, percent: null }, "en-US")).toMatchObject({ pct: 1240 * 100 / 5000 });
    expect(extraView({ ...on, limitMinor: null, percent: null }, "en-US")).toEqual({ on: true, text: "€12.40 used", pct: null, level: "ok" });
    const off: Extra = { ...on, enabled: false, usedMinor: 0, limitMinor: null, percent: null };
    expect(extraView({ ...off, disabledReason: "out_of_credits" })).toEqual({ on: false, reason: "no credits" });
    expect(extraView({ ...off, disabledReason: "user_disabled" })).toEqual({ on: false, reason: "turned off" });
    expect(extraView({ ...off, disabledReason: "plan_not_eligible" })).toEqual({ on: false, reason: "plan not eligible" });
    expect(extraView(off)).toEqual({ on: false, reason: null });
  });

  it("plan interactions queue like any other: the shown card stays first, Buddy shows the approval state", () => {
    const plan = (id: string): Interaction => ({ kind: "plan", requestId: id, plan: "## P", deadline: 0 });
    const a = mk({ status: "needs_you", pending: [approval("r1")] });
    const b = mk({ status: "needs_you", pending: [plan("r2")] });
    expect(pendingQueue([a, b], a.id).map((q) => q.item.requestId)).toEqual(["r1", "r2"]);
    expect(pendingQueue([a, b], a.id, "r2").map((q) => q.item.requestId)).toEqual(["r2", "r1"]);
    expect(botStateFor(b)).toBe("approval");
    expect(currentActivity(b)).toBe("Plan waits for you: ## P");
  });
});
