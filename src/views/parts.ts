// Small building blocks shared by the views.

import { h, clear } from "./dom";
import { colorForProject } from "../core/layout";
import type { Session } from "../core/types";
import { fmtAdded, fmtRemoved, level } from "../model/format";
import { statusGlyph } from "../model/viewmodel";

export function bar(pct: number | null, width = 64): HTMLElement {
  const fill = h("i", { style: `width:${Math.max(0, Math.min(100, pct ?? 0))}%` });
  return h("span", { class: `bar ${level(pct)}`, style: `width:${width}px` }, fill);
}

export function statusDot(s: Session): HTMLElement {
  return h("span", { class: `sglyph ${s.status}`, style: `--c:${colorForProject(s.project)}`, text: statusGlyph(s.status) });
}

export function btn(label: string, kind: "primary" | "secondary" | "danger", onClick: () => void, title?: string): HTMLButtonElement {
  return h("button", { class: `btn ${kind}`, title, onclick: (e: Event) => { e.stopPropagation(); onClick(); } }, h("span", { text: label }));
}

/** Rebuilds `container` only when `key` changed, so CSS animations are not restarted on every sync. */
export function keyed(container: HTMLElement, key: string, build: () => Node[]) {
  if (container.dataset.key === key) return;
  container.dataset.key = key;
  clear(container);
  container.append(...build());
}

/** "+N" in green and "-N" in red as two spans. */
export function linesChanged(added: number, removed: number): Node[] {
  return [h("span", { class: "ln-add", text: fmtAdded(added) }), document.createTextNode(" "), h("span", { class: "ln-del", text: fmtRemoved(removed) })];
}
