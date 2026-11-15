import { expect, test } from "bun:test";
import { normalizeBrief } from "../../src/engine/brief";
import { newLoop, NO_TALLY, SIZE_BUDGETS, type Tally } from "../../src/engine/loop";
import { learned, ROLLUP_MIN, suggestion } from "../../src/engine/retro";
import { proposeShape, runNow } from "../../src/engine/shape";
import { snapshot } from "../../src/engine/state";
import { createTask, listTasks, setTaskBrief, setTaskLoop } from "../../src/engine/tasks";
import { listSpaces, updateSpace } from "../../src/engine/spaces";
import { recordUsage } from "../../src/engine/usage";
import { loopHarness } from "./loop-harness";

const h = loopHarness();
const base = { size: "medium" as const, ratio: null, acceptance: 1, checked: true, shape: null };
const tally = (t: Partial<Tally>): Tally => ({ ...NO_TALLY, ...t });

test("the suggestion is the first rule the numbers meet", () => {
  expect(suggestion({ ...base, tally: tally({ checkFails: 2 }), acceptance: 0 })).toStartWith("2 rework turns came from failing checks and the brief had no acceptance criteria");
  expect(suggestion({ ...base, tally: tally({ reviewRounds: 1 }), checked: false })).toContain("a failing test first would likely have saved a review round");
  expect(suggestion({ ...base, tally: tally({ lateFails: 1 }) })).toStartWith("A check that had passed broke later");
  expect(suggestion({ ...base, tally: tally({ steers: 3 }) })).toStartWith("You steered 3 times");
  expect(suggestion({ ...base, tally: NO_TALLY, ratio: 2.4 })).toBe("This cost 2.4× your median: it would likely have been cheaper as 2 parts.");
  // A small task, or one that already ran as parts, isn't told to split.
  expect(suggestion({ ...base, tally: NO_TALLY, ratio: 2.4, size: "small" })).toStartWith("Reuse a brief like this one");
  expect(suggestion({ ...base, tally: NO_TALLY, ratio: 2.4, shape: "split" })).toStartWith("Reuse a brief like this one");
  expect(suggestion({ ...base, tally: tally({ reviewRounds: 1 }), acceptance: 0 })).toContain("list what done means");
  expect(suggestion({ ...base, tally: tally({ steers: 1 }) })).toBe("Nothing stood out: keep briefs this specific.");
});

// A space with learning on, where retros and roll-ups show.
const space = () => updateSpace(h.db, h.space(h.repo()).id, { learning: "light" });
const run = (now = Date.now()) => learned(h.db, listTasks(h.db), listSpaces(h.db), now);
let clock = Date.now() - 3600_000;

// A coding task the user accepted, with its tally, its tokens and the time it took to reach them. Each one finishes a
// minute after the last unless it says when.
function accepted(spaceId: string, opts: { tokens: number; tally?: Partial<Tally>; acceptance?: string[]; size?: "small" | "medium" | "large"; readyAfterMin?: number; at?: number; shape?: "single" | "scouts" }) {
  const t = createTask(h.db, { spaceId, title: `Task ${opts.tokens}` });
  setTaskBrief(h.db, t.id, normalizeBrief({ goal: "g", acceptance: opts.acceptance ?? ["works"], size: opts.size ?? "medium" }));
  const shape = opts.shape === "scouts" ? runNow(proposeShape({ kind: "scouts", reason: "broad reading first", scouts: ["Where is the cart total used?"] }, { size: "medium", checksFound: true })) : null;
  setTaskLoop(h.db, t.id, { ...newLoop(SIZE_BUDGETS.medium), checks: "passed", tally: tally(opts.tally ?? {}), shape });
  const at = opts.at ?? (clock += 60_000);
  h.db.query("UPDATE tasks SET status = 'done', created_at = ? WHERE id = ?").run(at - (opts.readyAfterMin ?? 10) * 60_000, t.id);
  h.db.query("INSERT INTO approvals (id, space_id, task_id, kind, title, status, created_at, resolved_at) VALUES (?, ?, ?, 'review', 'x', 'approved', ?, ?)").run(`apr_${t.id}`, spaceId, t.id, at, at);
  recordUsage(h.db, { taskId: t.id, spaceId, agent: "claude", purpose: "write", models: [{ model: "claude-sonnet-5-5", inputTokens: opts.tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }] });
  return t;
}

