import { describe, expect, it } from "vitest";
import { insideTextField, installNoBrowser, isBrowserShortcut } from "./nobrowser";

const key = (code: string, mods: { ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean } = {}) => ({
  code,
  ctrlKey: !!mods.ctrl,
  metaKey: !!mods.meta,
  shiftKey: !!mods.shift,
  altKey: !!mods.alt,
});

describe("isBrowserShortcut", () => {
  it("blocks F5 and Ctrl/Cmd reload, print, save, source, find, new window, open, bookmark, downloads", () => {
    expect(isBrowserShortcut(key("F5"))).toBe(true);
    for (const k of ["KeyR", "KeyP", "KeyS", "KeyU", "KeyF", "KeyG", "KeyN", "KeyO", "KeyD", "KeyJ"]) {
      expect(isBrowserShortcut(key(k, { ctrl: true })), `Ctrl+${k}`).toBe(true);
      expect(isBrowserShortcut(key(k, { meta: true })), `Cmd+${k}`).toBe(true);
    }
    expect(isBrowserShortcut(key("KeyR", { ctrl: true, shift: true })), "Ctrl+Shift+R").toBe(true);
  });

  it("blocks zoom, history and devtools", () => {
    for (const k of ["Equal", "Minus", "Digit0", "NumpadAdd", "NumpadSubtract", "Numpad0"]) {
      expect(isBrowserShortcut(key(k, { ctrl: true })), `Ctrl+${k}`).toBe(true);
    }
    expect(isBrowserShortcut(key("ArrowLeft", { alt: true }))).toBe(true);
    expect(isBrowserShortcut(key("ArrowRight", { alt: true }))).toBe(true);
    expect(isBrowserShortcut(key("KeyI", { ctrl: true, shift: true }))).toBe(true);
  });

  it("lets everything else through", () => {
    expect(isBrowserShortcut(key("KeyR"))).toBe(false);
    expect(isBrowserShortcut(key("KeyC", { ctrl: true }))).toBe(false);
    expect(isBrowserShortcut(key("KeyV", { meta: true }))).toBe(false);
    expect(isBrowserShortcut(key("KeyI", { ctrl: true })), "Ctrl+I without Shift").toBe(false);
    expect(isBrowserShortcut(key("ArrowLeft"))).toBe(false);
    expect(isBrowserShortcut(key("ArrowLeft", { ctrl: true, alt: true }))).toBe(false);
    expect(isBrowserShortcut(key("Escape"))).toBe(false);
    expect(isBrowserShortcut(key("Minus"))).toBe(false);
  });
});

describe("insideTextField", () => {
  const el = (matches: string[]) => ({
    closest: (sel: string) => (matches.some((m) => sel.split(", ").includes(m)) ? {} : null),
  });

  it("is true for text-like inputs, textareas and contenteditable", () => {
    for (const m of ["textarea", "input:not([type])", 'input[type="text" i]', 'input[type="password" i]', 'input[type="number" i]', '[contenteditable]:not([contenteditable="false"])']) {
      expect(insideTextField(el([m]) as unknown as EventTarget), m).toBe(true);
    }
  });

  it("is false for checkboxes, ranges, buttons and non-elements", () => {
    for (const m of ['input[type="checkbox" i]', 'input[type="range" i]', "button"]) {
      expect(insideTextField(el([m]) as unknown as EventTarget), m).toBe(false);
    }
    expect(insideTextField(null)).toBe(false);
    expect(insideTextField({} as EventTarget)).toBe(false);
  });
});

describe("installNoBrowser", () => {
  it("prevents the context menu outside text fields, the shortcuts in the capture phase and Ctrl+wheel", () => {
    const handlers: Record<string, { fn: (e: Event) => void; options?: unknown }> = {};
    const target = {
      addEventListener: (type: string, fn: (e: Event) => void, options?: unknown) => (handlers[type] = { fn, options }),
    } as unknown as Document;
    installNoBrowser(target);
    const fire = (type: string, extra: object) => {
      let prevented = false;
      handlers[type].fn({ ...extra, preventDefault: () => (prevented = true) } as unknown as Event);
      return prevented;
    };
    expect(fire("contextmenu", { target: { closest: () => null } })).toBe(true);
    expect(fire("contextmenu", { target: { closest: () => ({}) } }), "paste in a text field stays").toBe(false);
    expect(fire("keydown", key("KeyP", { ctrl: true }))).toBe(true);
    expect(fire("keydown", key("KeyA", { ctrl: true }))).toBe(false);
    expect(handlers.keydown.options).toEqual({ capture: true });
    expect(fire("wheel", { ctrlKey: true })).toBe(true);
    expect(fire("wheel", { ctrlKey: false }), "plain scrolling stays").toBe(false);
    expect(handlers.wheel.options).toEqual({ passive: false });
  });
});
