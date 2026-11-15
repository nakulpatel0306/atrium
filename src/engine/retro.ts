import type { Database } from "bun:sqlite";
import type { TaskSize } from "./brief";
import { dollars, type Spend, spendText } from "./cost";
import { compact, type Tally } from "./loop";
import { SHAPE_LABEL, type ShapeKind } from "./shape";
import type { Task } from "./tasks";
import { plural } from "./text";
import { workSpend } from "./usage";

// The director retro and the weekly roll-up: feedback on directing agents built only from what Atrium measured
// (steers, rework, late check failures, tokens), never from what anyone says about speed. The numbers and the one
// suggestion are picked here by fixed rules; no model writes or phrases them.

// Peers a cost is compared with, and tasks a week needs before the roll-up says anything.
export const PEERS_MIN = 3;
export const ROLLUP_MIN = 5;
const WEEK_MS = 7 * 86_400_000;

export type Retro = { lines: [string, string, string] };
export type Rollup = { tasks: number; lines: string[] };

type Finished = { task: Task; tally: Tally; size: TaskSize; spend: Spend; readyMs: number | null; finishedAt: number };

const rework = (t: Tally) => t.checkFails + t.reviewRounds;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

// Coding tasks the user accepted or opened a pull request for: what the retro and the roll-up are about. A part or an
// attempt counts through its parent, and spend leaves out the learning features' own calls.
function finished(db: Database, tasks: Task[]): Finished[] {
  const approved = new Map(
    (db.query("SELECT task_id AS id, MAX(resolved_at) AS at FROM approvals WHERE kind = 'review' AND status = 'approved' AND task_id IS NOT NULL GROUP BY task_id").all() as { id: string; at: number }[]).map((r) => [r.id, r.at]),
  );
  const firstReady = new Map(
    (db.query("SELECT task_id AS id, MIN(created_at) AS at FROM approvals WHERE kind = 'review' AND task_id IS NOT NULL GROUP BY task_id").all() as { id: string; at: number }[]).map((r) => [r.id, r.at]),
  );
  const spend = workSpend(db);
  return tasks
    .filter((t) => t.kind === "work" && t.loop && !t.loop.role && (approved.has(t.id) || t.prUrl))
    .map((t) => {
      const ready = firstReady.get(t.id);
      return {
        task: t,
        tally: t.loop!.tally,
        size: t.brief?.size ?? "medium",
        spend: spend[t.id] ?? { weighted: 0, usd: 0, unpriced: 0, cacheRead: 0, input: 0 },
        readyMs: ready ? ready - t.createdAt : null,
        finishedAt: approved.get(t.id) ?? t.updatedAt,
      };
    });
}

function measuredLine(t: Tally): string {
  const parts = [t.steers ? `You steered ${plural(t.steers, "time")}` : "No steers"];
  const r = rework(t);
  if (!r) parts.push("no rework");
  else {
    const from = [t.checkFails ? `${t.checkFails} from failing checks` : "", t.reviewRounds ? `${t.reviewRounds} from review` : ""].filter(Boolean).join(", ");
    parts.push(`${plural(r, "rework turn")} (${from})`);
  }
  parts.push(t.lateFails ? `${plural(t.lateFails, "late check failure")}: a check that had passed broke later` : "no late check failures");
  return `${parts.join(" · ")}.`;
}

function costLine(f: Finished, ratio: number | null): string {
  const cost = `${spendText(f.spend)} (${compact(f.spend.weighted)} weighted tokens)`;
  if (ratio === null) return `${cost}. Not enough ${f.size} tasks in this space to compare yet.`;
  const vs = ratio >= 1.25 ? `${ratio.toFixed(1)}× your median` : ratio <= 0.8 ? `${ratio.toFixed(1)}× your median, below it` : "about your median";
  return `${cost}, ${vs} for ${f.size} tasks in this space.`;
}

