import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSubmitGuard } from "./submitguard";

describe("createSubmitGuard", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("blocks a second submit", () => {
    const changes: boolean[] = [];
    const g = createSubmitGuard<object | null>((l) => changes.push(l));
    expect(g.lock(null)).toBe(true);
    expect(g.lock(null)).toBe(false);
    expect(g.locked).toBe(true);
    expect(changes).toEqual([true]);
  });

  it("re-enables on a new error notice but not on the one already shown", () => {
    const g = createSubmitGuard<object | null>(() => {});
    const old = {};
    g.lock(old);
    g.observe(old);
    expect(g.locked).toBe(true);
    g.observe({});
    expect(g.locked).toBe(false);
  });

  it("resets for a new request id", () => {
    const changes: boolean[] = [];
    const g = createSubmitGuard<object | null>((l) => changes.push(l));
    g.lock(null);
    g.reset();
    expect(g.locked).toBe(false);
    expect(changes).toEqual([true, false]);
    expect(g.lock(null)).toBe(true);
  });

  it("re-enables after the fallback delay", () => {
    const g = createSubmitGuard<object | null>(() => {});
    g.lock(null);
    vi.advanceTimersByTime(3999);
    expect(g.locked).toBe(true);
    vi.advanceTimersByTime(1);
    expect(g.locked).toBe(false);
  });
});
