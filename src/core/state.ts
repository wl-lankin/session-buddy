// UI state. Sessions themselves live in Rust; `snapshot` is the latest copy.

import type { BotStateName, IslandMode, IslandViewName } from "./layout";
import { EMPTY_SNAPSHOT, type Session, type Snapshot } from "./types";
import { botStateFor, loudest, orderSessions } from "../model/viewmodel";
import type { FinishItem, FinishStyle } from "../model/finish";

export interface Settings {
  soundEnabled: boolean;
  soundVolume: number;
  autoCloseInterval: number;
  compactInterval: number;
  staleMinutes: number;
  removeMinutes: number;
  screen: "primary" | "cursor";
  autostart: boolean;
  hotkey: string;
  contextSound: boolean;
  /** What a finishing session does: the card plus Mochi, Mochi only, or just the sound. */
  finishStyle: FinishStyle;
}

export const DEFAULT_SETTINGS: Settings = {
  soundEnabled: true,
  soundVolume: 0.12,
  autoCloseInterval: 15,
  compactInterval: 6,
  staleMinutes: 10,
  removeMinutes: 120,
  screen: "primary",
  autostart: false,
  hotkey: "Ctrl+Alt+Space",
  contextSound: true,
  finishStyle: "card",
};

type Listener = () => void;


class AppState {
  mode: IslandMode = "strip";
  view: IslandViewName = "session";
  snapshot: Snapshot = EMPTY_SNAPSHOT;
  focusId: string | null = null;
  stateOverride: BotStateName | null = null;
  mouse = { x: 0, y: 0 };
  mouseInIsland = { x: 0, y: 0 };
  isPinned = false;
  /** After a session finishes, its last message shows in the compact island until `until`. */
  flash: { sessionId: string; until: number } | null = null;
  /** What the finished card lists, oldest first. */
  finished: FinishItem[] = [];
  /** Short message on the interaction card, e.g. when an answer arrived too late. */
  notice: { text: string; until: number } | null = null;
  lastActivity = performance.now();
  settings: Settings = { ...DEFAULT_SETTINGS };

  private listeners = new Set<Listener>();
  private orderedFrom: Snapshot | null = null;
  private ordered: Session[] = [];

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  notify() {
    for (const fn of this.listeners) fn();
  }

  /** Live sessions first, then recent ones from transcripts; tabs, dots, pager and cycling all use this order. */
  get sessions(): Session[] {
    if (this.orderedFrom !== this.snapshot) {
      this.orderedFrom = this.snapshot;
      this.ordered = orderSessions(this.snapshot.sessions);
    }
    return this.ordered;
  }

  get focus(): Session | null {
    return this.sessions.find((s) => s.id === this.focusId) ?? this.sessions[0] ?? null;
  }

  /** The strip shows the loudest session; compact and expanded show the focused one. */
  get mochiSession(): Session | null {
    return this.mode === "strip" ? loudest(this.sessions) : this.focus;
  }

  get effectiveState(): BotStateName {
    return this.stateOverride ?? botStateFor(this.mochiSession);
  }
}

export const State = new AppState();
