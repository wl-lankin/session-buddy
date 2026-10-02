// Entry point: boot the bridge, wire the island, start the greeting.

import "./style.css";
import { Bridge, IS_TAURI, onEvent } from "./core/bridge";
import { installNoBrowser } from "./core/nobrowser";
import { Sound } from "./core/sound";
import { State, type Settings } from "./core/state";
import type { Cue, Snapshot } from "./core/types";
import type { ChatAction, ChatEvent } from "./model/chat";
import type { UpdateInfo } from "./model/update";
import { Island } from "./island/island";

declare global {
  interface Window {
    __sb?: { snapshot(s: Snapshot): void; cues(c: Cue[]): void; chat(a: ChatAction): void };
  }
}

async function main() {
  const root = document.getElementById("root");
  if (!root) return;
  void Sound.preload();
  const island = new Island(root);

  const boot = await Bridge.boot();
  if (boot) {
    State.settings = { ...State.settings, ...boot.settings };
    State.appVersion = boot.version;
  }
  island.applySettings();

  await onEvent<{ x: number; y: number }>("cursor", ({ x, y }) => island.onCursor(x, y));
  await onEvent<Snapshot>("sessions", (s) => island.onSnapshot(s));
  await onEvent<Cue[]>("cues", (c) => island.onCues(c));
  await onEvent<string>("tray", (what) => {
    if (what === "open") island.open();
  });
  await onEvent<ChatEvent>("chat-event", (e) => island.onChatEvent(e));
  await onEvent<UpdateInfo>("update-available", (u) => island.onUpdateAvailable(u));
  await onEvent<null>("update-none", () => island.onUpdateNone());
  await onEvent<{ message: string }>("update-error", (e) => island.onUpdateError(e.message));
  await onEvent<{ downloaded: number; total: number | null }>("update-progress", (p) => island.onUpdateProgress(p.downloaded, p.total));
  await onEvent<null>("update-ready", () => island.onUpdateReady());
  await onEvent<null>("hotkey", () => island.toggleFromHotkey());
  await onEvent<null>("screen-changed", () => void Bridge.reposition());
  // MacBook notch: the window starts at the top of the screen, the island hangs
  // below it and a black cap joins the two (src-tauri/src/island.rs).
  await onEvent<{ top: number; width: number }>("notch", ({ top, width }) => {
    document.documentElement.style.setProperty("--notch-top", `${top}px`);
    document.documentElement.style.setProperty("--notch-w", `${width}px`);
    island.setNotch(top, width);
  });
  await onEvent<Settings>("settings-changed", (s) => {
    State.settings = { ...State.settings, ...s };
    island.applySettings();
  });

  // The first placement ran before the listeners: place again to get "notch".
  void Bridge.reposition();

  const snap = await Bridge.snapshot();
  if (snap) island.onSnapshot(snap);
  island.launch();

  if (!IS_TAURI) {
    document.addEventListener("click", () => Sound.resume(), { once: true });
    window.__sb = { snapshot: (s) => island.onSnapshot(s), cues: (c) => island.onCues(c), chat: (a) => island.chatDispatch(a) };
  }
}

installNoBrowser();
void main();
