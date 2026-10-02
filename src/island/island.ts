// The island: DOM shell, sizing animation, Mochi placement, mouse, wheel and keys.
// Forked from Coucou's island.ts. File drop, chat and integration pills are gone,
// and the island never hides: it rests as a strip.

import { Ease, Tracked, Spring, clamp } from "../core/anim";
import { Bridge, IS_TAURI } from "../core/bridge";
import {
  EXPANDED_CORNER, EXPANDED_W, GREETING_W, PANEL_H, PANEL_W, ROUNDED_CORNER, STRIP_H, STRIP_W, botGlowColor, botGlowOpacity,
  botPosition, colorForProject, islandSize, type BotEmoteName, type BotStateName, type IslandMode, type IslandViewName,
} from "../core/layout";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import type { Cue, CueKind, Snapshot } from "../core/types";
import { BotEngine, hexToRGB } from "../buddy/engine";
import { Greeting } from "../buddy/greeting";
import type { ChatAction, ChatEvent } from "../model/chat";
import { FINISH_CARD_S, mergeFinish, planFinish, playsSound, type FinishItem } from "../model/finish";
import { newlyDelivered } from "../model/messages";
import { newPlan, planSession } from "../model/plan";
import { autoWidth, clampHeight, largeHeight, maxHeight, panelFor, shouldResetSize, type Screen, type SizeAnchor } from "../model/size";
import { newActionIds } from "../model/actions";
import { checkFailedText, isBusy, latestText, mayAutoOpen, mayShowNote, reduceUpdate, type UpdateInfo } from "../model/update";
import { cycle, pendingQueue, resolveFocus } from "../model/viewmodel";
import { h } from "../views/dom";
import { buildCompact } from "../views/compact";
import { buildStrip } from "../views/strip";
import { buildViews, type ViewActions, type ViewHost } from "../views/views";
import { ChatController } from "./chat";
import { IslandStateMachine } from "./fsm";

const BOT_OVERHANG = 40;
/** Same margin as the Rust hit test (src-tauri/src/island.rs). */
const HIT_MARGIN = 14;
const FLASH_MS = 6000;
const WHEEL_GAP_MS = 180;
const DRAG_START_PX = 4;
/** Step rows are 20 px: the views re-sync when the height crosses one. */
const ROW_STEP_PX = 20;

const CUE_SOUNDS: Record<CueKind, string> = {
  work: "work", finish: "finish", error: "error", approval: "approval", rate: "rate", context: "question",
};

const modeOrder = (m: IslandMode) => (m === "strip" ? 0 : m === "compact" ? 1 : 2);

/** Views whose height follows their content (ViewHost.measure). */
const MEASURED_VIEWS: IslandViewName[] = ["session", "interaction", "finished", "update"];
/** Views the grip and the enlarge button can make taller. */
const SIZABLE_VIEWS: IslandViewName[] = ["session", "interaction", "finished", "chat"];
/** The chat stays open longer than the cards: people read and type in it. */
const CHAT_CLOSE_MIN_S = 120;
const CARD_CLOSE_MIN_S = 5;
/** The short answer to a manual update check closes quickly. */
const UPDATE_NOTE_S = 4;

function screenSize(): Screen {
  const s = typeof window !== "undefined" ? window.screen : undefined;
  return { w: s?.width || 1920, h: s?.height || 1080 };
}

export class Island {
  readonly fsm = new IslandStateMachine();

  private root: HTMLElement;
  private islandEl!: HTMLElement;
  private clipEl!: HTMLElement;
  private contentEl!: HTMLElement;
  private botCanvas!: HTMLCanvasElement;
  private botGlow!: HTMLElement;
  private greetingCanvas!: HTMLCanvasElement;
  private countdown!: HTMLElement;
  private grip!: HTMLElement;
  /** Fills the menu bar strip above the island up to a MacBook notch. */
  private cap!: HTMLElement;
  private capBody!: HTMLElement;
  /** The notch the window leaves room for, logical pixels; zero without one. */
  private notch = { top: 0, width: 0 };

  private strip!: ViewHost;
  private compact!: ViewHost;
  private views!: Map<IslandViewName, ViewHost>;

  private width = new Tracked(STRIP_W);
  private height = new Tracked(STRIP_H);
  private radius = new Tracked(ROUNDED_CORNER);
  private botCx = new Spring(18);
  private botCy = new Spring(14);
  private botSize = new Spring(10);

  private engine = new BotEngine();
  private chat: ChatController;
  private chatShown = false;
  /** A confirmation card took the island from the chat: go back to the chat when it is answered. */
  private resumeChat = false;
  /** The state the chat put in State.stateOverride, so only that one is ever cleared. */
  private chatApplied: BotStateName | null = null;
  /** Same for the update install (working while it downloads, error face when it fails). */
  private updateApplied: BotStateName | null = null;
  private greeting = new Greeting();

  private running = false;
  private lastFrame = 0;
  private dirty = true;
  private canvasPx = 0;

  private wasInIsland = false;
  private pushedRect = { x: -1, y: -1, w: -1, h: -1 };
  private homeCollapseAt: number | null = null;

  private botHovering = false;
  private botHoverTimer: number | null = null;
  private lastLoveTime = 0;
  private botHoverStart = { x: 0, y: 0 };

  private confusedRecovery: number | null = null;
  private prevViewBeforeConfused: IslandViewName = "session";

  private acked = new Set<string>();
  /** The strip's natural width (label, dots and limits), clamped in islandSize. */
  private stripW = STRIP_W;
  private lastWheel = 0;
  private keyboard = false;

