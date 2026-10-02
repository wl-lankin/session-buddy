// Buddy Chat: the conversation view. Off card, empty state with suggestions, the
// transcript (streamed answers are revealed smoothly) and the composer.

import { State } from "../core/state";
import type { Session } from "../core/types";
import {
  activeAnswer, buildSessionBlock, buildSuggestions, canSend, dotState, isBusy, sessionChip, statusText, toolText,
  type ChatItem, type ChatState, type Suggestion, type ToolPill,
} from "../model/chat";
import { modelBadge, offLead, offLines } from "../model/chatmodel";
import { CONTROL_HINT, controlSuggestions, modeChoice, modeSwitch } from "../model/chatcontrol";
import {
  choicePatch, initialRow, modelsStale, pickerLock, pickerRows, selectedModel, stepRow, type LocalModels, type PickerRow,
} from "../model/chatpicker";
import { fmtDuration } from "../model/format";
import { h, svg } from "./dom";
import { ICONS } from "./icons";
import { renderMarkdown } from "./markdown";
import { btn, enlargeButton, pinButton } from "./parts";
import type { ViewActions, ViewHost } from "./views";

type Answer = Extract<ChatItem, { kind: "assistant" }>;

/** Reveal speed: at least this many characters a second, faster as the backlog grows. */
const REVEAL_MIN_CPS = 70;
const REVEAL_CATCH_UP = 5;
const STICK_PX = 28;
const JUMP_PX = 64;
const TYPING_HOLD_MS = 1500;
const COMPOSER_MAX = 112;
const COMPOSER_MAX_BIG = 240;

const STATE_CLASS: Record<ChatState, string> = { off: "off", starting: "starting", ready: "ready", busy: "busy", error: "error" };

const clock = (at: number): string => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

interface Row {
  el: HTMLElement;
  kind: ChatItem["kind"];
  sig: string;
  // Answers only
  item?: Answer;
  shown: number;
  pills?: HTMLElement;
  md?: HTMLElement;
  dots?: HTMLElement;
  note?: HTMLElement;
  time?: HTMLElement;
  paint?: string;
}

function pill(t: ToolPill): HTMLElement {
  const lead = t.state === "running" ? h("i", { class: "c-spin" }) : svg(t.state === "error" || t.state === "denied" ? ICONS.xmark : ICONS.check, 11, { stroke: 2.6 });
  return h("span", { class: `c-pill ${t.state}`, title: toolText(t) }, lead, h("span", { class: "c-pill-text", text: toolText(t) }));
}

function ctxChip(label: string, kind: "session" | "overview"): HTMLElement {
  return h("span", { class: "c-ctx" }, svg(kind === "session" ? ICONS.branch : ICONS.stack, 10, kind === "session" ? { stroke: 2.4 } : {}), h("span", { class: "c-ctx-text", text: label }));
}

