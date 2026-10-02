// Buddy Chat on the island side: folds backend events into State.chat, plays the
// chat sounds, decides how long Buddy keeps a face and talks to the bridge.

import { Bridge, type ChatModels } from "../core/bridge";
import type { BotEmoteName, BotStateName } from "../core/layout";
import { Sound } from "../core/sound";
import { State, type Settings } from "../core/state";
import {
  BUDDY_FLASH_MS, buildOverviewBlock, buildSessionBlock, canSend, chatBuddy, chatMoments, composePrompt, isBusy, overviewChip, reduceChat,
  sessionChip, type ChatAction, type ChatEvent, type ContextChip, type SuggestionContext,
} from "../model/chat";

export interface ChatHost {
  /** The chat view is on screen (expanded island). */
  viewing(): boolean;
  /** A one-shot Buddy emote; the island decides whether it may play. */
  emote(e: BotEmoteName): void;
}

export class ChatController {
  private flash: { kind: "finished" | "error"; until: number } | null = null;
  private typingOn = false;

  constructor(private host: ChatHost) {}

  dispatch(a: ChatAction) {
    const prev = State.chat;
    const next = reduceChat(prev, a);
    if (next === prev) return;
    State.chat = next;
    if (a.type === "event" || a.type === "status" || a.type === "enabled") {
      const viewing = this.host.viewing();
      const moments = chatMoments(prev, next, viewing);
      for (const s of moments.sounds) {
        if (s === "pop") window.setTimeout(() => Sound.play("pop"), 280);
        else Sound.play(s);
      }
      if (moments.failed) this.flashFor("error");
      else if (moments.finished) this.flashFor("finished");
      if (moments.emote) this.host.emote(moments.emote);
    }
    State.notify();
  }

  onEvent(event: ChatEvent) {
    this.dispatch({ type: "event", event, at: Date.now(), viewing: this.host.viewing() });
  }

  /** The setting may have changed in either window. */
  applySettings() {
    const on = State.settings.chatEnabled;
    this.dispatch({ type: "enabled", on, at: Date.now() });
    // The model may have changed even while the chat is off: the header and the Off card name it.
    void this.refreshStatus();
  }

  async refreshStatus() {
    const status = await Bridge.chatStatus();
    if (status && !isBusy(State.chat)) this.dispatch({ type: "status", status, at: Date.now() });
  }

  /** The chat view came on screen. */
  opened() {
    this.dispatch({ type: "seen" });
    if (State.chat.enabled) void Bridge.chatWake();
    void this.refreshStatus();
  }

  closed() {
    this.typing(false);
  }

  send(text: string, context: SuggestionContext) {
    const clean = text.trim();
    if (!clean || !canSend(State.chat)) return;
    let chip: ContextChip | null = null;
    let block: string | null = null;
    if (context?.kind === "session") {
      const s = State.allSessions.find((x) => x.id === context.sessionId);
      if (s) {
        chip = sessionChip(s);
        block = buildSessionBlock(s);
      }
    } else if (context?.kind === "overview") {
      chip = overviewChip();
      block = buildOverviewBlock(State.allSessions);
    }
    this.flash = null;
    this.dispatch({ type: "send", text: clean, context: chip, at: Date.now() });
    Sound.play("send");
    void Bridge.chatSend(composePrompt(block, clean)).then((r) => {
      if (!r.ok) this.dispatch({ type: "sendFailed", message: r.error, at: Date.now() });
    });
  }

  stop() {
    this.dispatch({ type: "stop", at: Date.now() });
    void Bridge.chatInterrupt();
  }

  reset() {
    this.flash = null;
    this.dispatch({ type: "reset" });
    void Bridge.chatReset();
  }

  setEnabled(on: boolean) {
    State.settings = { ...State.settings, chatEnabled: on };
    void Bridge.saveSettings(State.settings);
    Sound.play("blip");
    this.dispatch({ type: "enabled", on, at: Date.now() });
    if (on) {
      if (this.host.viewing()) void Bridge.chatWake();
      void this.refreshStatus();
    }
  }

  setModel(patch: Partial<Settings>) {
    if (isBusy(State.chat)) return;
    State.settings = { ...State.settings, ...patch };
    Sound.play("blip");
    State.notify();
    void Bridge.saveSettings(State.settings).then(() => this.refreshStatus());
  }

  models(): Promise<ChatModels> {
    return Bridge.chatModels(State.settings.chatOllamaUrl);
  }

  typing(on: boolean) {
    if (this.typingOn === on) return;
    this.typingOn = on;
    State.notify();
  }

  buddy(): { state: BotStateName; lookDown: boolean } {
    const flash = this.flash && performance.now() < this.flash.until ? this.flash.kind : null;
    return chatBuddy(State.chat, { typing: this.typingOn, flash });
  }

  private flashFor(kind: "finished" | "error") {
    this.flash = { kind, until: performance.now() + BUDDY_FLASH_MS };
    window.setTimeout(() => State.notify(), BUDDY_FLASH_MS + 40);
  }
}
