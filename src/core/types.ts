// Mirrors the JSON emitted by the Rust app (sb-core store + usage). camelCase.

export type Status = "thinking" | "working" | "needs_you" | "finished" | "error" | "idle" | "stale";

export interface Step { tool: string; label: string; at: number; ok: boolean | null }

export interface Agent {
  id: string;
  agentType: string;
  description: string | null;
  running: boolean;
  currentStep: string | null;
  startedAt: number;
  endedAt: number | null;
}

export interface BackgroundTask { id: string; kind: string; status: string; description: string; agentType: string | null }

export interface Stats {
  linesAdded: number;
  linesRemoved: number;
  contextUsedPct: number | null;
  contextTokens: number | null;
  contextSize: number | null;
  costUsd: number | null;
}

export interface QuestionOption { label: string; description?: string }
export interface Question { question: string; header?: string; options: QuestionOption[]; multiSelect?: boolean }

export type Interaction =
  | { kind: "approval"; requestId: string; tool: string; target: string; agentId: string | null; deadline: number }
  | { kind: "question"; requestId: string; questions: Question[]; deadline: number }
  | { kind: "reply"; requestId: string; message: string; deadline: number };

export interface Session {
  id: string;
  project: string;
  cwd: string;
  branch: string | null;
  termProgram: string | null;
  model: string | null;
  status: Status;
  statusSince: number;
  lastPrompt: string | null;
  lastMessage: string | null;
  steps: Step[];
  agents: Agent[];
  background: BackgroundTask[];
  stats: Stats;
  pending: Interaction[];
  startedAt: number;
  lastEventAt: number;
  /** The Claude Code process behind the session, when the relay reported it. */
  pid: number | null;
  /** False for sessions seeded from recent transcripts that have not sent an event yet. */
  live: boolean;
}

export interface Limit { usedPct: number; resetsAt: string | number | null }
export interface Account { email: string | null; org: string | null; plan: string | null }
export interface Usage {
  fiveHour: Limit | null;
  sevenDay: Limit | null;
  source: "statusline" | "oauth" | "none";
  updatedAt: number | null;
  error: string | null;
  account: Account | null;
}

export interface Snapshot { sessions: Session[]; usage: Usage; now: number }

export type CueKind = "work" | "finish" | "error" | "approval" | "rate" | "context";
export interface Cue {
  sessionId: string;
  kind: CueKind;
  /** Finish cues: how long the turn took, when its start was seen. */
  turnMs?: number;
}

export const EMPTY_SNAPSHOT: Snapshot = {
  sessions: [],
  usage: { fiveHour: null, sevenDay: null, source: "none", updatedAt: null, error: null, account: null },
  now: 0,
};