export function buildChatView(actions: ViewActions): ViewHost {
  const chat = actions.chat;

  const enlarge = enlargeButton(() => actions.toggleEnlarge());
  const pin = pinButton(() => actions.togglePin());
  const dot = h("i", { class: "c-dot off" });
  const statusEl = h("span", { class: "c-status", text: "Off" });
  const pickName = h("span", { class: "c-model-name" });
  const pickLocal = h("span", { class: "c-local", text: "local" });
  const picker = h(
    "button",
    { class: "c-pick", type: "button", "aria-haspopup": "menu", "aria-expanded": "false" },
    pickName,
    pickLocal,
    svg(ICONS.chevronDown, 9, { stroke: 2.8 }),
  );
  const modelEl = h("span", { class: "c-model" }, picker);
  const modeBtns = new Map<string, HTMLButtonElement>();
  const modeEl = h("span", { class: "c-modesw", role: "group", "aria-label": "Chat mode" });
  for (const o of modeSwitch("web", false).options) {
    const b = h("button", {
      class: "c-mode",
      type: "button",
      text: o.label,
      onclick: (e: Event) => {
        e.stopPropagation();
        const next = modeChoice(State.settings.chatMode, o.id, isBusy(State.chat));
        if (next) chat.setModel({ chatMode: next });
      },
    });
    modeBtns.set(o.id, b);
    modeEl.append(b);
  }
  const menu = h("div", { class: "c-menu", role: "menu", "aria-label": "Chat model" });
  const power = h("button", {
    class: "c-power",
    role: "switch",
    onclick: (e: Event) => {
      e.stopPropagation();
      chat.setEnabled(!State.chat.enabled);
    },
  }, h("i"));
  const newBtn = btn("New chat", "secondary", () => chat.reset(), "Clear the conversation and start over");
  newBtn.classList.add("c-new");
  newBtn.prepend(svg(ICONS.plus, 11));
  const closeBtn = h("button", {
    class: "enlarge c-close",
    title: "Back to the sessions",
    onclick: (e: Event) => {
      e.stopPropagation();
      actions.closeChat();
    },
  }, svg(ICONS.xmark, 11));
  const head = h(
    "div",
    { class: "c-head" },
    h("div", { class: "c-who" }, h("div", { class: "c-title", text: "Chat with Buddy" }), h("div", { class: "c-sub" }, dot, statusEl, modelEl, modeEl)),
    h("span", { class: "grow" }),
    power,
    newBtn,
    pin.el,
    enlarge.el,
    closeBtn,
  );

  const col = h("div", { class: "c-col" });
  const scroll = h("div", { class: "c-scroll scrollable" }, col);
  const jump = h("button", {
    class: "c-jump",
    title: "Jump to the latest message",
    onclick: (e: Event) => {
      e.stopPropagation();
      toBottom(true);
    },
  }, svg(ICONS.arrowDown, 12, { stroke: 2.2 }), h("span", { text: "Latest" }));
  const body = h("div", { class: "c-body" }, scroll, jump);

  const input = h("textarea", { class: "c-input", rows: 1, placeholder: "Message Buddy", spellcheck: "false" });
  const act = h("button", { class: "c-act", title: "Send (Enter)" }, svg(ICONS.arrowUp, 15, { stroke: 2.2 }));
  const addBtn = h("button", { class: "c-add", title: "Attach the focused session to your next message" }, svg(ICONS.plus, 10, { stroke: 2.4 }), h("span", { text: "Session" }));
  const attachedEl = h("span", { class: "c-attached" });
  const hint = h("span", { class: "c-hint", text: "Enter sends · Shift+Enter adds a line" });
  const box = h(
    "div",
    { class: "c-box" },
    h("div", { class: "c-line" }, input, act),
    h("div", { class: "c-tools" }, addBtn, attachedEl, h("span", { class: "grow" }), hint),
  );
  const composer = h("div", { class: "c-composer" }, box);
  const el = h("div", { class: "view chat-view", "data-mode": "off" }, head, body, composer, menu);

  // View-local state: it survives switching views because the view itself does.
  let attached: string | null = null;
  const rows = new Map<string, Row>();
  let typingRow: HTMLElement | null = null;
  let mode = "";
  let stick = true;
  let forceBottom: "smooth" | "instant" | null = null;
  let lastTick = 0;
  let typingTimer = 0;
  let focusTimer = 0;
  let lastMode = "";

  const focusComposer = () => {
    actions.wantKeyboard(true);
    window.clearTimeout(focusTimer);
    focusTimer = window.setTimeout(() => input.focus(), 120);
  };

  const distance = () => scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight;
  const updateJump = () => jump.classList.toggle("on", !stick && distance() > JUMP_PX);
  function toBottom(smooth: boolean) {
    stick = true;
    if (smooth) scroll.scrollTo({ top: scroll.scrollHeight, behavior: "smooth" });
    else scroll.scrollTop = scroll.scrollHeight;
    updateJump();
  }
  scroll.addEventListener("scroll", () => {
    stick = distance() < STICK_PX;
    updateJump();
  });

  const autoGrow = () => {
    input.style.height = "auto";
    const max = State.manualH != null ? COMPOSER_MAX_BIG : COMPOSER_MAX;
    input.style.height = `${Math.min(max, input.scrollHeight)}px`;
    input.classList.toggle("overflowing", input.scrollHeight > max);
  };

  const refreshAct = () => {
    const busy = isBusy(State.chat);
    const text = input.value.trim();
    act.classList.toggle("stop", busy);
    act.replaceChildren(busy ? svg(ICONS.stop, 14) : svg(ICONS.arrowUp, 15, { stroke: 2.2 }));
    act.title = busy ? "Stop the answer" : "Send (Enter)";
    act.disabled = !busy && (!text || !canSend(State.chat));
  };

  const submit = () => {
    const text = input.value.trim();
    if (!text || !canSend(State.chat)) return;
    const context = attached ? ({ kind: "session", sessionId: attached } as const) : null;
    attached = null;
    input.value = "";
    autoGrow();
    chat.typing(false);
    forceBottom = "smooth";
    chat.send(text, context);
    refreshAct();
  };

  act.addEventListener("click", (e) => {
    e.stopPropagation();
    if (isBusy(State.chat)) chat.stop();
    else submit();
  });
  addBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const s = State.focus;
    if (!s) return;
    attached = s.id;
    actions.redraw();
    focusComposer();
  });
  input.addEventListener("mousedown", focusComposer);
  box.addEventListener("mousedown", (e) => {
    if (!(e.target as Element).closest("button, textarea")) {
      e.preventDefault();
      focusComposer();
    }
  });
  input.addEventListener("input", () => {
    autoGrow();
    refreshAct();
    chat.typing(input.value.length > 0);
    window.clearTimeout(typingTimer);
    typingTimer = window.setTimeout(() => chat.typing(false), TYPING_HOLD_MS);
  });
  input.addEventListener("blur", () => {
    window.clearTimeout(typingTimer);
    chat.typing(false);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });


  // ---- Model picker

  let menuOpen = false;
  let locked = false;
  let local: LocalModels = { state: "idle" };
  let loadedAt = 0;
  let loadToken = 0;
  let menuSig = "";
  let menuRows: PickerRow[] = [];
  let menuItems: (HTMLElement | null)[] = [];

  const rowKey = (r: PickerRow | undefined) => (r?.type === "choice" ? r.choice.id : r?.type === "retry" ? "retry" : "");

  function renderMenu(force = false) {
    const rows = pickerRows(State.settings, local);
    const sig = rows.map((r) => (r.type === "choice" ? `${r.choice.id}${r.choice.active ? "*" : ""}` : r.type === "status" ? r.text : r.type)).join("|");
    if (!force && sig === menuSig) return;
    menuSig = sig;
    const keep = rowKey(menuRows[menuItems.indexOf(document.activeElement as HTMLElement)]);
    menuRows = rows;
    menuItems = rows.map((r) => {
      switch (r.type) {
        case "group": return null;
        case "status": return null;
        case "retry":
          return h("button", { class: "c-opt c-retry", type: "button", role: "menuitem", tabindex: -1, text: "Retry", onclick: (e: Event) => { e.stopPropagation(); loadLocal(); } });
        case "choice": {
          const c = r.choice;
          return h(
            "button",
            { class: "c-opt", type: "button", role: "menuitemradio", "aria-checked": String(c.active), tabindex: -1, onclick: (e: Event) => { e.stopPropagation(); choose(r); } },
            h("span", { class: "c-tick" }, c.active ? svg(ICONS.check, 12, { stroke: 2.8 }) : null),
            h("span", { class: "c-opt-text" }, h("span", { class: "c-opt-name", text: c.label }), h("span", { class: "c-opt-note", text: c.note })),
          );
        }
      }
    });
    menu.replaceChildren(
      ...rows.map((r, i) => {
        if (r.type === "group") return h("div", { class: "c-grp", role: "presentation", text: r.label });
        if (r.type === "status") return h("div", { class: `c-lstat${r.tone === "down" ? " down" : ""}`, role: "status", text: r.text });
        return menuItems[i] ?? "";
      }),
    );
    const at = keep ? rows.findIndex((r) => rowKey(r) === keep) : -1;
    if (at >= 0) menuItems[at]?.focus();
  }

  function placeMenu() {
    const box = el.getBoundingClientRect();
    const scale = el.offsetWidth ? box.width / el.offsetWidth : 1;
    const anchor = picker.getBoundingClientRect();
    const width = Math.min(284, el.offsetWidth - 12);
    const top = (anchor.bottom - box.top) / scale + 6;
    const left = Math.max(6, Math.min((anchor.left - box.left) / scale - 6, el.offsetWidth - width - 6));
    menu.style.width = `${width}px`;
    menu.style.top = `${top}px`;
    menu.style.left = `${left}px`;
    menu.style.maxHeight = `${Math.max(120, el.offsetHeight - top - 8)}px`;
  }

  function loadLocal() {
    const mine = ++loadToken;
    if (local.state !== "ok") local = { state: "loading" };
    renderMenu();
    void chat.models().then((r) => {
      if (mine !== loadToken) return;
      local = r.reachable ? { state: "ok", models: r.models } : { state: "down" };
      loadedAt = Date.now();
      if (menuOpen) renderMenu();
    });
  }

  const outside = (e: Event) => {
    const t = e.target as Node;
    if (!menu.contains(t) && !picker.contains(t)) closeMenu(false);
  };
  const leave = () => closeMenu(false);

  function openMenu() {
    if (menuOpen || locked) return;
    menuOpen = true;
    renderMenu(true);
    placeMenu();
    menu.classList.add("on");
    picker.setAttribute("aria-expanded", "true");
    actions.wantKeyboard(true);
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("blur", leave);
    if (State.settings.ollamaEnabled && modelsStale(local, loadedAt, Date.now())) loadLocal();
    menuItems[initialRow(menuRows)]?.focus();
  }

  function closeMenu(refocus: boolean) {
    if (!menuOpen) return;
    menuOpen = false;
    menu.classList.remove("on");
    picker.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", outside, true);
    window.removeEventListener("blur", leave);
    loadToken++;
    if (local.state === "loading") local = { state: "idle" };
    if (refocus) picker.focus();
  }

  function choose(r: Extract<PickerRow, { type: "choice" }>) {
    const patch = choicePatch(r.choice);
    closeMenu(false);
    if (patch) chat.setModel(patch);
    if (State.chat.enabled) focusComposer();
    else picker.focus();
  }

  picker.addEventListener("click", (e) => {
    e.stopPropagation();
    if (menuOpen) closeMenu(true);
    else openMenu();
  });
  menu.addEventListener("click", (e) => e.stopPropagation());

  function menuKey(e: KeyboardEvent): boolean {
    if (!menuOpen) {
      if (document.activeElement === picker && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        e.preventDefault();
        openMenu();
        return true;
      }
      return false;
    }
    const now = menuItems.indexOf(document.activeElement as HTMLElement);
    const go = (to: number) => menuItems[to]?.focus();
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        closeMenu(true);
        return true;
      case "ArrowDown":
        e.preventDefault();
        go(stepRow(menuRows, now, 1));
        return true;
      case "ArrowUp":
        e.preventDefault();
        go(stepRow(menuRows, now, -1));
        return true;
      case "Home":
        e.preventDefault();
        go(stepRow(menuRows, -1, 1));
        return true;
      case "End":
        e.preventDefault();
        go(stepRow(menuRows, 0, -1));
        return true;
      case "Tab":
        e.preventDefault();
        closeMenu(true);
        return true;
      case "ArrowLeft":
      case "ArrowRight":
        e.preventDefault();
        return true;
      default:
        return false;
    }
  }

  // ---- Rows

  function userRow(it: Extract<ChatItem, { kind: "user" }>): HTMLElement {
    const bubble = h("div", { class: "c-bubble", title: clock(it.at) }, it.context ? ctxChip(it.context.label, it.context.kind) : null, h("div", { class: "c-text", text: it.text }));
    return h("div", { class: "c-row user" }, bubble, h("div", { class: "c-time", text: clock(it.at) }));
  }

  function answerRow(row: Row, it: Answer) {
    row.pills = h("div", { class: "c-pills" });
    row.md = h("div", { class: "c-md" });
    row.dots = h("div", { class: "c-dots" }, h("i"), h("i"), h("i"));
    row.note = h("div", { class: "c-note" });
    row.time = h("div", { class: "c-time" });
    row.el.append(row.pills, row.md, row.dots, row.note, row.time);
    row.item = it;
  }

  function paintAnswer(row: Row) {
    const it = row.item;
    if (!it || !row.pills || !row.md || !row.dots || !row.note || !row.time) return;
    const n = Math.floor(row.shown);
    const live = it.streaming || n < it.text.length;
    const running = it.tools.some((t) => t.state === "running");
    const pillSig = it.tools.map((t) => `${t.callId}:${t.state}:${t.label}`).join(",");
    const sig = `${n}|${live}|${it.thinking}|${it.error}|${it.stopped}|${it.durationMs}|${pillSig}`;
    if (sig === row.paint) return;
    if (row.pills.dataset.sig !== pillSig) {
      row.pills.dataset.sig = pillSig;
      row.pills.replaceChildren(...it.tools.map(pill));
    }
    row.pills.style.display = it.tools.length ? "" : "none";
    const visible = it.text.slice(0, n);
    const nodes = renderMarkdown(visible, { copy: true });
    if (live && visible) {
      const caret = h("i", { class: "c-caret" });
      const last = nodes[nodes.length - 1];
      const host = last instanceof HTMLElement && last.matches(".md-p, .md-h") ? last : last instanceof HTMLElement ? last.querySelector<HTMLElement>(".md-li-text") : null;
      (host ?? row.md).append(caret);
    }
    row.md.replaceChildren(...nodes);
    row.md.style.display = visible ? "" : "none";
    row.dots.style.display = !visible && !running && !it.error && !it.stopped && it.durationMs === null ? "" : "none";
    row.note.className = `c-note${it.error ? " err" : ""}`;
    row.note.textContent = it.error ?? (it.stopped ? "Stopped" : "");
    row.note.style.display = row.note.textContent ? "" : "none";
    row.time.textContent = it.durationMs !== null ? `${clock(it.at)} · ${fmtDuration(it.durationMs)}` : clock(it.at);
    row.paint = sig;
  }

  function makeRow(it: ChatItem): Row {
    switch (it.kind) {
      case "user":
        return { el: userRow(it), kind: "user", sig: `${it.text}|${it.context?.label ?? ""}`, shown: 0 };
      case "assistant": {
        const row: Row = { el: h("div", { class: "c-row bot" }), kind: "assistant", sig: "", shown: it.streaming || State.chat.turnId === it.turn ? 0 : it.text.length };
        answerRow(row, it);
        return row;
      }
      case "divider": {
        const text = it.reason === "sleep" ? "Chat went to sleep" : it.reason === "off" ? "Chat was turned off" : it.reason === "model" ? "New context" : "Context was reset";
        return {
          el: h("div", { class: "c-divider", title: `${clock(it.at)}. Earlier messages are not remembered after this point.` }, h("span", { text }), h("small", { text: "earlier messages are forgotten" })),
          kind: "divider", sig: it.reason, shown: 0,
        };
      }
      case "error":
        return { el: h("div", { class: "c-row err" }, h("div", { class: "c-errtext", text: it.message })), kind: "error", sig: it.message, shown: 0 };
    }
  }

  function reconcile(items: ChatItem[]) {
    const seen = new Set<string>();
    let prev: Element | null = null;
    for (const it of items) {
      seen.add(it.id);
      let row = rows.get(it.id);
      if (!row) {
        row = makeRow(it);
        rows.set(it.id, row);
      }
      if (it.kind === "assistant") {
        row.item = it;
        if (it.stopped) row.shown = it.text.length;
        paintAnswer(row);
      }
      const want: Element | null = prev ?prev.nextElementSibling : col.firstElementChild;
      if (want !== row.el) col.insertBefore(row.el, want);
      prev = row.el;
    }
    for (const [id, row] of rows) {
      if (!seen.has(id)) {
        row.el.remove();
        rows.delete(id);
      }
    }
  }

  function syncTyping(show: boolean) {
    if (show && !typingRow) {
      typingRow = h("div", { class: "c-row bot" }, h("div", { class: "c-dots" }, h("i"), h("i"), h("i")));
    }
    if (show && typingRow) col.append(typingRow);
    else if (!show && typingRow) {
      typingRow.remove();
      typingRow = null;
    }
  }

  // ---- Off and empty

  function offCard(): HTMLElement {
    const missing = State.chat.claudeFound === false;
    const mode = State.settings.chatMode;
    const web = mode === "web" && State.chat.webSearch;
    const lines = offLines({ provider: State.chat.provider, model: State.chat.model, webSearch: web, idleMinutes: State.settings.chatIdleMinutes, mode });
    return h(
      "div",
      { class: "c-off" },
      h("div", { class: "c-off-title", text: "Chat with Buddy" }),
      h("p", { class: "c-off-lead", text: offLead({ webSearch: web, mode }) }),
      h("ul", { class: "c-off-list" }, ...lines.map((text) => h("li", { text }))),
      missing ? h("div", { class: "c-warn", text: "The Claude Code CLI was not found. Install it, or set its path in Settings." }) : null,
      h(
        "div",
        { class: "c-off-actions" },
        btn("Turn on chat", "primary", () => chat.setEnabled(true)),
        h("button", { class: "p-link", text: "Settings", onclick: (e: Event) => { e.stopPropagation(); actions.openSettings(); } }),
      ),
    );
  }

  function controlHint(): HTMLElement {
    return h(
      "div",
      { class: "c-empty c-ctl" },
      h("div", { class: "c-hello", text: CONTROL_HINT.title }),
      h("div", { class: "c-hello-sub", text: CONTROL_HINT.text }),
      btn(CONTROL_HINT.button, "primary", () => actions.openSettings()),
    );
  }

  function emptyCard(list: Suggestion[], control: boolean): HTMLElement {
    const chips = list.map((s) =>
      h(
        "button",
        { class: "c-sugg", title: s.context ? "Attaches the session context" : undefined, onclick: (e: Event) => { e.stopPropagation(); chat.send(s.prompt, s.context); } },
        s.context ? svg(s.context.kind === "session" ? ICONS.branch : ICONS.stack, 11, s.context.kind === "session" ? { stroke: 2.2 } : {}) : svg(ICONS.arrowUpRight, 11),
        h("span", { text: s.label }),
      ),
    );
    return h(
      "div",
      { class: "c-empty" },
      h("div", { class: "c-hello", text: "Hi, I'm Buddy." }),
      h("div", { class: "c-hello-sub", text: control ? "Ask what your sessions are doing, or have me start one for you." : "Ask me anything, or let me look at one of your sessions." }),
      h("div", { class: "c-chips" }, ...chips),
      State.chat.claudeFound === false ? h("div", { class: "c-warn", text: "The Claude Code CLI was not found. Set its path in Settings." }) : null,
    );
  }

  const sessionOf = (id: string | null): Session | null => (id ? State.allSessions.find((s) => s.id === id) ?? null : null);

  function syncComposer() {
    const m = State.chat;
    const s = sessionOf(attached);
    if (attached && !s) attached = null;
    const focus = State.focus;
    addBtn.style.display = s ? "none" : "";
    addBtn.disabled = !focus;
    addBtn.title = focus ? `Attach ${focus.project} to your next message` : "No session to attach";
    attachedEl.style.display = s ? "" : "none";
    if (s) {
      const block = buildSessionBlock(s);
      const key = `${s.id}|${block}`;
      if (attachedEl.dataset.key !== key) {
        attachedEl.dataset.key = key;
        const chip = sessionChip(s);
        attachedEl.replaceChildren(
          ctxChip(chip.label, "session"),
          h("button", {
            class: "c-detach",
            title: "Remove the session",
            onclick: (e: Event) => {
              e.stopPropagation();
              attached = null;
              actions.redraw();
            },
          }, svg(ICONS.xmark, 8, { stroke: 2.6 })),
        );
        attachedEl.title = `Sent with your message:\n\n${block}`;
      }
    } else delete attachedEl.dataset.key;
    const missing = m.claudeFound === false;
    input.disabled = missing;
    input.placeholder = missing ? "Claude Code CLI not found" : isBusy(m) ? "Buddy is answering..." : "Message Buddy";
    refreshAct();
    autoGrow();
  }

  return {
    el,
    busy: () => [...rows.values()].some((r) => r.item && r.shown < r.item.text.length),
    sync() {
      enlarge.refresh();
      pin.refresh();
      const m = State.chat;
      const st = dotState(m);
      dot.className = `c-dot ${STATE_CLASS[st]}`;
      const text = statusText(m);
      if (statusEl.textContent !== text) statusEl.textContent = text;
      statusEl.title = m.detail ?? "";
      const sel = selectedModel(State.settings);
      const badge = modelBadge(sel.provider, sel.model);
      const lock = pickerLock(isBusy(m));
      locked = lock.disabled;
      picker.setAttribute("aria-disabled", String(locked));
      picker.classList.toggle("locked", locked);
      picker.title = locked ? lock.title : `${badge.title}. ${lock.title}`;
      if (pickName.textContent !== badge.name) pickName.textContent = badge.name;
      pickLocal.style.display = badge.local ? "" : "none";
      const sw = modeSwitch(State.settings.chatMode, isBusy(m));
      modeEl.title = sw.title;
      modeEl.classList.toggle("locked", sw.disabled);
      for (const o of sw.options) {
        const b = modeBtns.get(o.id);
        if (!b) continue;
        b.classList.toggle("on", o.active);
        b.setAttribute("aria-pressed", String(o.active));
        b.setAttribute("aria-disabled", String(sw.disabled));
        b.title = sw.disabled ? sw.title : o.title;
      }
      if (locked) closeMenu(false);
      else if (menuOpen) renderMenu();
      power.setAttribute("aria-checked", String(m.enabled));
      power.classList.toggle("on", m.enabled);
      power.title = m.enabled ? "Turn chat off" : "Turn chat on";
      newBtn.style.display = m.enabled ? "" : "none";
      newBtn.disabled = m.items.length === 0 && !isBusy(m);

      const next = !m.enabled ? "off" : m.items.length ? "chat" : "empty";
      el.dataset.mode = next;
      if (next !== mode) {
        mode = next;
        col.replaceChildren();
        col.dataset.key = "";
        rows.clear();
        typingRow = null;
        stick = true;
      }
      if (next === "off") {
        const key = `${m.claudeFound}|${State.settings.chatIdleMinutes}|${m.provider}|${m.model}|${m.webSearch}|${State.settings.chatMode}`;
        if (col.dataset.key !== key) {
          col.dataset.key = key;
          col.replaceChildren(offCard());
        }
      } else if (next === "empty") {
        const control = State.settings.chatMode === "control";
        const needsFolder = control && !m.controlReady;
        const list = control ? controlSuggestions(State.allSessions, State.focusId) : buildSuggestions(State.allSessions, State.focusId, m.webSearch);
        const key = needsFolder ? `hint|${m.claudeFound}` : `${control}|${list.map((s) => s.label).join("|")}|${m.claudeFound}`;
        if (col.dataset.key !== key) {
          col.dataset.key = key;
          col.replaceChildren(needsFolder ? controlHint() : emptyCard(list, control));
        }
      } else {
        reconcile(m.items);
        syncTyping(m.awaiting && !activeAnswer(m));
        if (forceBottom) {
          const smooth = forceBottom === "smooth";
          forceBottom = null;
          window.requestAnimationFrame(() => toBottom(smooth));
        } else if (stick) scroll.scrollTop = scroll.scrollHeight;
        updateJump();
      }
      syncComposer();
      if (lastMode === "off" && next !== "off" && el.classList.contains("on")) focusComposer();
      lastMode = next;
    },
    tick(nowMs) {
      const dt = lastTick ? Math.min(0.1, (nowMs - lastTick) / 1000) : 0.016;
      lastTick = nowMs;
      let moved = false;
      for (const row of rows.values()) {
        const it = row.item;
        if (!it || row.shown >= it.text.length) continue;
        const backlog = it.text.length - row.shown;
        row.shown = Math.min(it.text.length, row.shown + Math.max(1, Math.max(REVEAL_MIN_CPS, backlog * REVEAL_CATCH_UP) * dt));
        paintAnswer(row);
        moved = true;
      }
      if (moved && stick) scroll.scrollTop = scroll.scrollHeight;
      if (moved) updateJump();
    },
    shown() {
      // The off-state switch lands where the chat button was: a double click must not flip it.
      el.classList.add("settling");
      window.setTimeout(() => el.classList.remove("settling"), 450);
      lastTick = 0;
      stick = true;
      scroll.scrollTop = scroll.scrollHeight;
      if (State.chat.enabled) focusComposer();
    },
    hidden() {
      closeMenu(false);
      window.clearTimeout(focusTimer);
      input.blur();
    },
    key(e) {
      if (menuKey(e)) return true;
      if (e.key === "Escape" && document.activeElement === input) {
        e.preventDefault();
        input.blur();
        actions.wantKeyboard(false);
        return true;
      }
      return false;
    },
  };
}
