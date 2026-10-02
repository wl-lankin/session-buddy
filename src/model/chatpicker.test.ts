import { describe, expect, it } from "vitest";
import {
  choicePatch, initialRow, localStatusText, MODELS_TTL_MS, modelsStale, OLLAMA_DOWN, selectedModel, pickerLock, pickerRows, stepRow,
  type LocalModels, type PickerChoice, type PickerRow, type PickerSettings,
} from "./chatpicker";

const claude = (chatModel = "haiku"): PickerSettings => ({ chatProvider: "claude", chatModel, chatOllamaModel: "", ollamaEnabled: true });
const local = (chatOllamaModel: string): PickerSettings => ({ chatProvider: "ollama", chatModel: "haiku", chatOllamaModel, ollamaEnabled: true });
const ok = (...models: string[]): LocalModels => ({ state: "ok", models });
const choices = (rows: PickerRow[]): PickerChoice[] => rows.flatMap((r) => (r.type === "choice" ? [r.choice] : []));
const active = (rows: PickerRow[]) => choices(rows).filter((c) => c.active).map((c) => c.id);

describe("selectedModel", () => {
  it("takes the Ollama field for a local provider", () => {
    expect(selectedModel(claude("sonnet"))).toEqual({ provider: "claude", model: "sonnet" });
    expect(selectedModel({ chatProvider: "ollama", chatModel: "opus", chatOllamaModel: "q", ollamaEnabled: true })).toEqual({ provider: "ollama", model: "q" });
  });

  it("falls back to Claude when Ollama is switched off", () => {
    expect(selectedModel({ chatProvider: "ollama", chatModel: "opus", chatOllamaModel: "q", ollamaEnabled: false })).toEqual({ provider: "claude", model: "opus" });
  });
});

describe("pickerRows with Ollama switched off", () => {
  const off: PickerSettings = { chatProvider: "claude", chatModel: "sonnet", chatOllamaModel: "qwen2.5:7b", ollamaEnabled: false };

  it("shows only the Claude group, no status line and no retry", () => {
    const rows = pickerRows(off, { state: "down" });
    expect(rows.filter((r) => r.type === "group").map((r) => (r.type === "group" ? r.label : ""))).toEqual(["Claude"]);
    expect(rows.some((r) => r.type === "status" || r.type === "retry")).toBe(false);
    expect(choices(rows).every((c) => c.provider === "claude")).toBe(true);
    expect(active(rows)).toEqual(["claude:sonnet"]);
  });

  it("never marks a local model active", () => {
    const stale: PickerSettings = { ...off, chatProvider: "ollama" };
    expect(active(pickerRows(stale, ok("qwen2.5:7b")))).toEqual(["claude:sonnet"]);
  });
});

