// Thin wrapper over the Tauri commands and events. Outside Tauri (plain
// browser, dev/preview.html) every call dispatches an `sb-invoke` DOM event
// instead, so the preview can react to answers.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Settings } from "./state";
import type { Snapshot } from "./types";
import type { ChatEvent, ChatStatus } from "../model/chat";
import type { CheckResult } from "../model/update";
import { fakeChat, fakeChatListen } from "./chatfake";
import { fakeUpdateListen } from "./updatefake";

export const IS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function browserInvoke(cmd: string, args?: Record<string, unknown>) {
  window.dispatchEvent(new CustomEvent("sb-invoke", { detail: { cmd, args } }));
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!IS_TAURI) {
    browserInvoke(cmd, args);
    return (fakeChat(cmd, args)?.value as T | undefined) ?? null;
  }
  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    console.error(`${cmd} failed`, err);
    return null;
  }
}

/** Local models an Ollama server offers (`chat_models`). */
export interface ChatModels { reachable: boolean; models: string[]; error?: string }

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

async function attempt<T>(cmd: string, args?: Record<string, unknown>): Promise<Result<T>> {
  if (!IS_TAURI) {
    browserInvoke(cmd, args);
    const fake = fakeChat(cmd, args);
    return fake ? { ok: true, value: fake.value as T } : { ok: false, error: "Not running inside Session Buddy." };
  }
  try {
    return { ok: true, value: await invoke<T>(cmd, args) };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/** The worker and message commands report a failure as an error string, as a rejected call or as the returned value. */
async function errorCall(cmd: string, args: Record<string, unknown>): Promise<string | null> {
  const r = await attempt<unknown>(cmd, args);
  if (!r.ok) return r.error;
  return typeof r.value === "string" && r.value ? r.value : null;
}

export interface BootInfo { settings: Settings; version: string }
export interface InstallStatus {
  hooksInstalled: boolean;
  statusLineInstalled: boolean;
  settingsPath: string;
  relayPath: string;
  relayReady: boolean;
}
export interface InstallPreview { diff: string; settingsPath: string; fingerprint: string }

export const Bridge = {
  boot: () => call<BootInfo>("boot"),
  snapshot: () => call<Snapshot>("snapshot"),
  saveSettings: (settings: Settings) => call<void>("save_settings", { settings }),
  saveSettingsChecked: (settings: Settings) => attempt<void>("save_settings", { settings }),
  setIslandRect: (x: number, y: number, width: number, height: number) =>
    call<void>("set_island_rect", { x, y, width, height }),
  focusWindow: (focused: boolean) => call<void>("focus_window", { focused }),
  reposition: () => call<void>("reposition"),
  /** Resizes the island window (logical pixels); Rust re-centres it at the top of its screen. */
  setPanelSize: (width: number, height: number) => call<void>("set_panel_size", { width, height }),
  resetPanelSize: () => call<void>("reset_panel_size"),
  ack: (requestId: string) => call<void>("ack", { requestId }),
  /** Resolves to an error message, or null when the answer was delivered. */
  answer: async (requestId: string, answer: unknown): Promise<string | null> => {
    const r = await attempt<void>("answer", { requestId, answer });
    return r.ok || !IS_TAURI ? null : r.error;
  },
  release: (requestId: string) => call<void>("release", { requestId }),
  installStatus: () => call<InstallStatus>("install_status"),
  installPreview: (install: boolean) => attempt<InstallPreview>("install_preview", { install }),
  installWrite: (install: boolean, fingerprint: string) => attempt<string>("install_write", { install, fingerprint }),
  openSettingsWindow: () => call<void>("open_settings_window"),
  log: (message: string) => call<void>("log", { message }),
  /** Opens one of the settings footer links (Rust accepts only those). */
  openLink: (url: string) => call<void>("open_link", { url }),
  quit: () => call<void>("quit_app"),
  /** The native folder dialog; null when it was cancelled. */
  pickFolder: async (startDir?: string): Promise<string | null> => (await call<string | null>("pick_folder", startDir ? { startDir } : undefined)) ?? null,
  /** Resolves to an error message, or null when the text was queued (or, for a managed session, sent directly). */
  sessionMessageSend: (sessionId: string, text: string) => errorCall("session_message_send", { sessionId, text }),
  sessionMessageCancel: (sessionId: string, messageId: string) => errorCall("session_message_cancel", { sessionId, messageId }),
  /** Brings the session's terminal app to the front (macOS). Resolves to an error message, or null. */
  focusTerminal: (sessionId: string) => errorCall("focus_terminal", { sessionId }),
  workerStop: (sessionId: string) => errorCall("worker_stop", { sessionId }),
  /** A manual check (it also emits the update events). */
  updateCheck: () => attempt<CheckResult>("update_check"),
  /** Resolves to an error message, or null; on success the app restarts, so it may never resolve. */
  updateInstall: () => errorCall("update_install", {}),
  chatSend: (text: string) => attempt<void>("chat_send", { text }),
  chatWake: () => call<void>("chat_wake"),
  chatInterrupt: () => call<void>("chat_interrupt"),
  chatReset: () => call<void>("chat_reset"),
  chatStatus: () => call<ChatStatus>("chat_status"),
  chatModels: async (url?: string): Promise<ChatModels> =>
    (await call<ChatModels>("chat_models", url ? { url } : undefined)) ?? { reachable: false, models: [], error: "Could not ask Session Buddy." },
};

export async function onEvent<T>(name: string, handler: (payload: T) => void) {
  if (!IS_TAURI) {
    if (name === "chat-event") fakeChatListen(handler as (e: ChatEvent) => void);
    else if (name.startsWith("update-")) fakeUpdateListen(name, handler as (p: unknown) => void);
    return;
  }
  await listen<T>(name, (e) => handler(e.payload));
}
