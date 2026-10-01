// Small building blocks shared by the views.

import { h, clear, svg } from "./dom";
import { ICONS } from "./icons";
import { colorForProject } from "../core/layout";
import type { Session } from "../core/types";
import { fmtAdded, fmtRemoved, level } from "../model/format";
import { sessionTitle, statusGlyph } from "../model/viewmodel";

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

/** The branch chip: a git-branch glyph and the branch name. */
export function branchChip(branch: string): HTMLElement {
  return h("span", { class: "branch" }, svg(ICONS.branch, 10, { stroke: 2.4 }), h("span", { class: "branch-name", text: branch }));
}

/** Project name (shrinks with an ellipsis) and the branch as its own chip that stays visible. */
export function sessionName(s: Session, cls = ""): HTMLElement {
  return h(
    "span",
    { class: `sname ${cls}`.trim(), title: sessionTitle(s) },
    h("span", { class: "sname-project", text: s.project }),
    s.branch ? branchChip(s.branch) : null,
  );
}
