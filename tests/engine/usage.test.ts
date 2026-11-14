import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cacheShare, costOf, priceOf, spendText } from "../../src/engine/cost";
import { openDb } from "../../src/engine/db";
import { deleteTask } from "../../src/engine/delete";
import { createTask, getTask, setTaskLoop } from "../../src/engine/tasks";
import { newLoop, SIZE_BUDGETS } from "../../src/engine/loop";
import { claudeSince, recordUsage, spaceSpend, spendWindows, taskSpend, turnModels } from "../../src/engine/usage";
import { createRegistry } from "../../src/engine/agents/registry";
import { snapshot } from "../../src/engine/state";
import { Database } from "bun:sqlite";
import { createSpace } from "../../src/engine/spaces";
import { tempHome } from "../helpers";
import { fake, loopHarness, ok, waitFor, writer } from "./loop-harness";

const h = loopHarness();
const tokens = (model: string, input: number, output = 0, cacheRead = 0, cacheWrite = 0) => ({ model, inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite });

describe("list prices", () => {
  test("a model is priced by its family's newest matching line, and an alias by the model it stands for", () => {
    expect(priceOf("claude-opus-5-5")).toEqual({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8 });
    expect(priceOf("claude-opus-4-8")!.input).toBe(5);
    expect(priceOf("haiku")).toEqual(priceOf("claude-haiku-5-5"));
    expect(priceOf("claude-sonnet-5-5[1m]")!.input).toBe(2);
    expect(priceOf("gpt-5")).toBeNull();
    expect(priceOf(null)).toBeNull();
  });

  test("a cost counts fresh input, output, cache reads and writes at their own prices", () => {
    // 1M fresh in at $4, 100k out at $20, 2M cache reads at $0.20, 100k cache writes at $5.
    expect(costOf({ inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 2_000_000, cacheWriteTokens: 100_000 }, "claude-opus-5-5")).toBeCloseTo(4 + 2 + 0.4 + 0.5);
    expect(costOf({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, "codex")).toBeNull();
  });

  test("the estimate says when it covers only part of the work, or none of it", () => {
    expect(spendText({ weighted: 0, usd: 0, unpriced: 0, cacheRead: 0, input: 0 })).toBe("nothing yet");
    expect(spendText({ weighted: 100, usd: 1.234, unpriced: 0, cacheRead: 0, input: 100 })).toBe("~$1.23 est.");
    expect(spendText({ weighted: 100, usd: 1, unpriced: 40, cacheRead: 0, input: 100 })).toBe("~$1.00 est. (part of it)");
    expect(spendText({ weighted: 100, usd: 0, unpriced: 100, cacheRead: 0, input: 100 })).toBe("no list price for these agents");
    expect(cacheShare({ weighted: 1, usd: 0, unpriced: 0, cacheRead: 75, input: 100 })).toBe(0.75);
  });
});

describe("the CLI's own cost", () => {
  // The two turns of a real resumed haiku session (Claude Code 2.1.323): its per-model totals as the result message
  // carried them, each with the CLI's costUSD at list prices and its writes in the one-hour cache.
  const first = { model: "claude-haiku-5-5", inputTokens: 4, outputTokens: 371, cacheReadTokens: 36607, cacheWriteTokens: 10506, cacheWrite1hTokens: 10506, costUSD: 0.00265317 };
  const second = { model: "claude-haiku-5-5", inputTokens: 6, outputTokens: 385, cacheReadTokens: 60333, cacheWriteTokens: 10771, cacheWrite1hTokens: 10771, costUSD: 0.00265317 + 0.00029746 };

  test("is used as the estimate when the CLI sends one", () => {
    expect(costOf(first, "claude-haiku-5-5")).toBe(0.00265317);
  });

  test("without it, list prices with one-hour cache writes at 2× land on the CLI's own figure", () => {
    const { costUSD: _, ...tokensOnly } = first;
    expect(costOf(tokensOnly, "claude-haiku-5-5")).toBeCloseTo(0.00265317, 8);
    // Priced as five-minute writes, the same turn would come out a third low.
    expect(costOf({ ...tokensOnly, cacheWrite1hTokens: 0 }, "claude-haiku-5-5")!).toBeLessThan(0.0019);
  });

  test("a resumed turn's cost is what the CLI's running total grew by", () => {
    const [turn] = turnModels([second], [first]);
    expect(turn).toMatchObject({ inputTokens: 2, outputTokens: 14, cacheReadTokens: 23726, cacheWriteTokens: 265, cacheWrite1hTokens: 265 });
    expect(turn!.costUSD).toBeCloseTo(0.00029746, 9);
  });
});

describe("a resumed session's share", () => {
  test("is what each model's running total grew by since the last turn", () => {
    const before = [tokens("claude-sonnet-5-5", 100, 50, 1000, 10)];
    const now = [tokens("claude-sonnet-5-5", 150, 80, 5000, 10), tokens("claude-haiku-5-5", 40, 5)];
    expect(turnModels(now, before)).toEqual([{ ...tokens("claude-sonnet-5-5", 50, 30, 4000, 0), cacheWrite1hTokens: 0 }, tokens("claude-haiku-5-5", 40, 5)]);
  });

  test("counts from zero when a total went down, rather than going negative", () => {
    expect(turnModels([tokens("m", 10, 1)], [tokens("m", 50, 9)])).toEqual([tokens("m", 10, 1)]);
  });
});

describe("the ledger", () => {
  test("each run records its tokens and cost; a task's spend includes its reviews, by the model that did the work", async () => {
    const path = h.repo();
    const s = h.space(path, { reviewBy: "claude" });
    const t = createTask(h.db, { spaceId: s.id, title: "Add totals" });
    const claude = writer(["pass"]);
    const reported = fake("claude", async (input, n) => {
      const r = await claude.adapter.run(input);
      if (r.status !== "ok") return r;
      return n === 1 ? { ...r, models: [tokens("claude-sonnet-5-5", 1000, 200, 9000, 100), tokens("claude-haiku-5-5", 500, 50)] } : { ...r, models: [tokens("claude-opus-5-5", 300, 30)] };
    });
    h.start({ claude: reported.adapter });
    await waitFor(() => h.status(t.id) === "review");
    const rows = h.db.query("SELECT purpose, model, input_tokens AS input FROM usage_log ORDER BY created_at, rowid").all();
    expect(rows).toEqual([
      { purpose: "write", model: "claude-sonnet-5-5", input: 1000 },
      { purpose: "write", model: "claude-haiku-5-5", input: 500 },
      { purpose: "review", model: "claude-opus-5-5", input: 300 },
    ]);
    // The budget counts the subagent's tokens too, since they come from the per-model totals.
    expect(getTask(h.db, t.id)!.loop!.usage.tokens).toBe(1000 + 200 + 900 + 125 + 500 + 50 + 300 + 30);
    const spend = taskSpend(h.db)[t.id]!;
    expect(spend.weighted).toBe(1000 + 200 + 900 + 125 + 500 + 50 + 300 + 30);
    expect(spend.usd).toBeCloseTo(costOf(tokens("claude-sonnet-5-5", 1000, 200, 9000, 100), "claude-sonnet-5-5")! + costOf(tokens("", 500, 50), "claude-haiku-5-5")! + costOf(tokens("", 300, 30), "claude-opus-5-5")!);
    expect(spend.unpriced).toBe(0);
    expect(cacheShare(spend)).toBeCloseTo(9000 / (1000 + 9000 + 100 + 500 + 300));
  });

  test("a run that's stopped still logs what its steps had used", async () => {
    const path = h.repo();
    const s = h.space(path);
    const t = createTask(h.db, { spaceId: s.id, title: "Long job" });
    const claude = fake("claude", (input) =>
      new Promise((resolve) =>
        input.signal!.addEventListener("abort", () =>
          resolve({ status: "error", kind: "failed", message: "Stopped", models: [tokens("claude-haiku-5-5", 3, 8, 9000, 400)] }),
        ),
      ),
    );
    const r = h.start({ claude: claude.adapter });
    await waitFor(() => claude.calls.length === 1);
    expect(await r.stopTask(t.id)).toBe("stopped");
    expect(h.db.query("SELECT purpose, input_tokens AS input, cache_read_tokens AS cached FROM usage_log").all()).toEqual([{ purpose: "write", input: 3, cached: 9000 }]);
  });

  test("an agent with no list price counts its tokens, with the dollars marked as unknown", async () => {
    const path = h.repo();
    const s = h.space(path);
    const t = createTask(h.db, { spaceId: s.id, title: "Add totals" });
    h.start({ claude: fake("claude", () => ok("Done.\nOUTCOME: done", 10)).adapter });
    await waitFor(() => h.status(t.id) === "review");
    // The default tier asks for no model, so the run is known only as Claude's own default.
    expect(taskSpend(h.db)[t.id]).toMatchObject({ weighted: 20, usd: 0, unpriced: 20 });
  });

  test("a space's spend today and this week, and Claude's since a time, come from the same rows", () => {
    const s = h.space(h.repo());
    const t = createTask(h.db, { spaceId: s.id, title: "x" });
    const now = new Date(2026, 10, 13, 15, 0).getTime(); // a Friday afternoon
    const { today, week } = spendWindows(now);
    expect(new Date(week).getDay()).toBe(1);
    recordUsage(h.db, { taskId: t.id, spaceId: s.id, agent: "claude", purpose: "write", models: [tokens("claude-sonnet-5-5", 1000)], at: today + 1 });
    recordUsage(h.db, { taskId: t.id, spaceId: s.id, agent: "claude", purpose: "write", models: [tokens("claude-sonnet-5-5", 4000)], at: week + 1 });
    recordUsage(h.db, { taskId: t.id, spaceId: s.id, agent: "codex", purpose: "review", models: [tokens("", 500)], at: week - 1 });
    expect(spaceSpend(h.db, now)[s.id]).toMatchObject({ today: { weighted: 1000 }, week: { weighted: 5000 } });
    expect(claudeSince(h.db, today).weighted).toBe(1000);
  });

  test("deleting a task takes its usage with it", async () => {
    const s = h.space(h.repo());
    const t = createTask(h.db, { spaceId: s.id, title: "x" });
    setTaskLoop(h.db, t.id, newLoop(SIZE_BUDGETS.small));
    h.db.query("UPDATE tasks SET status = 'done' WHERE id = ?").run(t.id);
    recordUsage(h.db, { taskId: t.id, spaceId: s.id, agent: "claude", purpose: "write", models: [tokens("claude-sonnet-5-5", 1)] });
    await deleteTask(h.db, t.id);
    expect(h.db.query("SELECT COUNT(*) AS n FROM usage_log").get()).toEqual({ n: 0 });
  });
});

test("the plan gauge shows Claude's own reading with when it was taken, and what Atrium ran in that window", () => {
  const s = h.space(h.repo());
  const t = createTask(h.db, { spaceId: s.id, title: "x" });
  const registry = createRegistry(h.db, {});
  const resetsAt = Date.now() + 3600_000;
  registry.recordUsage("claude", { fiveHour: { utilization: 0.42, resetsAt }, sevenDay: { utilization: 0.1, resetsAt: Date.now() + 86_400_000 } });
  // Inside the window, and from before it opened (five hours before it resets).
  recordUsage(h.db, { taskId: t.id, spaceId: s.id, agent: "claude", purpose: "write", models: [tokens("claude-sonnet-5-5", 700)] });
  recordUsage(h.db, { taskId: t.id, spaceId: s.id, agent: "claude", purpose: "write", models: [tokens("claude-sonnet-5-5", 300)], at: resetsAt - 6 * 3600_000 });
  const plan = snapshot(h.db).plan;
  expect(plan.fiveHour).toMatchObject({ utilization: 0.42, resetsAt });
  expect(plan.fiveHour!.seenAt).toBeGreaterThan(Date.now() - 5000);
  expect(plan.sevenDay?.utilization).toBe(0.1);
  expect(plan.atrium.weighted).toBe(700);
  // A fresh install has no reading at all, and says nothing it can't know.
  h.db.query("DELETE FROM settings WHERE key LIKE 'usage.claude.%'").run();
  expect(snapshot(h.db).plan).toMatchObject({ fiveHour: null, sevenDay: null });
});

test("an older database gains the usage ledger: its tasks show no spend, and new runs are logged", () => {
  const t = tempHome();
  const path = join(t.home, "atrium.db");
  // The shape of an install from before the ledger, with a task and a run of its own.
  const old = new Database(path);
  old.exec(`CREATE TABLE spaces (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, goal TEXT NOT NULL DEFAULT '', color TEXT NOT NULL,
    repo_path TEXT, private INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY, space_id TEXT NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'queued', blocked_reason TEXT, agent TEXT NOT NULL, weight TEXT NOT NULL,
    allow_on_battery INTEGER NOT NULL DEFAULT 0, branch TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE runs (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, agent TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER,
    exit_code INTEGER, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, transcript_path TEXT NOT NULL);
  INSERT INTO spaces (id, name, kind, color, created_at, updated_at) VALUES ('spc_old', 'Old', 'repo', '#fff', 1, 1);
  INSERT INTO tasks (id, space_id, title, agent, weight, status, created_at, updated_at) VALUES ('tsk_old', 'spc_old', 'Kept', 'claude', 'heavy', 'done', 1, 1);
  INSERT INTO runs (id, task_id, agent, started_at, input_tokens, output_tokens, transcript_path) VALUES ('run_old', 'tsk_old', 'claude', 1, 10, 20, '/nowhere')`);
  old.close();
  const db = openDb(path);
  expect(taskSpend(db)).toEqual({});
  expect(getTask(db, "tsk_old")?.title).toBe("Kept");
  recordUsage(db, { taskId: "tsk_old", spaceId: "spc_old", agent: "claude", purpose: "write", models: [tokens("claude-sonnet-5-5", 100)] });
  expect(taskSpend(db).tsk_old?.weighted).toBe(100);
  // Jobs are checked in code, not by the table, so a later one needs no rebuild.
  expect(() => recordUsage(db, { taskId: null, spaceId: null, agent: "claude", purpose: "guess" as never, models: [tokens("m", 1)] })).toThrow("Unknown usage purpose");
  db.exec("INSERT INTO usage_log (id, agent, purpose, created_at) VALUES ('use_x', 'claude', 'walkthrough', 1)");
  db.close();
  openDb(path).close();
  t.cleanup();
});

test("a fan-out's parent counts every part or attempt, and each child keeps its own", () => {
  const s = createSpace(h.db, { name: "App", kind: "repo", goal: "", repoPath: "/tmp/x" });
  const parent = createTask(h.db, { spaceId: s.id, title: "Totals" });
  const part = createTask(h.db, { spaceId: s.id, title: "Part", parentTaskId: parent.id });
  const review = createTask(h.db, { spaceId: s.id, title: "Review: Part", kind: "review", parentTaskId: part.id });
  recordUsage(h.db, { taskId: parent.id, spaceId: s.id, agent: "claude", purpose: "judge", models: [tokens("claude-opus-5-5", 10)] });
  recordUsage(h.db, { taskId: part.id, spaceId: s.id, agent: "claude", purpose: "write", models: [tokens("claude-sonnet-5-5", 100)] });
  recordUsage(h.db, { taskId: review.id, spaceId: s.id, agent: "claude", purpose: "review", models: [tokens("claude-opus-5-5", 1000)] });
  const spend = taskSpend(h.db);
  expect(spend[part.id]!.weighted).toBe(1100);
  expect(spend[parent.id]!.weighted).toBe(1110);
});
