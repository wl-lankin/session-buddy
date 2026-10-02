// The model picker in the chat header, as pure logic: the menu rows, which entry is
// active, keyboard order, the change a choice makes and when the picker is locked.

import { modelLabel, type ChatProvider } from "./chatmodel";

export interface PickerSettings {
  chatProvider: ChatProvider;
  chatModel: string;
  chatOllamaModel: string;
}

/** What the last `chat_models` call said; `idle` until the menu was opened once. */
export type LocalModels =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ok"; models: string[] }
  | { state: "down" };

export interface PickerChoice {
  id: string;
  provider: ChatProvider;
  model: string;
  label: string;
  note: string;
  active: boolean;
}

export type PickerRow =
  | { type: "group"; label: string }
  | { type: "choice"; choice: PickerChoice }
  | { type: "status"; text: string; tone: "calm" | "down" }
  | { type: "retry" };

const CLAUDE_CHOICES = [
  { model: "haiku", note: "fast, default" },
  { model: "sonnet", note: "smarter" },
  { model: "opus", note: "most capable" },
] as const;

export const CLAUDE_GROUP = "Claude";
export const LOCAL_GROUP = "On this Mac (Ollama)";
export const OLLAMA_DOWN = "Ollama is not reachable - set its address in Settings";
export const LOCAL_NOTE = "local, no web search";
const WEB_HINT = "web search";
/** A model list younger than this is reused when the menu opens again. */
export const MODELS_TTL_MS = 30_000;

/** The Claude alias a stored `chatModel` stands for; an empty value is the default. */
function claudeAlias(model: string): string {
  const m = model.trim().toLowerCase();
  return m || "haiku";
}

/** The provider and model name the settings select (what the header shows). */
export function selectedModel(s: PickerSettings): { provider: ChatProvider; model: string } {
  return { provider: s.chatProvider, model: s.chatProvider === "ollama" ? s.chatOllamaModel : s.chatModel };
}

export function localStatusText(l: LocalModels): string {
  switch (l.state) {
    case "idle":
    case "loading": return "Looking for local models...";
    case "ok": return l.models.length === 0 ? "No models yet. Try: ollama pull qwen2.5:7b" : `${l.models.length} ${l.models.length === 1 ? "model" : "models"}`;
    case "down": return OLLAMA_DOWN;
  }
}

export function pickerRows(s: PickerSettings, local: LocalModels): PickerRow[] {
  const alias = claudeAlias(s.chatModel);
  const onClaude = s.chatProvider === "claude";
  const known = CLAUDE_CHOICES.some((c) => c.model === alias);
  const rows: PickerRow[] = [{ type: "group", label: CLAUDE_GROUP }];
  const claude = (model: string, label: string, note: string): PickerRow => ({
    type: "choice",
    choice: { id: `claude:${model}`, provider: "claude", model, label, note: `${note} · ${WEB_HINT}`, active: onClaude && alias === model },
  });
  for (const c of CLAUDE_CHOICES) rows.push(claude(c.model, modelLabel("claude", c.model), c.note));
  // A full model id set earlier still needs a place for the check mark.
  if (!known) rows.push(claude(alias, alias, "custom id"));

  rows.push({ type: "group", label: LOCAL_GROUP }, { type: "status", text: localStatusText(local), tone: local.state === "down" ? "down" : "calm" });
  if (local.state === "down") rows.push({ type: "retry" });
  const current = s.chatOllamaModel.trim();
  const names = local.state === "ok" ? local.models : [];
  const shown = current && local.state === "ok" && !names.includes(current) ? [current, ...names] : names;
  for (const name of shown) {
    const missing = !names.includes(name);
    rows.push({
      type: "choice",
      choice: { id: `ollama:${name}`, provider: "ollama", model: name, label: name, note: missing ? "not installed" : LOCAL_NOTE, active: s.chatProvider === "ollama" && name === current },
    });
  }
  return rows;
}

/** Rows the keyboard can land on. */
export const isNavigable = (r: PickerRow): boolean => r.type === "choice" || r.type === "retry";

/** The next navigable row from `from` (-1 for none) in a direction, wrapping around; -1 when there is none. */
export function stepRow(rows: PickerRow[], from: number, dir: 1 | -1): number {
  const n = rows.length;
  for (let i = 1; i <= n; i++) {
    const at = (((from + dir * i) % n) + n) % n;
    if (isNavigable(rows[at])) return at;
  }
  return -1;
}

/** Where focus goes when the menu opens: the active entry, else the first one. */
export function initialRow(rows: PickerRow[]): number {
  const active = rows.findIndex((r) => r.type === "choice" && r.choice.active);
  return active >= 0 ? active : stepRow(rows, -1, 1);
}

/** The settings a choice changes, or null when it is already the active one. */
export function choicePatch(choice: PickerChoice): Partial<PickerSettings> | null {
  if (choice.active) return null;
  return choice.provider === "ollama" ? { chatProvider: "ollama", chatOllamaModel: choice.model } : { chatProvider: "claude", chatModel: choice.model };
}

/** Changing the model would stop a running answer, so the picker waits. */
export function pickerLock(busy: boolean): { disabled: boolean; title: string } {
  return busy
    ? { disabled: true, title: "Wait until the answer is finished, or stop it, to change the model" }
    : { disabled: false, title: "Choose the model" };
}

/** True when the local list has to be asked for again. */
export function modelsStale(l: LocalModels, loadedAt: number, now: number): boolean {
  if (l.state === "idle") return true;
  if (l.state === "loading") return false;
  return l.state === "down" || now - loadedAt > MODELS_TTL_MS;
}
