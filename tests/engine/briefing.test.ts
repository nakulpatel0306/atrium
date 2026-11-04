import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createApproval } from "../../src/engine/approvals";
import { briefing, markSeen } from "../../src/engine/briefing";
import { openDb } from "../../src/engine/db";
import { setSetting } from "../../src/engine/settings";
import { createSpace } from "../../src/engine/spaces";
import { snapshot } from "../../src/engine/state";
import { createTask, setTaskStatus } from "../../src/engine/tasks";
import { tempHome } from "../helpers";

let home: ReturnType<typeof tempHome>;
let db: Database;

beforeEach(() => {
  home = tempHome();
  db = openDb();
});
afterEach(() => {
  db.close();
  home.cleanup();
});

function seedRun(taskId: string, endedAt: number, exitCode = 0, tokens = 0) {
  db.query(
    "INSERT INTO runs (id, task_id, agent, started_at, ended_at, exit_code, input_tokens, output_tokens, transcript_path) VALUES (?, ?, 'claude', ?, ?, ?, ?, ?, '')",
  ).run(`run_${Math.random()}`, taskId, endedAt - 10, endedAt, exitCode, tokens, tokens);
}

test("no runs since last seen says nothing ran", () => {
  const b = briefing(db, Date.now());
  expect(b.summary).toContain("Nothing ran since you were last here.");
  expect(b.summary).not.toContain("finished");
});

test("counts finished runs, spaces, and pending approvals", () => {
  const now = Date.now();
  const a = createSpace(db, { name: "A", kind: "general", goal: "" });
  const b = createSpace(db, { name: "B", kind: "general", goal: "" });
  seedRun(createTask(db, { spaceId: a.id, title: "one" }).id, now - 1000);
  seedRun(createTask(db, { spaceId: b.id, title: "two" }).id, now - 500);
  createApproval(db, { spaceId: a.id, kind: "question", title: "q", detail: "" });
  const { summary } = briefing(db, now);
  expect(summary).toContain("2 tasks finished across 2 spaces");
  expect(summary).toContain("1 thing needs you");
  expect(summary).not.toContain("Nothing ran");
});

test("singular and plural wording, runs before lastSeen ignored", () => {
  const now = Date.now();
  const a = createSpace(db, { name: "A", kind: "general", goal: "" });
  const t = createTask(db, { spaceId: a.id, title: "one" });
  seedRun(t.id, now - 5000);
  seedRun(t.id, now - 1000);
  markSeen(db, now - 2000);
  expect(briefing(db, now).summary).toContain("1 task finished across 1 space.");
  createApproval(db, { spaceId: a.id, kind: "question", title: "q1", detail: "" });
  createApproval(db, { spaceId: a.id, kind: "question", title: "q2", detail: "" });
  expect(briefing(db, now).summary).toContain("2 things need you");
});

test("reports blocked tasks with first reason and heavy work waiting", () => {
  const a = createSpace(db, { name: "A", kind: "general", goal: "" });
  const t = createTask(db, { spaceId: a.id, title: "one" });
  setTaskStatus(db, t.id, "blocked", { blockedReason: "Needs a login" });
  setSetting(db, "runner.waiting", JSON.stringify({ taskId: t.id, reason: "on battery" }));
  const { summary } = briefing(db, Date.now());
  expect(summary).toContain("1 blocked (Needs a login)");
  expect(summary).toContain("Heavy work is waiting for power");
});

test("greeting follows time of day", () => {
  const at = (h: number) => new Date(2026, 10, 4, h, 0).getTime();
  expect(briefing(db, at(9)).greeting).toBe("Good morning, Nakul.");
  expect(briefing(db, at(12)).greeting).toBe("Good afternoon, Nakul.");
  expect(briefing(db, at(17)).greeting).toBe("Good afternoon, Nakul.");
  expect(briefing(db, at(18)).greeting).toBe("Good evening, Nakul.");
});

test("snapshot defaults and settings-derived power, usage", () => {
  const s0 = snapshot(db);
  expect(s0.power).toEqual({ source: "ac", overnight: false, keepAwake: false });
  expect(s0.usage.claudeTokens24h).toBe(0);

  const a = createSpace(db, { name: "A", kind: "general", goal: "" });
  const t = createTask(db, { spaceId: a.id, title: "one" });
  seedRun(t.id, Date.now(), 0, 50);
  seedRun(t.id, Date.now() - 48 * 3600_000, 0, 1000);
  setSetting(db, "power.source", "battery");
  setSetting(db, "power.keepAwake", "true");
  setSetting(db, "overnight", "true");
  setSetting(db, "runner.waiting", JSON.stringify({ taskId: t.id, reason: "on battery" }));
  setSetting(db, "runner.pausedUntil", String(Date.now() + 60_000));
  const s = snapshot(db);
  expect(s.usage.claudeTokens24h).toBe(100);
  expect(s.power.source).toBe("battery");
  expect(s.power.keepAwake).toBe(true);
  expect(s.power.overnight).toBe(true);
  expect(s.power.waiting).toEqual({ taskId: t.id, reason: "on battery" });
  expect(s.power.pausedUntil).toBeGreaterThan(Date.now());

  setSetting(db, "runner.waiting", "");
  setSetting(db, "runner.pausedUntil", String(Date.now() - 1));
  const s2 = snapshot(db);
  expect(s2.power.waiting).toBeUndefined();
  expect(s2.power.pausedUntil).toBeUndefined();
});
