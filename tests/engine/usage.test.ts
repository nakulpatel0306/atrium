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
import { tempHome } from "../helpers";
import { fake, loopHarness, ok, waitFor, writer } from "./loop-harness";

const h = loopHarness();
const tokens = (model: string, input: number, output = 0, cacheRead = 0, cacheWrite = 0) => ({ model, inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite });

describe("list prices", () => {
  test("a model is priced by its family's newest matching line, and an alias by the model it stands for", () => {
    expect(priceOf("claude-opus-5-5")).toEqual({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 });
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

describe("a resumed session's share", () => {
  test("is what each model's running total grew by since the last turn", () => {
    const before = [tokens("claude-sonnet-5-5", 100, 50, 1000, 10)];
    const now = [tokens("claude-sonnet-5-5", 150, 80, 5000, 10), tokens("claude-haiku-5-5", 40, 5)];
    expect(turnModels(now, before)).toEqual([tokens("claude-sonnet-5-5", 50, 30, 4000, 0), tokens("claude-haiku-5-5", 40, 5)]);
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

test("an older database gains the usage ledger, and its tasks show no spend", () => {
  const t = tempHome();
  const path = join(t.home, "atrium.db");
  const first = openDb(path);
  first.exec("INSERT INTO spaces (id, name, kind, color, created_at, updated_at) VALUES ('spc_old', 'Old', 'general', '#fff', 1, 1)");
  first.exec("INSERT INTO tasks (id, space_id, title, agent, weight, created_at, updated_at) VALUES ('tsk_old', 'spc_old', 'Kept', 'auto', 'light', 1, 1)");
  first.exec("DROP TABLE usage_log");
  first.close();
  const db = openDb(path);
  expect(taskSpend(db)).toEqual({});
  expect(getTask(db, "tsk_old")?.title).toBe("Kept");
  db.close();
  t.cleanup();
});
