import type { Database } from "bun:sqlite";
import { listPending } from "./approvals";
import { listPendingProposals } from "./autonomy/proposals";
import { taskFiles } from "./outputs/store";
import { getSetting } from "./settings";
import { listSpaces } from "./spaces";
import { askLine, attentionQueue } from "./needs";
import { openLines } from "./memory";
import { listTasks } from "./tasks";

// `files` is how many files a review's task made (0 for everything else), so the notification can say so.
// `outcome` is what a review's agent said when it wasn't plainly done.
export type Need = {
  id: string;
  kind: "review" | "question" | "suggestion" | "paused";
  title: string;
  spaceName: string;
  path: string;
  files: number;
  outcome: "partial" | "couldnt" | "unknown" | null;
};
export type Stopped = { id: string; title: string; spaceName: string; status: "failed" | "blocked"; reason: string | null; path: string };
export type Summary = {
  needsYou: number;
  needs: Need[];
  stopped: Stopped[];
  overnight: boolean;
};

const STOPPED_LIMIT = 20;

const pathFor = (spaceId: string, taskId: string | null) => (taskId ? `/space/${spaceId}?task=${taskId}` : `/space/${spaceId}`);

// The Mac app's badge, menu and notifications; small enough to refetch on every change. Built on the one queue
// (needs.ts), so the badge matches the dashboard's Needs you: only active spaces, and only items that hold something
// up. The menu lists them newest first, as notifications arrive.
export function summary(db: Database): Summary {
  const spaces = listSpaces(db);
  const names = new Map(spaces.map((s) => [s.id, s.name]));
  const approvals = listPending(db);
  const proposals = listPendingProposals(db);
  const tasks = listTasks(db);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const queue = attentionQueue({ spaces, approvals, proposals, tasks, learning: { memory: openLines(db) } }).filter((i) => !i.low);
  // Stable: a tie keeps the queue's order, which keeps each list's own.
  const needs = [...queue]
    .sort((a, b) => b.since - a.since)
    .map((i): Need => {
      const spaceName = i.spaceId === null ? "Atrium" : names.get(i.spaceId)!;
      if (i.kind === "review" || i.kind === "approval") {
        const a = approvals.find((x) => x.id === i.key)!;
        // An Atrium-wide question (a new repo, removing a local copy) belongs to no space and is answered from Home.
        if (a.spaceId === null) return { id: a.id, kind: a.kind, title: a.title, spaceName, path: "/", files: 0, outcome: null };
        const told = a.kind === "review" && a.taskId ? byId.get(a.taskId)?.outcome : null;
        const files = a.kind === "review" && a.taskId ? taskFiles(db, a.taskId).filter((f) => f.change !== "deleted").length : 0;
        return { id: a.id, kind: a.kind, title: a.title, spaceName, path: pathFor(a.spaceId, a.taskId), files, outcome: told && told !== "done" ? told : null };
      }
      // Suggestions are answered from Home's Needs you list, not from a space.
      if (i.kind === "suggestion") return { id: i.key, kind: "suggestion", title: `Stop asking about ${proposals.find((p) => p.id === i.key)!.label}?`, spaceName, path: "/", files: 0, outcome: null };
      const t = byId.get(i.taskId!)!;
      return { id: t.id, kind: i.kind === "paused" ? "paused" : "question", title: `${t.title}: ${askLine(t)}`, spaceName, path: pathFor(t.spaceId, t.id), files: 0, outcome: null };
    });
  const asking = new Set(queue.map((i) => i.taskId));
  // A paused task is already in needs; listing it as stopped too would notify twice.
  const stopped = tasks
    .filter((t) => (t.status === "failed" || t.status === "blocked") && t.kind === "work" && names.has(t.spaceId) && !asking.has(t.id))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, STOPPED_LIMIT)
    .map(
      (t): Stopped => ({
        id: t.id,
        title: t.title,
        spaceName: names.get(t.spaceId)!,
        status: t.status as Stopped["status"],
        reason: t.blockedReason,
        path: pathFor(t.spaceId, t.id),
      }),
    );
  return { needsYou: needs.length, needs, stopped, overnight: getSetting(db, "overnight") === "true" };
}
