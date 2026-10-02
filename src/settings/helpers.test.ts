import { describe, expect, it } from "vitest";
import { normalizeNumber, secondsLabel } from "./helpers";

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

describe("island timing fields", () => {
  it("allows 0 as the minimum", () => {
    expect(normalizeNumber(0, 0, 120, true)).toBe(0);
    expect(normalizeNumber("-3", 0, 120, true)).toBe(0);
    expect(normalizeNumber("0.4", 0, 120, true)).toBe(0);
    expect(normalizeNumber("garbage", 0, 120, true)).toBe(0);
  });
});

describe("secondsLabel", () => {
  it("says Immediately for 0 and seconds otherwise", () => {
    expect(secondsLabel(0)).toBe("Immediately");
    expect(secondsLabel(1)).toBe("seconds");
    expect(secondsLabel(15)).toBe("seconds");
  });
});
