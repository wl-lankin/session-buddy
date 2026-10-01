// Expanded-island views and the contract every view host follows.

import { h } from "./dom";
import type { IslandViewName } from "../core/layout";
import { buildSessionView } from "./expanded";
import { buildInteraction } from "./cards";
import { buildFinished } from "./finished";
import { buildPlan } from "./plan";

export interface ViewActions {
  focus(id: string): void;
  /** Focus a session and show its session view. */
  openSession(id: string): void;
  cycle(dir: 1 | -1): void;
  expand(): void;
  collapse(): void;
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
}

function simple(cls: string, title: string, sub: string): ViewHost {
  const el = h("div", { class: `view ${cls}` }, h("div", { class: "title", text: title }), h("div", { class: "sub", text: sub }));
  return { el, sync() {} };
}

export function buildViews(actions: ViewActions): Map<IslandViewName, ViewHost> {
  return new Map<IslandViewName, ViewHost>([
    ["session", buildSessionView(actions)],
    ["interaction", buildInteraction(actions)],
    ["plan", buildPlan(actions)],
    ["finished", buildFinished(actions)],
    ["empty", simple("empty-view", "No Claude Code sessions yet", "Start claude in any terminal. Sessions appear here on their first event.")],
    ["confused", simple("confused-view", "Ouch.", "Give Buddy a second.")],
    ["greeting", { el: h("div", { class: "view" }), sync() {} }],
  ]);
}
