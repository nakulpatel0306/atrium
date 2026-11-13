import type { Database } from "bun:sqlite";
import { listPending } from "./approvals";
import { listPendingProposals } from "./autonomy/proposals";
import { taskFiles } from "./outputs/store";
import { getSetting } from "./settings";
import { listSpaces } from "./spaces";
import { askLine, asksBeforeStarting } from "./needs";
import { getTask, listTasks } from "./tasks";

// `files` is how many files a review's task made (0 for everything else), so the notification can say so.
// `outcome` is what a review's agent said when it wasn't plainly done.
export type Need = {
  id: string;
  kind: "review" | "question" | "suggestion";
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

// The Mac app's badge, menu and notifications; small enough to refetch on every change. Only active spaces count,
// and "stop asking about this?" suggestions and tasks asking before they start count like approvals, so the badge
// matches the dashboard's Needs you (needs.ts).
export function summary(db: Database): Summary {
  const names = new Map(listSpaces(db).map((s) => [s.id, s.name]));
  // An Atrium-wide question (a new repo, removing a local copy) belongs to no space and is answered from Home.
  const approvals = listPending(db)
    .filter((a) => a.spaceId === null || names.has(a.spaceId))
    .map((a) => {
      const told = a.kind === "review" && a.taskId ? getTask(db, a.taskId)?.outcome : null;
      const extra = { outcome: told && told !== "done" ? told : null };
      return {
      at: a.createdAt,
      need: ({ ...(a.spaceId === null
        ? { id: a.id, kind: a.kind, title: a.title, spaceName: "Atrium", path: "/", files: 0 }
        : {
            id: a.id,
            kind: a.kind,
            title: a.title,
            spaceName: names.get(a.spaceId)!,
            path: pathFor(a.spaceId, a.taskId),
            files: a.kind === "review" && a.taskId ? taskFiles(db, a.taskId).filter((f) => f.change !== "deleted").length : 0,
          }), ...extra }) as Need,
      };
    });
  // Suggestions are answered from Home's Needs you list, not from a space.
  const suggestions = listPendingProposals(db)
    .filter((p) => names.has(p.spaceId))
    .map((p) => ({
      at: p.createdAt,
      need: { id: p.id, kind: "suggestion", title: `Stop asking about ${p.label}?`, spaceName: names.get(p.spaceId)!, path: "/", files: 0, outcome: null } as Need,
    }));
  // Tasks whose brief asks something before the writer starts; answered on the task or in Needs you.
  const asking = listTasks(db, { status: ["queued"] })
    .filter((t) => asksBeforeStarting(t) && names.has(t.spaceId))
    .map((t) => ({
      at: t.updatedAt,
      need: { id: t.id, kind: "question", title: `${t.title}: ${askLine(t)}`, spaceName: names.get(t.spaceId)!, path: pathFor(t.spaceId, t.id), files: 0, outcome: null } as Need,
    }));
  // Stable sort keeps each list's own tie order when two land in the same millisecond.
  const needs = [...approvals, ...suggestions, ...asking].sort((a, b) => b.at - a.at).map((x) => x.need);
  const stopped = listTasks(db, { status: ["failed", "blocked"] })
    .filter((t) => t.kind === "work" && names.has(t.spaceId))
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
