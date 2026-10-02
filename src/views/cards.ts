// The card for whatever is waiting for the user: a permission request, an
// AskUserQuestion prompt, or a plain-text question at the end of a turn.
// One card at a time: the card on screen stays until it resolves, then the focused
// session's items, then the other sessions in list order. The rest are counted, never replaced.

import { h, svg } from "./dom";
import { ICONS } from "./icons";
import { State } from "../core/state";
import type { ActionRequest, Interaction, Session } from "../core/types";
import { actionKey, buildAnswer, combinedQueue, folderOptions, hostChoice, hostLabel, initialDraft, visibleRows, withFolder, withHost, type ActionDraft, type QueueEntry } from "../model/actions";
import { fmtCountdown } from "../model/format";
import { answersFor, pendingQueue } from "../model/viewmodel";
import { createSubmitGuard } from "../model/submitguard";
import { btn, enlargeButton, sessionName, statusDot } from "./parts";
import type { ViewActions, ViewHost } from "./views";
import { renderMarkdown } from "./markdown";

const KIND_LABEL: Record<Interaction["kind"], string> = {
  approval: "Permission",
  question: "Question",
  reply: "Claude asks",
};

/** Clicks this soon after the card changed were aimed at the previous card. */
const CHANGE_GRACE_MS = 500;
/** The reply box grows from 2 to 6 rows when the island is enlarged. */
const REPLY_ROWS = 2;
const REPLY_ROWS_BIG = 6;

const present = (xs: (Node | null | undefined | false)[]): Node[] => xs.filter(Boolean) as Node[];

