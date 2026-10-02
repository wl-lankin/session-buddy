// What Buddy does when the user acts in the settings window.

import type { BotEmoteName, BotStateName } from "../core/layout";

export type SettingsEvent =
  | { kind: "sound"; on: boolean }
  | { kind: "chat"; on: boolean }
  | { kind: "plan"; on: boolean }
  | { kind: "ollama"; ok: boolean }
  | { kind: "folder"; added: boolean }
  | { kind: "install"; install: boolean; ok: boolean }
  | { kind: "update"; result: "available" | "latest" | "installing" | "error" };

export interface Reaction {
  /** A state held for `holdMs`, then Buddy returns to his resting state. */
  state?: BotStateName;
  emote?: BotEmoteName;
  holdMs?: number;
}

export function reactionFor(ev: SettingsEvent): Reaction | null {
  switch (ev.kind) {
    case "sound":
      return ev.on ? { emote: "yawn" } : null;
    case "chat":
    case "plan":
      return { emote: ev.on ? "wink" : "yawn" };
    case "folder":
      return ev.added ? { emote: "happy" } : null;
    case "ollama":
      return ev.ok ? { emote: "happy" } : { state: "error", holdMs: 2600 };
    case "update":
      if (ev.result === "error") return { state: "error", holdMs: 2600 };
      if (ev.result === "installing") return { state: "working", holdMs: 60_000 };
      return { emote: "happy" };
    case "install":
      if (!ev.ok) return { state: "error", holdMs: 2600 };
      return ev.install ? { emote: "proud", holdMs: 2200 } : { emote: "annoyed" };
  }
}

/** Sound off puts Buddy to sleep; otherwise he idles. */
export function restingState(soundEnabled: boolean): BotStateName {
  return soundEnabled ? "idle" : "sleeping";
}
