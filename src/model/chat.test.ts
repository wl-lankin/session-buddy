import { describe, expect, it } from "vitest";
import type { Session } from "../core/types";
import {
  activeAnswer, buildOverviewBlock, buildSessionBlock, buildSuggestions, canSend, chatBuddy, chatMoments, clip, composePrompt, CONTEXT_LIMITS,
  initialChat, isBusy, isSearching, reduceChat, statusText, toolText, type ChatAction, type ChatEvent, type ChatModel,
} from "./chat";

const session = (p: Partial<Session> = {}): Session => ({
  id: "a", project: "pushdocs", cwd: "/p", branch: "PDD-1", termProgram: null, model: "Opus 5.5", status: "working", statusSince: 0,
  lastPrompt: "fix the 409", lastMessage: "Done with the fix.", steps: [], agents: [], background: [], pending: [], startedAt: 0,
  lastEventAt: 0, pid: null, live: true, plan: null, managed: false, messages: [],
  stats: { linesAdded: 0, linesRemoved: 0, contextUsedPct: null, contextTokens: null, contextSize: null, costUsd: null }, ...p,
});

const on = (m = initialChat()): ChatModel => reduceChat(reduceChat(m, { type: "enabled", on: true, at: 1 }), {
  type: "status", status: { enabled: true, state: "ready", claudeFound: true, provider: "claude", model: "haiku", webSearch: true, mode: "web", controlReady: false }, at: 1,
});
const ev = (m: ChatModel, event: ChatEvent, viewing = true, at = 10): ChatModel => reduceChat(m, { type: "event", event, at, viewing });
const run = (m: ChatModel, ...actions: ChatAction[]): ChatModel => actions.reduce(reduceChat, m);
const send = (text = "hi"): ChatAction => ({ type: "send", text, context: null, at: 5 });
const kinds = (m: ChatModel) => m.items.map((i) => (i.kind === "divider" ? `divider:${i.reason}` : i.kind));

