import { h } from "./dom";
import type { ViewActions, ViewHost } from "./views";

export function buildInteraction(_actions: ViewActions): ViewHost {
  return { el: h("div", { class: "view", text: "interaction view (Task 12)" }), sync() {} };
}
