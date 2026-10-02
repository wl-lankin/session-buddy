// Control mode of the chat, as pure logic: the Web | Control switch, the suggestion
// chips and the hint shown while no project folder is set up.

import type { Session } from "../core/types";
import type { ChatMode, Suggestion } from "./chat";

export const CHAT_MODES: { id: ChatMode; label: string; title: string }[] = [
  { id: "web", label: "Web", title: "Web search: Buddy can search and read web pages" },
  { id: "control", label: "Control", title: "Control: Buddy can look at your sessions and start or steer background sessions, after you confirm" },
];

export interface ModeSwitch {
  options: { id: ChatMode; label: string; title: string; active: boolean }[];
  disabled: boolean;
  title: string;
}

/** Switching restarts the chat process, so it waits while an answer is produced (same rule as the model picker). */
export function modeSwitch(mode: ChatMode, busy: boolean): ModeSwitch {
  return {
    options: CHAT_MODES.map((m) => ({ ...m, active: m.id === mode })),
    disabled: busy,
    title: busy ? "Wait until the answer is finished, or stop it, to switch the mode" : "Switching starts a new context",
  };
}

/** The mode a click on `id` asks for, or null when it is the current one or the switch is locked. */
export function modeChoice(current: ChatMode, id: ChatMode, busy: boolean): ChatMode | null {
  return busy || id === current ? null : id;
}

export const CONTROL_HINT = {
  title: "Choose a project folder first",
  text: "Control lets Buddy start and steer background Claude Code sessions. It can only suggest folders you list in Settings, and you confirm every start in the island.",
  button: "Choose a project folder",
};

const START_MAX = 2;

/** Chips for an empty control chat: what the sessions do, starting one in a project that is already open, the list of allowed folders. */
export function controlSuggestions(sessions: Session[], focusId: string | null): Suggestion[] {
  const live = sessions.filter((s) => s.live && s.status !== "stale");
  const out: Suggestion[] = [];
  if (live.length) {
    out.push({
      id: "sessions",
      label: "What are my sessions doing?",
      prompt: "What are my sessions doing right now? Keep it short.",
      context: { kind: "overview" },
    });
  }
  const focus = live.find((s) => s.id === focusId);
  const projects: string[] = [];
  for (const s of focus ? [focus, ...live.filter((x) => x !== focus)] : live) {
    if (s.project && !projects.includes(s.project)) projects.push(s.project);
  }
  for (const project of projects.slice(0, START_MAX)) {
    out.push({
      id: `start:${project}`,
      label: `Start a session in ${project}`,
      prompt: `I want to start a new session in ${project}. Ask me what it should work on, then start it.`,
      context: null,
    });
  }
  out.push({ id: "projects", label: "Which projects can you use?", prompt: "Which project folders can you start sessions in?", context: null });
  return out.slice(0, 4);
}
