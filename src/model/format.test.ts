import { describe, expect, it } from "vitest";
import { firstLine, fmtAgo, fmtCountdown, fmtAdded, fmtDuration, fmtLines, fmtMoney, fmtRemoved, fmtReset, fmtTokens, level, parseReset } from "./format";

describe("format", () => {
  it("levels at 70 and 90", () => {
    expect(level(69.9)).toBe("ok");
    expect(level(70)).toBe("warn");
    expect(level(90)).toBe("crit");
    expect(level(null)).toBe("ok");
  });

  it("tokens", () => {
    expect(fmtTokens(950)).toBe("950");
    expect(fmtTokens(122_000)).toBe("122k");
    expect(fmtTokens(1_000_000)).toBe("1.0M");
    expect(fmtTokens(null)).toBe("?");
  });

  it("lines use a plain hyphen", () => {
    expect(fmtLines(128, 34)).toBe("+128 -34");
    expect(fmtAdded(128)).toBe("+128");
    expect(fmtRemoved(34)).toBe("-34");
    expect(fmtRemoved(0)).toBe("-0");
  });

  it("durations and ages", () => {
    expect(fmtDuration(42_000)).toBe("42s");
    expect(fmtDuration(252_000)).toBe("4m 12s");
    expect(fmtDuration(3_900_000)).toBe("1h 5m");
    expect(fmtAgo(30_000)).toBe("just now");
    expect(fmtAgo(5 * 60_000)).toBe("5m ago");
    expect(fmtAgo(3 * 3600_000)).toBe("3h ago");
    expect(fmtCountdown(105_000)).toBe("1:45");
    expect(fmtCountdown(-5)).toBe("0:00");
  });

  it("parses reset times in seconds, millis and ISO", () => {
    expect(parseReset(1_790_000_000)).toBe(1_790_000_000_000);
    expect(parseReset(1_790_000_000_000)).toBe(1_790_000_000_000);
    expect(parseReset("2026-10-01T14:30:00Z")).toBe(Date.parse("2026-10-01T14:30:00Z"));
    expect(parseReset("nope")).toBeNull();
    expect(parseReset(null)).toBeNull();
  });

  it("formats resets as time today or weekday + time", () => {
    const now = new Date(2026, 9, 1, 9, 0).getTime(); // Thu 1 Oct 2026, 09:00 local
    expect(fmtReset(new Date(2026, 9, 1, 14, 30).getTime(), now)).toBe("14:30");
    expect(fmtReset(new Date(2026, 9, 5, 9, 0).getTime(), now)).toBe("Mon 09:00");
    expect(fmtReset(null, now)).toBe("");
  });

  it("first non-empty line, clipped", () => {
    expect(firstLine("\n\n  Hello there  \nsecond")).toBe("Hello there");
    expect(firstLine("x".repeat(200), 10)).toBe("xxxxxxxxx…");
    expect(firstLine(null)).toBe("");
  });

});

describe("fmtMoney", () => {
  it("formats minor units with the currency symbol and the currency's exponent", () => {
    expect(fmtMoney(1240, "EUR", 2, "en-US")).toBe("€12.40");
    expect(fmtMoney(5000, "USD", 2, "en-US")).toBe("$50.00");
    expect(fmtMoney(1240, "EUR", 2, "de-DE").replace(/\s/g, " ")).toBe("12,40 €");
    expect(fmtMoney(1500, "JPY", 0, "en-US")).toBe("¥1,500");
    expect(fmtMoney(1240, "not a currency", 2, "en-US")).toBe("12.40 not a currency");
  });
});
