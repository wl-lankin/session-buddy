import { describe, expect, it } from "vitest";
import { initialChat, reduceChat, statusText, buildSuggestions, type ChatAction, type ChatModel, type ChatStatus } from "./chat";
import { modelBadge, modelLabel, offLines } from "./chatmodel";

describe("modelLabel and modelBadge", () => {
  it("names Claude aliases and keeps full ids", () => {
    expect(modelLabel("claude", "haiku")).toBe("Haiku");
    expect(modelLabel("claude", "OPUS")).toBe("Opus");
    expect(modelLabel("claude", "claude-sonnet-4-5")).toBe("claude-sonnet-4-5");
    expect(modelLabel("claude", "")).toBe("Haiku");
  });
  it("marks a local model", () => {
    expect(modelBadge("ollama", "qwen2.5:7b")).toMatchObject({ name: "qwen2.5:7b", local: true, title: "qwen2.5:7b - local, runs on this machine" });
    expect(modelBadge("ollama", "").name).toBe("Local model");
    expect(modelBadge("claude", "sonnet").local).toBe(false);
  });
});

describe("offLines", () => {
  it("describes Claude with web search", () => {
    const l = offLines({ provider: "claude", model: "sonnet", webSearch: true, idleMinutes: 10 });
    expect(l[0]).toBe("Runs a background Claude Code with Sonnet, only while you use it, and stops after 10 idle minutes");
    expect(l[1]).toMatch(/^Web search only/);
  });
  it("describes a local model without web search", () => {
    const l = offLines({ provider: "ollama", model: "gemma2:9b", webSearch: false, idleMinutes: 0 });
    expect(l[0]).toBe("Runs gemma2:9b on this machine through Ollama, only while you use it");
    expect(l.join(" ")).toContain("No web search");
    expect(l.join(" ")).toContain("never leave this computer");
  });
});

const status = (over: Partial<ChatStatus> = {}): ChatAction => ({
  type: "status", at: 1, status: { enabled: true, state: "ready", claudeFound: true, provider: "claude", model: "haiku", webSearch: true, ...over },
});

describe("chat model in the reducer", () => {
  const withItem = (m: ChatModel): ChatModel => reduceChat(m, { type: "send", text: "hi", context: null, at: 2 });

  it("takes provider, model and web search from the status", () => {
    const m = reduceChat(initialChat(), status({ provider: "ollama", model: "qwen2.5:7b", webSearch: false }));
    expect([m.provider, m.model, m.webSearch]).toEqual(["ollama", "qwen2.5:7b", false]);
  });
  it("says Loading the model while a local model starts", () => {
    const m = reduceChat(initialChat(), status({ provider: "ollama", model: "x", state: "starting" }));
    expect(statusText(m)).toBe("Loading the model");
    expect(statusText(reduceChat(initialChat(), status({ state: "starting" })))).toBe("Starting");
  });
  it("shows New context when the model changed before the process stopped", () => {
    let m = withItem(reduceChat(initialChat(), status()));
    m = reduceChat(m, { type: "event", at: 3, event: { type: "status", state: "off", provider: "claude", model: "sonnet" } });
    expect(m.items.at(-1)).toMatchObject({ kind: "divider", reason: "model" });
  });
  it("keeps the sleep divider when the model is the same", () => {
    let m = withItem(reduceChat(initialChat(), status()));
    m = reduceChat(m, { type: "event", at: 3, event: { type: "status", state: "off" } });
    expect(m.items.at(-1)).toMatchObject({ kind: "divider", reason: "sleep" });
  });
  it("does not call the first status a change", () => {
    const m = withItem(reduceChat(initialChat(), status({ provider: "ollama", model: "x", state: "off" })));
    expect(m.items.some((i) => i.kind === "divider")).toBe(false);
  });
});

describe("web suggestion", () => {
  it("is dropped without web search", () => {
    expect(buildSuggestions([], null, true).map((s) => s.id)).toContain("web");
    expect(buildSuggestions([], null, false).map((s) => s.id)).not.toContain("web");
  });
});
