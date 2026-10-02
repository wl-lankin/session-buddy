import { describe, expect, it } from "vitest";
import { reactionFor, restingState } from "./reactions";

describe("reactionFor", () => {
  it("yawns awake when sound goes on, nothing extra when it goes off", () => {
    expect(reactionFor({ kind: "sound", on: true })).toEqual({ emote: "yawn" });
    expect(reactionFor({ kind: "sound", on: false })).toBeNull();
  });
  it("the plan switch reacts like the chat switch", () => {
    expect(reactionFor({ kind: "plan", on: true })?.emote).toBe("wink");
    expect(reactionFor({ kind: "plan", on: false })?.emote).toBe("yawn");
  });

  it("winks for chat on, yawns for chat off", () => {
    expect(reactionFor({ kind: "chat", on: true })?.emote).toBe("wink");
    expect(reactionFor({ kind: "chat", on: false })?.emote).toBe("yawn");
  });
  it("is happy about a folder that was added, silent about a removal", () => {
    expect(reactionFor({ kind: "folder", added: true })?.emote).toBe("happy");
    expect(reactionFor({ kind: "folder", added: false })).toBeNull();
  });
  it("is proud of an install, annoyed by an uninstall, shows the error face on failure", () => {
    expect(reactionFor({ kind: "install", install: true, ok: true })?.emote).toBe("proud");
    expect(reactionFor({ kind: "install", install: false, ok: true })?.emote).toBe("annoyed");
    expect(reactionFor({ kind: "install", install: true, ok: false })?.state).toBe("error");
    expect(reactionFor({ kind: "install", install: false, ok: false })?.state).toBe("error");
  });
});

describe("local model reactions", () => {
  it("is happy for a working server and shows the error face otherwise", () => {
    expect(reactionFor({ kind: "ollama", ok: true })?.emote).toBe("happy");
    expect(reactionFor({ kind: "ollama", ok: false })?.state).toBe("error");
  });
});

describe("update reactions", () => {
  it("is happy about a new version and about being up to date", () => {
    expect(reactionFor({ kind: "update", result: "available" })?.emote).toBe("happy");
    expect(reactionFor({ kind: "update", result: "latest" })?.emote).toBe("happy");
  });
  it("works while installing and shows the error face on failure", () => {
    expect(reactionFor({ kind: "update", result: "installing" })?.state).toBe("working");
    expect(reactionFor({ kind: "update", result: "error" })?.state).toBe("error");
  });
});

describe("restingState", () => {
  it("sleeps while sound is off", () => {
    expect(restingState(false)).toBe("sleeping");
    expect(restingState(true)).toBe("idle");
  });
});
