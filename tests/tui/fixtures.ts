import type { State } from "../../src/engine/state";

type Space = State["spaces"][number];
type Task = State["tasks"][number];

export const ids = {
  atrium: "spc_atrium",
  jobHunt: "spc_jobhunt",
  running: "tsk_running",
  queued: "tsk_queued",
  blocked: "tsk_blocked",
  review: "tsk_review",
  approval: "apr_review",
  proposal: "prp_docs",
  liveRun: "run_live",
  reviewRun: "run_review",
} as const;

const now = Date.now();
const min = 60_000;

export const space = (over: Partial<Space>): Space => ({
  id: "spc_x",
  name: "x",
  kind: "general",
  goal: "",
  color: "",
  repoPath: null,
  private: false,
  status: "active",
  reviewBy: null,
  github: null,
  folder: null,
  createdAt: now - 3 * 24 * 60 * min,
  updatedAt: now - 60 * min,
  ...over,
});

// A pending "Stop asking about …?" suggestion in atrium, for tests that need one.
export const proposal = (over: Partial<State["proposals"][number]> = {}): State["proposals"][number] => ({
  id: ids.proposal,
  spaceId: ids.atrium,
  fingerprint: "docs:markdown",
  label: "docs-only changes",
  evidence: [1, 2, 3, 4, 5].map((i) => ({ id: `apr_old${i}`, title: `Review: Update README ${i}`, resolvedAt: now - i * 60 * min })),
  status: "pending",
  createdAt: now - 5 * min,
  answeredAt: null,
  liftedAt: null,
  ...over,
});

export const task = (over: Partial<Task>): Task => ({
  id: "tsk_x",
  spaceId: ids.atrium,
  title: "Task",
  detail: "",
  status: "queued",
  blockedReason: null,
  agent: "auto",
  weight: "light",
  allowOnBattery: false,
  ignoreReserve: false,
  kind: "work",
  parentTaskId: null,
  approvalId: null,
  strategyId: null,
  purpose: null,
  subject: null,
  branch: null,
  outcome: null,
  outcomeReason: null,
  prUrl: null,
  createdAt: now - 30 * min,
  updatedAt: now - 10 * min,
  ...over,
});

// A complete state with one of everything the panes show: two spaces, open work in every state, an approval, a live run.
export function makeState(over: Partial<State> = {}): State {
  return {
    spaces: [
      space({ id: ids.atrium, name: "atrium", kind: "repo", goal: "Ship the terminal app", repoPath: "/Users/me/Projects/atrium", reviewBy: "codex" }),
      space({ id: ids.jobHunt, name: "job hunt", goal: "Find a new role" }),
    ],
    archived: [],
    tasks: [
      task({ id: ids.review, title: "Fix login redirect", status: "review", agent: "claude", weight: "heavy", approvalId: ids.approval, branch: "atrium/tsk_review", createdAt: now - 50 * min }),
      task({ id: ids.running, title: "Add the status bar", status: "running", agent: "claude", detail: "Draw the gauge.", createdAt: now - 40 * min }),
      task({ id: ids.queued, title: "Add tests", status: "queued", agent: "auto", createdAt: now - 20 * min }),
      task({ id: ids.blocked, spaceId: ids.jobHunt, title: "Summarize postings", status: "blocked", blockedReason: "No postings found", createdAt: now - 15 * min }),
    ],
    attachments: [],
    runs: [
      { id: ids.liveRun, taskId: ids.running, agent: "claude", startedAt: now - 4 * min, endedAt: null, exitCode: null, inputTokens: 0, outputTokens: 0 },
      { id: ids.reviewRun, taskId: ids.review, agent: "claude", startedAt: now - 48 * min, endedAt: now - 44 * min, exitCode: 0, inputTokens: 1200, outputTokens: 300 },
    ],
    approvals: [
      { id: ids.approval, spaceId: ids.atrium, taskId: ids.review, kind: "review", title: "Review: Fix login redirect", detail: "Changed 2 files.", status: "pending", note: null, branchHead: null, fingerprint: null, decidedBy: "you", ruleId: null, undoneAt: null, alwaysAsk: null, topic: null, subject: null, createdAt: now - 3 * min, resolvedAt: null },
    ],
    proposals: [],
    rules: [],
    neverAsk: [],
    activity: [
      { id: "act_1", spaceId: ids.atrium, taskId: null, actor: "claude", message: "finished Fix login redirect", createdAt: now - 2 * min },
      { id: "act_2", spaceId: ids.jobHunt, taskId: null, actor: "you", message: "added Summarize postings", createdAt: now - 15 * min },
      { id: "act_3", spaceId: null, taskId: null, actor: "atrium", message: "Overnight mode off", createdAt: now - 90 * min },
    ],
    activityFiles: {},
    briefing: { greeting: "Good evening, Sam.", summary: "2 tasks finished across 1 space.", markets: null },
    power: { source: "ac", overnight: false, keepAwake: false },
    waits: {
      [ids.queued]: { taskId: ids.queued, agent: "claude", kind: "reserve", reason: "Saving Claude's window until 9:00 PM.", until: now + 60 * min },
    },
    usage: { claudeTokens24h: 48_000, claudeReserve: 0.5 },
    agents: {
      claude: { label: "Claude", installed: true, loggedIn: true, detail: "Signed in", limitedUntil: null, tokensToday: 12_000 },
      codex: { label: "Codex", installed: true, loggedIn: true, detail: "Signed in", limitedUntil: null, tokensToday: 3_000 },
      gemini: { label: "Gemini", installed: true, loggedIn: true, detail: "Signed in", limitedUntil: null, tokensToday: 0 },
    },
    claudeWindow: { utilization: 0.41, resetsAt: now + 2 * 60 * min, reserve: 0.5 },
    disk: { totalBytes: 12 * 1024 * 1024, transcriptsBytes: 10 * 1024 * 1024, dbBytes: 2 * 1024 * 1024 },
    repoActions: [],
    messageActions: [],
    nudges: [],
    messaging: { state: "untested", contactsReady: null },
    ...over,
  };
}
