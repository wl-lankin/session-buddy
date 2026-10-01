import { describe, expect, it } from "vitest";
import { diffLines, stepKey } from "./stepdetail";

describe("diffLines", () => {
  it("a one-line change is one removed and one added line", () => {
    expect(diffLines("const TVA = 0.196", "const TVA = 0.20")).toEqual([
      { kind: "-", text: "const TVA = 0.196" },
      { kind: "+", text: "const TVA = 0.20" },
    ]);
  });

  it("unchanged lines between two changes stay unchanged", () => {
    const old = ["const TVA = 0.196", "", "export function total() {", "  const sum = 1", "  return sum * (1 + TVA)"].join("\n");
    const next = ["const TVA = 0.20 // 2026", "", "export function total() {", "  const sum = 1", "  return Math.round(sum)"].join("\n");
    expect(diffLines(old, next).map((l) => l.kind + l.text)).toEqual([
      "-const TVA = 0.196",
      "+const TVA = 0.20 // 2026",
      " ",
      " export function total() {",
      " " + "  const sum = 1",
      "-  return sum * (1 + TVA)",
      "+  return Math.round(sum)",
    ]);
  });

  it("a long unchanged run between changes becomes one gap", () => {
    const mid = ["m1", "m2", "m3", "m4", "m5", "m6"];
    const old = ["a", ...mid, "z"].join("\n");
    const next = ["A", ...mid, "Z"].join("\n");
    expect(diffLines(old, next).map((l) => l.kind + l.text)).toEqual(["-a", "+A", " m1", " m2", "gap\u22EF", " m5", " m6", "-z", "+Z"]);
  });

  it("shared lines at the start and the end become context, at most two each", () => {
    const old = ["a", "b", "c", "old", "x", "y", "z"].join("\n");
    const next = ["a", "b", "c", "new", "x", "y", "z"].join("\n");
    expect(diffLines(old, next).map((l) => l.kind + l.text)).toEqual([" b", " c", "-old", "+new", " x", " y"]);
  });

  it("a new file is all added lines", () => {
    expect(diffLines("", "one\ntwo").map((l) => l.kind)).toEqual(["+", "+"]);
  });

  it("long changes fold their rest into one line", () => {
    const lines = diffLines("", Array.from({ length: 50 }, (_, i) => `l${i}`).join("\n"));
    expect(lines).toHaveLength(41);
    expect(lines[40]).toEqual({ kind: "gap", text: "\u2026 10 more lines" });
  });
});

describe("stepKey", () => {
  it("tells steps of the same session apart by time and tool", () => {
    const st = { tool: "Edit", label: "Edit · a.ts", at: 5, ok: true };
    expect(stepKey("s1", st)).toBe("s1@5@Edit");
    expect(stepKey("s1", { ...st, tool: "Bash" })).not.toBe(stepKey("s1", st));
  });
});
