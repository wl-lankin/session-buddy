// Expanded-island views and the contract every view host follows.

import { h } from "./dom";
import type { IslandViewName } from "../core/layout";
import { buildSessionView } from "./expanded";
import { buildInteraction } from "./cards";
import { buildFinished } from "./finished";
import { buildPlan } from "./plan";
import { buildChatView } from "./chat";
import type { ChatModels } from "../core/bridge";
import type { Settings } from "../core/state";
import type { SuggestionContext } from "../model/chat";

export interface ChatActions {
  send(text: string, context: SuggestionContext): void;
  /** Stops the running answer. */
  stop(): void;
  /** A new chat: clears the transcript and the conversation. */
  reset(): void;
  setEnabled(on: boolean): void;
  /** Saves a new provider/model choice; the backend restarts the process itself. */
  setModel(patch: Partial<Settings>): void;
  /** The local models the Ollama server offers. */
  models(): Promise<ChatModels>;
  /** The user is (or stopped) typing in the composer: Buddy looks down at it. */
  typing(on: boolean): void;
}

export interface ViewActions {
  focus(id: string): void;
  /** Focus a session and show its session view. */
  openSession(id: string): void;
  cycle(dir: 1 | -1): void;
  expand(): void;
  collapse(): void;
  /** Straight to the strip, without waiting for the compact card to rest. */
  minimize(): void;
  /** The pin button: keep the island open, or let it close on its own again. */
  togglePin(): void;
  answer(requestId: string, answer: unknown): void;
  release(requestId: string): void;
  openSettings(): void;
  /** Ask the OS for keyboard focus (hotkey, reply box) or give it back. */
  wantKeyboard(on: boolean): void;
  /** Content height changed: re-run the island geometry. */
  relayout(): void;
  /** The "Recent" pill: show or hide the recent sessions in the tab row. */
  toggleRecent(): void;
  /** View-local state changed (e.g. a folded list): sync the views again. */
  redraw(): void;
  /** The enlarge button: natural size <-> large reading size. */
  toggleEnlarge(): void;
  /** Show the chat view (the bubble button, the `/` key). */
  openChat(): void;
  /** Leave the chat view for the sessions. */
  closeChat(): void;
  chat: ChatActions;
}

export interface ViewHost {
  el: HTMLElement;
  sync(): void;
  tick?(nowMs: number): void;
  /** Natural size of the content: island height for the measured views, width for the strip. */
  measure?(): number;
  /** Island widths the content that must never be truncated needs (session view, see model/size autoWidth). */
  needs?(): number[];
  /** The interaction card on screen; enlarging is reset when it changes. */
  anchorId?(): string | null;
  /** Return true when the key was handled. */
  key?(e: KeyboardEvent): boolean;
  /** The view just came on screen / just left it. */
  shown?(): void;
  hidden?(): void;
  /** Something animates inside the view (it needs full frame rate). */
  busy?(): boolean;
}

function simple(cls: string, title: string, sub: string, extra?: Node): ViewHost {
  const el = h("div", { class: `view ${cls}` }, h("div", { class: "title", text: title }), h("div", { class: "sub", text: sub }), extra);
  return { el, sync() {} };
}

export function buildViews(actions: ViewActions): Map<IslandViewName, ViewHost> {
  return new Map<IslandViewName, ViewHost>([
    ["session", buildSessionView(actions)],
    ["interaction", buildInteraction(actions)],
    ["plan", buildPlan(actions)],
    ["finished", buildFinished(actions)],
    ["empty", simple("empty-view", "No Claude Code sessions yet", "Start claude in any terminal. Sessions appear here on their first event.", h("button", { class: "tab chat-link", text: "Chat with Buddy", title: "Chat with Buddy (/)", onclick: (e: Event) => { e.stopPropagation(); actions.openChat(); } }))],
    ["confused", simple("confused-view", "Ouch.", "Give Buddy a second.")],
    ["greeting", { el: h("div", { class: "view" }), sync() {} }],
    ["chat", buildChatView(actions)],
  ]);
}
