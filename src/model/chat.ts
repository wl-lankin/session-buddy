// Buddy Chat, as pure data: the transcript reducer, the context block for an attached
// session, the suggestion chips and what Buddy does at each chat moment. No DOM.

import type { BotEmoteName, BotStateName } from "../core/layout";
import type { Session } from "../core/types";
import { firstLine } from "./format";

export type ChatState = "off" | "starting" | "ready" | "busy" | "error";

/** The backend's `chat-event` payload (docs/specs/2026-10-02-chat-design.md). */
export type ChatEvent =
  | { type: "status"; state: ChatState; detail?: string }
  | { type: "turn"; id: string }
  | { type: "thinking"; id: string }
  | { type: "delta"; id: string; text: string }
  | { type: "tool"; id: string; callId: string; tool: string; label: string; state: "running" | "done" | "error" }
  | { type: "done"; id: string; text: string; durationMs: number; costUsd?: number }
  | { type: "error"; id?: string; message: string };

export interface ChatStatus { enabled: boolean; state: ChatState; claudeFound: boolean; detail?: string }

export interface ToolPill { callId: string; tool: string; label: string; state: "running" | "done" | "error" }

/** What the user's bubble shows instead of the attached block. */
export interface ContextChip { kind: "session" | "overview"; label: string }

export type DividerReason = "sleep" | "reset" | "off";

export type ChatItem =
  | { kind: "user"; id: string; text: string; context: ContextChip | null; at: number }
  | {
      kind: "assistant"; id: string; turn: string; text: string; tools: ToolPill[];
      thinking: boolean; streaming: boolean; stopped: boolean; error: string | null; at: number; durationMs: number | null;
    }
  | { kind: "divider"; id: string; reason: DividerReason; at: number }
  | { kind: "error"; id: string; message: string; at: number };

export interface ChatModel {
  items: ChatItem[];
  enabled: boolean;
  state: ChatState;
  detail: string | null;
  /** From chat_status; null until it answered. */
  claudeFound: boolean | null;
  /** The turn the backend is answering. */
  turnId: string | null;
  /** Sent, but the backend has not started a turn yet. */
  awaiting: boolean;
  unread: boolean;
  /** Stop was pressed: if the process restarts, the context is gone. */
  stopPending: boolean;
  seq: number;
}

export function initialChat(): ChatModel {
  return { items: [], enabled: false, state: "off", detail: null, claudeFound: null, turnId: null, awaiting: false, unread: false, stopPending: false, seq: 0 };
}

export type ChatAction =
  | { type: "event"; event: ChatEvent; at: number; viewing?: boolean }
  | { type: "status"; status: ChatStatus; at: number }
  | { type: "enabled"; on: boolean; at: number }
  | { type: "send"; text: string; context: ContextChip | null; at: number }
  | { type: "sendFailed"; message: string; at: number }
  | { type: "stop"; at: number }
  | { type: "reset" }
  | { type: "seen" };

type Assistant = Extract<ChatItem, { kind: "assistant" }>;

export const isBusy = (m: ChatModel): boolean => m.awaiting || m.turnId !== null;

/** The answer being written right now. */
export function activeAnswer(m: ChatModel): Assistant | null {
  if (m.turnId === null) return null;
  for (let i = m.items.length - 1; i >= 0; i--) {
    const it = m.items[i];
    if (it.kind === "assistant" && it.turn === m.turnId) return it;
  }
  return null;
}

export const isSearching = (m: ChatModel): boolean => activeAnswer(m)?.tools.some((t) => t.state === "running") ?? false;

const lastIsDivider = (m: ChatModel): boolean => m.items[m.items.length - 1]?.kind === "divider";

function withDivider(m: ChatModel, reason: DividerReason, at: number): ChatModel {
  if (!m.items.length || lastIsDivider(m)) return m;
  return { ...m, items: [...m.items, { kind: "divider", id: `d${m.seq + 1}`, reason, at }], seq: m.seq + 1 };
}

