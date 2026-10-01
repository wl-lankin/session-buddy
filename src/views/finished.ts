// The finished card: a green-washed block that says which session (or sessions)
// just finished, how long the turn took and what Claude said last (up to six
// lines, the rest scrolls). One finished session: clicking the card opens it.
// Several: one line per session, clicking a line opens that session. OK closes the island.

import { dot, h } from "./dom";
import { colorForProject } from "../core/layout";
import { State } from "../core/state";
import { fmtDuration } from "../model/format";
import { finishLines, finishTitle, type FinishItem } from "../model/finish";
import { btn, enlargeButton, keyed } from "./parts";
import type { ViewActions, ViewHost } from "./views";

const WASH = "rgba(52, 211, 153, 0.5)";
/** #content's vertical padding, the view's bottom padding, the card's border and padding. */
const CHROME_H = 22 + 2 + 2 + 24;

function messageOf(id: string): string | null {
  return State.sessions.find((s) => s.id === id)?.lastMessage ?? null;
}

function row(actions: ViewActions, item: FinishItem): HTMLElement {
  const first = finishLines(messageOf(item.sessionId), 1);
  return h(
    "div",
    {
      class: "f-row",
      title: `Open ${item.project}`,
      onclick: (e: Event) => {
        e.stopPropagation();
        actions.openSession(item.sessionId);
      },
    },
    dot(colorForProject(item.project), 6),
    h("span", { class: "f-project", text: item.project }),
    item.turnMs != null ? h("span", { class: "f-time", text: fmtDuration(item.turnMs) }) : null,
    first ? h("span", { class: "f-line", text: first }) : null,
  );
}

function content(actions: ViewActions, items: FinishItem[]): Node[] {
  const title = h("div", { class: "f-title" }, h("span", { class: "f-check", text: "✓" }), h("span", { class: "f-text", text: finishTitle(items) }));
  if (items.length === 1) {
    const text = finishLines(messageOf(items[0].sessionId), Infinity);
    return [title, h("div", { class: "f-message f-body scrollable", text: text || "Done." })];
  }
  const newest = [...items].reverse();
  return [title, h("div", { class: "f-list f-body scrollable" }, ...newest.map((x) => row(actions, x)))];
}

export function buildFinished(actions: ViewActions): ViewHost {
  const main = h("div", { class: "f-main" });
  const enlarge = enlargeButton(() => actions.toggleEnlarge());
  const foot = h("div", { class: "f-foot" }, enlarge.el, btn("OK", "secondary", () => actions.collapse()));
  const card = h(
    "div",
    {
      class: "card wash f-card",
      onclick: () => {
        // Selecting text in the message is not a click on the card.
        if (window.getSelection()?.isCollapsed === false) return;
        // Several sessions: each line opens its own; the card itself does nothing.
        if (State.finished.length === 1) actions.openSession(State.finished[0].sessionId);
      },
    },
    main,
    foot,
  );
  card.style.setProperty("--wash", WASH);
  const el = h("div", { class: "view finished-view" }, card);

  return {
    el,
    sync() {
      enlarge.refresh();
      const items = State.finished;
      const messages = items.map((x) => messageOf(x.sessionId));
      card.classList.toggle("single", items.length === 1);
      card.title = items.length === 1 ? "Open this session" : "";
      keyed(main, JSON.stringify([items, messages]), () => (items.length ? content(actions, items) : []));
    },
    measure() {
      // Title, gap and the body at its natural height (its max-height caps it at six lines).
      const kids = [...main.children] as HTMLElement[];
      const gap = parseFloat(getComputedStyle(main).rowGap) || 0;
      const mainH = kids.reduce((sum, k) => {
        if (!k.classList.contains("f-body")) return sum + k.offsetHeight;
        const cap = parseFloat(getComputedStyle(k).maxHeight);
        return sum + (Number.isFinite(cap) ? Math.min(k.scrollHeight, cap) : k.scrollHeight);
      }, 0) + Math.max(0, kids.length - 1) * gap;
      const footH = [...foot.children].reduce((sum, k) => sum + (k as HTMLElement).offsetHeight, 0) + 8;
      return CHROME_H + Math.max(mainH, footH);
    },
  };
}
