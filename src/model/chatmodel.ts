// Which model the chat runs on, as pure text: labels, the header line and the Off card
// bullets.

export type ChatProvider = "claude" | "ollama";

const ALIASES: Record<string, string> = { haiku: "Haiku", sonnet: "Sonnet", opus: "Opus" };

/** "haiku" -> "Haiku"; a full id or a local model name stays as it is. */
export function modelLabel(provider: ChatProvider, model: string): string {
  const name = model.trim();
  if (provider === "ollama") return name || "Local model";
  return ALIASES[name.toLowerCase()] ?? (name || "Haiku");
}

export interface ModelBadge { name: string; local: boolean; title: string }

/** The model next to the status in the chat header. */
export function modelBadge(provider: ChatProvider, model: string): ModelBadge {
  const name = modelLabel(provider, model);
  const local = provider === "ollama";
  return { name, local, title: local ? `${name} - local, runs on this machine` : `${name} - Claude` };
}

/** What the Off card says really runs. */
export function offLines(o: { provider: ChatProvider; model: string; webSearch: boolean; idleMinutes: number }): string[] {
  const stop = o.idleMinutes > 0 ? `, and stops after ${o.idleMinutes} idle minutes` : "";
  if (o.provider === "ollama") {
    return [
      `Runs ${modelLabel("ollama", o.model)} on this machine through Ollama, only while you use it${stop}`,
      "No web search, no files, no shell: nothing is written to disk",
      "Your messages never leave this computer",
    ];
  }
  return [
    `Runs a background Claude Code with ${modelLabel("claude", o.model)}, only while you use it${stop}`,
    o.webSearch ? "Web search only: no files, no shell, nothing written to disk" : "No files, no shell, nothing written to disk",
    "Your messages go to Anthropic with your own Claude login",
  ];
}
