// The resting island: a slim bar that is always on screen.

import { h, clear } from "./dom";
import { colorForProject } from "../core/layout";
import { State } from "../core/state";
import { pillText } from "../model/update";
import { limitParts, recentClass, stripLabel, summarize } from "../model/viewmodel";
import { updatePill } from "./parts";
import type { ViewActions, ViewHost } from "./views";

export function buildStrip(actions: ViewActions): ViewHost {
  const label = h("span", { class: "strip-label" });
  const dots = h("span", { class: "strip-dots" });
  const limits = h("span", { class: "strip-limits" });
  const pill = updatePill(() => actions.update.open());
  // The wrapper only matters beside a notch, where dots and limits share the right wing.
  const el = h("div", { class: "layer strip" }, label, h("span", { class: "strip-right" }, dots, pill.el, limits));
  let dotsKey = "";
  return {
    el,
    measure() {
      // Natural width: padding, the full label (it may be clipped right now), the dots and the limits, plus the gaps.
      const cs = getComputedStyle(el);
      const pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
      const gap = parseFloat(cs.columnGap) || 0;
      if (document.documentElement.classList.contains("notched")) {
        // Two equal wings around the notch, so the notch stays centred: the wider one decides.
        const notch = parseFloat(cs.getPropertyValue("--notch-w")) || 0;
        const left = parseFloat(cs.paddingLeft) + label.scrollWidth;
        const right = dots.scrollWidth + gap + (pill.shown() ? pill.el.scrollWidth + gap : 0) + limits.scrollWidth + parseFloat(cs.paddingRight);
        return 2 * Math.max(left, right) + notch + 16 + 1;
      }
      return pad + label.scrollWidth + dots.scrollWidth + limits.scrollWidth + (pill.shown() ? pill.el.scrollWidth + 3 * gap : 2 * gap) + 1;
    },
    sync() {
      // Only live sessions get a dot (the strip never shows the recent ones).
      const sessions = State.sessions.filter((s) => s.live);
      label.textContent = stripLabel(summarize(sessions));
      const key = sessions.map((s) => `${s.id}:${s.status}:${s.live}`).join("|");
      if (key !== dotsKey) {
        dotsKey = key;
        clear(dots);
        for (const s of sessions) {
          dots.append(h("i", { class: `sdot ${s.status}${recentClass(s)}`, style: `--c:${colorForProject(s.project)}`, title: s.project }));
        }
      }
      pill.set(pillText(State.update));
      const parts = limitParts(State.snapshot.usage);
      const limitsKey = parts.map((p) => `${p.text}:${p.level}`).join("|");
      if (limits.dataset.key !== limitsKey) {
        limits.dataset.key = limitsKey;
        clear(limits);
        parts.forEach((p, i) => {
          if (i) limits.append(" \u00B7 ");
          limits.append(h("span", { class: `lim ${p.level}`, text: p.text }));
        });
      }
    },
  };
}
