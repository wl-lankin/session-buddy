import { describe, expect, it } from "vitest";
import { accountWidth, autoWidth, clampHeight, IDLE_RESET_MS, largeHeight, maxHeight, panelFor, shouldResetSize } from "./size";

const FHD = { w: 1920, h: 1080 };
const SMALL = { w: 1280, h: 600 };

describe("manual height", () => {
  it("stays between the natural height and 80 % of the screen", () => {
    expect(clampHeight(500, 300, FHD)).toBe(500);
    expect(clampHeight(100, 300, FHD)).toBe(300);
    expect(clampHeight(2000, 300, FHD)).toBe(864);
    expect(maxHeight(300, FHD)).toBe(864);
  });

  it("never goes below the natural height, even when that is taller than 80 %", () => {
    expect(maxHeight(500, SMALL)).toBe(500);
    expect(clampHeight(900, 500, SMALL)).toBe(500);
  });

  it("enlarges to 640 or what the screen allows", () => {
    expect(largeHeight(300, FHD)).toBe(640);
    expect(largeHeight(300, SMALL)).toBe(480);
    expect(largeHeight(700, FHD)).toBe(700);
  });
});

describe("autoWidth", () => {
  it("is 920 when everything fits", () => {
    expect(autoWidth([600, 880], FHD)).toBe(920);
    expect(autoWidth([], FHD)).toBe(920);
  });

  it("grows to what the widest row needs, up to 70 % of the screen", () => {
    expect(autoWidth([1010.2, 700], FHD)).toBe(1011);
    expect(autoWidth([1800], FHD)).toBe(1344);
  });

  it("stays at 920 on a screen too small for more", () => {
    expect(autoWidth([1200], { w: 1024, h: 768 })).toBe(920);
  });

  it("ignores rows that could not be measured", () => {
    expect(autoWidth([Number.NaN, 950], FHD)).toBe(950);
  });
});

describe("accountWidth", () => {
  it("fits the email between 190 and 300", () => {
    expect(accountWidth(120)).toBe(190);
    expect(accountWidth(240.4)).toBe(241);
    expect(accountWidth(420)).toBe(300);
  });
});

describe("panelFor", () => {
  it("keeps the default panel for the normal island", () => {
    expect(panelFor(920, 380)).toEqual({ w: 960, h: 440 });
    expect(panelFor(920, 400)).toEqual({ w: 960, h: 440 });
    expect(panelFor(340, 28)).toEqual({ w: 960, h: 440 });
  });

  it("grows in 40 px steps with room around the island", () => {
    expect(panelFor(1011, 640)).toEqual({ w: 1080, h: 680 });
    expect(panelFor(920, 641)).toEqual({ w: 960, h: 720 });
  });
});

describe("shouldResetSize", () => {
  const anchor = { focusId: "a", requestId: "r1" };
  const base = { anchor, now: anchor, expanded: true, lastPointerAt: 1_000, nowMs: 2_000 };

  it("keeps the size while nothing changed", () => {
    expect(shouldResetSize(base)).toBe(false);
  });

  it("resets when the card is answered, released or expires", () => {
    expect(shouldResetSize({ ...base, now: { focusId: "a", requestId: null } })).toBe(true);
    expect(shouldResetSize({ ...base, now: { focusId: "a", requestId: "r2" } })).toBe(true);
  });

  it("resets when the island leaves expanded or the focus moves", () => {
    expect(shouldResetSize({ ...base, expanded: false })).toBe(true);
    expect(shouldResetSize({ ...base, now: { focusId: "b", requestId: "r1" } })).toBe(true);
  });

  it("resets after two minutes without the pointer on the island", () => {
    expect(shouldResetSize({ ...base, nowMs: 1_000 + IDLE_RESET_MS - 1 })).toBe(false);
    expect(shouldResetSize({ ...base, nowMs: 1_000 + IDLE_RESET_MS })).toBe(true);
  });
});