describe("pickerRows", () => {
  it("lists Claude first, in order, each with the web search hint", () => {
    const rows = pickerRows(claude(), ok("a"));
    expect(rows[0]).toEqual({ type: "group", label: "Claude" });
    const c = choices(rows).filter((x) => x.provider === "claude");
    expect(c.map((x) => x.label)).toEqual(["Haiku", "Sonnet", "Opus"]);
    expect(c.every((x) => x.note.endsWith("web search"))).toBe(true);
    expect(c[0].note).toBe("fast, default · web search");
  });
  it("marks exactly one entry active", () => {
    expect(active(pickerRows(claude("opus"), ok("a")))).toEqual(["claude:opus"]);
    expect(active(pickerRows(claude(" Sonnet "), ok("a")))).toEqual(["claude:sonnet"]);
    expect(active(pickerRows(claude(""), ok("a")))).toEqual(["claude:haiku"]);
    expect(active(pickerRows(local("b"), ok("a", "b")))).toEqual(["ollama:b"]);
  });
  it("keeps a custom Claude id selectable", () => {
    const rows = pickerRows(claude("claude-sonnet-4-5"), ok());
    expect(active(rows)).toEqual(["claude:claude-sonnet-4-5"]);
    expect(choices(rows).filter((c) => c.provider === "claude")).toHaveLength(4);
  });
  it("lists local models marked as local without web search", () => {
    const rows = pickerRows(claude(), ok("a", "b"));
    const l = choices(rows).filter((c) => c.provider === "ollama");
    expect(l.map((c) => c.model)).toEqual(["a", "b"]);
    expect(l.every((c) => c.note === "local, no web search" && !c.active)).toBe(true);
    expect(rows).toContainEqual({ type: "status", text: "2 models", tone: "calm" });
  });
  it("flags a chosen local model that is not installed, and keeps it active", () => {
    const rows = pickerRows(local("gone:1b"), ok("a"));
    const gone = choices(rows).find((c) => c.model === "gone:1b");
    expect(gone).toMatchObject({ active: true, note: "not installed" });
  });
  it("shows a calm line and Retry when Ollama is down, no local entries", () => {
    const rows = pickerRows(local("a"), { state: "down" });
    expect(rows).toContainEqual({ type: "status", text: OLLAMA_DOWN, tone: "down" });
    expect(rows.some((r) => r.type === "retry")).toBe(true);
    expect(choices(rows).some((c) => c.provider === "ollama")).toBe(false);
  });
  it("shows the loading and the empty line", () => {
    expect(localStatusText({ state: "loading" })).toMatch(/Looking/);
    expect(localStatusText(ok())).toMatch(/ollama pull/);
    expect(localStatusText(ok("a"))).toBe("1 model");
    expect(pickerRows(claude(), { state: "loading" }).some((r) => r.type === "retry")).toBe(false);
  });
});

describe("keyboard order", () => {
  const rows = pickerRows(claude("sonnet"), { state: "down" });
  it("starts on the active entry, else the first", () => {
    expect(initialRow(rows)).toBe(2);
    expect(initialRow(pickerRows(local("zzz"), { state: "down" }))).toBe(1);
  });
  it("steps over groups and status lines and wraps", () => {
    const kinds = rows.map((r) => r.type);
    let i = initialRow(rows);
    const visited: string[] = [];
    for (let n = 0; n < 5; n++) {
      i = stepRow(rows, i, 1);
      visited.push(kinds[i]);
    }
    expect(visited).toEqual(["choice", "retry", "choice", "choice", "choice"]);
    expect(stepRow(rows, 1, -1)).toBe(rows.findIndex((r) => r.type === "retry"));
  });
  it("finds nothing in a menu without entries", () => {
    expect(stepRow([{ type: "group", label: "x" }], -1, 1)).toBe(-1);
  });
});

describe("choicePatch", () => {
  const find = (s: PickerSettings, id: string) => choices(pickerRows(s, ok("a"))).find((c) => c.id === id) as PickerChoice;
  it("switches to Claude with the alias", () => {
    expect(choicePatch(find(local("a"), "claude:sonnet"))).toEqual({ chatProvider: "claude", chatModel: "sonnet" });
  });
  it("switches to Ollama and writes the Ollama model field only", () => {
    expect(choicePatch(find(claude(), "ollama:a"))).toEqual({ chatProvider: "ollama", chatOllamaModel: "a" });
  });
  it("does nothing for the active entry", () => {
    expect(choicePatch(find(claude(), "claude:haiku"))).toBeNull();
  });
});

describe("pickerLock", () => {
  it("locks while an answer is produced and explains why", () => {
    expect(pickerLock(true)).toMatchObject({ disabled: true });
    expect(pickerLock(true).title).toMatch(/answer/);
    expect(pickerLock(false).disabled).toBe(false);
  });
});

describe("modelsStale", () => {
  it("asks on first open, again after the ttl and after a failure", () => {
    expect(modelsStale({ state: "idle" }, 0, 0)).toBe(true);
    expect(modelsStale({ state: "loading" }, 0, 1e9)).toBe(false);
    expect(modelsStale(ok("a"), 1000, 1000 + MODELS_TTL_MS)).toBe(false);
    expect(modelsStale(ok("a"), 1000, 1001 + MODELS_TTL_MS)).toBe(true);
    expect(modelsStale({ state: "down" }, 1000, 1001)).toBe(true);
  });
});
