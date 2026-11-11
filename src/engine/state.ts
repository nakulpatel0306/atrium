import type { Database } from "bun:sqlite";
import { type Approval, listPending } from "./approvals";
import type { Registry, TaskWait } from "./agents/registry";
import { listNeverProposals, listPendingProposals, type Proposal } from "./autonomy/proposals";
import { listRules, type Rule } from "./autonomy/rules";
import { briefing } from "./briefing";
import { type ActivityRow, listActivity } from "./events";
import { activeNudges, type Nudge } from "./money/nudges";
import { getSetting } from "./settings";
import { type Space, listSpaces } from "./spaces";
import { atriumDiskUsage } from "./storage";
import { config } from "./config";
import { BadDraft, type ProjectDraft, projectPath } from "./repos/names";
import { getClone, pendingRepoActions } from "./repos/store";
import { type Candidate, type Group, type HandleSource, pendingMessageActions, type Service } from "./messaging/store";
import { type MessagingState, messagingState } from "./capabilities";
import { join } from "node:path";
import { type Task, listTasks } from "./tasks";
import { type Attachment, claimedAttachments } from "./attachments";

export type RunSummary = {
  id: string;
  taskId: string;
  agent: string;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  inputTokens: number;
  outputTokens: number;
};

export type AgentInfo = {
  label: string;
  installed: boolean;
  loggedIn: boolean | null;
  detail: string;
  limitedUntil: number | null;
  tokensToday: number;
};

export type State = {
  // Where the TradingView chart page is served this launch (the server fills it in), or null when its listener
  // didn't start. The token is part of the page's path, so nothing else on that port can stand in for it.
  embed?: { port: number; token: string } | null;
  spaces: Space[];
  // Archived spaces, most recently archived first, for the list that restores or deletes them.
  archived: Space[];
  tasks: Task[];
  // Files each task was sent with, by task.
  attachments: Attachment[];
  runs: RunSummary[];
  approvals: Approval[];
  // Pending "stop asking about this?" suggestions; every rule, newest first; kinds Nakul said never to suggest.
  proposals: Proposal[];
  rules: Rule[];
  neverAsk: Proposal[];
  activity: ActivityRow[];
  // How many files each task in the activity made, so the feed can say "wrote 2 files".
  activityFiles: Record<string, number>;
  briefing: ReturnType<typeof briefing>;
  power: {
    source: "ac" | "battery";
    overnight: boolean;
    keepAwake: boolean;
    pausedUntil?: number;
  };
  // Why each queued task the runner held back on its last pass isn't starting, by task id.
  waits: Record<string, TaskWait>;
  usage: { claudeTokens24h: number; claudeReserve: number };
  agents: Record<string, AgentInfo>;
  // The last five-hour reading while its window is still open; null when unknown or already reset.
  claudeWindow: { utilization: number; resetsAt: number; reserve: number } | null;
  disk: ReturnType<typeof atriumDiskUsage>;
  // Pending new-project drafts and clone removals, for the forms in Needs you.
  repoActions: RepoActionView[];
  // Pending texts, for the send cards in Needs you.
  messageActions: MessageActionView[];
  // The monthly import reminder, shown in Needs you as a quiet row (budget heads-ups are notifications only).
  nudges: Nudge[];
  // Whether sending has worked, is blocked, or hasn't been tried; and whether a Contacts lookup has worked (null
  // until the first one).
  messaging: { state: MessagingState; contactsReady: boolean | null };
};

export type MessageActionView = {
  id: string;
  approvalId: string;
  spaceId: string;
  taskId: string | null;
  toName: string;
  handle: string | null;
  handleSource: HandleSource | null;
  candidates: Candidate[] | null;
  service: Service;
  text: string;
  // A group text: whom the agent named and the chat Find picked (members' handles masked). Null for one person.
  group: Group | null;
  lastError: string | null;
  // Whether a Contacts lookup has worked before, so the card knows macOS won't ask again.
  contactsReady: boolean;
};

function contactsReadyOf(db: Database): boolean | null {
  const v = getSetting(db, "messaging.contactsReady");
  return v === null ? null : v === "true";
}

function messageActionViews(db: Database): MessageActionView[] {
  const contactsReady = getSetting(db, "messaging.contactsReady") === "true";
  return pendingMessageActions(db).map((a) => ({
    id: a.id,
    approvalId: a.approvalId,
    spaceId: a.spaceId,
    taskId: a.taskId,
    toName: a.toName,
    handle: a.handle,
    handleSource: a.handleSource,
    candidates: a.candidates,
    service: a.service,
    text: a.text,
    group: a.group,
    lastError: a.error,
    contactsReady,
  }));
}

export type RepoActionView = {
  id: string;
  approvalId: string;
  kind: "create" | "remove";
  draft: ProjectDraft | null;
  path: string | null;
  folderTaken: boolean;
  github: string | null;
  // A retry that picks up the repo an earlier run already pushed: its template can't change.
  pickedUp: boolean;
  // Not measured here (walking a big folder would slow every snapshot); the removal's detail carries its size.
  bytes: number | null;
};