export function buildInteraction(actions: ViewActions): ViewHost {
  const head = h("div", { class: "i-head" });
  const body = h("div", { class: "i-body" });
  const notice = h("div", { class: "i-notice" });
  const countdown = h("span", { class: "i-countdown" });
  const foot = h("div", { class: "i-foot" });
  const el = h("div", { class: "view interaction-view" }, head, body, notice, foot);
  const enlarge = enlargeButton(() => actions.toggleEnlarge());
  let replyBox: HTMLTextAreaElement | null = null;

  let shownId = "";
  let shownAt = 0;
  let current: QueueEntry | null = null;
  // What the user changed on each action card, kept while the card waits in the queue.
  const drafts = new Map<string, ActionDraft>();
  let choosing = false;
  let picks: Record<string, string[]> = {};
  let other: Record<string, string> = {};
  let submit: HTMLButtonElement | null = null;
  // Only the answering actions lock; "Answer in terminal" and the text fields stay usable.
  const guard = createSubmitGuard<typeof State.notice>((locked) => {
    el.querySelectorAll<HTMLButtonElement>(".btn.primary, .btn.danger, .opt, .i-fopt").forEach((c) => (c.disabled = locked));
    if (!locked) refreshSubmit();
  });

  const settled = () => performance.now() - shownAt >= CHANGE_GRACE_MS;

  const answer = (requestId: string, payload: unknown) => {
    if (settled() && guard.lock(State.notice)) actions.answer(requestId, payload);
  };

  const focusField = (field: HTMLInputElement | HTMLTextAreaElement) => {
    actions.wantKeyboard(true);
    window.setTimeout(() => field.focus(), 120);
  };

  const terminalBtn = (requestId: string) => btn("Answer in terminal", "secondary", () => {
      if (settled()) actions.release(requestId);
    });

  function refreshSubmit() {
    if (!submit || current?.kind !== "session" || current.item.kind !== "question") return;
    submit.disabled = guard.locked || answersFor(current.item.questions, picks, other) == null;
  }

  function renderApproval(session: Session, item: Extract<Interaction, { kind: "approval" }>) {
    const agent = item.agentId ? session.agents.find((a) => a.id === item.agentId) : undefined;
    body.replaceChildren(
      ...present([
        h("div", { class: "title", text: `Allow ${item.tool}?` }),
        agent ? h("div", { class: "sub", text: `Requested by sub-agent ${agent.agentType}` }) : null,
        h("pre", { class: "code scrollable i-target", text: item.target }),
      ]),
    );
    foot.replaceChildren(
      countdown,
      h("span", { class: "grow" }),
      terminalBtn(item.requestId),
      btn("Deny", "danger", () => answer(item.requestId, { behavior: "deny" })),
      btn("Allow", "primary", () => answer(item.requestId, { behavior: "allow" })),
    );
  }

  function renderQuestion(item: Extract<Interaction, { kind: "question" }>) {
    const blocks = item.questions.map((q) => {
      const opts = h("div", { class: "i-options" });
      const otherInput = h("input", { class: "i-other", placeholder: "Other..." });
      const renderOpts = () => {
        opts.replaceChildren(
          ...q.options.map((o) => {
            const on = (picks[q.question] ?? []).includes(o.label);
            return h(
              "button",
              {
                class: `opt${on ? " on" : ""}`,
                title: o.description ?? "",
                onclick: (e: Event) => {
                  e.stopPropagation();
                  if (guard.locked) return;
                  const cur = picks[q.question] ?? [];
                  picks[q.question] = q.multiSelect ? (on ? cur.filter((x) => x !== o.label) : [...cur, o.label]) : [o.label];
                  if (!q.multiSelect) {
                    other[q.question] = "";
                    otherInput.value = "";
                  }
                  renderOpts();
                  refreshSubmit();
                },
              },
              ...present([h("span", { class: "opt-label", text: o.label }), o.description ? h("span", { class: "opt-desc", text: o.description }) : null]),
            );
          }),
        );
      };
      otherInput.addEventListener("mousedown", () => focusField(otherInput));
      otherInput.addEventListener("input", () => {
        other[q.question] = otherInput.value;
        if (!q.multiSelect && otherInput.value.trim()) {
          picks[q.question] = [];
          renderOpts();
        }
        refreshSubmit();
      });
      renderOpts();
      return h(
        "div",
        { class: "i-q" },
        ...present([
          q.header ? h("span", { class: "chip", text: q.header }) : null,
          h("div", { class: "i-qtext", text: q.question }),
          q.multiSelect ? h("div", { class: "sub", text: "Pick any" }) : null,
          opts,
          otherInput,
        ]),
      );
    });
    body.replaceChildren(h("div", { class: "i-questions scrollable" }, ...blocks));
    submit = btn("Submit", "primary", () => {
      const answers = answersFor(item.questions, picks, other);
      if (answers) answer(item.requestId, { answers });
    });
    foot.replaceChildren(countdown, h("span", { class: "grow" }), terminalBtn(item.requestId), submit);
    refreshSubmit();
  }

  function renderReply(item: Extract<Interaction, { kind: "reply" }>) {
    const box = h("textarea", { class: "i-reply", rows: REPLY_ROWS, placeholder: "Reply to Claude (Enter sends, Shift+Enter adds a line)" });
    replyBox = box;
    const send = () => {
      const text = box.value.trim();
      if (text) answer(item.requestId, { reply: text });
    };
    box.addEventListener("mousedown", () => focusField(box));
    box.addEventListener("input", () => box.classList.toggle("overflowing", box.scrollHeight > box.clientHeight + 1));
    box.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });
    // Claude writes Markdown: **bold**, `code`, lists and code blocks read better rendered.
    body.replaceChildren(h("div", { class: "i-message scrollable" }, ...renderMarkdown(item.message)), box);
    foot.replaceChildren(countdown, h("span", { class: "grow" }), terminalBtn(item.requestId), btn("Send", "primary", send));
  }

  function renderAction(a: ActionRequest) {
    let draft = drafts.get(a.requestId) ?? initialDraft(a);
    drafts.set(a.requestId, draft);
    const edit = (next: ActionDraft) => {
      draft = next;
      drafts.set(a.requestId, next);
      paint();
      actions.relayout();
    };
    const folderEl = h("div", { class: "i-field" });
    const hostEl = h("div", { class: "i-field" });

    function paint() {
      if (a.folder) {
        const path = draft.folder ?? a.folder.path;
        const choose = btn(choosing ? "Choosing..." : "Choose...", "secondary", () => {
          if (!settled() || choosing) return;
          choosing = true;
          paint();
          void actions.pickFolder(path).then((picked) => {
            choosing = false;
            edit(withFolder(draft, picked));
          });
        }, "Pick any folder yourself");
        choose.disabled = choosing;
        const options = folderOptions(a, draft);
        folderEl.replaceChildren(
          ...present([
            h("span", { class: "i-fl", text: "Folder" }),
            h("span", { class: "i-fv" }, h("span", { class: "i-path", text: path, title: path }), choose),
            options.length
              ? h("div", { class: "i-fopts scrollable" }, ...options.map((o) => h("button", { class: "i-fopt", title: o, onclick: (e: Event) => { e.stopPropagation(); if (!guard.locked) edit(withFolder(draft, o)); } }, o)))
              : null,
          ]),
        );
      }
      if (a.host) {
        const control = hostChoice(a)
          ? h("select", { class: "i-select", title: "Where the session runs", onchange: (e: Event) => { draft = withHost(a, draft, (e.target as HTMLSelectElement).value); drafts.set(a.requestId, draft); } },
              ...a.host.options.map((o) => h("option", { value: o.id, text: o.label, selected: o.id === draft.host })))
          : h("span", { class: "i-fv" }, h("span", { class: "i-path plain", text: hostLabel(a, draft) }));
        hostEl.replaceChildren(h("span", { class: "i-fl", text: "Runs in" }), control);
      }
    }
    paint();

    const rows = visibleRows(a);
    body.replaceChildren(
      ...present([
        h("div", { class: "title", text: a.title }),
        rows.length ? h("div", { class: "i-rows" }, ...rows.map((r) => h("div", { class: "i-row" }, h("span", { class: "i-fl", text: r.label }), h("span", { class: "i-rv", text: r.value, title: r.value })))) : null,
        a.body ? h("div", { class: "scrollable i-prompt", text: a.body }) : null,
        a.folder ? folderEl : null,
        a.host ? hostEl : null,
      ]),
    );
    foot.replaceChildren(
      countdown,
      h("span", { class: "grow" }),
      btn("Deny", "danger", () => answer(a.requestId, buildAnswer(a, draft, false))),
      btn("Allow", "primary", () => answer(a.requestId, buildAnswer(a, draft, true))),
    );
  }

  // The window takes the keyboard only after the user clicks the card (Escape denies); it never steals it on its own.
  el.addEventListener("mousedown", () => {
    if (current?.kind === "action") actions.wantKeyboard(true);
  });

  return {
    el,
    sync() {
      enlarge.refresh();
      const shown = shownId || null;
      const queue = combinedQueue(State.snapshot.actions, pendingQueue(State.sessions, State.focusId, shown), shown);
      current = queue[0] ?? null;
      for (const id of [...drafts.keys()]) if (!State.snapshot.actions.some((a) => a.requestId === id)) drafts.delete(id);
      guard.observe(State.notice);
      notice.textContent = State.notice?.text ?? "";
      notice.style.display = State.notice ? "" : "none";
      if (!current) {
        if (shownId) {
          shownId = "";
          head.replaceChildren();
          body.replaceChildren();
          foot.replaceChildren();
        }
        return;
      }
      const entry = current;
      const waiting = queue.length > 1 ? h("span", { class: "i-queue", text: `+${queue.length - 1} waiting` }) : null;
      head.replaceChildren(
        ...present(
          entry.kind === "action"
            ? [h("span", { class: "i-buddy" }, svg(ICONS.buddy, 14)), h("span", { class: "i-who", text: "Buddy" }), h("span", { class: "i-kind", text: "Confirm" }), waiting, enlarge.el]
            : [statusDot(entry.session), sessionName(entry.session, "i-who"), h("span", { class: "i-kind", text: KIND_LABEL[entry.item.kind] }), waiting, enlarge.el],
        ),
      );
      const rows = State.manualH != null ? REPLY_ROWS_BIG : REPLY_ROWS;
      if (replyBox && replyBox.rows !== rows) {
        replyBox.rows = rows;
        replyBox.classList.toggle("overflowing", replyBox.scrollHeight > replyBox.clientHeight + 1);
      }
      const id = entry.kind === "action" ? entry.action.requestId : entry.item.requestId;
      if (id === shownId) return;
      shownId = id;
      shownAt = performance.now();
      guard.reset();
      picks = {};
      other = {};
      submit = null;
      replyBox = null;
      choosing = false;
      if (entry.kind === "action") renderAction(entry.action);
      else if (entry.item.kind === "approval") renderApproval(entry.session, entry.item);
      else if (entry.item.kind === "question") renderQuestion(entry.item);
      else renderReply(entry.item);
      actions.relayout();
    },
    anchorId: () => shownId || null,
    tick() {
      if (!current) return;
      const left = fmtCountdown((current.kind === "action" ? current.action.deadline : current.item.deadline) - Date.now());
      const text = current.kind === "action" ? `Denied automatically in ${left}` : `Back to the terminal in ${left}`;
      if (countdown.textContent !== text) countdown.textContent = text;
    },
    measure() {
      // Natural height of the card: scrollable areas count with their full content, the rest as laid out.
      const natural = (c: HTMLElement) =>
        c.classList.contains("i-reply") ? c.offsetHeight + parseFloat(getComputedStyle(c).marginTop) : c.scrollHeight + c.offsetHeight - c.clientHeight;
      const bodyKids = [...body.children] as HTMLElement[];
      const bodyH = bodyKids.reduce((sum, c) => sum + natural(c), 0) + Math.max(0, bodyKids.length - 1) * 6;
      const rows = [head.offsetHeight, bodyH, notice.style.display === "none" ? 0 : notice.offsetHeight, foot.offsetHeight].filter((x) => x > 0);
      const cs = getComputedStyle(el);
      const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      return rows.reduce((a, b) => a + b, 0) + Math.max(0, rows.length - 1) * 8 + pad + 22;
    },
    key(e) {
      if (current?.kind === "action") {
        if (actionKey(e.key, (e.target as Element | null)?.tagName ?? "") !== "deny") return false;
        e.preventDefault();
        (foot.querySelector<HTMLButtonElement>(".btn.danger"))?.click();
        return true;
      }
      if (current?.kind !== "session" || current.item.kind !== "question") return false;
      if (e.key === "Enter" && !(e.target as Element | null)?.closest("textarea")) {
        e.preventDefault();
        submit?.click();
        return true;
      }
      return false;
    },
  };
}