test("a retro is three measured lines, with the cost against the median of earlier similar tasks", () => {
  const s = space();
  const first = accepted(s.id, { tokens: 100_000 });
  for (const n of [120_000, 140_000]) accepted(s.id, { tokens: n });
  const big = accepted(s.id, { tokens: 300_000, tally: { steers: 1, checkFails: 2, reviewRounds: 1, lateFails: 1 } });
  // The learning features' own calls aren't the work's cost.
  recordUsage(h.db, { taskId: big.id, spaceId: s.id, agent: "claude", purpose: "walkthrough", models: [{ model: "claude-haiku-5-5", inputTokens: 900_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }] });
  // A task that finished later never moves an earlier one's comparison.
  accepted(s.id, { tokens: 900_000 });
  const r = run().retros[big.id]!;
  expect(r.lines[0]).toBe("You steered once · 3 rework turns (2 from failing checks, 1 from review) · 1 late check failure: a check that had passed broke later.");
  expect(r.lines[1]).toMatch(/^~\$[\d.]+ est\. \(300k weighted tokens\), 2\.5× your median for earlier medium tasks in this space\.$/);
  expect(r.lines[2]).toBe("Next time: A check that had passed broke later: name it in the acceptance criteria next time, so the writer keeps it passing.");
  expect(run().retros[first.id]!.lines[1]).toContain("Not enough earlier medium tasks in this space to compare with yet.");
});

test("the copy counts steers in words, says when no tokens were recorded, and a clean run's tip doesn't repeat its first line", () => {
  const s = space();
  const twice = accepted(s.id, { tokens: 1000, tally: { steers: 2 } });
  const none = accepted(s.id, { tokens: 0 });
  const r = run().retros;
  expect(r[twice.id]!.lines[0]).toStartWith("You steered twice ·");
  expect(r[twice.id]!.lines[2]).toBe("Next time: You steered twice: put that direction in the brief's scope or not-in-scope before it starts.");
  expect(r[none.id]!.lines[1]).toBe("No tokens were recorded for this task, so there's no cost to compare.");
  expect(r[none.id]!.lines[2]).toBe("Next time: Reuse a brief like this one: it needed nothing more from you or the writer.");
});

test("only measured tasks the user accepted or opened a pull request for get a retro; parts, running work and tasks from before the tally don't", () => {
  const s = space();
  const running = createTask(h.db, { spaceId: s.id, title: "Running" });
  setTaskLoop(h.db, running.id, newLoop(SIZE_BUDGETS.small));
  const pr = createTask(h.db, { spaceId: s.id, title: "PR" });
  setTaskLoop(h.db, pr.id, newLoop(SIZE_BUDGETS.small));
  h.db.query("UPDATE tasks SET pr_url = 'https://example.com/pr/1' WHERE id = ?").run(pr.id);
  // The PR's own push yes is when it finished, whatever updates the task afterwards.
  h.db.query("INSERT INTO approvals (id, space_id, task_id, kind, title, status, always_ask, created_at, resolved_at) VALUES ('apr_push', ?, ?, 'question', 'Push?', 'approved', 'push', 5, 5)").run(s.id, pr.id);
  const part = createTask(h.db, { spaceId: s.id, title: "Part" });
  setTaskLoop(h.db, part.id, { ...newLoop(SIZE_BUDGETS.small), role: "part" });
  h.db.query("UPDATE tasks SET pr_url = 'https://example.com/pr/2' WHERE id = ?").run(part.id);
  // Approved before this Atrium counted anything: its loop has no tally, as an older engine stored it.
  const old = createTask(h.db, { spaceId: s.id, title: "Old task" });
  const { tally: _, walkthrough: __, ...stored } = { ...newLoop(SIZE_BUDGETS.medium), stage: "ready" };
  h.db.query("UPDATE tasks SET loop = ?, status = 'done' WHERE id = ?").run(JSON.stringify(stored), old.id);
  h.db.query("INSERT INTO approvals (id, space_id, task_id, kind, title, status, created_at, resolved_at) VALUES ('apr_old', ?, ?, 'review', 'Old', 'approved', 1, 2)").run(s.id, old.id);
  expect(Object.keys(run().retros)).toEqual([pr.id]);
  expect(snapshot(h.db).learning.retros[pr.id]!.lines[0]).toBe("No steers · no rework · no late check failures.");
});

