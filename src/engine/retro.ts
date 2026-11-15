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

// Peers a cost is compared with, tasks a week needs before the roll-up says anything, and tasks each side of a
// comparison needs before the roll-up draws one.
export const PEERS_MIN = 3;
export const ROLLUP_MIN = 5;
export const SIDE_MIN = 3;
const WEEK_MS = 7 * 86_400_000;

export type Retro = { lines: [string, string, string] };
export type Rollup = { tasks: number; lines: string[] };

type Finished = { task: Task; tally: Tally; size: TaskSize; spend: Spend; readyMs: number | null; finishedAt: number };

const rework = (t: Tally) => t.checkFails + t.reviewRounds;
const meanRework = (g: Finished[]) => g.reduce((n, f) => n + rework(f.tally), 0) / g.length;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

// Coding tasks the user accepted or opened a pull request for, in spaces with learning on: what the retro and the
// roll-up are about. A part or an attempt counts through its parent, and spend leaves out the learning features' own
// calls. A task from before the tally existed has no measured numbers, so it's left out entirely rather than read as
// zeros. Finished is when the user accepted it, or pushed its pull request.
function finished(db: Database, tasks: Task[], on: ReadonlySet<string>): Finished[] {
  const at = (sql: string) => new Map((db.query(sql).all() as { id: string; at: number }[]).map((r) => [r.id, r.at]));
  const approved = at("SELECT task_id AS id, MIN(resolved_at) AS at FROM approvals WHERE kind = 'review' AND status = 'approved' AND task_id IS NOT NULL GROUP BY task_id");
  const pushed = at("SELECT task_id AS id, MIN(resolved_at) AS at FROM approvals WHERE always_ask = 'push' AND status = 'approved' AND task_id IS NOT NULL GROUP BY task_id");
  const firstReady = at("SELECT task_id AS id, MIN(created_at) AS at FROM approvals WHERE kind = 'review' AND task_id IS NOT NULL GROUP BY task_id");
  const spend = workSpend(db);
  const out: Finished[] = [];
  for (const t of tasks) {
    if (t.kind !== "work" || !t.loop?.tally || t.loop.role || !on.has(t.spaceId)) continue;
    const ends = [approved.get(t.id), t.prUrl ? pushed.get(t.id) : undefined].filter((x): x is number => x !== undefined);
    if (!ends.length) continue;
    const ready = firstReady.get(t.id);
    out.push({
      task: t,
      tally: t.loop.tally,
      size: t.brief?.size ?? "medium",
      spend: spend[t.id] ?? { weighted: 0, usd: 0, unpriced: 0, cacheRead: 0, input: 0 },
      readyMs: ready ? ready - t.createdAt : null,
      finishedAt: Math.min(...ends),
    });
  }
  return out.sort((a, b) => a.finishedAt - b.finishedAt);
}

const times = (n: number) => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);

function measuredLine(t: Tally): string {
  const parts = [t.steers ? `You steered ${times(t.steers)}` : "No steers"];
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
  if (!f.spend.weighted) return "No tokens were recorded for this task, so there's no cost to compare.";
  const cost = `${spendText(f.spend)} (${compact(f.spend.weighted)} weighted tokens)`;
  if (ratio === null) return `${cost}. Not enough earlier ${f.size} tasks in this space to compare with yet.`;
  const vs = ratio >= 1.25 ? `${ratio.toFixed(1)}× your median` : ratio <= 0.8 ? `${ratio.toFixed(1)}× your median, below it` : "about your median";
  return `${cost}, ${vs} for earlier ${f.size} tasks in this space.`;
}

// The one suggestion: the first rule the numbers meet, most actionable first.
export function suggestion(f: { tally: Tally; size: TaskSize; ratio: number | null; acceptance: number; checked: boolean; shape: ShapeKind | null }): string {
  const { tally: t } = f;
  if (t.checkFails >= 2 && f.acceptance === 0) return `${t.checkFails} rework turns came from failing checks and the brief had no acceptance criteria: add them next time, so the writer knows what has to pass.`;
  if (t.reviewRounds >= 1 && !f.checked) return "The review asked for changes and nothing could check the work: a failing test first would likely have saved a review round.";
  if (t.lateFails >= 1) return "A check that had passed broke later: name it in the acceptance criteria next time, so the writer keeps it passing.";
  if (t.steers >= 2) return `You steered ${times(t.steers)}: put that direction in the brief's scope or not-in-scope before it starts.`;
  if (f.ratio !== null && f.ratio >= 2 && f.size !== "small" && (f.shape ?? "single") === "single") return `This cost ${f.ratio.toFixed(1)}× your median: it would likely have been cheaper as 2 parts.`;
  if (t.reviewRounds >= 1 && f.acceptance === 0) return "The review asked for changes and the brief had no acceptance criteria: list what done means, so the writer can tell.";
  if (!t.steers && !rework(t) && !t.lateFails) return "Reuse a brief like this one: it needed nothing more from you or the writer.";
  return "Nothing stood out: keep briefs this specific.";
}

