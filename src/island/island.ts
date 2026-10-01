// The island: DOM shell, sizing animation, Mochi placement, mouse, wheel and keys.
// Forked from Coucou's island.ts. File drop, chat and integration pills are gone,
// and the island never hides: it rests as a strip.

import { Ease, Tracked, Spring, clamp } from "../core/anim";
import { Bridge, IS_TAURI } from "../core/bridge";
import {
  EXPANDED_CORNER, GREETING_W, PANEL_W, ROUNDED_CORNER, STRIP_H, STRIP_W, botGlowColor, botGlowOpacity, botPosition,
  colorForProject, islandSize, type IslandMode, type IslandViewName,
} from "../core/layout";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import type { Cue, CueKind, Snapshot } from "../core/types";
import { BotEngine, hexToRGB } from "../mochi/engine";
import { Greeting } from "../mochi/greeting";
import { FINISH_CARD_S, mergeFinish, planFinish, type FinishItem } from "../model/finish";
import { newPlan, planSession } from "../model/plan";
import { cycle, pendingQueue, resolveFocus } from "../model/viewmodel";
import { h } from "../views/dom";
import { buildCompact } from "../views/compact";
import { buildStrip } from "../views/strip";
import { buildViews, type ViewActions, type ViewHost } from "../views/views";
import { IslandStateMachine } from "./fsm";

const BOT_OVERHANG = 40;
/** Same margin as the Rust hit test (src-tauri/src/island.rs). */
const HIT_MARGIN = 14;
const FLASH_MS = 6000;
const WHEEL_GAP_MS = 180;

const CUE_SOUNDS: Record<CueKind, string> = {
  work: "work", finish: "finish", error: "error", approval: "approval", rate: "rate", context: "question",
};

