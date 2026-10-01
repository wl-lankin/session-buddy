// The settings window: Claude Code install (always preview, then write),
// sounds, island timing, sessions, start-up.

import "./settings.css";
import { Bridge } from "../core/bridge";
import { DEFAULT_SETTINGS, type Settings } from "../core/state";
import { h } from "../views/dom";

let settings: Settings = { ...DEFAULT_SETTINGS };
const save = () => void Bridge.saveSettings(settings);
const present = (xs: (Node | null | undefined | false)[]): Node[] => xs.filter(Boolean) as Node[];

function row(label: string, control: HTMLElement, hint?: string): HTMLElement {
  return h("label", { class: "row" }, h("span", { class: "lbl" }, ...present([document.createTextNode(label), hint ? h("small", { text: hint }) : null])), control);
}

function checkbox(get: () => boolean, set: (v: boolean) => void): HTMLInputElement {
  const el = h("input", { type: "checkbox" });
  el.checked = get();
  el.addEventListener("change", () => {
    set(el.checked);
    save();
  });
  return el;
}

function numberInput(get: () => number, set: (v: number) => void, min: number, max: number, step = 1): HTMLInputElement {
  const el = h("input", { type: "number", min, max, step });
  el.value = String(get());
  el.addEventListener("change", () => {
    const v = Math.min(max, Math.max(min, Number(el.value) || min));
    el.value = String(v);
    set(v);
    save();
  });
  return el;
}

function line(label: string, value: string): HTMLElement {
  return h("div", { class: "kv" }, h("span", { class: "k", text: label }), h("span", { class: "v", text: value }));
}

function installSection(): HTMLElement {
  const status = h("div", { class: "status" });
  const buttons = h("div", { class: "actions" });
  const diff = h("pre", { class: "diff" });
  const msg = h("div", { class: "msg" });
  const box = h(
    "section",
    {},
    h("h2", { text: "Claude Code" }),
    h("p", { class: "note", text: "Adds session-buddy's hooks and wraps your status line. A dated backup of settings.json is taken first; only session-buddy's own entries are ever added or removed. New Claude Code sessions pick it up; restart running ones." }),
    status,
    buttons,
    diff,
    msg,
  );

  const refresh = async () => {
    const st = await Bridge.installStatus();
    status.replaceChildren(
      line("Hooks", st?.hooksInstalled ? "installed" : "not installed"),
      line("Status line", st?.statusLineInstalled ? "wrapped (your own status line still runs)" : "not installed"),
      line("settings.json", st?.settingsPath ?? "?"),
      line("Relay", st ? `${st.relayPath}${st.relayReady ? "" : "  (missing: restart session-buddy)"}` : "?"),
    );
    buttons.replaceChildren(
      ...present([
        h("button", { class: "primary", text: st?.hooksInstalled ? "Reinstall..." : "Install...", onclick: () => void preview(true) }),
        st?.hooksInstalled || st?.statusLineInstalled ? h("button", { text: "Uninstall...", onclick: () => void preview(false) }) : null,
      ]),
    );
  };

  const preview = async (install: boolean) => {
    msg.textContent = "";
    const r = await Bridge.installPreview(install);
    if (!r.ok) {
      msg.textContent = r.error;
      return;
    }
    diff.textContent = r.value.diff || "(no changes)";
    buttons.replaceChildren(
      h("button", {
        class: "primary",
        text: `Write ${r.value.settingsPath}`,
        onclick: async () => {
          const w = await Bridge.installWrite(install, r.value.fingerprint);
          msg.textContent = w.ok ? `Done. Backup: ${w.value}` : w.error;
          diff.textContent = "";
          await refresh();
        },
      }),
      h("button", { text: "Cancel", onclick: () => { diff.textContent = ""; void refresh(); } }),
    );
  };

  void refresh();
  return box;
}

async function main() {
  const boot = await Bridge.boot();
  if (boot) settings = { ...settings, ...boot.settings };
  const app = document.getElementById("app");
  if (!app) return;

  const volume = h("input", { type: "range", min: 0, max: 0.2, step: 0.01 });
  volume.value = String(settings.soundVolume);
  volume.addEventListener("change", () => {
    settings.soundVolume = Number(volume.value);
    save();
  });

  const screen = h("select", {}, h("option", { value: "primary", text: "Primary display" }), h("option", { value: "cursor", text: "Display under the cursor" }));
  screen.value = settings.screen;
  screen.addEventListener("change", () => {
    settings.screen = screen.value === "cursor" ? "cursor" : "primary";
    save();
  });

  const hotkey = h("input", { type: "text", value: settings.hotkey, placeholder: "Ctrl+Alt+Space" });
  hotkey.addEventListener("change", () => {
    settings.hotkey = hotkey.value.trim();
    save();
  });

  app.append(
    h("h1", { text: "session-buddy" }),
    installSection(),
    h(
      "section",
      {},
      h("h2", { text: "Sounds" }),
      row("Sounds", checkbox(() => settings.soundEnabled, (v) => (settings.soundEnabled = v))),
      row("Volume", volume),
      row("Context warning", checkbox(() => settings.contextSound, (v) => (settings.contextSound = v)), "when a session passes 90 %"),
    ),
    h(
      "section",
      {},
      h("h2", { text: "Island" }),
      row("Expanded closes after", numberInput(() => settings.autoCloseInterval, (v) => (settings.autoCloseInterval = v), 3, 120), "seconds"),
      row("Card shrinks to the strip after", numberInput(() => settings.compactInterval, (v) => (settings.compactInterval = v), 2, 120), "seconds"),
      row("Screen", screen),
      row("Hotkey", hotkey, "opens the island from anywhere, e.g. Ctrl+Alt+Space"),
    ),
    h(
      "section",
      {},
      h("h2", { text: "Sessions" }),
      row("Grey out after", numberInput(() => settings.staleMinutes, (v) => (settings.staleMinutes = v), 1, 240), "minutes without events"),
      row("Remove after", numberInput(() => settings.removeMinutes, (v) => (settings.removeMinutes = v), 5, 1440), "minutes greyed out"),
    ),
    h(
      "section",
      {},
      h("h2", { text: "Start-up" }),
      row("Start with the system", checkbox(() => settings.autostart, (v) => (settings.autostart = v))),
    ),
    h("footer", {}, h("span", { text: `Version ${boot?.version ?? "?"}` }), h("button", { text: "Quit session-buddy", onclick: () => void Bridge.quit() })),
  );
}

void main();
