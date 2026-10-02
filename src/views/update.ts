// The update card: a release was found (notes, Install and restart / Later), its
// install is running (bar and phase), the install failed (message, Retry), or a
// manual check has a short answer. Nothing installs before the click.

import { h } from "./dom";
import { State } from "../core/state";
import { cardKind, progressLabel, progressPercent, versionLine, type CardKind } from "../model/update";
import { renderMarkdown } from "./markdown";
import { btn, keyed } from "./parts";
import type { ViewActions, ViewHost } from "./views";

/** #content's vertical padding plus the view's own bottom padding. */
const CHROME_H = 22 + 4;
const GAP = 8;

const TITLES: Record<CardKind, string> = { note: "", offer: "Update available", progress: "Updating Session Buddy", error: "Update failed" };

export function buildUpdate(actions: ViewActions): ViewHost {
  const main = h("div", { class: "u-main" });
  const el = h("div", { class: "view update-view" }, main);
  let fill: HTMLElement | null = null;
  let label: HTMLElement | null = null;

  const head = (kind: CardKind): HTMLElement => {
    const note = State.updateNote;
    const bad = kind === "error" || note?.tone === "bad";
    const icon = h("span", { class: `u-icon${bad ? " bad" : ""}`, text: bad ? "!" : kind === "note" ? "\u2713" : "\u2193" });
    return h("div", { class: "u-head" }, icon, h("span", { class: "u-title", text: kind === "note" ? (note?.text ?? "") : TITLES[kind] }));
  };

  const build = (kind: CardKind): Node[] => {
    const info = State.update.info;
    fill = null;
    label = null;
    if (kind === "note") return [head(kind), h("div", { class: "u-foot" }, btn("OK", "secondary", () => actions.collapse()))];
    if (!info) return [];
    const out: Node[] = [head(kind), h("div", { class: "u-sub", text: versionLine(info) })];
    if (kind === "offer" && info.notes?.trim()) out.push(h("div", { class: "u-notes scrollable" }, ...renderMarkdown(info.notes)));
    if (kind === "error") out.push(h("div", { class: "u-error", text: State.update.error ?? "" }));
    if (kind === "progress") {
      fill = h("i");
      label = h("div", { class: "u-label" });
      out.push(h("div", { class: "u-bar" }, fill), label);
    }
    if (kind === "offer") out.push(h("div", { class: "u-foot" }, btn("Install and restart", "primary", () => actions.update.install()), btn("Later", "secondary", () => actions.update.later())));
    if (kind === "error") out.push(h("div", { class: "u-foot" }, btn("Retry", "primary", () => actions.update.install()), btn("Later", "secondary", () => actions.update.later())));
    return out;
  };

  return {
    el,
    sync() {
      const kind = cardKind(State.update, State.updateNote);
      const u = State.update;
      keyed(main, `${kind}|${u.info?.version ?? ""}|${u.info?.notes ?? ""}|${u.error ?? ""}|${State.updateNote?.text ?? ""}`, () => build(kind));
      if (!fill || !label) return;
      const pct = progressPercent(u.downloaded, u.total);
      const busyNow = u.phase === "installing" || u.phase === "restarting";
      fill.parentElement?.classList.toggle("indeterminate", pct == null || busyNow);
      fill.style.width = `${busyNow ? 100 : (pct ?? 0)}%`;
      const text = progressLabel(u);
      if (label.textContent !== text) label.textContent = text;
    },
    measure() {
      const kids = [...main.children] as HTMLElement[];
      return CHROME_H + kids.reduce((sum, k) => sum + k.offsetHeight, 0) + Math.max(0, kids.length - 1) * GAP;
    },
  };
}