function repoActionViews(db: Database): RepoActionView[] {
  return pendingRepoActions(db).map((a) => {
    if (a.kind === "create" && a.draft) {
      let folderTaken = false;
      try {
        projectPath(a.draft.name);
      } catch (e) {
        if (!(e instanceof BadDraft)) throw e;
        folderTaken = true;
      }
      const path = join(config().projectsRoot, a.draft.name);
      return { id: a.id, approvalId: a.approvalId, kind: a.kind, draft: a.draft, path, folderTaken, github: null, pickedUp: a.pushedSha !== null, bytes: null };
    }
    const clone = a.cloneId ? getClone(db, a.cloneId) : null;
    return { id: a.id, approvalId: a.approvalId, kind: a.kind, draft: null, path: clone?.path ?? null, folderTaken: false, github: clone?.github ?? null, pickedUp: false, bytes: null };
  });
}

// Files recorded for the tasks the feed mentions; a deleted file still counts, as the run did make it.
function filesByTask(db: Database, activity: ActivityRow[]): Record<string, number> {
  const ids = [...new Set(activity.map((a) => a.taskId).filter((id): id is string => id !== null))];
  if (!ids.length) return {};
  const rows = db
    .query(`SELECT task_id, COUNT(DISTINCT root || ':' || path) AS n FROM run_files WHERE change != 'deleted' AND task_id IN (${ids.map(() => "?").join(",")}) GROUP BY task_id`)
    .all(...ids) as { task_id: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.task_id, r.n]));
}

export function snapshot(db: Database, registry?: Registry): State {
  const now = Date.now();
  const activity = listActivity(db, { limit: 300 });
  const waitsRaw = JSON.parse(getSetting(db, "runner.waiting") || "[]") as unknown;
  const pausedUntil = Number(getSetting(db, "agent.claude.limitedUntil") ?? 0);
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  const todayTokens = new Map(
    (
      db
        .query("SELECT agent, SUM(input_tokens + output_tokens) AS n FROM runs WHERE started_at >= ? GROUP BY agent")
        .all(midnight) as { agent: string; n: number }[]
    ).map((r) => [r.agent, r.n]),
  );
  const agents = Object.fromEntries(
    Object.entries(registry?.statuses() ?? {}).map(([id, s]) => [
      id,
      { label: registry!.adapters[id]!.label, ...s, tokensToday: todayTokens.get(id) ?? 0 },
    ]),
  );
  const windowRaw = getSetting(db, "usage.claude.fiveHour");
  const window = windowRaw ? (JSON.parse(windowRaw) as { utilization: number; resetsAt: number }) : null;
  const reserve = Number(getSetting(db, "usage.claude.reserve") ?? 0.5);
  const tokens = db
    .query("SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS n FROM runs WHERE started_at > ?")
    .get(now - 24 * 3600_000) as { n: number };
  return {
    spaces: listSpaces(db),
    archived: listSpaces(db, { includeArchived: true })
      .filter((s) => s.status === "archived")
      .sort((a, b) => b.updatedAt - a.updatedAt),
    tasks: listTasks(db),
    attachments: claimedAttachments(db),
    // rowid breaks ties between runs started in the same millisecond
    runs: db
      .query(
        `SELECT id, task_id AS taskId, agent, started_at AS startedAt, ended_at AS endedAt, exit_code AS exitCode,
                input_tokens AS inputTokens, output_tokens AS outputTokens
         FROM runs ORDER BY started_at DESC, rowid DESC LIMIT 200`,
      )
      .all() as RunSummary[],
    approvals: listPending(db),
    proposals: listPendingProposals(db),
    rules: listRules(db, now),
    neverAsk: listNeverProposals(db),
    activity,
    activityFiles: filesByTask(db, activity),
    briefing: briefing(db, now),
    power: {
      source: getSetting(db, "power.source") === "battery" ? "battery" : "ac",
      overnight: getSetting(db, "overnight") === "true",
      keepAwake: getSetting(db, "power.keepAwake") === "true",
      // A limit's time stays stored after it resets, so only a future one means paused.
      ...(pausedUntil > now ? { pausedUntil } : {}),
    },
    // An engine from before per-task waits stored a single object here until its first pass rewrites it.
    waits: Object.fromEntries((Array.isArray(waitsRaw) ? (waitsRaw as TaskWait[]) : []).map((w) => [w.taskId, w])),
    usage: { claudeTokens24h: tokens.n, claudeReserve: reserve },
    agents,
    claudeWindow:
      window && window.resetsAt > now
        ? { ...window, reserve }
        : null,
    disk: atriumDiskUsage(),
    repoActions: repoActionViews(db),
    messageActions: messageActionViews(db),
    nudges: activeNudges(db, now).filter((n) => n.kind === "import"),
    messaging: { state: messagingState(db), contactsReady: contactsReadyOf(db) },
  };
}