function mapAnswer(m: ChatModel, turn: string, fn: (a: Assistant) => Assistant): ChatModel {
  return { ...m, items: m.items.map((it) => (it.kind === "assistant" && it.turn === turn ? fn(it) : it)) };
}

function ensureAnswer(m: ChatModel, turn: string, at: number): ChatModel {
  if (m.items.some((it) => it.kind === "assistant" && it.turn === turn)) return m;
  const item: Assistant = {
    kind: "assistant", id: `a-${turn}`, turn, text: "", tools: [], thinking: false, streaming: false, stopped: false, error: null, at, durationMs: null,
  };
  return { ...m, items: [...m.items, item] };
}

const settleTools = (tools: ToolPill[], to: "done" | "error"): ToolPill[] => tools.map((t) => (t.state === "running" ? { ...t, state: to } : t));

/** The running turn ends without an answer (process gone, chat turned off). */
function abandonTurn(m: ChatModel, message: string): ChatModel {
  const turn = m.turnId;
  let next: ChatModel = { ...m, turnId: null, awaiting: false };
  if (turn) {
    next = mapAnswer(next, turn, (a) => ({
      ...a, streaming: false, thinking: false, tools: settleTools(a.tools, "error"), error: a.error ?? (a.text ? null : message),
    }));
  }
  return next;
}

function setState(m: ChatModel, state: ChatState, detail: string | null, at: number): ChatModel {
  let next: ChatModel = { ...m, detail };
  if (state === m.state) return next;
  const prev = m.state;
  next.state = state;
  if (state === "off") {
    if (isBusy(next)) next = abandonTurn(next, "The chat stopped before it answered.");
    if (next.enabled) next = withDivider(next, next.stopPending ? "reset" : "sleep", at);
    next.stopPending = false;
  } else if (state === "error") {
    if (isBusy(next)) next = abandonTurn(next, detail ?? "The chat stopped before it answered.");
  } else if (prev === "error" || (next.stopPending && state === "starting")) {
    // A new process has no memory of the old turns.
    next = withDivider(next, "reset", at);
    next.stopPending = false;
  } else if (state === "ready") {
    next.stopPending = false;
  }
  return next;
}

export function reduceChat(m: ChatModel, a: ChatAction): ChatModel {
  switch (a.type) {
    case "status": {
      const next = { ...m, enabled: a.status.enabled, claudeFound: a.status.claudeFound };
      return setState(next, a.status.state, a.status.detail ?? null, a.at);
    }
    case "enabled": {
      if (a.on === m.enabled) return m;
      let next: ChatModel = { ...m, enabled: a.on };
      if (!a.on) {
        next = abandonTurn(next, "Chat was turned off.");
        next = withDivider(next, "off", a.at);
        next = { ...next, state: "off", detail: null, stopPending: false };
      }
      return next;
    }
    case "send": {
      if (isBusy(m)) return m;
      const seq = m.seq + 1;
      return {
        ...m, seq, awaiting: true, unread: false,
        items: [...m.items, { kind: "user", id: `u${seq}`, text: a.text, context: a.context, at: a.at }],
      };
    }
    case "sendFailed": {
      const seq = m.seq + 1;
      return { ...m, seq, awaiting: false, items: [...m.items, { kind: "error", id: `e${seq}`, message: a.message, at: a.at }] };
    }
    case "stop": {
      if (!isBusy(m)) return m;
      let next: ChatModel = { ...m, stopPending: true };
      const turn = m.turnId;
      if (turn) next = mapAnswer(next, turn, (x) => ({ ...x, streaming: false, thinking: false, stopped: true, tools: settleTools(x.tools, "done") }));
      return { ...next, turnId: null, awaiting: false };
    }
    case "reset":
      return { ...m, items: [], turnId: null, awaiting: false, unread: false, stopPending: false };
    case "seen":
      return m.unread ? { ...m, unread: false } : m;
    case "event":
      return reduceEvent(m, a.event, a.at, a.viewing ?? true);
  }
}

