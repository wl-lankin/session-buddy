import { describe, expect, it } from "vitest";
import {
  cardKind, checkSummary, displayVersion, initialUpdate, mayAutoOpen, mayShowNote, pillText, progressLabel, progressPercent,
  reduceUpdate, versionLine, type UpdateInfo, type UpdateModel,
} from "./update";

const info: UpdateInfo = { version: "1.0.11", currentVersion: "1.0.10", notes: "- faster" };
const found = (): UpdateModel => reduceUpdate(initialUpdate, { type: "available", info });

describe("version display", () => {
  it("drops a leading v", () => {
    expect(displayVersion("v1.0.11")).toBe("1.0.11");
    expect(displayVersion(" 1.0.11 ")).toBe("1.0.11");
  });
  it("names both versions", () => {
    expect(versionLine(info)).toBe("Version 1.0.11 (you have 1.0.10)");
    expect(versionLine({ ...info, version: "v2.0.0", currentVersion: "v1.0.10" })).toBe("Version 2.0.0 (you have 1.0.10)");
  });
});

describe("pill", () => {
  it("shows nothing without an update", () => {
    expect(pillText(initialUpdate)).toBeNull();
  });
  it("shows the version while an update waits", () => {
    expect(pillText(found())).toBe("Update 1.0.11");
  });
  it("hides after Later, for that version only", () => {
    const later = reduceUpdate(found(), { type: "later" });
    expect(pillText(later)).toBeNull();
    const newer = reduceUpdate(later, { type: "available", info: { ...info, version: "1.0.12" } });
    expect(pillText(newer)).toBe("Update 1.0.12");
  });
  it("an update announced again after Later shows again (a new check)", () => {
    const later = reduceUpdate(found(), { type: "later" });
    expect(pillText(reduceUpdate(later, { type: "available", info }))).toBe("Update 1.0.11");
  });
  it("says Updating and Restarting while installing", () => {
    const m = reduceUpdate(found(), { type: "install" });
    expect(pillText(m)).toBe("Updating");
    expect(pillText(reduceUpdate(m, { type: "ready" }))).toBe("Restarting");
  });
  it("stays visible after a failed install", () => {
    const m = reduceUpdate(reduceUpdate(found(), { type: "install" }), { type: "error", message: "offline" });
    expect(pillText(m)).toBe("Update 1.0.11");
  });
});

describe("when an update may open the island", () => {
  it("opens a closed island", () => {
    expect(mayAutoOpen({ mode: "strip", view: "session", needsUser: false })).toBe(true);
    expect(mayAutoOpen({ mode: "compact", view: "session", needsUser: false })).toBe(true);
  });
  it("never takes the island from a waiting card", () => {
    expect(mayAutoOpen({ mode: "strip", view: "session", needsUser: true })).toBe(false);
    expect(mayShowNote({ mode: "strip", view: "session", needsUser: true })).toBe(false);
  });
  it("leaves an open island alone, except the empty view", () => {
    expect(mayAutoOpen({ mode: "expanded", view: "session", needsUser: false })).toBe(false);
    expect(mayAutoOpen({ mode: "expanded", view: "chat", needsUser: false })).toBe(false);
    expect(mayAutoOpen({ mode: "expanded", view: "empty", needsUser: false })).toBe(true);
  });
  it("a manual answer may replace a calm view but not a card or the chat", () => {
    expect(mayShowNote({ mode: "expanded", view: "session", needsUser: false })).toBe(true);
    expect(mayShowNote({ mode: "expanded", view: "finished", needsUser: false })).toBe(true);
    expect(mayShowNote({ mode: "expanded", view: "interaction", needsUser: false })).toBe(false);
    expect(mayShowNote({ mode: "expanded", view: "plan", needsUser: false })).toBe(false);
    expect(mayShowNote({ mode: "expanded", view: "chat", needsUser: false })).toBe(false);
  });
});