const modeOrder = (m: IslandMode) => (m === "strip" ? 0 : m === "compact" ? 1 : 2);

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
  private lastWheel = 0;
  private keyboard = false;

  constructor(root: HTMLElement) {
    this.root = root;
    this.build();
    this.wireFsm();
    this.wireInput();
    this.engine.onDizzy = () => this.handleDizzy();
    this.greeting.onComplete = () => this.fsm.greetComplete();
    State.subscribe(() => {
      this.dirty = true;
      this.ensureRunning();
    });
  }

  // -- DOM ------------------------------------------------------------------

  private actions(): ViewActions {
    return {
      focus: (id) => {
        State.focusId = id;
        Sound.play("blip");
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
      answer: (requestId, answer) => void this.answer(requestId, answer),
      release: (requestId) => {
        Sound.play("blip");
        void Bridge.release(requestId);
      },
      openSettings: () => void Bridge.openSettingsWindow(),
      wantKeyboard: (on) => this.setKeyboard(on),
      relayout: () => this.animateGeometry(false),
    };
  }

  private build() {
    const actions = this.actions();
    this.botGlow = h("div", { id: "bot-glow" });
    this.botCanvas = h("canvas", { id: "bot-canvas" });
    this.greetingCanvas = h("canvas", { id: "greeting-canvas" });
    this.countdown = h("div", { id: "countdown" });

    this.strip = buildStrip();
    this.compact = buildCompact(actions);
    this.views = buildViews(actions);
    const viewsEl = h("div", { id: "views" });
    for (const v of this.views.values()) viewsEl.append(v.el);
    this.contentEl = h("div", { id: "content" }, viewsEl);

    this.clipEl = h("div", { id: "island-clip" }, this.greetingCanvas, this.strip.el, this.compact.el, this.contentEl);
    this.islandEl = h("div", { id: "island" }, this.clipEl, this.botGlow, this.botCanvas, this.countdown);

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.greetingCanvas.width = Math.round(GREETING_W * dpr);
    this.greetingCanvas.height = Math.round(150 * dpr);
    this.greetingCanvas.style.width = `${GREETING_W}px`;
    this.greetingCanvas.style.height = "150px";

    this.root.append(this.islandEl);
    this.applyGeometry();
  }

  // -- FSM ------------------------------------------------------------------

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
    if (pendingQueue(State.sessions, State.focusId).length) return "interaction";
    if (planSession(State.sessions, State.focusId)) return "plan";
    return State.sessions.length ? "session" : "empty";
  }

  // -- Mode / view ----------------------------------------------------------

  private setMode(mode: IslandMode) {
    const prev = State.mode;
    if (mode === prev) return;
    State.mode = mode;
    if (mode === "expanded") Sound.play("open");
    if (prev === "expanded") {
      Sound.play("close");
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
    return State.view === "finished" ? FINISH_CARD_S : State.settings.autoCloseInterval;
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
    State.isPinned = false;
    this.fsm.pinned = false;
    this.fsm.forcePetit();
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

  toggleFromHotkey() {
    if (State.mode === "expanded") {
      this.collapse();
      return;
    }
    this.fsm.forceHome();
    this.setKeyboard(true);
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
    State.notify();
  }

  // -- Data from Rust -------------------------------------------------------

  onSnapshot(snap: Snapshot) {
    const prev = State.snapshot.sessions;
    State.snapshot = snap;
    const { focusId, newlyPending } = resolveFocus(State.focusId, prev, snap.sessions);
    State.focusId = focusId;
    const planned = newPlan(prev, snap.sessions);

    const queue = pendingQueue(snap.sessions, focusId);
    const live = new Set(queue.map((q) => q.item.requestId));
    for (const id of live) {
      if (!this.acked.has(id)) {
        this.acked.add(id);
        void Bridge.ack(id);
      }
    }
    for (const id of [...this.acked]) if (!live.has(id)) this.acked.delete(id);

    if (newlyPending) {
      State.isPinned = true;
      this.alert("interaction");
    } else if (planned && queue.length === 0) {
      Sound.play("approval");
      State.focusId = planned;
      this.showPlan();
    } else if (queue.length === 0 && State.view === "interaction") {
      State.isPinned = false;
      this.fsm.pinned = false;
      this.setKeyboard(false);
      this.rearmCollapse();
      if (State.mode === "expanded") this.setView(this.defaultView());
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
      Sound.play(CUE_SOUNDS[c.kind]);
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
    });
    if (plan.flash) State.flash = { sessionId: c.sessionId, until: performance.now() + FLASH_MS };
    if (plan.emote) this.celebrate();
    if (plan.card) {
      const project = State.snapshot.sessions.find((s) => s.id === c.sessionId)?.project ?? "Session";
      this.showFinished({ sessionId: c.sessionId, project, turnMs: c.turnMs ?? null, at: Date.now() });
    }
    if (plan.reveal) this.fsm.reveal();
  }

  /** Proud eyes and stars plus a small jump, once per finish. */
  private celebrate() {
    this.engine.triggerEmote("proud");
    this.engine.anim("oy", [[-0.3, 140, Ease.out], [0, 380, Ease.back]]);
  }

  /** Opens (or extends) the finished card. It never pins: it closes after FINISH_CARD_S unless hovered. */
  private showFinished(item: FinishItem) {
    const shown = State.mode === "expanded" && State.view === "finished";
    State.finished = mergeFinish(State.finished, item, shown);
    State.focusId = item.sessionId;
    State.isPinned = false;
    this.fsm.pinned = false;
    if (State.mode !== "expanded") this.fsm.forceHome();
    this.expand("finished");
    this.rearmCollapse();
  }

  /** The read-only plan card: opens like an alert but never pins, so it closes on its own. */
  private showPlan() {
    State.isPinned = false;
    this.fsm.pinned = false;
    if (State.mode !== "expanded") this.fsm.forceHome();
    this.expand("plan");
    this.rearmCollapse();
  }

  private async answer(requestId: string, answer: unknown) {
    const deny = typeof answer === "object" && answer !== null && (answer as { behavior?: string }).behavior === "deny";
    Sound.play(deny ? "blip" : "approve");
    const error = await Bridge.answer(requestId, answer);
    if (error) {
      State.notice = { text: error, until: performance.now() + 2600 };
      Sound.play("error");
      State.notify();
    }
  }

  // -- Geometry -------------------------------------------------------------

  private targetSize(): { w: number; h: number; r: number } {
    const { w, h } = islandSize(State.mode, State.view, this.views.get("interaction")?.measure?.());
    return { w, h, r: State.mode === "expanded" ? EXPANDED_CORNER : ROUNDED_CORNER };
  }

  private animateGeometry(shrinking: boolean) {
    const { w, h, r } = this.targetSize();
    if (shrinking) {
      this.width.curveTowards(w);
      this.height.curveTowards(h);
      this.radius.curveTowards(r);
    } else {
      this.width.springTo(w);
      this.height.springTo(h);
      this.radius.springTo(r);
    }
    this.ensureRunning();
  }

  private applyGeometry() {
    const w = this.width.value;
    const hh = this.height.value;
    const r = this.radius.value;
    this.islandEl.style.width = `${w}px`;
    this.islandEl.style.height = `${hh}px`;
    this.islandEl.style.borderRadius = `0 0 ${r}px ${r}px`;
    this.islandEl.style.transform = "translateX(-50%)";
    this.greetingCanvas.style.left = `${(w - GREETING_W) / 2}px`;
    const rect = { x: (PANEL_W - w) / 2, y: 0, w, h: hh };
    const p = this.pushedRect;
    if (Math.abs(p.x - rect.x) > 0.5 || Math.abs(p.w - rect.w) > 0.5 || Math.abs(p.h - rect.h) > 0.5) {
      this.pushedRect = rect;
      void Bridge.setIslandRect(rect.x, rect.y, rect.w, rect.h);
    }
  }

  private islandRect() {
    const w = this.width.value;
    return { x: (PANEL_W - w) / 2, y: 0, w, h: this.height.value };
  }

  // -- Input ----------------------------------------------------------------

  private wireInput() {
    this.islandEl.addEventListener("mousedown", (e) => {
      Sound.resume();
      State.lastActivity = performance.now();
      const onButton = (e.target as Element | null)?.closest("button, input, textarea, .tab");
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
    State.mouseInIsland = { x: x - rect.x, y: y - rect.y };
    const inIsland =
      x >= rect.x - HIT_MARGIN && x <= rect.x + rect.w + HIT_MARGIN &&
      y >= rect.y - HIT_MARGIN && y <= rect.y + rect.h + HIT_MARGIN;
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

    const overBot = State.mode === "expanded" && State.stateOverride == null && this.isBotHit(x, y);
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
    const cy = rect.y + this.botCy.value;
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
      if (!this.botHovering || State.stateOverride != null) return;
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

  // -- Frame loop -----------------------------------------------------------

  private ensureRunning() {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    requestAnimationFrame(this.frame);
  }

  private frame = (nowMs: number) => {
    const dt = Math.min(0.05, (nowMs - this.lastFrame) / 1000);
    this.lastFrame = nowMs;

    this.width.step(dt, nowMs);
    this.height.step(dt, nowMs);
    this.radius.step(dt, nowMs);
    this.applyGeometry();

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

    const settling = this.width.animating || this.height.animating || this.radius.animating;
    const animating =
      settling || !this.botCx.settled || !this.botCy.settled || !this.botSize.settled ||
      greetingActive || this.engine.busy || State.flash != null || State.notice != null;

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
    this.botCx.target = p.cx;
    this.botCy.target = p.cy;
    this.botSize.target = p.diameter / 0.6;
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

  // -- DOM sync -------------------------------------------------------------

  private syncDom() {
    const expanded = State.mode === "expanded";
    const greetingActive = expanded && State.view === "greeting";
    this.contentEl.style.opacity = expanded && !greetingActive ? "1" : "0";
    this.contentEl.style.pointerEvents = expanded && !greetingActive ? "auto" : "none";
    this.greetingCanvas.style.display = greetingActive ? "block" : "none";

    this.strip.el.classList.toggle("on", State.mode === "strip");
    this.compact.el.classList.toggle("on", State.mode === "compact");
    if (State.mode === "strip") this.strip.sync();
    if (State.mode === "compact") this.compact.sync();

    for (const [name, view] of this.views) {
      const on = expanded && name === State.view;
      view.el.classList.toggle("on", on);
      if (on) view.sync();
    }
    if (expanded && State.view === "interaction") this.animateGeometry(false);

    this.engine.setState(State.effectiveState);
  }

  applySettings() {
    Sound.setEnabled(State.settings.soundEnabled);
    Sound.setVolume(State.settings.soundVolume);
    this.fsm.homeToPetitDelay = this.closeDelay();
    this.fsm.compactToStripDelay = State.settings.compactInterval;
    State.notify();
  }
}
