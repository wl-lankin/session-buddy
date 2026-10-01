// Four sessions that exercise every part of the island.

import type { Session, Snapshot } from "../src/core/types";

const base = (id: string, project: string, now: number, p: Partial<Session>): Session => ({
  id, project, cwd: `C:\\Projects\\${project}`, branch: null, termProgram: "WarpTerminal", model: "Opus 5.5",
  status: "idle", statusSince: now, lastPrompt: null, lastMessage: null, steps: [], agents: [], background: [],
  stats: { linesAdded: 0, linesRemoved: 0, contextUsedPct: 12, contextTokens: 24_000, contextSize: 200_000, costUsd: 0.2 },
  pending: [], startedAt: now, lastEventAt: now, ...p,
});

export function demoSnapshot(now: number): Snapshot {
  return {
    now,
    usage: {
      fiveHour: { usedPct: 42, resetsAt: now + 3 * 3600_000 },
      sevenDay: { usedPct: 74, resetsAt: now + 4 * 24 * 3600_000 },
      source: "statusline", updatedAt: now, error: null,
      account: { email: "wolfgang@example.com", org: "Personal", plan: "Max" },
    },
    sessions: [
      base("a", "pushdocs", now, {
        branch: "PDD-1981", status: "working", statusSince: now - 252_000, lastPrompt: "fix the DATEV 409 handling",
        steps: [
          { tool: "Read", label: "Read · DatevClient.php", at: now, ok: true },
          { tool: "Grep", label: "Search · KeyConflictFault", at: now, ok: true },
          { tool: "Bash", label: "Run · php artisan test --filter Datev", at: now, ok: false },
          { tool: "Edit", label: "Edit · DatevClient.php", at: now, ok: null },
        ],
        agents: [
          { id: "ag1", agentType: "Explore", description: "Find callers", running: true, currentStep: "Search · 409", startedAt: now, endedAt: null },
          { id: "ag2", agentType: "Plan", description: "Plan the fix", running: false, currentStep: null, startedAt: now - 200_000, endedAt: now - 60_000 },
        ],
        background: [{ id: "bg1", kind: "bash", status: "running", description: "npm run build", agentType: null }],
        stats: { linesAdded: 128, linesRemoved: 34, contextUsedPct: 61, contextTokens: 122_000, contextSize: 200_000, costUsd: 1.9 },
      }),
      base("b", "bankconnect", now, {
        branch: "BCD-1120", status: "needs_you",
        pending: [{ kind: "approval", requestId: "r-b1", tool: "Bash", target: "Bash · php artisan migrate --database=testing", agentId: null, deadline: now + 110_000 }],
      }),
      base("c", "fetchdocs", now, {
        status: "needs_you",
        pending: [{
          kind: "question", requestId: "r-c1", deadline: now + 540_000,
          questions: [
            { question: "Which driver should the import use?", header: "Driver", options: [{ label: "Serial", description: "One work item at a time" }, { label: "Parallel" }] },
            { question: "Which checks should run?", header: "Checks", multiSelect: true, options: [{ label: "PHPStan" }, { label: "Pest" }, { label: "Pint" }] },
          ],
        }],
      }),
      base("d", "InvoiceRails", now, {
        status: "finished", lastMessage: "All 312 tests pass. Shall I open the PR?",
        stats: { linesAdded: 12, linesRemoved: 3, contextUsedPct: 93, contextTokens: 186_000, contextSize: 200_000, costUsd: 4.1 },
      }),
    ],
  };
}
