// A scripted stand-in for the chat backend, used only outside Tauri (npm run dev,
// dev/preview.html): streaming text, a fake web search, a done event.

import type { ChatEvent, ChatState, ChatStatus } from "../model/chat";
import type { ChatModels } from "./bridge";
import { DEFAULT_SETTINGS, State } from "./state";

type Emit = (e: ChatEvent) => void;

let emit: Emit = () => {};
let state: ChatState = "off";
let turns = 0;
let timers: number[] = [];

export function fakeChatListen(handler: Emit) {
  emit = handler;
}

const later = (ms: number, fn: () => void) => {
  timers.push(window.setTimeout(fn, ms));
};

const cancel = () => {
  for (const t of timers) window.clearTimeout(t);
  timers = [];
};

const setStatus = (next: ChatState) => {
  state = next;
  emit({ type: "status", state: next });
};

const SEARCH = /search|web|news|latest|release|find out/i;

function answerFor(text: string, searched: boolean): string {
  const project = /^Project: (.+)$/m.exec(text)?.[1];
  if (text.includes("<attached-sessions>")) {
    return "Two things need you:\n\n- **bankconnect** waits for a permission (`php artisan migrate`)\n- **fetchdocs** asks which driver the import should use\n\nEverything else is working or idle.";
  }
  if (project) {
    return `**${project}** is busy editing the retry code.\n\n1. It read the webhook controller\n2. Its last test run failed, so it is fixing the fake clock\n\nNothing needs you yet. A failing run looks like this:\n\n\`\`\`bash\nnpm test -- webhooks\n\`\`\``;
  }
  if (searched) {
    return "Claude Code ships often. The latest notes mention faster startup and a tidier `/permissions` screen.\n\nRead more in the [release notes](https://docs.claude.com/en/release-notes/claude-code).\n\n- Startup is about twice as fast\n- Plans can be saved as files";
  }
  return "Hi! I run in the background and I can look at your sessions or search the web.\n\nTry attaching a session with **+ Session** and ask what it is doing.";
}

function run(text: string) {
  const id = `t${++turns}`;
  const searched = State.settings.chatProvider !== "ollama" && SEARCH.test(text.split("</attached-session>").pop() ?? text);
  const full = answerFor(text, searched);
  setStatus("busy");
  emit({ type: "turn", id });
  let at = 350;
  later(at, () => emit({ type: "thinking", id }));
  if (searched) {
    at += 700;
    later(at, () => emit({ type: "tool", id, callId: `c${turns}`, tool: "WebSearch", label: "claude code release notes", state: "running" }));
    at += 2200;
    later(at, () => emit({ type: "tool", id, callId: `c${turns}`, tool: "WebSearch", label: "claude code release notes", state: "done" }));
    at += 200;
  } else {
    at += 500;
  }
  // Bursty on purpose: the view has to smooth it out.
  let i = 0;
  const step = () => {
    if (i >= full.length) {
      emit({ type: "done", id, text: full, durationMs: at, costUsd: 0.0012 });
      setStatus("ready");
      return;
    }
    const n = 2 + Math.floor(Math.random() * 14);
    emit({ type: "delta", id, text: full.slice(i, i + n) });
    i += n;
    later(45 + Math.random() * 60, step);
  };
  later(at, step);
}

function ensureRunning(then: () => void) {
  if (state === "off" || state === "error") {
    setStatus("starting");
    later(State.settings.chatProvider === "ollama" ? 1600 : 700, () => {
      setStatus("ready");
      then();
    });
  } else then();
}

const FAKE_MODELS = ["qwen2.5:7b", "gemma2:9b", "mistral-small:latest"];

/** ?ollama=down or ?ollama=empty in the page URL picks the unreachable or the empty answer. */
function fakeModels(url: unknown): ChatModels {
  const mode = new URLSearchParams(location.search).get("ollama");
  const target = String(url || State.settings.chatOllamaUrl);
  if (mode === "down" || /offline/.test(target)) return { reachable: false, models: [], error: "connection refused" };
  if (mode === "empty") return { reachable: true, models: [] };
  return { reachable: true, models: FAKE_MODELS };
}

const runKey = (c: typeof DEFAULT_SETTINGS) => `${c.chatProvider}|${c.chatProvider === "ollama" ? c.chatOllamaModel : c.chatModel}|${c.chatOllamaUrl}`;
let lastRun = runKey(DEFAULT_SETTINGS);

/** The real backend stops the process when provider, model or address change. */
function settingsSaved() {
  const { chatProvider: provider, chatModel, chatOllamaModel } = State.settings;
  const model = provider === "ollama" ? chatOllamaModel : chatModel;
  const key = runKey(State.settings);
  if (key === lastRun) return;
  lastRun = key;
  cancel();
  state = "off";
  emit({ type: "status", state: "off", provider, model, webSearch: provider !== "ollama" });
}

export function fakeChat(cmd: string, args?: Record<string, unknown>): { value: unknown } | null {
  const enabled = State.settings.chatEnabled;
  switch (cmd) {
    case "chat_status": {
      const { chatProvider: provider, chatModel, chatOllamaModel } = State.settings;
      const local = provider === "ollama";
      const status: ChatStatus = {
        enabled, state: enabled ? state : "off", claudeFound: true, provider, model: local ? chatOllamaModel : chatModel, webSearch: !local,
      };
      return { value: status };
    }
    case "save_settings":
      settingsSaved();
      return { value: undefined };
    case "chat_models":
      return { value: fakeModels(args?.url) };
    case "chat_wake":
      if (enabled && state === "off") ensureRunning(() => {});
      return { value: undefined };
    case "chat_send":
      ensureRunning(() => run(String(args?.text ?? "")));
      return { value: undefined };
    case "chat_interrupt":
      cancel();
      setStatus("ready");
      return { value: undefined };
    case "chat_reset":
      cancel();
      setStatus("off");
      return { value: undefined };
    default:
      return null;
  }
}
