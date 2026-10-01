import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IslandStateMachine } from "./fsm";

describe("IslandStateMachine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("rests as the strip and opens compact on hover without arming the rest timer", () => {
    const fsm = new IslandStateMachine();
    fsm.compactToStripDelay = 6;
    expect(fsm.state).toBe("strip");
    fsm.mouseEntered();
    expect(fsm.state).toBe("petit");
    vi.advanceTimersByTime(60_000);
    expect(fsm.state).toBe("petit");
  });

  it("returns to the strip after the cursor leaves compact", () => {
    const fsm = new IslandStateMachine();
    fsm.compactToStripDelay = 6;
    fsm.mouseEntered();
    fsm.mouseLeft();
    vi.advanceTimersByTime(5_900);
    expect(fsm.state).toBe("petit");
    vi.advanceTimersByTime(200);
    expect(fsm.state).toBe("strip");
  });

  it("does not collapse a pinned home, and collapses after unpin plus mouseLeft", () => {
    const fsm = new IslandStateMachine();
    fsm.homeToPetitDelay = 15;
    fsm.pinned = true;
    fsm.forceHome();
    fsm.mouseLeft();
    vi.advanceTimersByTime(60_000);
    expect(fsm.state).toBe("home");
    fsm.pinned = false;
    fsm.mouseLeft();
    vi.advanceTimersByTime(15_100);
    expect(fsm.state).toBe("petit");
  });
});
