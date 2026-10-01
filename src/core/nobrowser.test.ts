import { describe, expect, it } from "vitest";
import { insideTextField, installNoBrowser, isBrowserShortcut } from "./nobrowser";

const key = (k: string, mods: { ctrl?: boolean; meta?: boolean; shift?: boolean } = {}) => ({
  key: k,
  ctrlKey: !!mods.ctrl,
  metaKey: !!mods.meta,
  shiftKey: !!mods.shift,
});

describe("isBrowserShortcut", () => {
  it("blocks F5 and the reload, print, save, source, find shortcuts", () => {
    expect(isBrowserShortcut(key("F5"))).toBe(true);
    for (const k of ["r", "p", "s", "u", "f", "g"]) {
      expect(isBrowserShortcut(key(k, { ctrl: true })), `Ctrl+${k}`).toBe(true);
      expect(isBrowserShortcut(key(k, { meta: true })), `Cmd+${k}`).toBe(true);
    }
    expect(isBrowserShortcut(key("R", { ctrl: true, shift: true })), "Ctrl+Shift+R").toBe(true);
  });

  it("lets everything else through", () => {
    expect(isBrowserShortcut(key("r"))).toBe(false);
    expect(isBrowserShortcut(key("c", { ctrl: true }))).toBe(false);
    expect(isBrowserShortcut(key("v", { meta: true }))).toBe(false);
    expect(isBrowserShortcut(key("Escape"))).toBe(false);
    expect(isBrowserShortcut(key("F12"))).toBe(false);
  });
});

describe("insideTextField", () => {
  it("is true for targets inside an input or textarea", () => {
    const field = { closest: (sel: string) => (sel.includes("input") ? {} : null) };
    expect(insideTextField(field as unknown as EventTarget)).toBe(true);
    expect(insideTextField({ closest: () => null } as unknown as EventTarget)).toBe(false);
    expect(insideTextField(null)).toBe(false);
    expect(insideTextField({} as EventTarget), "a non-element target").toBe(false);
  });
});

describe("installNoBrowser", () => {
  it("prevents the context menu outside text fields and the browser shortcuts", () => {
    const handlers: Record<string, (e: Event) => void> = {};
    installNoBrowser({ addEventListener: ((type: string, fn: (e: Event) => void) => (handlers[type] = fn)) as Document["addEventListener"] });
    const fire = (type: string, extra: object) => {
      let prevented = false;
      handlers[type]({ ...extra, preventDefault: () => (prevented = true) } as unknown as Event);
      return prevented;
    };
    expect(fire("contextmenu", { target: { closest: () => null } })).toBe(true);
    expect(fire("contextmenu", { target: { closest: () => ({}) } }), "paste in a text field stays").toBe(false);
    expect(fire("keydown", key("p", { ctrl: true }))).toBe(true);
    expect(fire("keydown", key("a", { ctrl: true }))).toBe(false);
  });
});
