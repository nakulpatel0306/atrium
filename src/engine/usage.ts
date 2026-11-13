import type { Database } from "bun:sqlite";
import type { AgentRunResult, ModelTokens } from "./agents/types";
import { costOf, NO_SPEND, type Spend } from "./cost";
import { newId } from "./ids";
import { weightedTokens } from "./loop";

// Every run's tokens, by model and job, so a task, a space and the plan window can each say what they used.
export type Purpose = "brief" | "write" | "scout" | "review" | "explain" | "judge";

const sum = (rows: ModelTokens[]): Omit<ModelTokens, "model"> =>
  rows.reduce(
    (a, r) => ({
      inputTokens: a.inputTokens + r.inputTokens,
      outputTokens: a.outputTokens + r.outputTokens,
      cacheReadTokens: a.cacheReadTokens + r.cacheReadTokens,
      cacheWriteTokens: a.cacheWriteTokens + r.cacheWriteTokens,
    }),
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  );

// A resumed session reports its running totals, earlier turns included, so this turn's share is what grew since
// the totals recorded at the end of the last one. A model that shrank (a CLI that reset its count) counts from zero.
export function turnModels(now: ModelTokens[], before: ModelTokens[] = []): ModelTokens[] {
  const prior = new Map(before.map((m) => [m.model, m]));
  return now
    .map((m): ModelTokens => {
      const p = prior.get(m.model);
      const grew = p && m.inputTokens >= p.inputTokens && m.outputTokens >= p.outputTokens && m.cacheReadTokens >= p.cacheReadTokens && m.cacheWriteTokens >= p.cacheWriteTokens;
      if (!grew) return m;
      // The CLI's cost is a running total too; one that didn't grow with the tokens can't be split, so it's priced.
      const cost = m.costUSD !== undefined && p.costUSD !== undefined && m.costUSD >= p.costUSD ? { costUSD: m.costUSD - p.costUSD } : {};
      return {
        model: m.model,
        inputTokens: m.inputTokens - p.inputTokens,
        outputTokens: m.outputTokens - p.outputTokens,
        cacheReadTokens: m.cacheReadTokens - p.cacheReadTokens,
        cacheWriteTokens: m.cacheWriteTokens - p.cacheWriteTokens,
        cacheWrite1hTokens: Math.max(0, (m.cacheWrite1hTokens ?? 0) - (p.cacheWrite1hTokens ?? 0)),
        ...cost,
      };
    })
    .filter((m) => m.inputTokens + m.outputTokens + m.cacheReadTokens + m.cacheWriteTokens > 0);
}

// One finished run's tokens by model: Claude's per-model totals (subagents included) less what an earlier turn of
// the same session already counted, or the run's own counts under the model it was asked for.
export function runModels(result: Extract<AgentRunResult, { status: "ok" }>, asked: string | null, before?: ModelTokens[]): ModelTokens[] {
  if (result.models) return turnModels(result.models, before);
  const own = {
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    cacheReadTokens: result.cacheReadTokens ?? 0,
    cacheWriteTokens: result.cacheWriteTokens ?? 0,
    cacheWrite1hTokens: result.cacheWrite1hTokens ?? 0,
  };
  return turnModels([{ model: asked ?? "", ...own }]);
}

// The result with its token counts taken from the per-model share, so budgets count what subagents read too.
export function withModels<R extends Extract<AgentRunResult, { status: "ok" }>>(result: R, models: ModelTokens[]): R {
  return { ...result, ...sum(models) };
}

export function recordUsage(db: Database, row: { taskId: string | null; spaceId: string | null; agent: string; purpose: Purpose; models: ModelTokens[]; at?: number }): void {
  const at = row.at ?? Date.now();
  const insert = db.query(
    "INSERT INTO usage_log (id, task_id, space_id, agent, model, purpose, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, weighted, cost_usd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const m of row.models) {
    insert.run(newId("use"), row.taskId, row.spaceId, row.agent, m.model || null, row.purpose, m.inputTokens, m.outputTokens, m.cacheReadTokens, m.cacheWriteTokens, weightedTokens(m), costOf(m, m.model || null), at);
  }
}

type SpendRow = { weighted: number | null; usd: number | null; unpriced: number | null; cache_read: number | null; input: number | null };

const SPEND_COLUMNS = `COALESCE(SUM(weighted), 0) AS weighted, COALESCE(SUM(cost_usd), 0) AS usd,
  COALESCE(SUM(CASE WHEN cost_usd IS NULL THEN weighted ELSE 0 END), 0) AS unpriced,
  COALESCE(SUM(cache_read_tokens), 0) AS cache_read, COALESCE(SUM(input_tokens + cache_read_tokens + cache_write_tokens), 0) AS input`;

const toSpend = (r: SpendRow | null): Spend =>
  r ? { weighted: r.weighted ?? 0, usd: r.usd ?? 0, unpriced: r.unpriced ?? 0, cacheRead: r.cache_read ?? 0, input: r.input ?? 0 } : NO_SPEND;

// Each task's own spend plus its reviews', by task. A split's parts and a best-of-N's attempts keep their own.
export function taskSpend(db: Database): Record<string, Spend> {
  const rows = db
    .query(
      `SELECT COALESCE(CASE WHEN t.kind = 'review' THEN t.parent_task_id END, u.task_id) AS id, ${SPEND_COLUMNS}
       FROM usage_log u JOIN tasks t ON t.id = u.task_id GROUP BY 1`,
    )
    .all() as (SpendRow & { id: string })[];
  return Object.fromEntries(rows.map((r) => [r.id, toSpend(r)]));
}

// Midnight today and the Monday that starts this week, local time.
export function spendWindows(now: number): { today: number; week: number } {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const week = new Date(today);
  week.setDate(week.getDate() - ((week.getDay() + 6) % 7));
  return { today: today.getTime(), week: week.getTime() };
}

// Each space's spend today and this week.
export function spaceSpend(db: Database, now = Date.now()): Record<string, { today: Spend; week: Spend }> {
  const { today, week } = spendWindows(now);
  const q = db.query(`SELECT space_id AS id, ${SPEND_COLUMNS} FROM usage_log WHERE space_id IS NOT NULL AND created_at >= ? GROUP BY space_id`);
  const byDay = new Map((q.all(today) as (SpendRow & { id: string })[]).map((r) => [r.id, toSpend(r)]));
  return Object.fromEntries((q.all(week) as (SpendRow & { id: string })[]).map((r) => [r.id, { today: byDay.get(r.id) ?? NO_SPEND, week: toSpend(r) }]));
}

// Everything Atrium ran through Claude since `since`, for the plan gauge.
export function claudeSince(db: Database, since: number): Spend {
  return toSpend(db.query(`SELECT ${SPEND_COLUMNS} FROM usage_log WHERE agent = 'claude' AND created_at >= ?`).get(since) as SpendRow | null);
}

export function totalSince(db: Database, since: number): Spend {
  return toSpend(db.query(`SELECT ${SPEND_COLUMNS} FROM usage_log WHERE created_at >= ?`).get(since) as SpendRow | null);
}