describe("reduceChat transcript", () => {
  it("send adds the user bubble and waits for the turn", () => {
    const m = run(on(), send("hello"));
    expect(kinds(m)).toEqual(["user"]);
    expect(isBusy(m)).toBe(true);
    expect(canSend(m)).toBe(false);
  });

  it("ignores a second send while busy", () => {
    const m = run(on(), send("a"), send("b"));
    expect(m.items).toHaveLength(1);
  });

  it("streams deltas into one assistant item and finishes with the full text", () => {
    let m = run(on(), send());
    m = ev(m, { type: "turn", id: "t1" });
    expect(m.awaiting).toBe(false);
    m = ev(m, { type: "thinking", id: "t1" });
    expect(activeAnswer(m)?.thinking).toBe(true);
    m = ev(m, { type: "delta", id: "t1", text: "Hel" });
    m = ev(m, { type: "delta", id: "t1", text: "lo" });
    const a = activeAnswer(m)!;
    expect(a.text).toBe("Hello");
    expect(a.streaming).toBe(true);
    expect(a.thinking).toBe(false);
    m = ev(m, { type: "done", id: "t1", text: "Hello there", durationMs: 900 });
    expect(isBusy(m)).toBe(false);
    const done = m.items[m.items.length - 1];
    expect(done.kind === "assistant" && done.text).toBe("Hello there");
    expect(done.kind === "assistant" && done.streaming).toBe(false);
  });

  it("keeps the streamed text when done carries none", () => {
    let m = run(on(), send());
    m = ev(m, { type: "delta", id: "t1", text: "abc" });
    m = ev(m, { type: "done", id: "t1", text: "", durationMs: 1 });
    expect(m.items[1].kind === "assistant" && m.items[1].text).toBe("abc");
  });

  it("tracks tool pills by call id and settles them on done", () => {
    let m = run(on(), send());
    m = ev(m, { type: "tool", id: "t1", callId: "c1", tool: "WebSearch", label: "rust news", state: "running" });
    m = ev(m, { type: "tool", id: "t1", callId: "c2", tool: "WebFetch", label: "example.com", state: "running" });
    m = ev(m, { type: "tool", id: "t1", callId: "c1", tool: "WebSearch", label: "rust news", state: "done" });
    expect(activeAnswer(m)!.tools.map((t) => t.state)).toEqual(["done", "running"]);
    m = ev(m, { type: "done", id: "t1", text: "x", durationMs: 5 });
    const a = m.items[1];
    expect(a.kind === "assistant" && a.tools.map((t) => t.state)).toEqual(["done", "done"]);
  });

  it("an error with a turn id marks that answer and ends the turn", () => {
    let m = run(on(), send());
    m = ev(m, { type: "delta", id: "t1", text: "par" });
    m = ev(m, { type: "error", id: "t1", message: "rate limited" });
    expect(isBusy(m)).toBe(false);
    expect(kinds(m)).toEqual(["user", "assistant"]);
    const a = m.items[1];
    expect(a.kind === "assistant" && a.error).toBe("rate limited");
  });

  it("an error without an id becomes its own item", () => {
    const m = ev(run(on(), send()), { type: "error", message: "claude crashed" });
    expect(kinds(m)).toEqual(["user", "error"]);
    expect(isBusy(m)).toBe(false);
  });

  it("sendFailed ends the wait and shows the reason", () => {
    const m = run(on(), send(), { type: "sendFailed", message: "no CLI", at: 6 });
    expect(kinds(m)).toEqual(["user", "error"]);
    expect(isBusy(m)).toBe(false);
  });

  it("stop settles the answer and ignores its late events", () => {
    let m = run(on(), send());
    m = ev(m, { type: "delta", id: "t1", text: "part" });
    m = run(m, { type: "stop", at: 7 });
    expect(isBusy(m)).toBe(false);
    const a = m.items[1];
    expect(a.kind === "assistant" && a.stopped).toBe(true);
    m = ev(m, { type: "delta", id: "t1", text: "more" });
    m = ev(m, { type: "done", id: "t1", text: "part more", durationMs: 1 });
    const b = m.items[1];
    expect(b.kind === "assistant" && b.text).toBe("part");
    expect(m.unread).toBe(false);
  });

  it("reset clears the transcript but keeps the chat on", () => {
    const m = run(run(on(), send()), { type: "reset" });
    expect(m.items).toEqual([]);
    expect(m.enabled).toBe(true);
    expect(isBusy(m)).toBe(false);
  });
});

describe("reduceChat dividers and status", () => {
  it("adds a sleep divider when an enabled chat with history goes off", () => {
    let m = run(on(), send());
    m = ev(m, { type: "done", id: "t1", text: "ok", durationMs: 1 });
    m = ev(m, { type: "status", state: "off" });
    expect(kinds(m)).toEqual(["user", "assistant", "divider:sleep"]);
    m = ev(m, { type: "status", state: "off" });
    expect(m.items).toHaveLength(3);
  });

  it("no divider for an empty transcript", () => {
    expect(ev(on(), { type: "status", state: "off" }).items).toEqual([]);
  });

  it("turning chat off adds one divider and abandons the turn", () => {
    let m = run(on(), send());
    m = ev(m, { type: "delta", id: "t1", text: "x" });
    m = run(m, { type: "enabled", on: false, at: 9 });
    m = ev(m, { type: "status", state: "off" });
    expect(kinds(m)).toEqual(["user", "assistant", "divider:off"]);
    expect(isBusy(m)).toBe(false);
    expect(m.state).toBe("off");
  });

  it("a restart after an error shows a reset divider", () => {
    let m = run(on(), send());
    m = ev(m, { type: "error", message: "boom" });
    m = ev(m, { type: "status", state: "error", detail: "exit 1" });
    m = ev(m, { type: "status", state: "starting" });
    expect(kinds(m)).toEqual(["user", "error", "divider:reset"]);
  });

  it("an error status during a turn ends it with a message", () => {
    let m = run(on(), send());
    m = ev(m, { type: "turn", id: "t1" });
    m = ev(m, { type: "status", state: "error", detail: "died" });
    expect(isBusy(m)).toBe(false);
    const a = m.items[1];
    expect(a.kind === "assistant" && a.error).toBe("died");
  });

  it("stop followed by a restart shows a reset divider, a kept process does not", () => {
    let kept = run(on(), send(), { type: "stop", at: 7 });
    kept = ev(kept, { type: "status", state: "ready" });
    expect(kinds(kept)).toEqual(["user"]);
    let lost = run(on(), send(), { type: "stop", at: 7 });
    lost = ev(lost, { type: "status", state: "starting" });
    expect(kinds(lost)).toEqual(["user", "divider:reset"]);
  });

  it("chat_status sets enabled and whether the CLI exists", () => {
    const m = reduceChat(initialChat(), { type: "status", status: { enabled: true, state: "off", claudeFound: false, provider: "claude", model: "haiku", webSearch: true, mode: "web", controlReady: false }, at: 1 });
    expect(m.enabled).toBe(true);
    expect(m.claudeFound).toBe(false);
    expect(canSend(m)).toBe(false);
    expect(statusText(m)).toBe("Claude CLI not found");
  });
});

