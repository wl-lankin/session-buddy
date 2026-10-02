import { describe, expect, it } from "vitest";
import { addRoot, DEFAULT_OLLAMA_URL, normalizeNumber, normalizeOllamaUrl, ollamaTestText, removeRoot, rootParts, secondsLabel } from "./helpers";

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

describe("normalizeOllamaUrl", () => {
  it("falls back to the default for empty input", () => {
    expect(normalizeOllamaUrl("  ")).toBe(DEFAULT_OLLAMA_URL);
  });
  it("adds a scheme and drops trailing slashes", () => {
    expect(normalizeOllamaUrl("nas.local:11434//")).toBe("http://nas.local:11434");
    expect(normalizeOllamaUrl("https://ollama.example/")).toBe("https://ollama.example");
  });
});

describe("ollamaTestText", () => {
  it("counts the models of a reachable server", () => {
    expect(ollamaTestText(true, 1, "http://x")).toBe("Reachable - 1 model");
    expect(ollamaTestText(true, 3, "http://x")).toBe("Reachable - 3 models");
    expect(ollamaTestText(true, 0, "http://x")).toContain("no models");
  });
  it("names the address of an unreachable one", () => {
    expect(ollamaTestText(false, 0, "http://localhost:11434")).toBe("Ollama is not reachable at http://localhost:11434 - start it with `ollama serve`");
  });
});

describe("project roots", () => {
  it("adds a folder once, trimmed and without a trailing separator", () => {
    expect(addRoot([], " /Users/a/Projects/ ")).toEqual(["/Users/a/Projects"]);
    expect(addRoot(["C:\\Code"], "C:\\Code\\")).toEqual(["C:\\Code"]);
  });
  it("returns the same list for a cancelled dialog or a duplicate", () => {
    const roots = ["/a"];
    expect(addRoot(roots, null)).toBe(roots);
    expect(addRoot(roots, "  ")).toBe(roots);
    expect(addRoot(roots, "/a/")).toBe(roots);
  });
  it("keeps the root folder itself", () => {
    expect(addRoot([], "/")).toEqual(["/"]);
  });
  it("removes one folder", () => {
    expect(removeRoot(["/a", "/b"], "/a")).toEqual(["/b"]);
  });
  it("splits a path into name and place", () => {
    expect(rootParts("/Users/a/Projects/nexa")).toEqual({ name: "nexa", dir: "/Users/a/Projects" });
    expect(rootParts("C:\\Code\\nexa\\")).toEqual({ name: "nexa", dir: "C:\\Code" });
    expect(rootParts("/nexa")).toEqual({ name: "nexa", dir: "/" });
    expect(rootParts("nexa")).toEqual({ name: "nexa", dir: "" });
  });
});
