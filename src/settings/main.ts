// The settings window: Claude Code install (always preview, then write),
// sounds, island timing, sessions, start-up.

import "./settings.css";
import { Bridge, IS_TAURI, type BootInfo, type InstallStatus } from "../core/bridge";
import { installNoBrowser } from "../core/nobrowser";
import { DEFAULT_SETTINGS, type Settings } from "../core/state";
import { h } from "../views/dom";
import { normalizeNumber } from "./helpers";
import { buddyMark } from "./mark";

// ?demo=1 in a plain browser: a fake boot result for the README screenshots.
const DEMO = !IS_TAURI && new URLSearchParams(location.search).get("demo") === "1";
const DEMO_BOOT: BootInfo = { settings: { ...DEFAULT_SETTINGS }, version: "1.0.2" };
const DEMO_STATUS: InstallStatus = {
  hooksInstalled: true,
  statusLineInstalled: true,
  settingsPath: String.raw`C:\Users\alex\.claude\settings.json`,
  relayPath: String.raw`C:\Users\alex\AppData\Local\session-buddy\bin\sb-relay.exe`,
  relayReady: true,
};

let settings: Settings = { ...DEFAULT_SETTINGS };
const statusLine = h("div", { class: "msg top" });
const save = () => {
  void Bridge.saveSettingsChecked(settings).then((r) => {
    statusLine.textContent = r.ok ? "" : `Could not save settings: ${r.error}`;
  });
};
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

function numberInput(get: () => number, set: (v: number) => void, min: number, max: number, step = 1, integer = true): HTMLInputElement {
  const el = h("input", { type: "number", min, max, step });
  el.value = String(get());
  el.addEventListener("change", () => {
    const v = normalizeNumber(el.value, min, max, integer);
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
    h("p", { class: "note", text: "Adds Session Buddy's hooks and wraps your status line. A dated backup of settings.json is taken first; only Session Buddy's own entries are ever added or removed. New Claude Code sessions pick it up; restart running ones." }),
    status,
    buttons,
    diff,
    msg,
  );

  const refresh = async () => {
    const st = DEMO ? DEMO_STATUS : await Bridge.installStatus();
    if (!st) status.replaceChildren(line("Status", "Could not read install status"));
    else
      status.replaceChildren(
        line("Hooks", st.hooksInstalled ? "installed" : "not installed"),
        line("Status line", st.statusLineInstalled ? "wrapped (your own status line still runs)" : "not installed"),
        line("settings.json", st.settingsPath),
        line("Relay", `${st.relayPath}${st.relayReady ? "" : "  (missing: restart Session Buddy)"}`),
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

const AUTHOR_URL = "https://wolfgang-linz.de";
const COUCOU_URL = "https://github.com/Louis-CFM/coucou";

/** A link that opens in the default browser (through Rust's allow-list), never inside the settings window. */
function link(text: string, url: string, cls = ""): HTMLElement {
  return h("a", {
    class: `link ${cls}`.trim(),
    href: url,
    title: url,
    onclick: (e: Event) => {
      e.preventDefault();
      void Bridge.openLink(url);
    },
  }, text);
}

function footer(version: string): HTMLElement {
  return h(
    "footer",
    {},
    h(
      "div",
      { class: "foot-row" },
      h(
        "div",
        { class: "made" },
        buddyMark(22),
        h("span", { text: "Made with" }),
        h("span", { class: "heart", "aria-label": "love", text: "♥" }),
        h("span", { text: "by" }),
        link("Wolfgang Linz", AUTHOR_URL, "author"),
      ),
      h("button", { class: "quit", text: "Quit Session Buddy", onclick: () => void Bridge.quit() }),
    ),
    h(
      "div",
      { class: "foot-meta" },
      h("span", { class: "ver", text: `Session Buddy ${version}` }),
      h("span", { class: "sep", text: "·" }),
      h("span", {}, "based on ", link("Coucou", COUCOU_URL), " by Louis Raille (MIT)"),
    ),
  );
}

async function main() {
  const boot = DEMO ? DEMO_BOOT : await Bridge.boot();
  const app = document.getElementById("app");
  if (!app) return;
  if (!boot) {
    app.append(
      h("h1", { text: "Session Buddy settings" }),
      h("p", { class: "msg", text: "Could not load settings from Session Buddy." }),
      installSection(),
    );
    return;
  }
  settings = { ...settings, ...boot.settings };

  const volume = h("input", { type: "range", min: 0, max: 0.2, step: 0.01 });
  volume.value = String(normalizeNumber(settings.soundVolume, 0, 0.2, false));
  volume.addEventListener("change", () => {
    settings.soundVolume = normalizeNumber(volume.value, 0, 0.2, false);
    save();
  });

  const screen = h("select", {}, h("option", { value: "primary", text: "Primary display" }), h("option", { value: "cursor", text: "Display under the cursor" }));
  screen.value = settings.screen;
  screen.addEventListener("change", () => {
    settings.screen = screen.value === "cursor" ? "cursor" : "primary";
    save();
  });

  const finish = h(
    "select",
    {},
    h("option", { value: "card", text: "Card and animation" }),
    h("option", { value: "animation", text: "Animation only" }),
    h("option", { value: "off", text: "Off" }),
  );
  finish.value = settings.finishStyle;
  finish.addEventListener("change", () => {
    settings.finishStyle = finish.value === "animation" || finish.value === "off" ? finish.value : "card";
    save();
  });

  const hotkey = h("input", { type: "text", value: settings.hotkey, placeholder: "Ctrl+Alt+Space" });
  hotkey.addEventListener("change", () => {
    settings.hotkey = hotkey.value.trim();
    save();
  });

  app.append(
    h("h1", { text: "Session Buddy settings" }),
    statusLine,
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
      row("When a session finishes", finish, "the sound plays in every mode while sounds are on"),
      row("Show the card for turns longer than", numberInput(() => settings.finishMinSeconds, (v) => (settings.finishMinSeconds = v), 0, 3600), "seconds; shorter ones only get the sound"),
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
    footer(boot.version),
  );
  if (DEMO) {
    await document.fonts.ready;
    document.body.dataset.ready = "1";
  }
}

installNoBrowser();
void main();