describe("unread", () => {
  it("is set when an answer ends while the chat is not on screen", () => {
    const m = ev(run(on(), send()), { type: "done", id: "t1", text: "ok", durationMs: 1 }, false);
    expect(m.unread).toBe(true);
    expect(reduceChat(m, { type: "seen" }).unread).toBe(false);
  });

  it("stays clear while the chat is on screen, and a new send clears it", () => {
    let m = ev(run(on(), send()), { type: "done", id: "t1", text: "ok", durationMs: 1 }, true);
    expect(m.unread).toBe(false);
    m = ev(run(m, send("again")), { type: "done", id: "t2", text: "ok", durationMs: 1 }, false);
    expect(m.unread).toBe(true);
    expect(run(m, send("third")).unread).toBe(false);
  });
});

describe("statusText", () => {
  it("follows the turn", () => {
    let m = run(on(), send());
    expect(statusText(m)).toBe("Thinking");
    m = ev(m, { type: "tool", id: "t1", callId: "c", tool: "WebSearch", label: "q", state: "running" });
    expect(statusText(m)).toBe("Searching the web");
    m = ev(m, { type: "delta", id: "t1", text: "x" });
    m = ev(m, { type: "tool", id: "t1", callId: "c", tool: "WebSearch", label: "q", state: "done" });
    expect(statusText(m)).toBe("Writing");
  });
});

describe("toolText", () => {
  it("words the pills", () => {
    expect(toolText({ callId: "1", tool: "WebSearch", label: "q", state: "running" })).toBe("Searching the web: q");
    expect(toolText({ callId: "1", tool: "WebSearch", label: "q", state: "done" })).toBe("Searched the web: q");
    expect(toolText({ callId: "1", tool: "WebFetch", label: "a.com", state: "done" })).toBe("Read: a.com");
    expect(toolText({ callId: "1", tool: "WebFetch", label: "a.com", state: "error" })).toBe("Could not read: a.com");
    expect(toolText({ callId: "1", tool: "WebSearch", label: "q", state: "error" })).toBe("Web search failed: q");
    expect(toolText({ callId: "1", tool: "Other", label: "", state: "running" })).toBe("Other");
  });
});