  /** Expanded width from the session view's untruncatable rows (model/size autoWidth). */
  private autoW = EXPANDED_W;
  /** The OS window size last asked for (logical pixels). */
  private panel = { w: PANEL_W, h: PANEL_H };
  /** What the manual size belongs to; it resets when that changes. */
  private sizeAnchor: SizeAnchor & { view: IslandViewName } = { focusId: null, requestId: null, view: "session" };
  private lastPointerAt = performance.now();
  private heightBucket = 0;
  private wasResizing = false;
  private drag: { pointerId: number; startY: number; startH: number; active: boolean } | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    this.build();
    this.wireFsm();
    this.wireInput();
    this.chat = new ChatController({
      viewing: () => State.mode === "expanded" && State.view === "chat",
      emote: (e) => this.chatEmote(e),
    });
    this.engine.onDizzy = () => this.handleDizzy();
    this.greeting.onComplete = () => this.fsm.greetComplete();
    State.subscribe(() => {
      this.dirty = true;
      this.ensureRunning();
    });
  }

  private actions(): ViewActions {
    return {
      focus: (id) => {
        State.focusId = id;
        Sound.play("blip");
        this.leavePlanIfGone();
        State.notify();
        this.animateGeometry(false);
      },
      openSession: (id) => {
        State.focusId = id;
        Sound.play("blip");
        this.setView("session");
      },
      cycle: (dir) => this.cycleFocus(dir),
      expand: () => this.fsm.forceHome(),
      collapse: () => this.collapse(),
      minimize: () => this.minimize(),
      togglePin: () => this.togglePin(),
      answer: (requestId, answer) => void this.answer(requestId, answer),
      release: (requestId) => {
        Sound.play("blip");
        void Bridge.release(requestId);
      },
      focusTerminal: (sessionId) => void this.focusTerminal(sessionId),
      openSettings: () => void Bridge.openSettingsWindow(),
      wantKeyboard: (on) => this.setKeyboard(on),
      relayout: () => this.animateGeometry(false),
      redraw: () => State.notify(),
      toggleEnlarge: () => this.toggleEnlarge(),
      openChat: () => this.openChat(),
      closeChat: () => this.setView(this.defaultView()),
      chat: {
        send: (text, context) => this.chat.send(text, context),
        stop: () => this.chat.stop(),
        reset: () => this.chat.reset(),
        setEnabled: (on) => this.chat.setEnabled(on),
        setModel: (patch) => this.chat.setModel(patch),
        models: () => this.chat.models(),
        typing: (on) => this.chat.typing(on),
      },
      pickFolder: (startDir) => Bridge.pickFolder(startDir),
      worker: {
        stop: async (id) => {
          const error = await Bridge.workerStop(id);
          Sound.play(error ? "error" : "blip");
          return error;
        },
      },
      message: {
        send: async (id, text) => {
          const error = await Bridge.sessionMessageSend(id, text);
          Sound.play(error ? "error" : "send");
          return error;
        },
        cancel: async (id, messageId) => {
          const error = await Bridge.sessionMessageCancel(id, messageId);
          Sound.play(error ? "error" : "blip");
          return error;
        },
      },
      update: {
        open: () => this.openUpdate(),
        install: () => this.installUpdate(),
        later: () => this.laterUpdate(),
      },
      toggleRecent: () => {
        State.showRecent = !State.showRecent;
        Sound.play("blip");
        State.notify();
      },
    };
  }

  private build() {
    const actions = this.actions();
    this.botGlow = h("div", { id: "bot-glow" });
    this.botCanvas = h("canvas", { id: "bot-canvas" });
    this.greetingCanvas = h("canvas", { id: "greeting-canvas" });
    this.countdown = h("div", { id: "countdown" });
    this.grip = h("div", { id: "grip", title: "Drag to resize, double-click for the normal size" });

    this.strip = buildStrip(actions);
    this.compact = buildCompact(actions);
    this.views = buildViews(actions);
    const viewsEl = h("div", { id: "views" });
    for (const v of this.views.values()) viewsEl.append(v.el);
    this.contentEl = h("div", { id: "content" }, viewsEl);

    this.clipEl = h("div", { id: "island-clip" }, this.greetingCanvas, this.compact.el, this.contentEl);
    this.capBody = h("div", { class: "cap-body" });
    this.cap = h("div", { id: "notch-cap" }, h("i", { class: "cap-shoulder left" }), this.capBody, h("i", { class: "cap-shoulder right" }));
    // The strip sits outside the clip: next to a notch it lives in the cap, above the island.
    this.islandEl = h("div", { id: "island" }, this.cap, this.clipEl, this.strip.el, this.botGlow, this.botCanvas, this.countdown, this.grip);

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.greetingCanvas.width = Math.round(GREETING_W * dpr);
    this.greetingCanvas.height = Math.round(150 * dpr);
    this.greetingCanvas.style.width = `${GREETING_W}px`;
    this.greetingCanvas.style.height = "150px";

    this.root.append(this.islandEl);
    this.applyGeometry();
  }

  private wireFsm() {
    this.fsm.homeToPetitDelay = State.settings.autoCloseInterval;
    this.fsm.compactToStripDelay = State.settings.compactInterval;
    this.fsm.onTransition = (from, to) => {
      switch (to) {
        case "strip":
          this.setMode("strip");
          break;
        case "petit":
          if (from === "coucou") this.greeting.interrupt();
          else if (from === "strip") Sound.play("peek");
          this.setMode("compact");
          if (from === "coucou") State.view = this.defaultView();
          if (!this.wasInIsland) this.fsm.mouseLeft();
          break;
        case "home":
          this.expand(this.defaultView());
          if (!this.wasInIsland) this.fsm.mouseLeft();
          break;
        case "coucou":
          this.expand("greeting");
          this.greeting.start();
          break;
      }
      State.notify();
    };
  }

  launch() {
    this.fsm.launch();
  }

  private defaultView(): IslandViewName {
    if (State.snapshot.actions.length || pendingQueue(State.sessions, State.focusId).length) return "interaction";
    if (planSession(State.sessions, State.focusId)) return "plan";
    // Recent sessions alone still open the session view: its "Recent" pill shows them.
    return State.allSessions.length ? "session" : "empty";
  }

  private setMode(mode: IslandMode) {
    const prev = State.mode;
    if (mode === prev) return;
    State.mode = mode;
    if (mode === "expanded") Sound.play("open");
    if (prev === "expanded") {
      Sound.play("close");
      State.updateNote = null;
      this.resetSize();
      State.answerOpenFor = null;
      State.stepOpen = null;
      State.showRecent = false;
      State.userPinned = false;
      State.isPinned = false;
      this.fsm.pinned = false;
      this.setKeyboard(false);
    }
    if (mode !== "expanded") this.engine.resetMorph();
    this.animateGeometry(modeOrder(mode) < modeOrder(prev));
    State.notify();
  }

  /** The finished card closes sooner than the other views. */
  private closeDelay(): number {
    const set = State.settings.autoCloseInterval;
    switch (State.view) {
      case "chat": return Math.max(CHAT_CLOSE_MIN_S, set);
      case "finished": return FINISH_CARD_S;
      case "update": return State.updateNote ? UPDATE_NOTE_S : Math.max(CARD_CLOSE_MIN_S, set);
      case "plan":
      case "interaction": return Math.max(CARD_CLOSE_MIN_S, set);
      default: return set;
    }
  }

  private expand(view: IslandViewName) {
    State.view = view;
    this.fsm.homeToPetitDelay = this.closeDelay();
    if (State.mode !== "expanded") this.setMode("expanded");
    else this.animateGeometry(false);
    State.lastActivity = performance.now();
    this.homeCollapseAt = null;
    State.notify();
  }

  private setView(view: IslandViewName) {
    if (State.mode !== "expanded") {
      this.fsm.forceHome();
      State.view = view;
      // forceHome armed the close timer with the default view's delay.
      this.fsm.homeToPetitDelay = this.closeDelay();
      this.rearmCollapse();
      this.animateGeometry(false);
      State.notify();
      return;
    }
    State.view = view;
    this.fsm.homeToPetitDelay = this.closeDelay();
    State.lastActivity = performance.now();
    this.animateGeometry(false);
    State.notify();
  }

  private collapse() {
    State.userPinned = false;
    State.isPinned = false;
    this.fsm.pinned = false;
    this.fsm.forcePetit();
  }

  private minimize() {
    State.userPinned = false;
    State.isPinned = false;
    this.fsm.pinned = false;
    this.fsm.forceStrip();
  }

  /** Something needs the user: open on this view and stay open until it is answered. */
  private alert(view: IslandViewName) {
    this.fsm.pinned = State.isPinned;
    this.fsm.forceHome();
    this.expand(view);
  }

  open() {
    this.fsm.forceHome();
  }

  openChat() {
    if (State.mode === "expanded" && State.view === "chat") this.views.get("chat")?.shown?.();
    else this.setView("chat");
  }

  /** The chat's events come from the backend (src/main.ts). */
  onChatEvent(event: ChatEvent) {
    this.chat.onEvent(event);
  }

  /** Dev preview only: drive the chat transcript directly. */
  chatDispatch(a: ChatAction) {
    this.chat.dispatch(a);
  }

  /** Something in a session waits for the user: the chat never masks it. */
  private needsUser(): boolean {
    if (State.snapshot.actions.length) return true;
    return State.allSessions.some((s) => s.live && (s.pending.length > 0 || s.status === "needs_you" || s.plan !== null));
  }

  private chatEmote(e: BotEmoteName) {
    if (this.needsUser()) return;
    // "proud" is for an answer that arrived elsewhere, the rest for the chat on screen.
    if (e === "proud" ? this.chatShown : !this.chatShown) return;
    if (e === "yawn") Sound.play("yawn");
    this.engine.triggerEmote(e);
    this.ensureRunning();
  }

  /** The chat drives Buddy only while its view is on screen and no session needs the user. */
  private syncChatBuddy() {
    const on = State.mode === "expanded" && State.view === "chat" && !this.needsUser();
    if (on) {
      const { state } = this.chat.buddy();
      State.stateOverride = state;
      this.chatApplied = state;
    } else if (this.chatApplied !== null) {
      if (State.stateOverride === this.chatApplied) State.stateOverride = null;
      this.chatApplied = null;
    }
  }

  /** Hover and love work on a calm Buddy, also while the chat holds it at idle. */
  private buddyFree(): boolean {
    return State.stateOverride == null || (State.stateOverride === "idle" && this.chatApplied === "idle");
  }

  toggleFromHotkey() {
    if (State.mode === "expanded") {
      this.collapse();
      return;
    }
    this.fsm.forceHome();
    this.setKeyboard(true);
  }

  /** Only the user's pin survives; an alert's pin ends when its card is gone. */
  private syncPin() {
    // An install in progress keeps its card open.
    State.isPinned = State.userPinned || isBusy(State.update);
    this.fsm.pinned = State.isPinned;
  }

  private togglePin() {
    State.userPinned = !State.userPinned;
    State.isPinned = State.userPinned || State.view === "interaction" || isBusy(State.update);
    this.fsm.pinned = State.isPinned;
    if (!State.isPinned) this.rearmCollapse();
    State.notify();
  }

  /** After a pin is released with the cursor outside, restart the close timer (nothing else will). */
  private rearmCollapse() {
    if (this.wasInIsland) return;
    this.fsm.mouseLeft();
    if (this.fsm.state === "home") this.homeCollapseAt = performance.now() + this.closeDelay() * 1000;
  }

  private setKeyboard(on: boolean) {
    if (on === this.keyboard) return;
    this.keyboard = on;
    void Bridge.focusWindow(on);
  }

  private cycleFocus(dir: 1 | -1) {
    const id = cycle(State.sessions, State.focusId, dir);
    if (!id || id === State.focusId) return;
    State.focusId = id;
    Sound.play("blip");
    if (State.mode === "expanded" && State.view === "empty") this.setView("session");
    this.leavePlanIfGone();
    State.notify();
  }

  /** The plan card belongs to the focused session: switching to one without a plan shows its session view. */
  private leavePlanIfGone() {
    if (State.mode === "expanded" && State.view === "plan" && !planSession(State.sessions, State.focusId)) this.setView("session");
  }

  onSnapshot(snap: Snapshot) {
    const prev = State.sessions;
    const prevAll = State.snapshot.sessions;
    const prevActions = State.snapshot.actions;
    State.snapshot = snap.actions ? snap : { ...snap, actions: [] };
    const actions = State.snapshot.actions;
    const newAction = newActionIds(prevActions, actions).length > 0;
    const { focusId, newlyPending } = resolveFocus(State.focusId, prev, State.sessions);
    State.focusId = focusId;
    const planned = newPlan(prev, snap.sessions);
    if (newlyDelivered(prevAll, snap.sessions).length) {
      Sound.play("tick");
      this.engine.blink();
    }

    const queue = pendingQueue(snap.sessions, focusId);
    const waiting = queue.length + actions.length;
    const live = new Set(queue.map((q) => q.item.requestId));
    for (const id of live) {
      if (!this.acked.has(id)) {
        this.acked.add(id);
        void Bridge.ack(id);
      }
    }
    for (const id of [...this.acked]) if (!live.has(id)) this.acked.delete(id);

    if (newlyPending || (newAction && !(State.mode === "expanded" && State.view === "interaction"))) {
      if (newAction && State.mode === "expanded" && State.view === "chat") this.resumeChat = true;
      State.isPinned = true;
      if (newAction) Sound.play("approval");
      this.alert("interaction");
    } else if (newAction) {
      Sound.play("approval");
    } else if (planned && waiting === 0) {
      Sound.play("approval");
      State.focusId = planned;
      // The same snapshot may have resolved a reply card: give the keyboard back.
      this.setKeyboard(false);
      this.showPlan();
    } else if (waiting === 0 && State.view === "interaction") {
      this.syncPin();
      this.setKeyboard(false);
      this.rearmCollapse();
      const back = this.resumeChat;
      this.resumeChat = false;
      if (State.mode === "expanded") this.setView(back ? "chat" : this.defaultView());
      else State.view = "session";
    } else if (State.view === "plan" && !planSession(State.sessions, State.focusId)) {
      if (State.mode === "expanded") {
        this.setView(this.defaultView());
        this.rearmCollapse();
      } else State.view = "session";
    } else if (State.mode === "expanded" && State.view === "empty" && snap.sessions.length) {
      this.setView("session");
    }
    State.notify();
    this.animateGeometry(false);
  }

  onCues(cues: Cue[]) {
    for (const c of cues) {
      if (c.kind === "context" && !State.settings.contextSound) continue;
      if (playsSound(c)) Sound.play(CUE_SOUNDS[c.kind]);
      if (c.kind === "finish") this.onFinish(c);
      else if (c.kind !== "approval" && State.mode === "strip") this.fsm.reveal();
    }
    State.notify();
  }

  private onFinish(c: Cue) {
    const plan = planFinish({
      style: State.settings.finishStyle,
      mode: State.mode,
      view: State.view,
      anyPending: pendingQueue(State.sessions, State.focusId).length > 0,
      busy: c.busy ?? false,
      turnMs: c.turnMs ?? null,
      minSeconds: State.settings.finishMinSeconds,
    });
    if (plan.flash) State.flash = { sessionId: c.sessionId, until: performance.now() + FLASH_MS };
    if (plan.emote) this.celebrate(plan.jump);
    if (plan.card) {
      const project = State.snapshot.sessions.find((s) => s.id === c.sessionId)?.project ?? "Session";
      this.showFinished({ sessionId: c.sessionId, project, turnMs: c.turnMs ?? null, at: Date.now() });
    }
    if (plan.reveal) this.fsm.reveal();
  }

  /** Proud eyes and stars, plus a small jump for the real thing, once per finish. */
  private celebrate(jump: boolean) {
    this.engine.triggerEmote("proud");
    if (jump) this.engine.anim("oy", [[-0.3, 140, Ease.out], [0, 380, Ease.back]]);
  }

  /** Opens (or extends) the finished card. It never pins: it closes after FINISH_CARD_S unless hovered. */
  private showFinished(item: FinishItem) {
    const shown = State.mode === "expanded" && State.view === "finished";
    State.finished = mergeFinish(State.finished, item, shown);
    State.focusId = item.sessionId;
    this.syncPin();
    if (State.mode !== "expanded") this.fsm.forceHome();
    this.expand("finished");
    this.rearmCollapse();
  }

  /** The read-only plan card: opens like an alert but never pins, so it closes on its own. */
  private showPlan() {
    this.syncPin();
    if (State.mode !== "expanded") this.fsm.forceHome();
    this.expand("plan");
    this.rearmCollapse();
  }

  /** The backend found a release: a pill always, the card only while the island is quiet. */
  onUpdateAvailable(info: UpdateInfo) {
    const first = State.update.info?.version !== info.version;
    const before = State.update;
    State.update = reduceUpdate(State.update, { type: "available", info });
    State.notify();
    if (State.update === before) return;
    State.updateNote = null;
    const quiet = !this.needsUser();
    if (first && quiet) {
      Sound.play("pop");
      this.engine.triggerEmote("happy");
    }
    if (mayAutoOpen({ mode: State.mode, view: State.view, needsUser: this.needsUser() })) this.showUpdate();
    else this.animateGeometry(false);
  }

  /** A manual check found nothing. */
  onUpdateNone() {
    this.showUpdateNote({ text: latestText(State.appVersion), tone: "ok" });
  }

  /** A failed check shows as a note; a failed install as the card's error with Retry. */
  onUpdateError(message: string) {
    // The install call and the event both report one failure.
    if (State.update.phase === "error") return;
    const installing = isBusy(State.update);
    State.update = reduceUpdate(State.update, { type: "error", message });
    Sound.play("error");
    if (installing) {
      this.syncPin();
      this.showUpdate();
    } else this.showUpdateNote({ text: checkFailedText(message), tone: "bad" });
  }

  onUpdateProgress(downloaded: number, total: number | null) {
    State.update = reduceUpdate(State.update, { type: "progress", downloaded, total });
    this.syncPin();
    State.notify();
  }

  onUpdateReady() {
    State.update = reduceUpdate(State.update, { type: "ready" });
    State.updateNote = null;
    this.syncPin();
    State.notify();
  }

  private showUpdateNote(note: { text: string; tone: "ok" | "bad" }) {
    if (isBusy(State.update) || !mayShowNote({ mode: State.mode, view: State.view, needsUser: this.needsUser() })) return;
    State.updateNote = note;
    if (note.tone === "ok") {
      Sound.play("blip");
      this.engine.triggerEmote("happy");
    }
    this.showUpdate();
  }

  /** Opens the update card like the plan card: never pinned (except during an install), so it closes on its own. */
  private showUpdate() {
    this.syncPin();
    if (State.mode !== "expanded") this.fsm.forceHome();
    this.expand("update");
    this.rearmCollapse();
  }

  private openUpdate() {
    if (!State.update.info) return;
    State.updateNote = null;
    Sound.play("blip");
    this.showUpdate();
  }

  private installUpdate() {
    const before = State.update;
    State.update = reduceUpdate(State.update, { type: "install" });
    if (State.update === before) return;
    State.updateNote = null;
    Sound.play("approve");
    this.syncPin();
    State.notify();
    void Bridge.updateInstall().then((error) => {
      if (error) this.onUpdateError(error);
    });
  }

  private laterUpdate() {
    State.update = reduceUpdate(State.update, { type: "later" });
    Sound.play("blip");
    if (State.mode === "expanded" && State.view === "update") this.collapse();
    State.notify();
  }

  /** While an install runs Buddy works; after a failed one he shows the error face. */
  private syncUpdateBuddy() {
    const u = State.update;
    let want: BotStateName | null = null;
    if (!this.needsUser() && State.stateOverride === this.updateApplied) {
      if (u.phase === "downloading" || u.phase === "installing") want = "working";
      else if (u.phase === "error" && State.mode === "expanded" && State.view === "update") want = "error";
    }
    if (want === this.updateApplied) return;
    if (State.stateOverride === this.updateApplied) State.stateOverride = want;
    this.updateApplied = want;
  }

  private async focusTerminal(sessionId: string) {
    const error = await Bridge.focusTerminal(sessionId);
    if (!error) return;
    State.notice = { text: error, until: performance.now() + 2600 };
    State.notify();
  }

  private async answer(requestId: string, answer: unknown) {
    const verdict = typeof answer === "object" && answer !== null ? (answer as { behavior?: string; allow?: boolean }) : {};
    const deny = verdict.behavior === "deny" || verdict.allow === false;
    Sound.play(deny ? "blip" : "approve");
    const error = await Bridge.answer(requestId, answer);
    if (error) {
      State.notice = { text: error, until: performance.now() + 2600 };
      Sound.play("error");
      State.notify();
    }
  }

  /** A MacBook notch (top and width in logical pixels, zero without one): the strip moves beside it. */
  setNotch(top: number, width: number) {
    if (top === this.notch.top && width === this.notch.width) return;
    this.notch = { top, width };
    document.documentElement.classList.toggle("notched", top > 0);
    this.strip.sync();
    this.stripW = this.strip.measure?.() ?? STRIP_W;
    this.updateBotTargets();
    this.animateGeometry(false);
  }

  /** The island without a manual size. */
  private naturalSize(): { w: number; h: number } {
    const measured = MEASURED_VIEWS.includes(State.view) ? this.views.get(State.view)?.measure?.() : undefined;
    const size = islandSize(State.mode, State.view, measured, this.stripW, this.autoW);
    // Beside a notch the strip is all cap: nothing hangs below the menu bar.
    return State.mode === "strip" && this.notch.top > 0 ? { w: size.w, h: 0 } : size;
  }

  private sizable(): boolean {
    return State.mode === "expanded" && SIZABLE_VIEWS.includes(State.view);
  }

  private targetSize(): { w: number; h: number; r: number } {
    const natural = this.naturalSize();
    const h = this.sizable() && State.manualH != null ? clampHeight(State.manualH, natural.h, screenSize()) : natural.h;
    return { w: natural.w, h, r: State.mode === "expanded" ? EXPANDED_CORNER : ROUNDED_CORNER };
  }

  private currentAnchor(): SizeAnchor & { view: IslandViewName } {
    const requestId = State.view === "interaction" ? (this.views.get("interaction")?.anchorId?.() ?? null) : null;
    return { focusId: State.focus?.id ?? null, requestId, view: State.view };
  }

  private setManualHeight(h: number | null) {
    if (h != null && State.manualH == null) this.sizeAnchor = this.currentAnchor();
    State.manualH = h;
    this.lastPointerAt = performance.now();
  }

  private toggleEnlarge() {
    Sound.play("blip");
    if (State.manualH != null) {
      this.resetSize();
      return;
    }
    this.setManualHeight(largeHeight(this.naturalSize().h, screenSize()));
    this.animateGeometry(false);
    State.notify();
  }

  /** Back to the natural size (double-click on the grip, or an automatic reset). */
  private resetSize() {
    if (State.manualH == null && !this.drag) return;
    State.manualH = null;
    this.endDrag();
    this.animateGeometry(true);
    State.notify();
  }

  /** Automatic reset: the card was answered, the focus moved, the island closed, or two idle minutes. */
  private checkSizeReset(nowMs: number) {
    if (State.manualH == null || this.dragging) return;
    const now = this.currentAnchor();
    const reset = shouldResetSize({
      anchor: this.sizeAnchor,
      now,
      expanded: State.mode === "expanded",
      lastPointerAt: this.lastPointerAt,
      nowMs,
    }) || now.view !== this.sizeAnchor.view;
    if (reset) this.resetSize();
  }

  private wireGrip() {
    this.grip.addEventListener("pointerdown", (e) => {
      if (!this.sizable() || e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      try {
        this.grip.setPointerCapture(e.pointerId);
      } catch {
        // Not an active pointer (synthetic event): the drag still works while the pointer stays on the grip.
      }
      // Nothing changes yet: a plain click or double-click must not resize anything.
      this.drag = { pointerId: e.pointerId, startY: e.clientY, startH: this.height.value, active: false };
    });
    this.grip.addEventListener("pointermove", (e) => {
      const d = this.drag;
      if (!d || e.pointerId !== d.pointerId) return;
      this.lastPointerAt = performance.now();
      if (!d.active) {
        if (Math.abs(e.clientY - d.startY) < DRAG_START_PX) return;
        d.active = true;
        this.setManualHeight(Math.round(d.startH));
        this.islandEl.classList.add("resizing");
        // The whole (now tall) window takes the pointer while dragging, so it can move past the island's edge.
        this.syncPanel();
      }
      const h = clampHeight(d.startH + e.clientY - d.startY, this.naturalSize().h, screenSize());
      State.manualH = h;
      this.height.jump(h);
      this.ensureRunning();
    });
    const end = (e: PointerEvent) => {
      const d = this.drag;
      if (!d || e.pointerId !== d.pointerId) return;
      this.endDrag();
      if (!d.active) return;
      // Dragged back to (or above) the natural height: that is the natural size again.
      if (State.manualH != null && State.manualH <= this.naturalSize().h) State.manualH = null;
      this.animateGeometry(false);
      State.notify();
    };
    this.grip.addEventListener("pointerup", end);
    this.grip.addEventListener("pointercancel", end);
    this.grip.addEventListener("lostpointercapture", end);
    this.grip.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      this.resetSize();
    });
  }

  private get dragging(): boolean {
    return this.drag?.active === true;
  }

  private endDrag() {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    if (this.grip.hasPointerCapture(d.pointerId)) this.grip.releasePointerCapture(d.pointerId);
    this.islandEl.classList.remove("resizing");
    this.pushedRect = { x: -1, y: -1, w: -1, h: -1 };
  }

  /** The OS window follows the island: larger while it is wide or tall, the default panel otherwise. */
  private syncPanel() {
    const h = this.dragging ? maxHeight(this.naturalSize().h, screenSize()) : this.target.h;
    const want = panelFor(this.target.w, h);
    if (want.w === this.panel.w && want.h === this.panel.h) return;
    // Grow at once, so the island never draws past the window; shrink once the island has arrived (one call, no burst).
    const shrinking = want.w < this.panel.w || want.h < this.panel.h;
    const grows = want.w > this.panel.w || want.h > this.panel.h;
    if (shrinking && !grows && (this.width.animating || this.height.animating || this.dragging)) return;
    if (shrinking && grows) {
      // One dimension grows while the other shrinks: grow now, keep the larger side until the island settles.
      if (this.width.animating || this.height.animating) {
        const keep = { w: Math.max(want.w, this.panel.w), h: Math.max(want.h, this.panel.h) };
        if (keep.w === this.panel.w && keep.h === this.panel.h) return;
        this.panel = keep;
        void Bridge.setPanelSize(keep.w, keep.h);
        return;
      }
    }
    this.panel = want;
    if (want.w === PANEL_W && want.h === PANEL_H) void Bridge.resetPanelSize();
    else void Bridge.setPanelSize(want.w, want.h);
  }

  private refreshAutoWidth() {
    if (State.mode !== "expanded") return;
    const needs = this.views.get("session")?.needs?.() ?? [];
    if (!needs.length) return;
    const w = autoWidth(needs, screenSize());
    if (Math.abs(w - this.autoW) < 1) return;
    this.autoW = w;
    this.animateGeometry(false);
  }

  /** Where the island is heading. Only a changed value restarts its animation (a re-sent target never turns a shrink into a bounce). */
  private target = { w: STRIP_W, h: STRIP_H, r: ROUNDED_CORNER };

  private animateGeometry(shrinking: boolean) {
    const next = this.targetSize();
    const move = (t: Tracked, from: number, to: number) => {
      if (Math.abs(from - to) < 0.5) return;
      if (shrinking) t.curveTowards(to);
      else t.springTo(to);
    };
    move(this.width, this.target.w, next.w);
    if (!this.dragging) move(this.height, this.target.h, next.h);
    move(this.radius, this.target.r, next.r);
    this.target = next;
    this.ensureRunning();
  }

  /** The window's width: the island is centred in it (CSS left: 50%). */
  private viewportW(): number {
    return window.innerWidth > 0 ? window.innerWidth : this.panel.w;
  }

  private applyGeometry() {
    const w = this.width.value;
    const hh = this.height.value;
    const r = this.radius.value;
    this.islandEl.style.width = `${w}px`;
    this.islandEl.style.height = `${hh}px`;
    this.islandEl.style.borderRadius = `0 0 ${r}px ${r}px`;
    // The cap takes over the rounded corners while the island below it is shorter than them.
    const capR = Math.max(0, Math.min(r, r - hh));
    this.capBody.style.borderRadius = `0 0 ${capR}px ${capR}px`;
    this.islandEl.style.transform = "translateX(-50%)";
    this.greetingCanvas.style.left = `${(w - GREETING_W) / 2}px`;
    // While the grip is dragged the whole window takes the pointer (see wireGrip).
    const rect = this.dragging
      ? { x: 0, y: 0, w: this.viewportW(), h: window.innerHeight > 0 ? window.innerHeight : this.panel.h }
      : this.islandRect();
    const p = this.pushedRect;
    if (Math.abs(p.x - rect.x) > 0.5 || Math.abs(p.y - rect.y) > 0.5 || Math.abs(p.w - rect.w) > 0.5 || Math.abs(p.h - rect.h) > 0.5) {
      this.pushedRect = rect;
      void Bridge.setIslandRect(rect.x, rect.y, rect.w, rect.h);
    }
  }

  /** The island plus its notch cap, which sits above y = 0. */
  private islandRect() {
    const w = this.width.value;
    const top = this.notch.top;
    return { x: (this.viewportW() - w) / 2, y: -top, w, h: this.height.value + top };
  }

  private wireInput() {
    this.wireGrip();
    this.islandEl.addEventListener("pointermove", () => (this.lastPointerAt = performance.now()));
    this.islandEl.addEventListener("mousedown", (e) => {
      Sound.resume();
      State.lastActivity = performance.now();
      this.lastPointerAt = performance.now();
      const onButton = (e.target as Element | null)?.closest("button, input, textarea, .tab, #grip");
      if (State.mode !== "expanded") {
        if (!onButton) this.fsm.click();
        return;
      }
      if (this.isBotHit(e.clientX, e.clientY)) {
        this.cancelBotHover();
        this.engine.slap();
      }
    });

    this.islandEl.addEventListener(
      "wheel",
      (e) => {
        this.lastPointerAt = performance.now();
        if ((e.target as Element | null)?.closest(".scrollable")) return;
        e.preventDefault();
        const now = performance.now();
        if (now - this.lastWheel < WHEEL_GAP_MS) return;
        this.lastWheel = now;
        const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
        if (delta !== 0) this.cycleFocus(delta > 0 ? 1 : -1);
      },
      { passive: false },
    );

    window.addEventListener("keydown", (e) => {
      State.lastActivity = performance.now();
      if (this.views.get(State.view)?.key?.(e)) return;
      if (e.key === "Escape") {
        if (State.mode === "expanded") this.collapse();
        this.setKeyboard(false);
        return;
      }
      const typing = (e.target as Element | null)?.closest("input, textarea");
      if (typing) return;
      if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        this.openChat();
        return;
      }
      if (e.key === "ArrowRight" || (e.key === "Tab" && !e.shiftKey)) {
        e.preventDefault();
        this.cycleFocus(1);
      } else if (e.key === "ArrowLeft" || (e.key === "Tab" && e.shiftKey)) {
        e.preventDefault();
        this.cycleFocus(-1);
      } else if (/^[1-9]$/.test(e.key)) {
        const s = State.sessions[Number(e.key) - 1];
        if (s) this.actions().focus(s.id);
      }
    });

    if (!IS_TAURI) {
      window.addEventListener("mousemove", (e) => this.onCursor(e.clientX, e.clientY));
    }
  }

  onCursor(x: number, y: number) {
    State.mouse = { x, y };
    const rect = this.islandRect();
    // The island's own y starts below the notch cap (rect.y is the cap's top).
    State.mouseInIsland = { x: x - rect.x, y };
    const inIsland =
      x >= rect.x - HIT_MARGIN && x <= rect.x + rect.w + HIT_MARGIN &&
      y >= rect.y - HIT_MARGIN && y <= rect.y + rect.h + HIT_MARGIN;
    if (inIsland) this.lastPointerAt = performance.now();
    // wasInIsland must be current before the FSM runs: its transition handler reads it.
    if (inIsland && !this.wasInIsland) {
      this.wasInIsland = true;
      Sound.resume();
      if (this.fsm.state === "coucou") this.greeting.hover();
      this.fsm.mouseEntered();
      this.homeCollapseAt = null;
    }
    if (!inIsland && this.wasInIsland) {
      this.wasInIsland = false;
      this.fsm.mouseLeft();
      if (this.fsm.state === "home" && !State.isPinned) {
        this.homeCollapseAt = performance.now() + this.closeDelay() * 1000;
      }
    }

    const overBot = State.mode === "expanded" && this.buddyFree() && this.isBotHit(x, y);
    if (overBot && !this.botHovering) this.botHoverIn(x, y);
    if (!overBot && this.botHovering) this.cancelBotHover();
    this.botHovering = overBot;
    if (this.botHovering) {
      const d = Math.hypot(x - this.botHoverStart.x, y - this.botHoverStart.y);
      if (d > 40) {
        this.botHoverStart = { x, y };
        this.scheduleLove();
      }
    }
    this.ensureRunning();
  }

  private isBotHit(x: number, y: number): boolean {
    const rect = this.islandRect();
    const cx = rect.x + this.botCx.value;
    const cy = this.botCy.value;
    const radius = this.botSize.value / 2;
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius;
  }

  private botHoverIn(x: number, y: number) {
    if (performance.now() / 1000 - this.lastLoveTime < 6) return;
    this.botHoverStart = { x, y };
    this.engine.blink();
    this.engine.tgEs = 1.08;
    Sound.play("hover");
    this.scheduleLove();
  }

  private scheduleLove() {
    if (this.botHoverTimer != null) window.clearTimeout(this.botHoverTimer);
    this.botHoverTimer = window.setTimeout(() => {
      this.botHoverTimer = null;
      if (!this.botHovering || !this.buddyFree()) return;
      if (performance.now() / 1000 - this.lastLoveTime < 6) return;
      this.lastLoveTime = performance.now() / 1000;
      this.engine.triggerEmote("love");
      Sound.play("love");
    }, 1900);
  }

  private cancelBotHover() {
    if (this.botHoverTimer != null) window.clearTimeout(this.botHoverTimer);
    this.botHoverTimer = null;
    this.engine.tgEs = 1;
  }

  /** Three slaps: dizzy + confused view for 3.3 s, then back. */
  private handleDizzy() {
    this.prevViewBeforeConfused = State.view;
    State.stateOverride = "dizzy";
    this.engine.setState("dizzy");
    Sound.play("dizzy");
    this.alert("confused");
    if (this.confusedRecovery != null) window.clearTimeout(this.confusedRecovery);
    this.confusedRecovery = window.setTimeout(() => {
      this.confusedRecovery = null;
      State.stateOverride = null;
      this.engine.setState(State.effectiveState);
      if (State.view === "confused") {
        this.setView(this.prevViewBeforeConfused === "confused" ? this.defaultView() : this.prevViewBeforeConfused);
      }
      this.engine.triggerEmote("happy");
    }, 3300);
  }

  private ensureRunning() {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    requestAnimationFrame(this.frame);
  }

  private frame = (nowMs: number) => {
    const dt = Math.min(0.05, (nowMs - this.lastFrame) / 1000);
    this.lastFrame = nowMs;

    this.checkSizeReset(nowMs);
    this.width.step(dt, nowMs);
    this.height.step(dt, nowMs);
    this.radius.step(dt, nowMs);
    this.applyGeometry();
    this.syncPanel();
    // A changing size changes how many step rows fit and what the rows need: re-sync when the
    // height crosses a 20 px row boundary and once when the island has settled, not every frame.
    const resizing = this.width.animating || this.height.animating || this.dragging;
    const bucket = Math.floor(this.height.value / ROW_STEP_PX);
    if (State.mode === "expanded" && (bucket !== this.heightBucket || (this.wasResizing && !resizing))) this.dirty = true;
    this.heightBucket = bucket;
    this.wasResizing = resizing;

    if (State.flash && nowMs > State.flash.until) {
      State.flash = null;
      this.dirty = true;
    }
    if (State.notice && nowMs > State.notice.until) {
      State.notice = null;
      this.dirty = true;
    }
    if (this.dirty) {
      this.dirty = false;
      this.syncDom();
    }

    this.updateBotTargets();
    this.botCx.step(dt);
    this.botCy.step(dt);
    this.botSize.step(dt);

    const greetingActive = State.mode === "expanded" && State.view === "greeting";
    if (greetingActive) {
      const gctx = this.greetingCanvas.getContext("2d");
      if (gctx) {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.greeting.draw(gctx);
      }
    } else {
      this.drawBot(dt);
    }

    if (State.mode === "compact") this.compact.tick?.(nowMs);
    if (State.mode === "expanded") this.views.get(State.view)?.tick?.(nowMs);
    this.updateCountdown(nowMs);

    const settling = this.width.animating || this.height.animating || this.radius.animating || this.dragging;
    const animating =
      settling || !this.botCx.settled || !this.botCy.settled || !this.botSize.settled ||
      greetingActive || this.engine.busy || State.flash != null || State.notice != null ||
      (State.mode === "expanded" && this.views.get(State.view)?.busy?.() === true);

    if (!animating && State.mode === "strip") {
      this.running = false;
      Sound.idle();
      return;
    }
    // Mochi breathes forever while the island is visible; 15 fps is plenty when nothing is
    // animating (the countdown bar and the status timer still tick) and keeps CPU low.
    if (!animating) window.setTimeout(() => requestAnimationFrame(this.frame), 66);
    else requestAnimationFrame(this.frame);
  };

  private updateBotTargets() {
    const p = botPosition(State.mode, State.view);
    // Beside a notch the strip's Buddy sits in the cap, left of the notch.
    const inCap = State.mode === "strip" && this.notch.top > 0;
    this.botCx.target = inCap ? 22 : p.cx;
    this.botCy.target = inCap ? -this.notch.top / 2 : p.cy;
    this.botSize.target = (inCap ? 20 : p.diameter) / 0.6;
    const greetingActive = State.mode === "expanded" && State.view === "greeting";
    this.botCanvas.style.opacity = p.opacity > 0 && !greetingActive ? "1" : "0";
    if (State.mode === "expanded" && !greetingActive) {
      const d = p.diameter;
      const color = botGlowColor(State.effectiveState);
      this.botGlow.style.display = "block";
      this.botGlow.style.width = `${d * 2.2}px`;
      this.botGlow.style.height = `${d * 2.2}px`;
      this.botGlow.style.left = `${this.botCx.value - d * 1.1}px`;
      this.botGlow.style.top = `${this.botCy.value - d * 1.1}px`;
      this.botGlow.style.background = `radial-gradient(circle, ${color} 0%, transparent 62%)`;
      this.botGlow.style.opacity = String(botGlowOpacity(State.effectiveState));
    } else {
      this.botGlow.style.display = "none";
    }
  }

  private drawBot(dt: number) {
    const size = this.botSize.value;
    const w = Math.max(1, Math.round(size));
    const hCss = w + BOT_OVERHANG;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (this.canvasPx !== w) {
      this.canvasPx = w;
      this.botCanvas.width = Math.round(w * dpr);
      this.botCanvas.height = Math.round(hCss * dpr);
      this.botCanvas.style.width = `${w}px`;
      this.botCanvas.style.height = `${hCss}px`;
    }
    this.botCanvas.style.left = `${this.botCx.value - w / 2}px`;
    this.botCanvas.style.top = `${this.botCy.value - BOT_OVERHANG / 2 - hCss / 2}px`;
    const ctx = this.botCanvas.getContext("2d");
    if (!ctx) return;
    const s = State.mochiSession;
    this.engine.bodyColor = s ? hexToRGB(colorForProject(s.project)) : null;
    this.engine.particleOverhang = BOT_OVERHANG;
    this.engine.lookX = Math.tanh((State.mouse.x - (this.islandRect().x + this.botCx.value)) / 260);
    this.engine.lookY = -Math.tanh((State.mouse.y - this.botCy.value) / 200);
    // Typing in the chat composer: eyes down and to the right, where the box is.
    if (State.mode === "expanded" && State.view === "chat" && this.chat.buddy().lookDown) {
      this.engine.lookX = 0.35;
      this.engine.lookY = -0.85;
    }
    this.engine.update(dt);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hCss);
    this.engine.draw(ctx, w, hCss);
  }

  private updateCountdown(nowMs: number) {
    if (State.mode !== "expanded" || State.isPinned || this.homeCollapseAt == null) {
      this.countdown.style.width = "0px";
      return;
    }
    const windowS = Math.min(10, this.closeDelay() * 0.6);
    const remaining = (this.homeCollapseAt - nowMs) / 1000;
    this.countdown.style.width = remaining < windowS ? `${Math.max(0, clamp(remaining / windowS, 0, 1) * 160)}px` : "0px";
  }

  private syncDom() {
    const expanded = State.mode === "expanded";
    const greetingActive = expanded && State.view === "greeting";
    this.contentEl.style.opacity = expanded && !greetingActive ? "1" : "0";
    this.contentEl.style.pointerEvents = expanded && !greetingActive ? "auto" : "none";
    this.greetingCanvas.style.display = greetingActive ? "block" : "none";

    this.strip.el.classList.toggle("on", State.mode === "strip");
    this.compact.el.classList.toggle("on", State.mode === "compact");
    // Always kept current: its width decides the strip's size before the island shrinks to it.
    this.strip.sync();
    const stripW = this.strip.measure?.() ?? STRIP_W;
    if (Math.abs(stripW - this.stripW) > 0.5) {
      this.stripW = stripW;
      if (State.mode === "strip") this.animateGeometry(false);
    }
    if (State.mode === "compact") this.compact.sync();

    for (const [name, view] of this.views) {
      const on = expanded && name === State.view;
      view.el.classList.toggle("on", on);
      // The session view stays current while expanded: its rows decide the width of every view.
      if (on || (expanded && name === "session")) view.sync();
    }
    const onChat = expanded && State.view === "chat";
    if (onChat !== this.chatShown) {
      this.chatShown = onChat;
      const chatView = this.views.get("chat");
      if (onChat) {
        this.chat.opened();
        chatView?.shown?.();
      } else {
        this.chat.closed();
        chatView?.hidden?.();
      }
    }
    this.syncChatBuddy();
    this.syncUpdateBuddy();
    const big = this.sizable() && State.manualH != null;
    this.islandEl.classList.toggle("big", big);
    this.grip.classList.toggle("on", this.sizable() && !greetingActive);
    if (expanded) {
      this.refreshAutoWidth();
      if (MEASURED_VIEWS.includes(State.view) || big) this.animateGeometry(false);
    }

    this.engine.setState(State.effectiveState);
  }

  applySettings() {
    Sound.setEnabled(State.settings.soundEnabled);
    Sound.setVolume(State.settings.soundVolume);
    this.fsm.homeToPetitDelay = this.closeDelay();
    this.fsm.compactToStripDelay = State.settings.compactInterval;
    this.chat.applySettings();
    State.notify();
  }
}