function reduceEvent(m: ChatModel, e: ChatEvent, at: number, viewing: boolean): ChatModel {
  switch (e.type) {
    case "status":
      return setState(m, e.state, e.detail ?? null, at);
    case "turn": {
      const next = ensureAnswer(m, e.id, at);
      return { ...next, turnId: e.id, awaiting: false };
    }
    case "thinking": {
      if (isStopped(m, e.id)) return m;
      const next = ensureAnswer(m, e.id, at);
      return { ...mapAnswer(next, e.id, (x) => ({ ...x, thinking: x.text === "" })), turnId: e.id, awaiting: false };
    }
    case "delta": {
      if (isStopped(m, e.id)) return m;
      const next = ensureAnswer(m, e.id, at);
      return { ...mapAnswer(next, e.id, (x) => ({ ...x, text: x.text + e.text, thinking: false, streaming: true })), turnId: e.id, awaiting: false };
    }
    case "tool": {
      if (isStopped(m, e.id)) return m;
      const next = ensureAnswer(m, e.id, at);
      const pill: ToolPill = { callId: e.callId, tool: e.tool, label: e.label, state: e.state };
      return {
        ...mapAnswer(next, e.id, (x) => {
          const has = x.tools.some((t) => t.callId === e.callId);
          return { ...x, thinking: false, tools: has ? x.tools.map((t) => (t.callId === e.callId ? pill : t)) : [...x.tools, pill] };
        }),
        turnId: e.id,
        awaiting: false,
      };
    }
    case "done": {
      if (isStopped(m, e.id)) return m;
      const next = ensureAnswer(m, e.id, at);
      const done = mapAnswer(next, e.id, (x) => ({
        ...x, text: e.text || x.text, streaming: false, thinking: false, tools: settleTools(x.tools, "done"), durationMs: e.durationMs,
      }));
      return { ...done, turnId: m.turnId === e.id ? null : m.turnId, awaiting: false, unread: done.unread || !viewing };
    }
    case "error": {
      const known = e.id !== undefined && m.items.some((it) => it.kind === "assistant" && it.turn === e.id);
      let next = m;
      if (known && e.id) {
        next = mapAnswer(next, e.id, (x) => ({ ...x, streaming: false, thinking: false, tools: settleTools(x.tools, "error"), error: e.message }));
      } else {
        const seq = m.seq + 1;
        next = { ...m, seq, items: [...m.items, { kind: "error", id: `e${seq}`, message: e.message, at }] };
      }
      const ends = e.id === undefined || e.id === m.turnId;
      return ends ? { ...next, turnId: null, awaiting: false } : next;
    }
  }
}

const isStopped = (m: ChatModel, turn: string): boolean => m.items.some((it) => it.kind === "assistant" && it.turn === turn && it.stopped);

export const canSend = (m: ChatModel): boolean => m.enabled && m.claudeFound !== false && !isBusy(m);

/** Header line under the title. */
export function statusText(m: ChatModel): string {
  if (!m.enabled) return "Off";
  if (m.claudeFound === false) return "Claude CLI not found";
  if (isSearching(m)) return "Searching the web";
  if (m.awaiting || m.turnId) return activeAnswer(m)?.text ? "Writing" : "Thinking";
  switch (m.state) {
    case "starting": return "Starting";
    case "error": return "Error";
    case "busy": return "Working";
    case "off": return "Asleep, wakes on your next message";
    case "ready": return "Ready";
  }
}

/** The header dot: the backend's state, but busy as soon as a turn is going. */
export const dotState = (m: ChatModel): ChatState => (!m.enabled ? "off" : isBusy(m) ? "busy" : m.state);

const TOOL_TEXT: Record<string, [running: string, done: string, failed: string]> = {
  WebSearch: ["Searching the web", "Searched the web", "Web search failed"],
  WebFetch: ["Reading", "Read", "Could not read"],
};

export function toolText(t: ToolPill): string {
  const [running, done, failed] = TOOL_TEXT[t.tool] ?? [t.tool, t.tool, `${t.tool} failed`];
  const verb = t.state === "running" ? running : t.state === "error" ? failed : done;
  return t.label ? `${verb}: ${t.label}` : verb;
}

