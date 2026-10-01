// Entry point: boot the bridge, wire the island, start the greeting.

import "./style.css";
import { Bridge, IS_TAURI, onEvent } from "./core/bridge";
import { installNoBrowser } from "./core/nobrowser";
import { Sound } from "./core/sound";
import { State, type Settings } from "./core/state";
import type { Cue, Snapshot } from "./core/types";
import { Island } from "./island/island";

declare global {
  interface Window {
    __sb?: { snapshot(s: Snapshot): void; cues(c: Cue[]): void };
  }
}

async function main() {
  const root = document.getElementById("root");
  if (!root) return;
  void Sound.preload();
  const island = new Island(root);

  const boot = await Bridge.boot();
  if (boot) State.settings = { ...State.settings, ...boot.settings };
  island.applySettings();

  await onEvent<{ x: number; y: number }>("cursor", ({ x, y }) => island.onCursor(x, y));
  await onEvent<Snapshot>("sessions", (s) => island.onSnapshot(s));
  await onEvent<Cue[]>("cues", (c) => island.onCues(c));
  await onEvent<string>("tray", (what) => {
    if (what === "open") island.open();
  });
  await onEvent<null>("hotkey", () => island.toggleFromHotkey());
  await onEvent<null>("screen-changed", () => void Bridge.reposition());
  await onEvent<Settings>("settings-changed", (s) => {
    State.settings = { ...State.settings, ...s };
    island.applySettings();
  });

  const snap = await Bridge.snapshot();
  if (snap) island.onSnapshot(snap);
  island.launch();

  if (!IS_TAURI) {
    document.addEventListener("click", () => Sound.resume(), { once: true });
    window.__sb = { snapshot: (s) => island.onSnapshot(s), cues: (c) => island.onCues(c) };
  }
}

installNoBrowser();
void main();
