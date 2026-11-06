import type { Database } from "bun:sqlite";
import { advancedSpaces } from "./advanced";
import { createApproval, type Approval } from "../approvals";
import { bus, logActivity } from "../events";
import { newId } from "../ids";
import { createTask, listTasks } from "../tasks";
import { agentName } from "../text";
import { etClock, etDate, etInstant, usSession } from "./calendar";
import { instrumentKey, parseInstrumentKey } from "./instrument";
import { money } from "./labels";

export type StrategyInput = {
  name: string;
  rules: string;
  symbols: string[];
  cadence: "open" | "hourly" | "close";
  maxPositionValue: number;
  maxTradesPerDay: number;
};
export type Strategy = StrategyInput & {
  id: string;
  spaceId: string;
  status: "draft" | "active" | "paused" | "rejected";
  approvalId: string | null;
  lastRunAt: number | null;
  createdAt: number;
};

// A slot missed by more than this (engine asleep, lid closed) is skipped rather than run at the wrong time of day.
const LATE_SLOT_MS = 60 * 60_000;
const CADENCE_TEXT: Record<StrategyInput["cadence"], string> = {
  open: "once a day at 9:45 AM ET",
  hourly: "every hour from 10 AM to 3 PM ET",
  close: "once a day at 3:45 PM ET",
};

type Row = {
  id: string;
  space_id: string;
  name: string;
  rules: string;
  symbols: string;
  cadence: StrategyInput["cadence"];
  max_position_value: number;
  max_trades_per_day: number;
  status: Strategy["status"];
  approval_id: string | null;
  last_run_at: number | null;
  last_slot_at: number | null;
  created_at: number;
};

const toStrategy = (r: Row): Strategy => ({
  id: r.id,
  spaceId: r.space_id,
  name: r.name,
  rules: r.rules,
  symbols: JSON.parse(r.symbols) as string[],
  cadence: r.cadence,
  maxPositionValue: r.max_position_value,
  maxTradesPerDay: r.max_trades_per_day,
  status: r.status,
  approvalId: r.approval_id,
  lastRunAt: r.last_run_at,
  createdAt: r.created_at,
});

export const getStrategy = (db: Database, id: string): Strategy | null => {
  const row = db.query("SELECT * FROM market_strategies WHERE id = ?").get(id) as Row | null;
  return row ? toStrategy(row) : null;
};

export function validateStrategy(input: StrategyInput): StrategyInput {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 60) throw new Error("Give the strategy a name of up to 60 characters.");
  const rules = typeof input.rules === "string" ? input.rules.trim() : "";
  if (!rules) throw new Error("Write down the strategy's rules; they're what the agent follows.");
  if (!Array.isArray(input.symbols) || input.symbols.length < 1 || input.symbols.length > 10) throw new Error("A strategy trades 1 to 10 symbols.");
  const symbols = input.symbols.map((s) => {
    const i = typeof s === "string" ? parseInstrumentKey(s) : null;
    if (!i || i.exchange !== "US") throw new Error("Paper strategies trade US stocks only, like AAPL or SPY.");
    return instrumentKey(i);
  });
  if (!["open", "hourly", "close"].includes(input.cadence)) throw new Error("Pick when it runs: at the open, hourly, or near the close.");
  if (!(typeof input.maxPositionValue === "number" && input.maxPositionValue > 0 && input.maxPositionValue <= 10_000_000)) {
    throw new Error("Set a maximum position value above $0.");
  }
  if (!(Number.isInteger(input.maxTradesPerDay) && input.maxTradesPerDay >= 1 && input.maxTradesPerDay <= 50)) {
    throw new Error("Set a daily trade limit from 1 to 50.");
  }
  return { name, rules, symbols: [...new Set(symbols)], cadence: input.cadence, maxPositionValue: input.maxPositionValue, maxTradesPerDay: input.maxTradesPerDay };
}

export function describeLimits(s: StrategyInput): string {
  return `Symbols ${s.symbols.join(", ")} · runs ${CADENCE_TEXT[s.cadence]} · at most ${money(s.maxPositionValue, "USD")} per position · at most ${s.maxTradesPerDay} trades a day`;
}