test("learning off hides retros, roll-ups and open CLAUDE.md proposals, and its tasks aren't in Home's roll-up", () => {
  const on = space();
  const off = space();
  for (let i = 0; i < ROLLUP_MIN; i++) accepted(on.id, { tokens: 1000 });
  for (let i = 0; i < ROLLUP_MIN; i++) accepted(off.id, { tokens: 1000 });
  h.db.query("INSERT INTO memory_lines (id, space_id, source, line, created_at) VALUES ('mem_on', ?, 'steer', 'a', 1), ('mem_off', ?, 'steer', 'b', 1)").run(on.id, off.id);
  updateSpace(h.db, off.id, { learning: "off" });
  const l = snapshot(h.db).learning;
  expect(new Set(listTasks(h.db).filter((t) => l.retros[t.id]).map((t) => t.spaceId))).toEqual(new Set([on.id]));
  expect(Object.keys(l.rollups).sort()).toEqual(["all", on.id].sort());
  expect(l.rollups.all!.tasks).toBe(ROLLUP_MIN);
  expect(l.memory.map((m) => m.id)).toEqual(["mem_on"]);
});

test("the weekly roll-up says nothing under five tasks, and compares only with three on each side", () => {
  const s = space();
  for (let i = 0; i < ROLLUP_MIN - 1; i++) accepted(s.id, { tokens: 1000 });
  expect(run().rollups).toEqual({});
  accepted(s.id, { tokens: 1000, acceptance: [], tally: { checkFails: 2 }, readyAfterMin: 30 });
  accepted(s.id, { tokens: 1000, acceptance: [], tally: { reviewRounds: 2 }, readyAfterMin: 30 });
  // Last month's work isn't this week's.
  accepted(s.id, { tokens: 1000, at: Date.now() - 30 * 86_400_000 });
  let r = run().rollups[s.id]!;
  expect(r.tasks).toBe(6);
  expect(r.lines[0]).toMatch(/^This week \(6\): median <?\$[\d.]+ est\., 0\.7 rework turns each, 10 min to ready$/);
  // Two briefs without acceptance criteria is too few to compare.
  expect(r.lines).toHaveLength(1);
  accepted(s.id, { tokens: 1000, acceptance: [], tally: { checkFails: 2 }, readyAfterMin: 30 });
  r = run().rollups[s.id]!;
  expect(r.lines).toContain("Complete briefs needed less rework this week.");
  expect(r.lines.some((l) => l.startsWith("Briefs with acceptance criteria and a check (4): "))).toBe(true);
  expect(r.lines.some((l) => l.startsWith("Briefs without (3): median ") && l.includes("2.0 rework turns each, 30 min to ready"))).toBe(true);
  // One shape only, so no shape lines; with three scouts tasks, each shape gets one.
  expect(r.lines.some((l) => l.startsWith("Single writer"))).toBe(false);
  for (let i = 0; i < 3; i++) accepted(s.id, { tokens: 1000, shape: "scouts" });
  expect(run().rollups[s.id]!.lines.some((l) => l.startsWith("Scouts"))).toBe(true);
});
