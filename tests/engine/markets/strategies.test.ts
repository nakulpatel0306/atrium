import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { listPending, onApprovalResolved, resolveApproval } from "../../../src/engine/approvals";
import { openDb } from "../../../src/engine/db";
import { createSpace } from "../../../src/engine/spaces";
import { listTasks, setTaskStatus } from "../../../src/engine/tasks";
import { etInstant } from "../../../src/engine/markets/calendar";
import {
  anyStrategyActive,
  enqueueDueStrategies,
  handleStrategyDecision,
  listStrategies,
  proposeStrategy,
  setStrategyPaused,
  strategySlots,
  type StrategyInput,
} from "../../../src/engine/markets/strategies";
import { setAdvanced } from "../../../src/engine/markets/advanced";
import { tempHome } from "../../helpers";

let home: ReturnType<typeof tempHome>;
let db: Database;
let spaceId: string;
let off: () => void;
const INPUT: StrategyInput = { name: "Momentum", rules: "Buy when above SMA20.", symbols: ["aapl"], cadence: "open", maxPositionValue: 2000, maxTradesPerDay: 3 };

beforeEach(() => {
  home = tempHome();
  db = openDb();
  spaceId = createSpace(db, { name: "Stocks", kind: "markets", goal: "paper" }).id;
  // Plan 7 behaviour under test is Advanced-only; the gates themselves are tested with it off.
  setAdvanced(db, spaceId, true);
  off = onApprovalResolved((a, d) => handleStrategyDecision(db, a, d));
});
afterEach(() => {
  off();
  db.close();
  home.cleanup();
});

test("propose → draft with one approval; approve → active, reject → rejected", () => {
  const s = proposeStrategy(db, spaceId, INPUT, "claude", "Backtest AAPL SMA 20/50 crossover (1Y): 4.2% vs buy-and-hold 9.1%.");
  expect(s.status).toBe("draft");
  expect(s.symbols).toEqual(["AAPL"]);
  const pending = listPending(db);
  expect(pending).toHaveLength(1);
  expect(pending[0]!.title).toBe("Approve paper strategy: Momentum");
  expect(pending[0]!.detail).toContain("Runs against the paper account only. Atrium never places real trades.");
  expect(pending[0]!.detail).toContain("Backtest AAPL");
  expect(anyStrategyActive(db)).toBe(false);
  resolveApproval(db, pending[0]!.id, "approve");
  expect(listStrategies(db, spaceId)[0]!.status).toBe("active");
  expect(anyStrategyActive(db)).toBe(true);
  const t = proposeStrategy(db, spaceId, { ...INPUT, name: "Other" }, "claude");
  resolveApproval(db, t.approvalId!, "reject");
  expect(listStrategies(db, spaceId)[1]!.status).toBe("rejected");
  expect(() => proposeStrategy(db, spaceId, { ...INPUT, symbols: ["SHOP.TO"] }, "claude")).toThrow("Paper strategies trade US stocks only, like AAPL or SPY.");
});

test("slots", () => {
  const at = (hhmm: string, d = "2026-11-27") => etInstant(d, hhmm);
  expect(strategySlots("hourly", "2026-11-27", true)).toEqual([at("10:00"), at("11:00"), at("12:00")]);
  expect(strategySlots("hourly", "2026-11-05", false)).toHaveLength(6);
  expect(strategySlots("open", "2026-11-05", false)).toEqual([at("09:45", "2026-11-05")]);
  expect(strategySlots("close", "2026-11-27", true)).toEqual([at("12:45")]);
  expect(strategySlots("close", "2026-11-05", false)).toEqual([at("15:45", "2026-11-05")]);
});

test("enqueueDueStrategies runs each due slot once, only for active strategies in session", () => {
  const s = proposeStrategy(db, spaceId, INPUT, "claude");
  let kicks = 0;
  const kick = () => void kicks++;
  const at1001 = etInstant("2026-11-05", "10:01");
  expect(enqueueDueStrategies(db, at1001, kick)).toBe(0);
  resolveApproval(db, s.approvalId!, "approve");
  expect(enqueueDueStrategies(db, at1001, kick)).toBe(1);
  expect(kicks).toBe(1);
  const tasks = listTasks(db);
  expect(tasks).toHaveLength(1);
  expect(tasks[0]).toMatchObject({ agent: "claude", weight: "light", strategyId: s.id, title: "Paper strategy: Momentum (9:45 AM ET)" });
  expect(enqueueDueStrategies(db, at1001 + 60_000, kick)).toBe(0);
  setTaskStatus(db, tasks[0]!.id, "running");
  setTaskStatus(db, tasks[0]!.id, "done");
  expect(enqueueDueStrategies(db, at1001 + 120_000, kick)).toBe(0);
  expect(enqueueDueStrategies(db, etInstant("2026-11-06", "09:50"), kick)).toBe(1);
  setStrategyPaused(db, s.id, true);
  expect(enqueueDueStrategies(db, etInstant("2026-11-09", "09:50"), kick)).toBe(0);
  setStrategyPaused(db, s.id, false);
  expect(enqueueDueStrategies(db, etInstant("2026-11-07", "09:50"), kick)).toBe(0);
  expect(enqueueDueStrategies(db, etInstant("2026-11-09", "12:00"), kick)).toBe(0);
});

test("strategies don't enqueue while Advanced is off", () => {
  setAdvanced(db, spaceId, false);
  const s = proposeStrategy(db, spaceId, INPUT, "claude");
  resolveApproval(db, s.approvalId!, "approve");
  const at = etInstant("2026-11-05", "10:01");
  expect(anyStrategyActive(db)).toBe(false);
  expect(enqueueDueStrategies(db, at, () => {})).toBe(0);
  expect(listTasks(db)).toHaveLength(0);
  setAdvanced(db, spaceId, true);
  expect(anyStrategyActive(db)).toBe(true);
  expect(enqueueDueStrategies(db, at, () => {})).toBe(1);
});