export function proposeStrategy(db: Database, spaceId: string, input: StrategyInput, by: string, backtestSummary?: string): Strategy {
  const s = validateStrategy(input);
  const id = newId("stg");
  const now = Date.now();
  const detail = [
    `Proposed by ${agentName(by)}.`,
    `Rules: ${s.rules}`,
    describeLimits(s),
    ...(backtestSummary ? [backtestSummary] : []),
    "Runs against the paper account only. Atrium never places real trades.",
  ].join("\n\n");
  db.transaction(() => {
    db.query(
      "INSERT INTO market_strategies (id, space_id, name, rules, symbols, cadence, max_position_value, max_trades_per_day, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)",
    ).run(id, spaceId, s.name, s.rules, JSON.stringify(s.symbols), s.cadence, s.maxPositionValue, s.maxTradesPerDay, now, now);
    const a = createApproval(db, { spaceId, kind: "question", title: `Approve paper strategy: ${s.name}`, detail });
    db.query("UPDATE market_strategies SET approval_id = ? WHERE id = ?").run(a.id, id);
  })();
  logActivity(db, spaceId, by, `Proposed paper strategy "${s.name}"`);
  return getStrategy(db, id)!;
}

export function handleStrategyDecision(db: Database, a: Approval, decision: "approve" | "reject"): void {
  const row = db.query("SELECT * FROM market_strategies WHERE approval_id = ? AND status = 'draft'").get(a.id) as Row | null;
  if (!row) return;
  db.query("UPDATE market_strategies SET status = ?, updated_at = ? WHERE id = ?").run(decision === "approve" ? "active" : "rejected", Date.now(), row.id);
  bus.emit({ type: "changed" });
}

export function setStrategyPaused(db: Database, id: string, paused: boolean): Strategy {
  const cur = getStrategy(db, id);
  if (!cur) throw new Error(`No strategy with id ${id}`);
  const from = paused ? "active" : "paused";
  if (cur.status !== from) throw new Error(paused ? "Only a running strategy can be paused." : "Only a paused strategy can be resumed.");
  db.query("UPDATE market_strategies SET status = ?, updated_at = ? WHERE id = ?").run(paused ? "paused" : "active", Date.now(), id);
  logActivity(db, cur.spaceId, "you", `${paused ? "Paused" : "Resumed"} paper strategy "${cur.name}"`);
  return getStrategy(db, id)!;
}

export function listStrategies(db: Database, spaceId: string): Strategy[] {
  return (db.query("SELECT * FROM market_strategies WHERE space_id = ? ORDER BY created_at, rowid").all(spaceId) as Row[]).map(toStrategy);
}

// Strategies are an Advanced tool: a space with Advanced off keeps its active strategies but runs none.
export function anyStrategyActive(db: Database): boolean {
  const adv = advancedSpaces(db);
  return (db.query("SELECT m.space_id FROM market_strategies m JOIN spaces s ON s.id = m.space_id WHERE m.status = 'active' AND s.status = 'active'").all() as { space_id: string }[]).some((r) => adv.has(r.space_id));
}

export function strategySlots(cadence: StrategyInput["cadence"], date: string, early: boolean): number[] {
  if (cadence === "open") return [etInstant(date, "09:45")];
  if (cadence === "close") return [etInstant(date, early ? "12:45" : "15:45")];
  const last = early ? 12 : 15;
  const out: number[] = [];
  for (let h = 10; h <= last; h++) out.push(etInstant(date, `${String(h).padStart(2, "0")}:00`));
  return out;
}

export function markStrategyRun(db: Database, id: string, at: number): void {
  db.query("UPDATE market_strategies SET last_run_at = ? WHERE id = ?").run(at, id);
}

export function enqueueDueStrategies(db: Database, now: number, kick: () => void): number {
  const session = usSession(now);
  if (!session.open) return 0;
  const rows = db
    .query("SELECT m.* FROM market_strategies m JOIN spaces s ON s.id = m.space_id WHERE m.status = 'active' AND s.status = 'active'")
    .all() as Row[];
  const adv = advancedSpaces(db);
  const busy = new Set(listTasks(db, { status: ["queued", "running"] }).map((t) => t.strategyId).filter(Boolean));
  let n = 0;
  for (const r of rows) {
    if (busy.has(r.id) || !adv.has(r.space_id)) continue;
    const slot = strategySlots(r.cadence, etDate(now), session.earlyClose).filter((t) => t <= now).at(-1);
    if (slot === undefined || now - slot > LATE_SLOT_MS || (r.last_slot_at ?? 0) >= slot) continue;
    const s = toStrategy(r);
    db.query("UPDATE market_strategies SET last_slot_at = ? WHERE id = ?").run(slot, r.id);
    createTask(db, {
      spaceId: r.space_id,
      title: `Paper strategy: ${s.name} (${etClock(slot)})`,
      detail: `Run the approved paper strategy "${s.name}" against current prices and decide whether to place paper orders.\n\nRules: ${s.rules}`,
      agent: "claude",
      weight: "light",
      strategyId: s.id,
    });
    n++;
  }
  if (n) kick();
  return n;
}