// The one suggestion: the first rule the numbers meet, most actionable first.
export function suggestion(f: { tally: Tally; size: TaskSize; ratio: number | null; acceptance: number; checked: boolean; shape: ShapeKind | null }): string {
  const { tally: t } = f;
  if (t.checkFails >= 2 && f.acceptance === 0) return `${t.checkFails} rework turns came from failing checks and the brief had no acceptance criteria: add them next time, so the writer knows what has to pass.`;
  if (t.reviewRounds >= 1 && !f.checked) return "The review asked for changes and nothing could check the work: a failing test first would likely have saved a review round.";
  if (t.lateFails >= 1) return "A check that had passed broke later: name it in the acceptance criteria next time, so the writer keeps it passing.";
  if (t.steers >= 2) return `You steered ${t.steers} times: put that direction in the brief's scope or not-in-scope before it starts.`;
  if (f.ratio !== null && f.ratio >= 2 && f.size !== "small" && (f.shape ?? "single") === "single") return `This cost ${f.ratio.toFixed(1)}× your median: it would likely have been cheaper as 2 parts.`;
  if (t.reviewRounds >= 1 && f.acceptance === 0) return "The review asked for changes and the brief had no acceptance criteria: list what done means, so the writer can tell.";
  if (!t.steers && !rework(t) && !t.lateFails) return "A clean run: no steers, rework or late failures. A brief like this one works.";
  return "Nothing stood out: keep briefs this specific.";
}

// Each finished task's retro, by task.
export function retros(db: Database, tasks: Task[]): Record<string, Retro> {
  const all = finished(db, tasks);
  const out: Record<string, Retro> = {};
  for (const f of all) {
    const peers = all.filter((p) => p !== f && p.task.spaceId === f.task.spaceId && p.size === f.size && p.spend.weighted > 0).map((p) => p.spend.weighted);
    const ratio = peers.length >= PEERS_MIN && f.spend.weighted > 0 ? f.spend.weighted / median(peers) : null;
    const tip = suggestion({ tally: f.tally, size: f.size, ratio, acceptance: f.task.brief?.acceptance.length ?? 0, checked: f.task.loop!.checks !== "none", shape: f.task.loop!.shape?.kind ?? null });
    out[f.task.id] = { lines: [measuredLine(f.tally), costLine(f, ratio), `Next time: ${tip}`] };
  }
  return out;
}

const minutes = (ms: number) => `${Math.max(1, Math.round(ms / 60_000))} min`;

function groupLine(label: string, group: Finished[]): string {
  const ready = group.map((f) => f.readyMs).filter((x): x is number => x !== null);
  return `${label} (${group.length}): median ${dollars(median(group.map((f) => f.spend.usd)))} est., ${(group.reduce((n, f) => n + rework(f.tally), 0) / group.length).toFixed(1)} rework turns each${ready.length ? `, ${minutes(median(ready))} to ready` : ""}`;
}

// What paid off this week, in a space or everywhere (`spaceId` null): shapes and how complete the brief was, by
// cost, rework and time to ready. Nothing until the week holds enough finished tasks to say anything.
export function rollup(db: Database, tasks: Task[], spaceId: string | null, now = Date.now()): Rollup | null {
  const week = finished(db, tasks).filter((f) => now - f.finishedAt < WEEK_MS && (spaceId === null || f.task.spaceId === spaceId));
  if (week.length < ROLLUP_MIN) return null;
  const lines = [groupLine("This week", week)];
  const byShape = new Map<ShapeKind, Finished[]>();
  for (const f of week) {
    const k = f.task.loop!.shape?.kind ?? "single";
    byShape.set(k, [...(byShape.get(k) ?? []), f]);
  }
  const shapes = [...byShape].filter(([, g]) => g.length >= 2);
  if (shapes.length >= 2) for (const [k, g] of shapes) lines.push(groupLine(SHAPE_LABEL[k], g));
  const complete = week.filter((f) => (f.task.brief?.acceptance.length ?? 0) > 0 && f.task.loop!.checks !== "none");
  const partial = week.filter((f) => !complete.includes(f));
  if (complete.length >= 2 && partial.length >= 2) {
    lines.push(groupLine("Briefs with acceptance criteria and a check", complete), groupLine("Briefs without", partial));
    const a = complete.reduce((n, f) => n + rework(f.tally), 0) / complete.length;
    const b = partial.reduce((n, f) => n + rework(f.tally), 0) / partial.length;
    if (a < b) lines.push("Complete briefs needed less rework this week.");
    else if (a > b) lines.push("Complete briefs didn't save rework this week.");
  }
  return { tasks: week.length, lines };
}
