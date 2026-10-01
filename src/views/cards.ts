// The card for whatever is waiting for the user: a permission request, an
// AskUserQuestion prompt, or a plain-text question at the end of a turn.
// One card at a time: the card on screen stays until it resolves, then the focused
// session's items, then the other sessions in list order. The rest are counted, never replaced.

import { h } from "./dom";
import { State } from "../core/state";
import type { Interaction, Session } from "../core/types";
import { fmtCountdown } from "../model/format";
import { answersFor, pendingQueue } from "../model/viewmodel";
import { createSubmitGuard } from "../model/submitguard";
import { btn, enlargeButton, sessionName, statusDot } from "./parts";
import type { ViewActions, ViewHost } from "./views";

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
  let current: { session: Session; item: Interaction } | null = null;
  let picks: Record<string, string[]> = {};
  let other: Record<string, string> = {};
  let submit: HTMLButtonElement | null = null;
  // Only the answering actions lock; "Answer in terminal" and the text fields stay usable.
  const guard = createSubmitGuard<typeof State.notice>((locked) => {
    el.querySelectorAll<HTMLButtonElement>(".btn.primary, .btn.danger, .opt").forEach((c) => (c.disabled = locked));
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
    if (!submit || current?.item.kind !== "question") return;
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
    body.replaceChildren(h("div", { class: "i-message scrollable", text: item.message }), box);
    foot.replaceChildren(countdown, h("span", { class: "grow" }), terminalBtn(item.requestId), btn("Send", "primary", send));
  }

  return {
    el,
    sync() {
      enlarge.refresh();
      const queue = pendingQueue(State.sessions, State.focusId, shownId || null);
      current = queue[0] ?? null;
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
      const { session, item } = current;
      head.replaceChildren(
        ...present([
          statusDot(session),
          sessionName(session, "i-who"),
          h("span", { class: "i-kind", text: KIND_LABEL[item.kind] }),
          queue.length > 1 ? h("span", { class: "i-queue", text: `+${queue.length - 1} waiting` }) : null,
          enlarge.el,
        ]),
      );
      const rows = State.manualH != null ? REPLY_ROWS_BIG : REPLY_ROWS;
      if (replyBox && replyBox.rows !== rows) {
        replyBox.rows = rows;
        replyBox.classList.toggle("overflowing", replyBox.scrollHeight > replyBox.clientHeight + 1);
      }
      if (item.requestId === shownId) return;
      shownId = item.requestId;
      shownAt = performance.now();
      guard.reset();
      picks = {};
      other = {};
      submit = null;
      replyBox = null;
      if (item.kind === "approval") renderApproval(session, item);
      else if (item.kind === "question") renderQuestion(item);
      else renderReply(item);
      actions.relayout();
    },
    anchorId: () => shownId || null,
    tick() {
      if (!current) return;
      const text = `Back to the terminal in ${fmtCountdown(current.item.deadline - Date.now())}`;
      if (countdown.textContent !== text) countdown.textContent = text;
    },
    measure() {
      // Natural height of the card: scrollable areas count with their full content, the rest as laid out.
      const natural = (c: HTMLElement) => (c.classList.contains("i-reply") ? c.offsetHeight : c.scrollHeight + c.offsetHeight - c.clientHeight);
      const bodyKids = [...body.children] as HTMLElement[];
      const bodyH = bodyKids.reduce((sum, c) => sum + natural(c), 0) + Math.max(0, bodyKids.length - 1) * 6;
      const rows = [head.offsetHeight, bodyH, notice.style.display === "none" ? 0 : notice.offsetHeight, foot.offsetHeight].filter((x) => x > 0);
      const cs = getComputedStyle(el);
      const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      return rows.reduce((a, b) => a + b, 0) + Math.max(0, rows.length - 1) * 8 + pad + 22;
    },
    key(e) {
      if (!current || current.item.kind !== "question") return false;
      if (e.key === "Enter" && !(e.target as Element | null)?.closest("textarea")) {
        e.preventDefault();
        submit?.click();
        return true;
      }
      return false;
    },
  };
}