describe("context block", () => {
  it("lists project, branch, model, prompt, answer and the last steps", () => {
    const steps = Array.from({ length: 12 }, (_, i) => ({ tool: "Read", label: `Read · F${i}.php`, at: 0, ok: i === 11 ? null : true }));
    const block = buildSessionBlock(session({ steps }));
    expect(block).toContain("Project: pushdocs");
    expect(block).toContain("Branch: PDD-1");
    expect(block).toContain("Model: Opus 5.5");
    expect(block).toContain("Last prompt: fix the 409");
    expect(block).toContain("Last answer: Done with the fix.");
    expect(block).toContain("- Read · F11.php (running)");
    expect(block).toContain("- Read · F4.php (ok)");
    expect(block).not.toContain("F3.php");
  });

  it("clips long text and stays under the total limit", () => {
    const long = "x".repeat(10_000);
    const steps = Array.from({ length: 8 }, () => ({ tool: "Bash", label: `Run · ${long}`, at: 0, ok: false as boolean | null }));
    const block = buildSessionBlock(session({ lastPrompt: long, lastMessage: long, steps }));
    expect(block.length).toBeLessThanOrEqual(CONTEXT_LIMITS.total);
    expect(block.startsWith("<attached-session>")).toBe(true);
    expect(block.endsWith("</attached-session>")).toBe(true);
  });

  it("mentions what the session waits for", () => {
    const block = buildSessionBlock(session({
      status: "needs_you",
      pending: [{ kind: "approval", requestId: "r", tool: "Bash", target: "Bash · rm -rf build", agentId: null, deadline: 0 }],
    }));
    expect(block).toContain("Status: needs you");
    expect(block).toContain("Waiting for the user: permission for Bash · rm -rf build");
  });

  it("composes the prompt with or without a block", () => {
    expect(composePrompt(null, "hi")).toBe("hi");
    expect(composePrompt("<b>", "hi")).toBe("<b>\n\nhi");
  });

  it("clip shortens with an ellipsis", () => {
    expect(clip("  abc  ", 10)).toBe("abc");
    expect(clip("abcdefgh", 5)).toBe("abcd…");
  });

  it("the overview skips recent and stale sessions", () => {
    const block = buildOverviewBlock([session(), session({ id: "b", project: "old", live: false }), session({ id: "c", project: "gone", status: "stale" })]);
    expect(block).toContain("pushdocs");
    expect(block).not.toContain("old");
    expect(block).not.toContain("gone");
  });
});

describe("suggestions", () => {
  it("builds chips from the focused session", () => {
    const out = buildSuggestions([session(), session({ id: "b", project: "fetchdocs" })], "b");
    expect(out[0].label).toBe("What is fetchdocs doing right now?");
    expect(out[0].context).toEqual({ kind: "session", sessionId: "b" });
    expect(out.map((s) => s.id)).toContain("attention");
    expect(out.length).toBeLessThanOrEqual(4);
  });

  it("offers the error chip only when something failed", () => {
    expect(buildSuggestions([session()], "a").map((s) => s.id)).not.toContain("error");
    const failing = session({ steps: [{ tool: "Bash", label: "Run · test", at: 0, ok: false }] });
    expect(buildSuggestions([failing], "a").map((s) => s.id)).toContain("error");
  });

  it("without live sessions it still offers something", () => {
    const out = buildSuggestions([], null);
    expect(out.map((s) => s.id)).toEqual(["web", "can"]);
    expect(out.every((s) => s.context === null)).toBe(true);
  });
});

describe("Buddy", () => {
  const model = (...actions: ChatAction[]) => run(on(), ...actions);
  const none = { typing: false, flash: null } as const;

  it("sleeps while the chat is off", () => {
    expect(chatBuddy(initialChat(), none).state).toBe("sleeping");
  });

  it("walks through the moments of a turn", () => {
    let m = model();
    expect(chatBuddy(m, none).state).toBe("idle");
    m = run(m, send());
    expect(chatBuddy(m, none).state).toBe("thinking");
    m = ev(m, { type: "tool", id: "t1", callId: "c", tool: "WebSearch", label: "q", state: "running" });
    expect(chatBuddy(m, none).state).toBe("searching");
    m = ev(m, { type: "tool", id: "t1", callId: "c", tool: "WebSearch", label: "q", state: "done" });
    m = ev(m, { type: "delta", id: "t1", text: "hi" });
    expect(chatBuddy(m, none).state).toBe("working");
    m = ev(m, { type: "done", id: "t1", text: "hi", durationMs: 1 });
    expect(chatBuddy(m, none).state).toBe("idle");
    expect(chatBuddy(m, { typing: false, flash: "finished" }).state).toBe("finished");
    expect(chatBuddy(m, { typing: false, flash: "error" }).state).toBe("error");
  });

  it("looks down while typing, but only when otherwise idle", () => {
    const m = model();
    expect(chatBuddy(m, { typing: true, flash: null })).toEqual({ state: "idle", lookDown: true });
    expect(chatBuddy(run(m, send()), { typing: true, flash: null }).lookDown).toBe(false);
  });

  it("moments: yawn on starting, happy or proud on done, sounds for search, finish, error and the dot", () => {
    const base = model();
    const starting = ev(base, { type: "status", state: "starting" });
    expect(chatMoments(base, starting, true).emote).toBe("yawn");

    const sent = run(base, send());
    const searching = ev(sent, { type: "tool", id: "t1", callId: "c", tool: "WebSearch", label: "q", state: "running" });
    expect(chatMoments(sent, searching, true).sounds).toEqual(["search"]);

    const done = ev(searching, { type: "done", id: "t1", text: "x", durationMs: 1 }, true);
    expect(chatMoments(searching, done, true)).toMatchObject({ emote: "happy", sounds: ["finish"], finished: true });

    const away = ev(searching, { type: "done", id: "t1", text: "x", durationMs: 1 }, false);
    const moments = chatMoments(searching, away, false);
    expect(moments.emote).toBe("proud");
    expect(moments.sounds).toEqual(["finish", "pop"]);

    const failed = ev(sent, { type: "error", message: "boom" });
    expect(chatMoments(sent, failed, true)).toMatchObject({ failed: true, sounds: ["error"] });
  });

  it("no moments for a plain delta", () => {
    const a = ev(run(model(), send()), { type: "delta", id: "t1", text: "a" });
    const b = ev(a, { type: "delta", id: "t1", text: "b" });
    expect(chatMoments(a, b, true)).toEqual({ sounds: [], emote: null, finished: false, failed: false });
  });
});

