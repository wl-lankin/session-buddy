import { h } from "./dom";
import type { ViewActions, ViewHost } from "./views";

export function buildSessionView(_actions: ViewActions): ViewHost {
  return { el: h("div", { class: "view", text: "session view (Task 11)" }), sync() {} };
}
