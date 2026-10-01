// The panel under the steps: an edit as removed and added lines, a command with
// the end of its output. A line diff (longest common subsequence) of Edit's old
// and new text; unchanged lines are kept only next to a change.

import type { Step } from "../core/types";

export type DiffLine = { kind: " " | "-" | "+" | "gap"; text: string };

/** Unchanged lines kept around a change. */
const CONTEXT = 2;
/** Lines per hunk before the rest is folded into "…". */
const MAX_LINES = 40;

/** Identifies a step of a session across snapshots. */
export function stepKey(sessionId: string, step: Step): string {
  return `${sessionId}@${step.at}@${step.tool}`;
}

/** Every line of both texts, in order, marked kept, removed or added. */
function lcsDiff(a: string[], b: string[]): DiffLine[] {
  // The relay caps each text at 2000 characters, so the table stays small.
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ kind: " ", text: a[i] });
      i++;
      j++;
    } else if (j < b.length && (i === a.length || lcs[i][j + 1] >= lcs[i + 1][j])) {
      // Removals first within a change: "- old" reads before "+ new".
      if (i < a.length && lcs[i + 1][j] === lcs[i][j]) out.push({ kind: "-", text: a[i++] });
      else out.push({ kind: "+", text: b[j++] });
    } else {
      out.push({ kind: "-", text: a[i++] });
    }
  }
  return out;
}

export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = oldText === "" ? [] : oldText.split("\n");
  const b = newText === "" ? [] : newText.split("\n");
  const all = lcsDiff(a, b);
  // Keep unchanged lines within CONTEXT of a change; a longer run becomes one gap marker.
  const near = all.map((l, i) => l.kind !== " " || all.slice(Math.max(0, i - CONTEXT), i + CONTEXT + 1).some((x) => x.kind !== " "));
  const out: DiffLine[] = [];
  all.forEach((l, i) => {
    if (near[i]) out.push(l);
    else if (out.length && out[out.length - 1].kind !== "gap" && near.slice(i + 1).some(Boolean)) out.push({ kind: "gap", text: "\u22EF" });
  });
  if (out.length > MAX_LINES) {
    const rest = out.length - MAX_LINES;
    return [...out.slice(0, MAX_LINES), { kind: "gap", text: `\u2026 ${rest} more line${rest === 1 ? "" : "s"}` }];
  }
  return out;
}
