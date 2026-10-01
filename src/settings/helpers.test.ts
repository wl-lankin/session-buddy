import { describe, expect, it } from "vitest";
import { normalizeNumber } from "./helpers";

describe("normalizeNumber", () => {
  it("rounds fractional input when integer", () => {
    expect(normalizeNumber("2.6", 1, 240, true)).toBe(3);
  });
  it("keeps fractions when not integer", () => {
    expect(normalizeNumber(0.07, 0, 0.2, false)).toBe(0.07);
  });
  it("clamps to the range", () => {
    expect(normalizeNumber(999, 1, 240, true)).toBe(240);
    expect(normalizeNumber(0.9, 0, 0.2, false)).toBe(0.2);
    expect(normalizeNumber(-4, 5, 10, true)).toBe(5);
  });
  it("falls back to min for garbage", () => {
    expect(normalizeNumber("abc", 3, 120, true)).toBe(3);
    expect(normalizeNumber(NaN, 3, 120, true)).toBe(3);
  });
});
