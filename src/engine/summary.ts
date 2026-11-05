import type { Database } from "bun:sqlite";
import { listPending } from "./approvals";
import { getSetting } from "./settings";
import { listSpaces } from "./spaces";
import { listTasks } from "./tasks";

export type Need = { id: string; kind: "review" | "question"; title: string; spaceName: string; path: string };
export type Stopped = { id: string; title: string; spaceName: string; status: "failed" | "blocked"; reason: string | null; path: string };
export type Summary = { needsYou: number; needs: Need[]; stopped: Stopped[]; overnight: boolean };

const STOPPED_LIMIT = 20;

const pathFor = (spaceId: string, taskId: string | null) => (taskId ? `/space/${spaceId}?task=${taskId}` : `/space/${spaceId}`);

// The Mac app's badge, menu and notifications; small enough to refetch on every change. Only active spaces count,
// so the badge matches the dashboard's Needs you list.
export function summary(db: Database): Summary {
  const names = new Map(listSpaces(db).map((s) => [s.id, s.name]));
  const needs = listPending(db)
    .filter((a) => names.has(a.spaceId))
    .map((a): Need => ({ id: a.id, kind: a.kind, title: a.title, spaceName: names.get(a.spaceId)!, path: pathFor(a.spaceId, a.taskId) }));
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