const minutes = (ms: number) => `${Math.max(1, Math.round(ms / 60_000))} min`;

function groupLine(label: string, group: Finished[]): string {
  const ready = group.map((f) => f.readyMs).filter((x): x is number => x !== null);
  return `${label} (${group.length}): median ${dollars(median(group.map((f) => f.spend.usd)))} est., ${meanRework(group).toFixed(1)} rework turns each${ready.length ? `, ${minutes(median(ready))} to ready` : ""}`;
}

// What paid off in a week of finished tasks: shapes and how complete the brief was, by cost, rework and time to ready.
// Nothing under five tasks, and a comparison only when each side has three.
function weekRollup(week: Finished[]): Rollup | null {
  if (week.length < ROLLUP_MIN) return null;
  const lines = [groupLine("This week", week)];
  const byShape = new Map<ShapeKind, Finished[]>();
  for (const f of week) {
    const k = f.task.loop!.shape?.kind ?? "single";
    byShape.set(k, [...(byShape.get(k) ?? []), f]);
  }
  const shapes = [...byShape].filter(([, g]) => g.length >= SIDE_MIN);
  if (shapes.length >= 2) for (const [k, g] of shapes) lines.push(groupLine(SHAPE_LABEL[k], g));
  const complete = week.filter((f) => (f.task.brief?.acceptance.length ?? 0) > 0 && f.task.loop!.checks !== "none");
  const partial = week.filter((f) => !complete.includes(f));
  if (complete.length >= SIDE_MIN && partial.length >= SIDE_MIN) {
    lines.push(groupLine("Briefs with acceptance criteria and a check", complete), groupLine("Briefs without", partial));
    // Only a gap of a whole rework turn or more says anything on a week's numbers.
    const gap = meanRework(partial) - meanRework(complete);
    if (gap >= 1) lines.push("Complete briefs needed less rework this week.");
    else if (gap <= -1) lines.push("Complete briefs didn't save rework this week.");
  }
  return { tasks: week.length, lines };
}

// Every finished task's retro, by task, and this week's roll-up by space and for every space with learning on ("all";
// a key is missing until there's enough to say), from one read of the finished tasks. A task's cost is compared only
// with tasks of its size in its space that finished before it, so an old retro doesn't drift.
export function learned(db: Database, tasks: Task[], spaces: readonly { id: string; learning: string }[], now = Date.now()): { retros: Record<string, Retro>; rollups: Record<string, Rollup> } {
  const all = finished(db, tasks, new Set(spaces.filter((s) => s.learning !== "off").map((s) => s.id)));
  const retros: Record<string, Retro> = {};
  // Each space and size's costs so far, kept sorted as the tasks go by in the order they finished.
  const earlier = new Map<string, number[]>();
  for (const f of all) {
    const key = `${f.task.spaceId}\0${f.size}`;
    const before = earlier.get(key) ?? [];
    const mid = before.length >> 1;
    const med = before.length % 2 ? before[mid]! : (before[mid - 1]! + before[mid]!) / 2;
    const ratio = before.length >= PEERS_MIN && f.spend.weighted > 0 ? f.spend.weighted / med : null;
    const tip = suggestion({ tally: f.tally, size: f.size, ratio, acceptance: f.task.brief?.acceptance.length ?? 0, checked: f.task.loop!.checks !== "none", shape: f.task.loop!.shape?.kind ?? null });
    retros[f.task.id] = { lines: [measuredLine(f.tally), costLine(f, ratio), `Next time: ${tip}`] };
    if (f.spend.weighted > 0) {
      let i = 0;
      while (i < before.length && before[i]! <= f.spend.weighted) i++;
      before.splice(i, 0, f.spend.weighted);
      earlier.set(key, before);
    }
  }
  const week = all.filter((f) => now - f.finishedAt < WEEK_MS);
  const rollups: Record<string, Rollup> = {};
  const bySpace = new Map<string, Finished[]>();
  for (const f of week) bySpace.set(f.task.spaceId, [...(bySpace.get(f.task.spaceId) ?? []), f]);
  for (const [id, group] of [["all", week] as const, ...bySpace]) {
    const r = weekRollup(group);
    if (r) rollups[id] = r;
  }
  return { retros, rollups };
}
