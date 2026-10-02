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

/** Streams `full` in bursts from `at` ms on, then ends the turn. */
function streamAnswer(id: string, full: string, at: number) {
  streamAnswer(id, full, at);
}

/** A control-mode start waiting for the confirmation card (answered through the `answer` command). */
let pendingStart: { id: string; callId: string; project: string } | null = null;

const START = /start (?:a |an |another )?(?:new )?session in ([\w.-]+)/i;

function runControl(text: string) {
  const id = `t${++turns}`;
  const tool = (callId: string, name: string, label: string, state: "running" | "done" | "denied") =>
    emit({ type: "tool", id, callId, tool: `mcp__buddy__${name}`, label, state });
  setStatus("busy");
  emit({ type: "turn", id });
  later(350, () => emit({ type: "thinking", id }));
  const start = START.exec(text);
  if (start) {
    const project = start[1];
    later(900, () => tool(`${id}a`, "list_projects", "Looking at your projects", "running"));
    later(1500, () => tool(`${id}a`, "list_projects", "Looking at your projects", "done"));
    later(1900, () => {
      tool(`${id}b`, "start_session", `Starting a session in ${project}`, "running");
      pendingStart = { id, callId: `${id}b`, project };
      window.dispatchEvent(new CustomEvent("sb-fake-start", { detail: { project } }));
    });
    return;
  }
  if (/project|folder/i.test(text)) {
    later(800, () => tool(`${id}c`, "list_projects", "Looking at your projects", "running"));
    later(1300, () => tool(`${id}c`, "list_projects", "Looking at your projects", "done"));
    streamAnswer(id, "I can start sessions in these folders:\n\n- **nexa-web**\n- **client-sites/nexa**\n- **session-buddy**\n\nSay *start a session in nexa-web* and I will ask you to confirm.", 1500);
    return;
  }
  later(800, () => tool(`${id}c`, "list_sessions", "Looking at your sessions", "running"));
  later(1400, () => tool(`${id}c`, "list_sessions", "Looking at your sessions", "done"));
  streamAnswer(id, "Three sessions are running:\n\n- **pushdocs** is editing the DATEV client\n- **bankconnect** waits for a permission (`php artisan migrate`)\n- **fetchdocs** asks which driver the import should use\n\nNothing else needs you.", 1600);
}

function finishStart(allow: boolean) {
  const p = pendingStart;
  if (!p) return;
  pendingStart = null;
  emit({ type: "tool", id: p.id, callId: p.callId, tool: "mcp__buddy__start_session", label: allow ? `Started a session in ${p.project}` : `Starting a session in ${p.project}`, state: allow ? "done" : "denied" });
  streamAnswer(p.id, allow ? `Started. **${p.project}** is running in the background, you can follow it in the tabs and send it more prompts there.` : "Okay, I did not start anything.", 500);
}

function run(text: string) {
  if (State.settings.chatMode === "control") {
    runControl(text);
    return;
  }
  const id = `t${++turns}`;
  const searched = State.settings.chatProvider !== "ollama" && SEARCH.test(text.split("</attached-session>").pop() ?? text);
  const full = answerFor(text, searched);
  setStatus("busy");
  emit({ type: "turn", id });
  let at = 350;
  later(at, () => emit({ type: "thinking", id }));
  if (searched) {
    at += 700;
    later(at, () => emit({ type: "tool", id, callId: `${id}c`, tool: "WebSearch", label: "claude code release notes", state: "running" }));
    at += 2200;
    later(at, () => emit({ type: "tool", id, callId: `${id}c`, tool: "WebSearch", label: "claude code release notes", state: "done" }));
    at += 200;
  } else {
    at += 500;
  }
  streamAnswer(id, full, at);
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

/** What the fake folder dialog answers on its turns; the last one is "cancelled". */
const PICKS: (string | null)[] = ["/Users/alex/Projects/nexa-web-v2", "/Users/alex/Code/experiments/nexa", null];
let picked = 0;

const FAKE_MODELS = ["qwen2.5:7b", "gemma2:9b", "mistral-small:latest"];

/** ?ollama=down or ?ollama=empty in the page URL picks the unreachable or the empty answer. */
function fakeModels(url: unknown): ChatModels {
  const mode = new URLSearchParams(location.search).get("ollama");
  const target = String(url || State.settings.chatOllamaUrl);
  if (mode === "down" || /offline/.test(target)) return { reachable: false, models: [], error: "connection refused" };
  if (mode === "empty") return { reachable: true, models: [] };
  return { reachable: true, models: FAKE_MODELS };
}

const runKey = (c: typeof DEFAULT_SETTINGS) => `${c.chatProvider}|${c.chatProvider === "ollama" ? c.chatOllamaModel : c.chatModel}|${c.chatOllamaUrl}|${c.chatMode}`;
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
  pendingStart = null;
  emit({ type: "status", state: "off", provider, model, webSearch: provider !== "ollama" && State.settings.chatMode === "web", mode: State.settings.chatMode, controlReady: State.settings.chatProjectRoots.length > 0 });
}

export function fakeChat(cmd: string, args?: Record<string, unknown>): { value: unknown } | null {
  const enabled = State.settings.chatEnabled;
  switch (cmd) {
    case "chat_status": {
      const { chatProvider: provider, chatModel, chatOllamaModel } = State.settings;
      const local = provider === "ollama";
      const status: ChatStatus = {
        enabled, state: enabled ? state : "off", claudeFound: true, provider, model: local ? chatOllamaModel : chatModel,
        webSearch: !local && State.settings.chatMode === "web", mode: State.settings.chatMode, controlReady: State.settings.chatProjectRoots.length > 0,
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
    case "pick_folder":
      return { value: PICKS[picked++ % PICKS.length] };
    case "session_message_send":
      return { value: /fail/i.test(String(args?.text ?? "")) ? "That session is busy with another prompt." : null };
    case "session_message_cancel":
      return { value: null };
    case "focus_terminal":
      return { value: null };
    case "worker_stop":
      return { value: null };
    case "answer": {
      const a = args?.answer as { allow?: boolean } | undefined;
      if (typeof a?.allow === "boolean") finishStart(a.allow);
      return { value: undefined };
    }
    case "chat_reset":
      pendingStart = null;
      cancel();
      setStatus("off");
      return { value: undefined };
    default:
      return null;
  }
}
