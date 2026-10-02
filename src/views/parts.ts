// Small building blocks shared by the views.

import { h, clear, svg } from "./dom";
import { ICONS } from "./icons";
import { colorForProject } from "../core/layout";
import type { Session } from "../core/types";
import { fmtAdded, fmtRemoved, level, type Level } from "../model/format";
import { sessionTitle, statusGlyph } from "../model/viewmodel";
import { State } from "../core/state";

/** A width of 0 leaves the width to CSS. */
export function bar(pct: number | null, width = 64, lvl: Level = level(pct)): HTMLElement {
  const fill = h("i", { style: `width:${Math.max(0, Math.min(100, pct ?? 0))}%` });
  return h("span", { class: `bar ${lvl}`, style: width > 0 ? `width:${width}px` : undefined }, fill);
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

/** The enlarge toggle (top right of a card): one per view, refreshed on every sync. */
export function enlargeButton(onToggle: () => void): { el: HTMLButtonElement; refresh(): void } {
  const el = h("button", {
    class: "enlarge",
    onclick: (e: Event) => {
      e.stopPropagation();
      onToggle();
    },
  });
  const refresh = () => {
    const big = State.manualH != null;
    const text = big ? "\u2921" : "\u2922";
    if (el.textContent !== text) el.textContent = text;
    el.title = big ? "Back to the normal size" : "Enlarge (or drag the grip at the bottom edge)";
    el.classList.toggle("on", big);
  };
  refresh();
  return { el, refresh };
}

/** The pin toggle: keeps the island open. Filled while pinned. */
export function pinButton(onToggle: () => void): { el: HTMLButtonElement; refresh(): void } {
  const el = h("button", {
    class: "enlarge pin",
    onclick: (e: Event) => {
      e.stopPropagation();
      onToggle();
    },
  }, svg(ICONS.pin, 14, { stroke: 1.8 }));
  const refresh = () => {
    el.classList.toggle("on", State.userPinned);
    el.title = State.userPinned ? "Unpin: let the island close on its own" : "Pin: keep the island open";
  };
  refresh();
  return { el, refresh };
}

/** Natural width of a row of shrinking items: what its children take now plus what their ellipsis leaves hide. */
export function rowNatural(row: HTMLElement, leaves: string): number {
  const kids = [...row.children] as HTMLElement[];
  const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
  const taken = kids.reduce((sum, k) => sum + k.offsetWidth, 0) + Math.max(0, kids.length - 1) * gap;
  const hidden = [...row.querySelectorAll<HTMLElement>(leaves)].reduce((sum, l) => sum + Math.max(0, l.scrollWidth - l.clientWidth), 0);
  return taken + hidden;
}
