import { expect, test } from "bun:test";
import { normalizeBrief } from "../../src/engine/brief";
import { newLoop, NO_TALLY, SIZE_BUDGETS, type Tally } from "../../src/engine/loop";
import { retros, rollup, ROLLUP_MIN, suggestion } from "../../src/engine/retro";
import { snapshot } from "../../src/engine/state";
import { createTask, listTasks, setTaskBrief, setTaskLoop } from "../../src/engine/tasks";
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
  expect(suggestion({ ...base, tally: NO_TALLY, ratio: 2.4, size: "small" })).toStartWith("A clean run");
  expect(suggestion({ ...base, tally: NO_TALLY, ratio: 2.4, shape: "split" })).toStartWith("A clean run");
  expect(suggestion({ ...base, tally: tally({ reviewRounds: 1 }), acceptance: 0 })).toContain("list what done means");
  expect(suggestion({ ...base, tally: tally({ steers: 1 }) })).toBe("Nothing stood out: keep briefs this specific.");
});

// A coding task the user accepted, with its tally, its tokens and the time it took to reach them.
function accepted(spaceId: string, opts: { tokens: number; tally?: Partial<Tally>; acceptance?: string[]; size?: "small" | "medium" | "large"; readyAfterMin?: number; at?: number }) {
  const t = createTask(h.db, { spaceId, title: `Task ${opts.tokens}` });
  setTaskBrief(h.db, t.id, normalizeBrief({ goal: "g", acceptance: opts.acceptance ?? ["works"], size: opts.size ?? "medium" }));
  setTaskLoop(h.db, t.id, { ...newLoop(SIZE_BUDGETS.medium), checks: "passed", tally: tally(opts.tally ?? {}) });
  const at = opts.at ?? Date.now();
  h.db.query("UPDATE tasks SET status = 'done', created_at = ? WHERE id = ?").run(at - (opts.readyAfterMin ?? 10) * 60_000, t.id);
  h.db.query("INSERT INTO approvals (id, space_id, task_id, kind, title, status, created_at, resolved_at) VALUES (?, ?, ?, 'review', 'x', 'approved', ?, ?)").run(`apr_${t.id}`, spaceId, t.id, at, at);
  recordUsage(h.db, { taskId: t.id, spaceId, agent: "claude", purpose: "write", models: [{ model: "claude-sonnet-5-5", inputTokens: opts.tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }] });
  return t;
}

test("a retro is three measured lines, with the cost against the user's median once there are enough similar tasks", () => {
  const s = h.space(h.repo());
  for (const n of [100_000, 120_000, 140_000]) accepted(s.id, { tokens: n });
  const big = accepted(s.id, { tokens: 300_000, tally: { steers: 1, checkFails: 2, reviewRounds: 1, lateFails: 1 } });
  // The learning features' own calls aren't the work's cost.
  recordUsage(h.db, { taskId: big.id, spaceId: s.id, agent: "claude", purpose: "walkthrough", models: [{ model: "claude-haiku-5-5", inputTokens: 900_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }] });
  const r = retros(h.db, listTasks(h.db))[big.id]!;
  expect(r.lines[0]).toBe("You steered 1 time · 3 rework turns (2 from failing checks, 1 from review) · 1 late check failure: a check that had passed broke later.");
  expect(r.lines[1]).toMatch(/^~\$[\d.]+ est\. \(300k weighted tokens\), 2\.5× your median for medium tasks in this space\.$/);
  expect(r.lines[2]).toBe("Next time: A check that had passed broke later: name it in the acceptance criteria next time, so the writer keeps it passing.");
  const first = retros(h.db, listTasks(h.db).filter((t) => t.id !== big.id));
  expect(Object.values(first)[0]!.lines[1]).toContain("Not enough medium tasks in this space to compare yet.");
});

test("only tasks the user accepted or opened a pull request for get a retro; parts and running work don't", () => {
  const s = h.space(h.repo());
  const running = createTask(h.db, { spaceId: s.id, title: "Running" });
  setTaskLoop(h.db, running.id, newLoop(SIZE_BUDGETS.small));
  const pr = createTask(h.db, { spaceId: s.id, title: "PR" });
  setTaskLoop(h.db, pr.id, newLoop(SIZE_BUDGETS.small));
  h.db.query("UPDATE tasks SET pr_url = 'https://example.com/pr/1' WHERE id = ?").run(pr.id);
  const part = createTask(h.db, { spaceId: s.id, title: "Part" });
  setTaskLoop(h.db, part.id, { ...newLoop(SIZE_BUDGETS.small), role: "part" });
  h.db.query("UPDATE tasks SET pr_url = 'https://example.com/pr/2' WHERE id = ?").run(part.id);
  expect(Object.keys(retros(h.db, listTasks(h.db)))).toEqual([pr.id]);
  expect(snapshot(h.db).learning.retros[pr.id]!.lines[0]).toBe("No steers · no rework · no late check failures.");
});

test("the weekly roll-up says nothing under five tasks, then compares shapes and briefs by measured numbers", () => {
  const s = h.space(h.repo());
  for (let i = 0; i < ROLLUP_MIN - 1; i++) accepted(s.id, { tokens: 1000 });
  expect(rollup(h.db, listTasks(h.db), s.id)).toBeNull();
  expect(snapshot(h.db).learning.rollups).toEqual({});
  accepted(s.id, { tokens: 1000, acceptance: [], tally: { checkFails: 2 }, readyAfterMin: 30 });
  accepted(s.id, { tokens: 1000, acceptance: [], tally: { reviewRounds: 1 }, readyAfterMin: 30 });
  // Last month's work isn't this week's.
  accepted(s.id, { tokens: 1000, at: Date.now() - 30 * 86_400_000 });
  const r = rollup(h.db, listTasks(h.db), s.id)!;
  expect(r.tasks).toBe(6);
  expect(r.lines[0]).toMatch(/^This week \(6\): median <?\$[\d.]+ est\., 0\.5 rework turns each, 10 min to ready$/);
  expect(r.lines).toContain("Complete briefs needed less rework this week.");
  expect(r.lines.some((l) => l.startsWith("Briefs with acceptance criteria and a check (4): "))).toBe(true);
  expect(r.lines.some((l) => l.startsWith("Briefs without (2): median ") && l.includes("1.5 rework turns each, 30 min to ready"))).toBe(true);
  const rollups = snapshot(h.db).learning.rollups;
  expect(Object.keys(rollups).sort()).toEqual(["all", s.id].sort());
});
