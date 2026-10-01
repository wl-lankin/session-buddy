// The finished card: a green-washed block that says which session (or sessions)
// just finished, how long the turn took and how Claude's last message starts.
// Clicking it opens that session; OK closes the island.

import { dot, h } from "./dom";
import { colorForProject } from "../core/layout";
import { State } from "../core/state";
import { fmtDuration } from "../model/format";
import { finishLines, finishTitle, type FinishItem } from "../model/finish";
import { btn, keyed } from "./parts";
import type { ViewActions, ViewHost } from "./views";

const LIST_ROWS = 3;
const WASH = "rgba(52, 211, 153, 0.5)";

function messageOf(id: string): string | null {
  return State.sessions.find((s) => s.id === id)?.lastMessage ?? null;
}

function row(actions: ViewActions, item: FinishItem): HTMLElement {
  const first = finishLines(messageOf(item.sessionId)).split("\n")[0];
  return h(
    "div",
    {
      class: "f-row",
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
    const text = finishLines(messageOf(items[0].sessionId));
    return [title, h("div", { class: "f-message", text: text || "Done." })];
  }
  const newest = [...items].reverse();
  const rows = newest.slice(0, LIST_ROWS).map((x) => row(actions, x));
  const more = newest.length > LIST_ROWS ? h("div", { class: "f-more", text: `+${newest.length - LIST_ROWS} more` }) : null;
  return [title, h("div", { class: "f-list" }, ...rows, more)];
}

export function buildFinished(actions: ViewActions): ViewHost {
  const main = h("div", { class: "f-main" });
  const foot = h("div", { class: "f-foot" }, btn("OK", "secondary", () => actions.collapse()));
  const card = h(
    "div",
    {
      class: "card wash f-card",
      title: "Open this session",
      onclick: () => {
        const last = State.finished[State.finished.length - 1];
        if (last) actions.openSession(last.sessionId);
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
      const items = State.finished;
      const messages = items.map((x) => messageOf(x.sessionId));
      keyed(main, JSON.stringify([items, messages]), () => (items.length ? content(actions, items) : []));
    },
  };
}
