// Mirrors the JSON emitted by the Rust app (sb-core store + usage). camelCase.

export type Status = "thinking" | "working" | "needs_you" | "finished" | "error" | "idle" | "stale";

/** What a step changed (Edit, Write) or ran (Bash), unfolded under the steps. */
export type StepDetail =
  | { kind: "diff"; path: string; hunks: { old: string; new: string }[] }
  | { kind: "run"; command: string; output: string | null };

export interface Step { tool: string; label: string; at: number; ok: boolean | null; detail?: StepDetail }

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
  /** The plan waiting in Claude Code's own terminal dialog (ExitPlanMode); "" when its text is unknown. */
  plan: string | null;
}

export interface Limit { usedPct: number; resetsAt: string | number | null; severity: string }
export interface LimitRow { kind: string; label: string; usedPct: number; resetsAt: string | number | null; severity: string }
export interface Extra {
  enabled: boolean;
  usedMinor: number;
  limitMinor: number | null;
  currency: string;
  exponent: number;
  disabledReason: string | null;
  percent: number | null;
}
export interface Account { email: string | null; org: string | null; plan: string | null }
export interface Usage {
  fiveHour: Limit | null;
  sevenDay: Limit | null;
  /** Every row of the limits block: 5H, 7D, then the scoped limits ("7D Fable"). */
  limits: LimitRow[];
  extra: Extra | null;
  source: "statusline" | "oauth" | "none";
  updatedAt: number | null;
  error: string | null;
  /** When the usage endpoint last answered, and its last error: the scoped limits and extra usage are as old as this. */
  oauthUpdatedAt: number | null;
  oauthError: string | null;
  account: Account | null;
}

export interface Snapshot { sessions: Session[]; usage: Usage; now: number }

export type CueKind = "work" | "finish" | "error" | "approval" | "rate" | "context";
export interface Cue {
  sessionId: string;
  kind: CueKind;
  /** Finish cues: how long the turn took, when its start was seen (after background work: since the prompt). */
  turnMs?: number;
  /** Finish cues: agents or background tasks are still running. */
  busy?: boolean;
}

export const EMPTY_SNAPSHOT: Snapshot = {
  sessions: [],
  usage: { fiveHour: null, sevenDay: null, limits: [], extra: null, source: "none", updatedAt: null, error: null, oauthUpdatedAt: null, oauthError: null, account: null },
  now: 0,
};
