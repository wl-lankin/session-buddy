// The resting island: a slim bar that is always on screen.

import { h, clear } from "./dom";
import { colorForProject } from "../core/layout";
import { State } from "../core/state";
import { limitsShort, stripLabel, summarize } from "../model/viewmodel";
import type { ViewHost } from "./views";

export function buildStrip(): ViewHost {
  const label = h("span", { class: "strip-label" });
  const dots = h("span", { class: "strip-dots" });
  const limits = h("span", { class: "strip-limits" });
  const el = h("div", { class: "layer strip" }, label, dots, limits);
  let dotsKey = "";
  return {
    el,
    sync() {
      const sessions = State.sessions;
      label.textContent = stripLabel(summarize(sessions));
      const key = sessions.map((s) => `${s.id}:${s.status}`).join("|");
      if (key !== dotsKey) {
        dotsKey = key;
        clear(dots);
        for (const s of sessions) {
          dots.append(h("i", { class: `sdot ${s.status}`, style: `--c:${colorForProject(s.project)}`, title: s.project }));
        }
      }
      const l = limitsShort(State.snapshot.usage);
      limits.textContent = l.text;
      limits.className = `strip-limits ${l.level}`;
    },
  };
}
