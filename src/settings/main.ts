// The settings window: Claude Code install (always preview, then write),
// sounds, island timing, sessions, start-up.

import "./settings.css";
import { Bridge, IS_TAURI, onEvent, type BootInfo, type InstallStatus } from "../core/bridge";
import { installNoBrowser } from "../core/nobrowser";
import { DEFAULT_SETTINGS, type Settings } from "../core/state";
import { Sound } from "../core/sound";
import { ICONS } from "../views/icons";
import { h, svg } from "../views/dom";
import { headerBuddy, type HeaderBuddy } from "./buddy";
import { DEFAULT_OLLAMA_URL, normalizeNumber, normalizeOllamaUrl, ollamaTestText, secondsLabel } from "./helpers";
import { buddyMark } from "./mark";
import type { SettingsEvent } from "./reactions";

// ?demo=1 in a plain browser: a fake boot result for the README screenshots.
const DEMO = !IS_TAURI && new URLSearchParams(location.search).get("demo") === "1";
// &ollama=down|empty picks the fake Ollama server's answer for the Test button.
const DEMO_BOOT: BootInfo = { settings: { ...DEFAULT_SETTINGS, chatEnabled: true }, version: "1.0.4" };
const DEMO_STATUS: InstallStatus = {
  hooksInstalled: true,
  statusLineInstalled: true,
  settingsPath: String.raw`C:\Users\alex\.claude\settings.json`,
  relayPath: String.raw`C:\Users\alex\AppData\Local\session-buddy\bin\sb-relay.exe`,
  relayReady: true,
};

let settings: Settings = { ...DEFAULT_SETTINGS };
const statusLine = h("div", { class: "msg bad top" });
const save = () => {
  void Bridge.saveSettingsChecked(settings).then((r) => {
    statusLine.textContent = r.ok ? "" : `Could not save settings: ${r.error}`;
    if (!r.ok && IS_TAURI) buddy?.react({ kind: "install", install: true, ok: false });
  });
};
const present = (xs: (Node | null | undefined | false)[]): Node[] => xs.filter(Boolean) as Node[];

const tell = (ev: SettingsEvent) => buddy?.react(ev);
let buddy: HeaderBuddy | null = null;
let order = 0;

function row(label: string, control: HTMLElement, hint?: string): HTMLElement {
  return h("label", { class: "row" }, h("span", { class: "lbl" }, ...present([document.createTextNode(label), hint ? h("small", { text: hint }) : null])), control);
}

/** A section card: icon chip, heading, then the content. */
function card(title: string, icon: string, ...children: (Node | null)[]): HTMLElement {
  return h(
    "section",
    { class: "card", style: `--i:${order++}` },
    h("h2", {}, h("span", { class: "chip" }, icon === ICONS.claude ? svg(icon, 14, { stroke: 2 }) : svg(icon, 14)), title),
    ...children,
  );
}

function toggle(get: () => boolean, set: (v: boolean) => void): HTMLElement {
  const input = h("input", { type: "checkbox", role: "switch" });
  input.checked = get();
  input.addEventListener("change", () => {
    set(input.checked);
    save();
  });
  return h("span", { class: "switch" }, input, h("span", { class: "track" }, h("span", { class: "knob" })));
}

function numberInput(get: () => number, set: (v: number) => void, min: number, max: number, step = 1, integer = true, unit?: (v: number) => string): HTMLElement {
  const el = h("input", { type: "number", min, max, step });
  el.value = String(get());
  const label = h("span", { class: "unit" });
  const showUnit = () => {
    if (unit) label.textContent = unit(normalizeNumber(el.value === "" ? min : el.value, min, max, integer));
  };
  showUnit();
  el.addEventListener("input", showUnit);
  el.addEventListener("change", () => {
    const v = normalizeNumber(el.value, min, max, integer);
    el.value = String(v);
    set(v);
    showUnit();
    save();
  });
  return h("span", { class: "field" }, ...present([el, unit ? label : null]));
}

function line(label: string, value: string, on?: boolean): HTMLElement {
  return h("div", { class: "kv" }, h("span", { class: "k", text: label }), h("span", { class: on === undefined ? "v" : `v pill ${on ? "ok" : "off"}`, text: value }));
}