describe("control tools", () => {
  const tool = (state: "running" | "done" | "error" | "denied", name = "start_session", label = "Starting a session in Nexa") =>
    ({ type: "tool", id: "t1", callId: "c1", tool: `mcp__buddy__${name}`, label, state }) as const;

  it("uses the backend's label as is", () => {
    expect(toolText({ callId: "c", tool: "mcp__buddy__start_session", label: "Starting a session in Nexa", state: "running" })).toBe("Starting a session in Nexa");
    expect(toolText({ callId: "c", tool: "mcp__buddy__send_prompt", label: "Sent a prompt to Nexa", state: "done" })).toBe("Sent a prompt to Nexa");
  });
  it("says denied, and failed", () => {
    expect(toolText({ callId: "c", tool: "mcp__buddy__stop_session", label: "Stopping Nexa", state: "denied" })).toBe("Stopping Nexa - denied");
    expect(toolText({ callId: "c", tool: "mcp__buddy__stop_session", label: "Stopping Nexa", state: "error" })).toBe("Stopping Nexa - failed");
  });
  it("falls back to a readable name without a label", () => {
    expect(toolText({ callId: "c", tool: "mcp__buddy__list_sessions", label: "", state: "done" })).toBe("Looking at your sessions");
    expect(toolText({ callId: "c", tool: "mcp__buddy__nope", label: "", state: "done" })).toBe("Working with your sessions");
  });
  it("keeps web tools as they were", () => {
    expect(toolText({ callId: "c", tool: "WebSearch", label: "x", state: "running" })).toBe("Searching the web: x");
    expect(toolText({ callId: "c", tool: "WebSearch", label: "x", state: "denied" })).toBe("Web search failed: x");
  });
  it("a running control tool is not a web search: no search status, no search sound", () => {
    const m = ev(ev(on(), { type: "turn", id: "t1" }), tool("running"));
    expect(isSearching(m)).toBe(false);
    expect(statusText(m)).not.toBe("Searching the web");
    expect(chatMoments(ev(on(), { type: "turn", id: "t1" }), m, true).sounds).not.toContain("search");
  });
  it("a denied pill stays denied when the turn ends", () => {
    let m = ev(ev(on(), { type: "turn", id: "t1" }), tool("running"));
    m = ev(m, tool("denied"));
    m = ev(m, { type: "done", id: "t1", text: "Okay.", durationMs: 5 });
    expect(m.items.find((i) => i.kind === "assistant" && i.tools[0].state === "denied")).toBeDefined();
  });
  it("a running control tool settles when the turn ends", () => {
    let m = ev(ev(on(), { type: "turn", id: "t1" }), tool("running"));
    m = ev(m, { type: "done", id: "t1", text: "ok", durationMs: 5 });
    const a = m.items.find((i) => i.kind === "assistant");
    expect(a && a.kind === "assistant" && a.tools[0].state).toBe("done");
  });
});
