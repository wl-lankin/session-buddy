// A scripted stand-in for the update backend, used only outside Tauri.
// The page URL picks the story: ?update=1 (a release 99.0.0 is found shortly
// after start), ?update=fail (the same, but the download fails at 40 %),
// ?update=error (manual checks fail), anything else: manual checks find nothing.

import type { CheckResult } from "../model/update";

type Handler = (payload: unknown) => void;

const handlers = new Map<string, Handler>();
const CURRENT = "1.0.10";
const FAKE = {
  version: "99.0.0",
  currentVersion: CURRENT,
  notes: "## What is new\n\n- The update notice on the island\n- **Install and restart** from the island or the settings\n- Faster startup\n\nSee [all changes](https://github.com/example/session-buddy/releases).",
};
const TOTAL = 12_582_912;
const STEPS = 12;

const mode = () => new URLSearchParams(location.search).get("update") ?? "";
const offers = () => mode() === "1" || mode() === "fail";
const emit = (name: string, payload?: unknown) => handlers.get(name)?.(payload);

export function fakeUpdateListen(name: string, handler: Handler) {
  handlers.set(name, handler);
  if (name === "update-available" && offers()) window.setTimeout(() => emit("update-available", FAKE), 1500);
}

/** What a manual check reports and emits. */
function check(): CheckResult {
  if (mode() === "error") {
    emit("update-error", { message: "GitHub did not answer (offline?)" });
    return { available: false, currentVersion: CURRENT, error: "GitHub did not answer (offline?)" };
  }
  if (offers()) {
    emit("update-available", FAKE);
    return { available: true, version: FAKE.version, currentVersion: CURRENT, notes: FAKE.notes };
  }
  emit("update-none");
  return { available: false, currentVersion: CURRENT };
}

let installing = false;

function install(): null {
  if (installing) return null;
  installing = true;
  for (let i = 1; i <= STEPS; i++) {
    window.setTimeout(() => {
      if (mode() === "fail" && i === 5) {
        installing = false;
        emit("update-error", { message: "The download was interrupted" });
      } else if (installing && !(mode() === "fail" && i > 5)) {
        emit("update-progress", { downloaded: Math.round((TOTAL * i) / STEPS), total: TOTAL });
      }
    }, i * 450);
  }
  window.setTimeout(() => {
    if (!installing) return;
    emit("update-ready");
    installing = false;
  }, (STEPS + 3) * 450);
  return null;
}

export function fakeUpdate(cmd: string): { value: unknown } | null {
  if (cmd === "update_check") return { value: check() };
  if (cmd === "update_install") return { value: install() };
  return null;
}
