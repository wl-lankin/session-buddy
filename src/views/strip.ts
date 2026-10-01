// The resting island: a slim bar that is always on screen.

import { h, clear } from "./dom";
import { colorForProject } from "../core/layout";
import { State } from "../core/state";
import { limitsShort, recentClass, stripLabel, summarize } from "../model/viewmodel";
import type { ViewHost } from "./views";

export function buildStrip(): ViewHost {
  const label = h("span", { class: "strip-label" });
  const dots = h("span", { class: "strip-dots" });
  const limits = h("span", { class: "strip-limits" });
  const el = h("div", { class: "layer strip" }, label, dots, limits);
  let dotsKey = "";
  return {
    el,
    measure() {
      // Natural width: padding, the full label (it may be clipped right now), the dots and the limits, plus the gaps.
      const cs = getComputedStyle(el);
      const pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
      const gap = parseFloat(cs.columnGap) || 0;
      return pad + label.scrollWidth + dots.scrollWidth + limits.scrollWidth + 2 * gap + 1;
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
      const l = limitsShort(State.snapshot.usage);
      limits.textContent = l.text;
      limits.className = `strip-limits ${l.level}`;
    },
  };
}