// Context for an attached session

export const CONTEXT_LIMITS = { prompt: 600, answer: 1600, step: 110, steps: 8, pending: 140, total: 3200 };

export function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

const stepMark = (ok: boolean | null): string => (ok === true ? "ok" : ok === false ? "failed" : "running");

function pendingLine(s: Session): string | null {
  const p = s.pending[0];
  if (!p) return null;
  if (p.kind === "approval") return `permission for ${clip(p.target, CONTEXT_LIMITS.pending)}`;
  if (p.kind === "question") return `question: ${clip(p.questions[0]?.question ?? "", CONTEXT_LIMITS.pending)}`;
  return `asked: ${clip(p.message, CONTEXT_LIMITS.pending)}`;
}

export function sessionLabel(s: Pick<Session, "project" | "branch">): string {
  return s.branch ? `${s.project} · ${s.branch}` : s.project;
}

export const sessionChip = (s: Session): ContextChip => ({ kind: "session", label: sessionLabel(s) });
export const overviewChip = (): ContextChip => ({ kind: "overview", label: "All sessions" });

/** What the CLI gets for an attached session. A snapshot, clipped so it never swamps the question. */
export function buildSessionBlock(s: Session): string {
  const build = (stepCount: number, answerMax: number): string => {
    const lines = [
      "<attached-session>",
      "A Claude Code session the user attached from Session Buddy. It is a snapshot, use it to answer.",
      `Project: ${s.project}`,
    ];
    if (s.branch) lines.push(`Branch: ${s.branch}`);
    if (s.model) lines.push(`Model: ${s.model}`);
    lines.push(`Status: ${s.status.replace("_", " ")}`);
    const waiting = pendingLine(s);
    if (waiting) lines.push(`Waiting for the user: ${waiting}`);
    if (s.lastPrompt) lines.push(`Last prompt: ${clip(s.lastPrompt, CONTEXT_LIMITS.prompt)}`);
    if (s.lastMessage?.trim()) lines.push(`Last answer: ${clip(s.lastMessage, answerMax)}`);
    const steps = s.steps.slice(-stepCount);
    if (steps.length) {
      lines.push("Recent steps, oldest first:");
      for (const st of steps) lines.push(`- ${clip(firstLine(st.label, CONTEXT_LIMITS.step), CONTEXT_LIMITS.step)} (${stepMark(st.ok)})`);
    }
    lines.push("</attached-session>");
    return lines.join("\n");
  };
  let block = build(CONTEXT_LIMITS.steps, CONTEXT_LIMITS.answer);
  for (let n = CONTEXT_LIMITS.steps - 1; block.length > CONTEXT_LIMITS.total && n >= 0; n--) block = build(n, CONTEXT_LIMITS.answer);
  if (block.length > CONTEXT_LIMITS.total) block = build(0, 500);
  return block;
}

const OVERVIEW_MAX = 8;

/** One line per live session, for "What needs my attention?". */
export function buildOverviewBlock(sessions: Session[]): string {
  const live = sessions.filter((s) => s.live && s.status !== "stale");
  const lines = ["<attached-sessions>", "The user's Claude Code sessions right now, from Session Buddy. A snapshot, use it to answer."];
  for (const s of live.slice(0, OVERVIEW_MAX)) {
    const parts = [`${sessionLabel(s)}: ${s.status.replace("_", " ")}`];
    const waiting = pendingLine(s);
    if (waiting) parts.push(`waiting for the user (${waiting})`);
    if (s.lastPrompt) parts.push(`last prompt "${clip(firstLine(s.lastPrompt, 100), 100)}"`);
    lines.push(`- ${parts.join("; ")}`);
  }
  if (live.length > OVERVIEW_MAX) lines.push(`- and ${live.length - OVERVIEW_MAX} more`);
  if (!live.length) lines.push("(no live sessions)");
  lines.push("</attached-sessions>");
  return lines.join("\n");
}

