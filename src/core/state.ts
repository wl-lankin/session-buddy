// UI state. Sessions themselves live in Rust; `snapshot` is the latest copy.

import type { BotStateName, IslandMode, IslandViewName } from "./layout";
import { EMPTY_SNAPSHOT, type Session, type Snapshot } from "./types";
import { botStateFor, loudest, orderSessions, visibleSessions } from "../model/viewmodel";
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
  /** The finished card only shows for turns at least this long, seconds. */
  finishMinSeconds: number;
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
  finishMinSeconds: 60,
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
  /** The "Recent" pill: recent sessions join the tab row until the island collapses. */
  showRecent = false;
  /** Short message on the interaction card, e.g. when an answer arrived too late. */
  notice: { text: string; until: number } | null = null;
  lastActivity = performance.now();
  /** Manual height of the expanded island (grip or enlarge button); null = natural size. */
  manualH: number | null = null;
  /** The session whose last answer is unfolded in the session view. */
  answerOpenFor: string | null = null;
  /** The step whose change or output is unfolded (stepKey), or null. */
  stepOpen: string | null = null;
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

  /** Every session: live ones first, then recent ones from transcripts. */
  get allSessions(): Session[] {
    if (this.orderedFrom !== this.snapshot) {
      this.orderedFrom = this.snapshot;
      this.ordered = orderSessions(this.snapshot.sessions);
    }
    return this.ordered;
  }

  /** What tabs, dots, pager, cycling and number keys show: live sessions, plus recent ones while the pill is on. */
  get sessions(): Session[] {
    return visibleSessions(this.allSessions, this.showRecent && this.mode === "expanded");
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
