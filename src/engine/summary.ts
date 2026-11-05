import type { Database } from "bun:sqlite";
import { listPending, type AlertTopic } from "./approvals";
import { listPendingProposals } from "./autonomy/proposals";
import { getSetting } from "./settings";
import { listSpaces } from "./spaces";
import { listTasks } from "./tasks";

export type Need = { id: string; kind: "review" | "question" | "alert" | "suggestion"; title: string; spaceName: string; path: string; topic: AlertTopic | null };
export type Stopped = { id: string; title: string; spaceName: string; status: "failed" | "blocked"; reason: string | null; path: string };
export type Summary = {
  needsYou: number;
  needs: Need[];
  stopped: Stopped[];
  overnight: boolean;
  // Pending market alerts by kind; indicator alerts count as price.
  alerts: { price: number; earnings: number; news: number; flag: number };
};

const STOPPED_LIMIT = 20;

const pathFor = (spaceId: string, taskId: string | null) => (taskId ? `/space/${spaceId}?task=${taskId}` : `/space/${spaceId}`);

// The Mac app's badge, menu and notifications; small enough to refetch on every change. Only active spaces count,
// and "stop asking about this?" suggestions count like approvals, so the badge matches the dashboard's Needs you.
export function summary(db: Database): Summary {
  const names = new Map(listSpaces(db).map((s) => [s.id, s.name]));
  // An Atrium-wide question (a new repo, removing a local copy) belongs to no space and is answered from Home.
  const approvals = listPending(db)
    .filter((a) => a.spaceId === null || names.has(a.spaceId))
    .map((a) => ({
      at: a.createdAt,
      need: (a.spaceId === null
        ? { id: a.id, kind: a.kind, title: a.title, spaceName: "Atrium", path: "/", topic: a.topic }
        : { id: a.id, kind: a.kind, title: a.title, spaceName: names.get(a.spaceId)!, path: pathFor(a.spaceId, a.taskId), topic: a.topic }) as Need,
    }));
  // Suggestions are answered from Home's Needs you list, not from a space.
  const suggestions = listPendingProposals(db)
    .filter((p) => names.has(p.spaceId))
    .map((p) => ({
      at: p.createdAt,
      need: { id: p.id, kind: "suggestion", title: `Stop asking about ${p.label}?`, spaceName: names.get(p.spaceId)!, path: "/", topic: null } as Need,
    }));
  // Stable sort keeps each list's own tie order when two land in the same millisecond.
  const needs = [...approvals, ...suggestions].sort((a, b) => b.at - a.at).map((x) => x.need);
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
  const alerts = { price: 0, earnings: 0, news: 0, flag: 0 };
  for (const n of needs) {
    if (n.kind !== "alert") continue;
    const t = n.topic === "indicator" || !n.topic ? "price" : n.topic;
    alerts[t]++;
  }
  return { needsYou: needs.length, needs, stopped, overnight: getSetting(db, "overnight") === "true", alerts };
}
