import { describe, expect, it } from "vitest";
import { superellipsePath } from "./mark";

describe("superellipsePath", () => {
  it("puts every point on the superellipse and closes the path", () => {
    const d = superellipsePath(12, 12, 9, 7, 2.7, 24);
    expect(d.startsWith("M")).toBe(true);
    expect(d.endsWith("Z")).toBe(true);
    const pts = d.slice(1, -1).split("L").map((p) => p.split(" ").map(Number));
    expect(pts).toHaveLength(24);
    for (const [x, y] of pts) {
      const v = Math.abs((x - 12) / 9) ** 2.7 + Math.abs((y - 12) / 7) ** 2.7;
      expect(v).toBeCloseTo(1, 1);
    }
    expect(pts[0]).toEqual([21, 12]);
  });
});
