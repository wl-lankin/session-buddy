// Hover / event state: one session card, flip with the wheel or the arrows.

import { h, svg } from "./dom";
import { ICONS } from "./icons";
import { State } from "../core/state";
import { fmtPct, level } from "../model/format";
import { currentActivity, sessionTitle, statusLine } from "../model/viewmodel";
import { linesChanged, statusDot } from "./parts";
import type { ViewActions, ViewHost } from "./views";

export function buildCompact(actions: ViewActions): ViewHost {
  const title = h("span", { class: "c-title" });
  const lines = h("span", { class: "c-lines" });
  const ctx = h("span", { class: "c-ctx" });
  const page = h("span", { class: "c-page" });
  const prev = h("button", { class: "icon-btn", title: "Previous session", onclick: (e: Event) => { e.stopPropagation(); actions.cycle(-1); } }, svg(ICONS.chevronLeft, 10, { stroke: 2.4 }));
  const next = h("button", { class: "icon-btn", title: "Next session", onclick: (e: Event) => { e.stopPropagation(); actions.cycle(1); } }, svg(ICONS.chevronRight, 10, { stroke: 2.4 }));
  const pager = h("span", { class: "c-pager" }, prev, page, next);
  const status = h("span", { class: "c-status" });
  const activity = h("span", { class: "c-activity" });
  const el = h(
    "div",
    { class: "layer compact" },
    h("div", { class: "c-row1" }, title, lines, ctx, pager),
    h("div", { class: "c-row2" }, status, activity),
  );

  return {
    el,
    sync() {
      const s = State.focus;
      const all = State.sessions;
      if (!s) {
        title.textContent = "No sessions yet";
        lines.replaceChildren();
        ctx.textContent = "";
        pager.style.display = "none";
        status.replaceChildren(document.createTextNode("Start claude in any terminal"));
        activity.textContent = "";
        return;
      }
      title.textContent = sessionTitle(s);
      lines.replaceChildren(...(s.stats.linesAdded || s.stats.linesRemoved ? linesChanged(s.stats.linesAdded, s.stats.linesRemoved) : []));
      const pct = s.stats.contextUsedPct;
      ctx.textContent = pct == null ? "" : `ctx ${fmtPct(pct)}%`;
      ctx.className = `c-ctx ${level(pct)}`;
      pager.style.display = all.length > 1 ? "" : "none";
      page.textContent = `${all.indexOf(s) + 1}/${all.length}`;
      status.replaceChildren(statusDot(s), document.createTextNode(statusLine(s, Date.now())));
      const flashing = State.flash?.sessionId === s.id && !!s.lastMessage;
      activity.textContent = flashing ? (s.lastMessage ?? "") : currentActivity(s);
      activity.classList.toggle("shimmer", !flashing && (s.status === "working" || s.status === "thinking"));
      activity.classList.toggle("flash", flashing);
    },
    tick() {
      // Keeps the "4m 12s" counter moving while the compact island is visible.
      const s = State.focus;
      if (s && (s.status === "working" || s.status === "thinking")) {
        const text = statusLine(s, Date.now());
        if (status.lastChild?.textContent !== text) status.replaceChildren(statusDot(s), document.createTextNode(text));
      }
    },
  };
}