export function composePrompt(block: string | null, text: string): string {
  return block ? `${block}\n\n${text}` : text;
}

// Suggestions

export type SuggestionContext = { kind: "session"; sessionId: string } | { kind: "overview" } | null;
export interface Suggestion { id: string; label: string; prompt: string; context: SuggestionContext }

const hasFailure = (s: Session): boolean => s.status === "error" || s.steps.some((st) => st.ok === false);

export function buildSuggestions(sessions: Session[], focusId: string | null): Suggestion[] {
  const live = sessions.filter((s) => s.live && s.status !== "stale");
  const focus = live.find((s) => s.id === focusId) ?? live[0] ?? null;
  const out: Suggestion[] = [];
  if (focus) {
    out.push({
      id: "doing",
      label: `What is ${focus.project} doing right now?`,
      prompt: `What is the session ${focus.project} doing right now? Keep it short.`,
      context: { kind: "session", sessionId: focus.id },
    });
  }
  if (live.length) {
    out.push({ id: "attention", label: "What needs my attention?", prompt: "Which of my sessions need my attention, and why? Keep it short.", context: { kind: "overview" } });
  }
  const failing = focus && hasFailure(focus) ? focus : live.find(hasFailure);
  if (failing) {
    out.push({
      id: "error",
      label: "Explain the last error",
      prompt: `Explain the last error in ${failing.project} and suggest what to try next.`,
      context: { kind: "session", sessionId: failing.id },
    });
  }
  out.push({ id: "web", label: "Search the web for Claude Code news", prompt: "Search the web for the latest Claude Code release notes and tell me what is new.", context: null });
  if (!live.length) out.push({ id: "can", label: "What can you do here?", prompt: "What can you help me with in this little chat?", context: null });
  return out.slice(0, 4);
}

// Buddy

/** How long Buddy shows the finished or error face after an answer ends, ms. */
export const BUDDY_FLASH_MS = 2600;

export interface BuddyInput { typing: boolean; flash: "finished" | "error" | null }

/** The steady face: the spec's table, minus the one-shot emotes (chatMoments). */
export function chatBuddy(m: ChatModel, o: BuddyInput): { state: BotStateName; lookDown: boolean } {
  if (!m.enabled) return { state: "sleeping", lookDown: false };
  const busy = isBusy(m);
  let state: BotStateName = "idle";
  if (o.flash === "error") state = "error";
  else if (isSearching(m)) state = "searching";
  else if (busy) state = activeAnswer(m)?.text ? "working" : "thinking";
  else if (o.flash === "finished") state = "finished";
  return { state, lookDown: o.typing && !busy && state === "idle" };
}

export type ChatSound = "search" | "finish" | "error" | "pop";

const answered = (m: ChatModel): number => m.items.filter((it) => it.kind === "assistant" && it.durationMs !== null).length;
const failures = (m: ChatModel): number => m.items.filter((it) => it.kind === "error" || (it.kind === "assistant" && it.error !== null)).length;
const running = (m: ChatModel): number => m.items.reduce((n, it) => n + (it.kind === "assistant" ? it.tools.filter((t) => t.state === "running").length : 0), 0);

export interface ChatMoments { sounds: ChatSound[]; emote: BotEmoteName | null; finished: boolean; failed: boolean }

/** What changed between two models that deserves a sound or an emote. */
export function chatMoments(prev: ChatModel, next: ChatModel, viewing: boolean): ChatMoments {
  const finished = answered(next) > answered(prev);
  const failed = failures(next) > failures(prev) || (next.state === "error" && prev.state !== "error");
  const sounds: ChatSound[] = [];
  if (running(next) > running(prev)) sounds.push("search");
  if (finished) sounds.push("finish");
  if (failed) sounds.push("error");
  if (!prev.unread && next.unread) sounds.push("pop");
  let emote: BotEmoteName | null = null;
  if (next.enabled && prev.state !== "starting" && next.state === "starting") emote = "yawn";
  if (finished) emote = viewing ? "happy" : "proud";
  return { sounds, emote, finished, failed };
}
