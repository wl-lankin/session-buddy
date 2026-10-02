// The live Buddy in the settings header: the island's engine on a small canvas.

import { BotEngine } from "../buddy/engine";
import type { BotStateName } from "../core/layout";
import { h } from "../views/dom";
import { reactionFor, restingState, type SettingsEvent } from "./reactions";

const SIZE = 72;
const OVERHANG = 18;

export interface HeaderBuddy {
  el: HTMLElement;
  /** Tells Buddy what the user just did. */
  react(ev: SettingsEvent): void;
  /** Sound off puts him to sleep, on wakes him. */
  setSound(on: boolean): void;
}

export function headerBuddy(soundOn: boolean): HeaderBuddy {
  const engine = new BotEngine();
  engine.particleOverhang = OVERHANG;
  const canvas = h("canvas", { class: "buddy", title: "Poke me", "aria-hidden": "true" });
  const el = h("div", { class: "buddy-wrap" }, canvas);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const heightPx = SIZE + OVERHANG;
  canvas.width = Math.round(SIZE * dpr);
  canvas.height = Math.round(heightPx * dpr);
  canvas.style.width = `${SIZE}px`;
  canvas.style.height = `${heightPx}px`;
  const ctx = canvas.getContext("2d");

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  let sound = soundOn;
  let holdTimer: number | null = null;
  let hovering = false;
  let loveTimer: number | null = null;
  let lastLove = 0;
  let mouse: { x: number; y: number } | null = null;

  const rest = () => engine.setState(restingState(sound));
  const hold = (state: BotStateName, ms: number) => {
    if (holdTimer != null) window.clearTimeout(holdTimer);
    engine.setState(state);
    holdTimer = window.setTimeout(() => {
      holdTimer = null;
      rest();
    }, ms);
  };
  rest();

  engine.onDizzy = () => {
    hold("dizzy", 3300);
    window.setTimeout(() => engine.triggerEmote("happy"), 3300);
  };

  window.addEventListener("mousemove", (e) => (mouse = { x: e.clientX, y: e.clientY }));
  document.documentElement.addEventListener("mouseleave", () => (mouse = null));

  canvas.addEventListener("mousedown", () => {
    if (engine.state === "sleeping" && holdTimer == null) {
      engine.triggerEmote("surprised");
      return;
    }
    engine.slap();
  });
  canvas.addEventListener("mouseenter", () => {
    hovering = true;
    engine.tgEs = 1.08;
    engine.blink();
  });
  canvas.addEventListener("mouseleave", () => {
    hovering = false;
    engine.tgEs = 1;
    if (loveTimer != null) window.clearTimeout(loveTimer);
    loveTimer = null;
  });
  // Hovering the whole header earns the love after a moment, like in the island.
  const scheduleLove = () => {
    if (loveTimer != null || sound === false) return;
    loveTimer = window.setTimeout(() => {
      loveTimer = null;
      const t = performance.now();
      if (!hovering || holdTimer != null || t - lastLove < 6000) return;
      lastLove = t;
      engine.triggerEmote("love");
    }, 1900);
  };
  canvas.addEventListener("mousemove", scheduleLove);

  let last = performance.now();
  const frame = (nowMs: number) => {
    const step = reduced.matches ? 120 : 0;
    if (!document.hidden && ctx && nowMs - last >= step) {
      const dt = Math.min(0.1, (nowMs - last) / 1000);
      last = nowMs;
      const r = canvas.getBoundingClientRect();
      const cx = r.left + SIZE / 2;
      const cy = r.top + OVERHANG + SIZE / 2;
      engine.lookX = mouse ? Math.tanh((mouse.x - cx) / 260) : 0;
      engine.lookY = mouse ? -Math.tanh((mouse.y - cy) / 200) : 0;
      engine.update(dt);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, SIZE, heightPx);
      engine.draw(ctx, SIZE, heightPx);
    } else if (document.hidden) {
      last = nowMs;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  return {
    el,
    react(ev) {
      if (ev.kind === "sound") this.setSound(ev.on);
      const r = reactionFor(ev);
      if (!r) return;
      if (r.state) hold(r.state, r.holdMs ?? 2000);
      else if (r.emote) {
        if (holdTimer != null) {
          window.clearTimeout(holdTimer);
          holdTimer = null;
          rest();
        }
        engine.triggerEmote(r.emote, r.holdMs ? r.holdMs / 1000 : 1.8);
      }
    },
    setSound(on) {
      sound = on;
      if (holdTimer == null) rest();
    },
  };
}