function installSection(): HTMLElement {
  const status = h("div", { class: "status" });
  const buttons = h("div", { class: "actions" });
  const diff = h("pre", { class: "diff" });
  const msg = h("div", { class: "msg" });
  const box = card(
    "Claude Code",
    ICONS.claude,
    h("p", { class: "note", text: "Adds Session Buddy's hooks and wraps your status line. A dated backup of settings.json is taken first; only Session Buddy's own entries are ever added or removed. New Claude Code sessions pick it up; restart running ones." }),
    status,
    buttons,
    diff,
    msg,
  );
  const fail = (text: string) => {
    msg.textContent = text;
    msg.classList.add("bad");
    tell({ kind: "install", install: true, ok: false });
  };

  const refresh = async () => {
    const st = DEMO ? DEMO_STATUS : await Bridge.installStatus();
    if (!st) status.replaceChildren(line("Status", "Could not read install status"));
    else
      status.replaceChildren(
        line("Hooks", st.hooksInstalled ? "installed" : "not installed", st.hooksInstalled),
        line("Status line", st.statusLineInstalled ? "wrapped (your own status line still runs)" : "not installed", st.statusLineInstalled),
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
    msg.classList.remove("bad");
    const r = await Bridge.installPreview(install);
    if (!r.ok) {
      fail(r.error);
      return;
    }
    diff.textContent = r.value.diff || "(no changes)";
    buttons.replaceChildren(
      h("button", {
        class: "primary",
        text: `Write ${r.value.settingsPath}`,
        onclick: async () => {
          const w = await Bridge.installWrite(install, r.value.fingerprint);
          if (w.ok) {
            msg.classList.remove("bad");
            msg.textContent = `Done. Backup: ${w.value}`;
            tell({ kind: "install", install, ok: true });
          } else fail(w.error);
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

function chatSection(): HTMLElement {
  const cliState = h("span", { class: "v pill off", text: "checking..." });
  const cli = h("div", { class: "kv" }, h("span", { class: "k", text: "Claude CLI" }), cliState);
  const check = async () => {
    const st = await Bridge.chatStatus();
    cliState.className = `v pill ${st?.claudeFound ? "ok" : "off"}`;
    if (!st) cliState.textContent = "could not ask Session Buddy";
    else cliState.textContent = st.claudeFound ? `found${st.detail ? `: ${st.detail}` : ""}` : "not found - install Claude Code, or enter its path below";
  };
  void check();
  const path = h("input", { type: "text", value: settings.chatClaudePath, placeholder: "Detected automatically" });
  path.addEventListener("change", () => {
    settings.chatClaudePath = path.value.trim();
    save();
    void check();
  });

  const url = h("input", { type: "text", value: settings.chatOllamaUrl, placeholder: DEFAULT_OLLAMA_URL });
  const result = h("span", { class: "test-text" });
  const resultRow = h("div", { class: "msg calm" }, result);
  const test = h("button", { type: "button", text: "Test" });
  url.addEventListener("change", () => {
    settings.chatOllamaUrl = normalizeOllamaUrl(url.value);
    url.value = settings.chatOllamaUrl;
    save();
  });
  let token = 0;
  test.addEventListener("click", () => {
    const mine = ++token;
    const target = normalizeOllamaUrl(url.value);
    test.disabled = true;
    result.textContent = "Asking Ollama...";
    resultRow.classList.remove("down");
    void Bridge.chatModels(target).then((r) => {
      if (mine !== token) return;
      test.disabled = false;
      result.textContent = ollamaTestText(r.reachable, r.models.length, target);
      resultRow.classList.toggle("down", !r.reachable);
      tell({ kind: "ollama", ok: r.reachable });
    });
  });

  return card(
    "Chat",
    ICONS.bubble,
    h("p", { class: "note", text: "A chat in the island, answered by a background Claude Code or by a model running locally in Ollama. It runs only while you use it, can read nothing on your disk and writes nothing to it." }),
    h("p", { class: "note tight", text: "Choose the model in the chat header." }),
    row("Chat", toggle(() => settings.chatEnabled, (v) => { settings.chatEnabled = v; void check(); tell({ kind: "chat", on: v }); }), "adds a bubble to the island, off by default"),
    row("Stop after idle", numberInput(() => settings.chatIdleMinutes, (v) => (settings.chatIdleMinutes = v), 0, 240, 1, true, (v) => (v === 0 ? "Never" : "minutes")), "idle time before the background process stops"),
    cli,
    row("Claude CLI path", path, "optional, only to override the automatic detection"),
    row("Ollama server", h("span", { class: "field" }, url, test), "address of a local or network Ollama"),
    resultRow,
  );
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

function header(version: string | undefined): HTMLElement {
  return h(
    "header",
    {},
    buddy?.el,
    h(
      "div",
      { class: "title" },
      h("h1", {}, "Session Buddy", version ? h("span", { class: "version", text: `v${version.replace(/^v/, "")}` }) : null),
      h("p", { text: "A calm little companion for your Claude Code sessions." }),
    ),
  );
}

async function main() {
  const boot = DEMO ? DEMO_BOOT : await Bridge.boot();
  const app = document.getElementById("app");
  if (!app) return;
  if (!boot) {
    buddy = headerBuddy(true);
    app.append(
      header(undefined),
      h("main", {}, h("p", { class: "msg bad", text: "Could not load settings from Session Buddy." }), installSection()),
    );
    buddy.react({ kind: "install", install: true, ok: false });
    return;
  }
  settings = { ...settings, ...boot.settings };
  Sound.setEnabled(settings.soundEnabled);
  // The model is picked in the island: take it over so a later save here does not undo it.
  void onEvent<Settings>("settings-changed", (s) => {
    settings = { ...settings, chatProvider: s.chatProvider, chatModel: s.chatModel, chatOllamaModel: s.chatOllamaModel };
  });
  buddy = headerBuddy(settings.soundEnabled);

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
    header(boot.version),
    h(
      "main",
      {},
      statusLine,
      installSection(),
      card(
        "Sounds",
        ICONS.speakerOn,
        row("Sounds", toggle(() => settings.soundEnabled, (v) => {
          settings.soundEnabled = v;
          Sound.setEnabled(v);
          tell({ kind: "sound", on: v });
        })),
        row("Volume", volume),
        row("Context warning", toggle(() => settings.contextSound, (v) => (settings.contextSound = v)), "when a session passes 90 %"),
      ),
      card(
        "Island",
        ICONS.stack,
        row("Expanded closes after", numberInput(() => settings.autoCloseInterval, (v) => (settings.autoCloseInterval = v), 0, 120, 1, true, secondsLabel)),
        row("Card shrinks to the strip after", numberInput(() => settings.compactInterval, (v) => (settings.compactInterval = v), 0, 120, 1, true, secondsLabel)),
        row("When a session finishes", finish, "the sound plays in every mode while sounds are on"),
        row("Show the card for turns longer than", numberInput(() => settings.finishMinSeconds, (v) => (settings.finishMinSeconds = v), 0, 3600), "seconds; shorter ones only get the sound"),
        row("Screen", screen),
      ),
      chatSection(),
      card(
        "Sessions",
        ICONS.timer,
        row("Grey out after", numberInput(() => settings.staleMinutes, (v) => (settings.staleMinutes = v), 1, 240), "minutes without events"),
        row("Remove after", numberInput(() => settings.removeMinutes, (v) => (settings.removeMinutes = v), 5, 1440), "minutes greyed out"),
      ),
      card(
        "Start-up and hotkey",
        ICONS.gear,
        row("Start with the system", toggle(() => settings.autostart, (v) => (settings.autostart = v))),
        row("Hotkey", hotkey, "opens the island from anywhere, e.g. Ctrl+Alt+Space"),
      ),
      footer(boot.version),
    ),
  );
  if (DEMO) {
    document.body.classList.add("still");
    await document.fonts.ready;
    document.body.dataset.ready = "1";
  }
}

installNoBrowser();
void main();
