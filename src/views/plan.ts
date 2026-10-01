// "Plan ready": Claude Code waits for its own plan dialog in the terminal (the
// hook cannot answer it), so the island shows the plan read-only and says where
// to choose. Lower priority than real interactions, never pinned.

import { h } from "./dom";
import { State } from "../core/state";
import { planSession } from "../model/plan";
import { renderMarkdown } from "./markdown";
import { keyed, sessionName, statusDot } from "./parts";
import type { ViewHost } from "./views";

export function buildPlan(): ViewHost {
  const head = h("div", { class: "i-head" });
  const body = h("div", { class: "p-plan scrollable" });
  const hint = h("div", { class: "p-hint", text: "Choose in the terminal: auto-accept edits / approve edits manually / keep planning" });
  const el = h("div", { class: "view plan-view" }, head, body, hint);

  return {
    el,
    sync() {
      const s = planSession(State.sessions, State.focusId);
      if (!s) return;
      keyed(head, `${s.id}|${s.status}|${s.project}|${s.branch ?? ""}`, () => [
        statusDot(s),
        sessionName(s, "i-who"),
        h("span", { class: "i-kind", text: "Plan ready" }),
      ]);
      const plan = s.plan ?? "";
      keyed(body, `${s.id}|${plan}`, () => (plan.trim() ? renderMarkdown(plan) : [h("p", { class: "md-p", text: "The plan is shown in the terminal." })]));
    },
  };
}
