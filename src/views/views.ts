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
}

export interface ViewHost {
  el: HTMLElement;
  sync(): void;
  tick?(nowMs: number): void;
  measure?(): number;
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
    ["plan", buildPlan()],
    ["finished", buildFinished(actions)],
    ["empty", simple("empty-view", "No Claude Code sessions yet", "Start claude in Warp or any terminal. Sessions appear here on their first event.")],
    ["confused", simple("confused-view", "Ouch.", "Give Mochi a second.")],
    ["greeting", { el: h("div", { class: "view" }), sync() {} }],
  ]);
}