describe("install flow", () => {
  it("needs an update to install", () => {
    expect(reduceUpdate(initialUpdate, { type: "install" })).toBe(initialUpdate);
  });
  it("downloads, installs when the bytes are all there, then restarts", () => {
    let m = reduceUpdate(found(), { type: "install" });
    expect(m.phase).toBe("downloading");
    m = reduceUpdate(m, { type: "progress", downloaded: 500, total: 1000 });
    expect(m.phase).toBe("downloading");
    m = reduceUpdate(m, { type: "progress", downloaded: 1000, total: 1000 });
    expect(m.phase).toBe("installing");
    expect(reduceUpdate(m, { type: "ready" }).phase).toBe("restarting");
  });
  it("a late progress event does not undo Restarting", () => {
    const m = reduceUpdate(reduceUpdate(found(), { type: "install" }), { type: "ready" });
    expect(reduceUpdate(m, { type: "progress", downloaded: 1, total: 2 }).phase).toBe("restarting");
  });
  it("an error while installing ends in the error card, and install retries", () => {
    const failed = reduceUpdate(reduceUpdate(found(), { type: "install" }), { type: "error", message: "disk full" });
    expect(failed.phase).toBe("error");
    expect(failed.error).toBe("disk full");
    expect(reduceUpdate(failed, { type: "install" }).phase).toBe("downloading");
  });
  it("an error outside an install changes nothing", () => {
    const m = found();
    expect(reduceUpdate(m, { type: "error", message: "x" })).toBe(m);
  });
  it("Later does not interrupt an install", () => {
    const m = reduceUpdate(found(), { type: "install" });
    expect(reduceUpdate(m, { type: "later" })).toBe(m);
  });
  it("a repeated announcement during the install changes nothing", () => {
    const m = reduceUpdate(found(), { type: "install" });
    expect(reduceUpdate(m, { type: "available", info })).toBe(m);
  });
});

describe("progress", () => {
  it("is a percentage, or unknown without a total", () => {
    expect(progressPercent(250, 1000)).toBe(25);
    expect(progressPercent(5000, 1000)).toBe(100);
    expect(progressPercent(10, null)).toBeNull();
    expect(progressPercent(10, 0)).toBeNull();
  });
  it("labels each phase", () => {
    const base = reduceUpdate(found(), { type: "install" });
    expect(progressLabel(base)).toBe("Downloading ...");
    const mid = reduceUpdate(base, { type: "progress", downloaded: 4_404_019, total: 12_582_912 });
    expect(progressLabel(mid)).toBe("Downloading 35% (4.2 MB of 12.0 MB)");
    expect(progressLabel(reduceUpdate(base, { type: "progress", downloaded: 2048, total: null }))).toBe("Downloading 2 KB");
    expect(progressLabel(reduceUpdate(mid, { type: "progress", downloaded: 12_582_912, total: 12_582_912 }))).toBe("Installing ...");
    expect(progressLabel(reduceUpdate(mid, { type: "ready" }))).toBe("Restarting");
  });
});

describe("card kind", () => {
  it("picks the card from the note and the phase", () => {
    expect(cardKind(found(), null)).toBe("offer");
    expect(cardKind(found(), { text: "x", tone: "ok" })).toBe("note");
    expect(cardKind(reduceUpdate(found(), { type: "install" }), null)).toBe("progress");
    const failed = reduceUpdate(reduceUpdate(found(), { type: "install" }), { type: "error", message: "e" });
    expect(cardKind(failed, null)).toBe("error");
  });
});

describe("check summary", () => {
  it("covers latest, available and error", () => {
    expect(checkSummary({ available: false, currentVersion: "1.0.10" })).toEqual({ tone: "ok", text: "You have the latest version (1.0.10)" });
    expect(checkSummary({ available: true, version: "1.0.11", currentVersion: "1.0.10" })).toEqual({ tone: "offer", text: "Version 1.0.11 is available (you have 1.0.10)" });
    expect(checkSummary({ available: false, currentVersion: "1.0.10", error: "offline" })).toEqual({ tone: "bad", text: "Could not check for updates: offline" });
  });
});

describe("events without a known release", () => {
  it("progress and ready are ignored", () => {
    expect(reduceUpdate(initialUpdate, { type: "progress", downloaded: 1, total: 2 })).toBe(initialUpdate);
    expect(reduceUpdate(initialUpdate, { type: "ready" })).toBe(initialUpdate);
  });
});
