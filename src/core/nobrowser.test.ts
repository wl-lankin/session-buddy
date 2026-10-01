import { describe, expect, it } from "vitest";
import { insideTextField, installNoBrowser, isBrowserShortcut } from "./nobrowser";

const WIN = { mac: false };
const MAC = { mac: true };

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
      expect(isBrowserShortcut(key(k, { ctrl: true }), WIN), `Ctrl+${k}`).toBe(true);
      expect(isBrowserShortcut(key(k, { meta: true }), MAC), `Cmd+${k}`).toBe(true);
    }
    expect(isBrowserShortcut(key("KeyR", { ctrl: true, shift: true }), WIN), "Ctrl+Shift+R").toBe(true);
  });

  it("blocks zoom, history and devtools", () => {
    for (const k of ["Equal", "Minus", "Digit0", "NumpadAdd", "NumpadSubtract", "Numpad0"]) {
      expect(isBrowserShortcut(key(k, { ctrl: true }), WIN), `Ctrl+${k}`).toBe(true);
    }
    expect(isBrowserShortcut(key("ArrowLeft", { alt: true }), WIN)).toBe(true);
    expect(isBrowserShortcut(key("ArrowRight", { alt: true }), WIN)).toBe(true);
    expect(isBrowserShortcut(key("KeyI", { ctrl: true, shift: true }), WIN)).toBe(true);
  });

  it("never treats AltGr (Ctrl+Alt on Windows) as a shortcut", () => {
    for (const k of ["Digit0", "Minus", "KeyS", "KeyN", "KeyO", "KeyD", "Equal"]) {
      expect(isBrowserShortcut(key(k, { ctrl: true, alt: true }), WIN), `AltGr+${k}`).toBe(false);
    }
    const altGraph = { ...key("Digit0", { ctrl: true }), getModifierState: (m: string) => m === "AltGraph" };
    expect(isBrowserShortcut(altGraph, WIN)).toBe(false);
  });

  it("leaves Option+arrows and the Ctrl emacs keys to text fields", () => {
    expect(isBrowserShortcut(key("ArrowLeft", { alt: true }), { ...MAC, inTextField: true })).toBe(false);
    expect(isBrowserShortcut(key("ArrowRight", { alt: true }), { ...WIN, inTextField: true })).toBe(false);
    expect(isBrowserShortcut(key("ArrowLeft", { alt: true }), { ...MAC, inTextField: false })).toBe(true);
    // macOS matches Cmd only: Ctrl+D (delete forward), Ctrl+N / Ctrl+O are not shortcuts there.
    for (const k of ["KeyD", "KeyN", "KeyO", "KeyP", "KeyR"]) expect(isBrowserShortcut(key(k, { ctrl: true }), MAC), `mac Ctrl+${k}`).toBe(false);
    // Windows matches Ctrl only.
    expect(isBrowserShortcut(key("KeyP", { meta: true }), WIN)).toBe(false);
    expect(isBrowserShortcut(key("KeyI", { meta: true, alt: true }), MAC), "devtools on macOS").toBe(true);
  });

  it("lets everything else through", () => {
    expect(isBrowserShortcut(key("KeyR"))).toBe(false);
    expect(isBrowserShortcut(key("KeyC", { ctrl: true }), WIN)).toBe(false);
    expect(isBrowserShortcut(key("KeyV", { meta: true }), MAC)).toBe(false);
    expect(isBrowserShortcut(key("KeyI", { ctrl: true }), WIN), "Ctrl+I without Shift").toBe(false);
    expect(isBrowserShortcut(key("ArrowLeft"))).toBe(false);
    expect(isBrowserShortcut(key("ArrowLeft", { ctrl: true, alt: true }), WIN)).toBe(false);
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
    const win = { ...key("KeyP", { ctrl: true }), target: { closest: () => null } };
    expect(fire("keydown", { ...win, getModifierState: () => false }) || fire("keydown", { ...key("KeyP", { meta: true }), target: { closest: () => null } })).toBe(true);
    expect(fire("keydown", { ...key("KeyA", { ctrl: true }), target: { closest: () => null } })).toBe(false);
    expect(handlers.keydown.options).toEqual({ capture: true });
    expect(fire("wheel", { ctrlKey: true })).toBe(true);
    expect(fire("wheel", { ctrlKey: false }), "plain scrolling stays").toBe(false);
    expect(handlers.wheel.options).toEqual({ passive: false });
  });
});
