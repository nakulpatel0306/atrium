import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createApproval } from "../../src/engine/approvals";
import { briefing, markSeen } from "../../src/engine/briefing";
import { createRegistry } from "../../src/engine/agents/registry";
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
  expect(briefing(db, Date.now()).summary).toBe("Nothing ran since you were last here.");
});

test("counts finished runs and spaces", () => {
  const now = Date.now();
  const a = createSpace(db, { name: "A", kind: "general", goal: "" });
  const b = createSpace(db, { name: "B", kind: "general", goal: "" });
  seedRun(createTask(db, { spaceId: a.id, title: "one" }).id, now - 1000);
  seedRun(createTask(db, { spaceId: b.id, title: "two" }).id, now - 500);
  createApproval(db, { spaceId: a.id, kind: "question", title: "q", detail: "" });
  expect(briefing(db, now).summary).toBe("2 tasks finished across 2 spaces.");
});

test("singular and plural wording, runs before lastSeen ignored", () => {
  const now = Date.now();
  const a = createSpace(db, { name: "A", kind: "general", goal: "" });
  const t = createTask(db, { spaceId: a.id, title: "one" });
  seedRun(t.id, now - 5000);
  seedRun(t.id, now - 1000);
  markSeen(db, now - 2000);
  expect(briefing(db, now).summary).toBe("1 task finished across 1 space.");
});

// Live status (needs you, blocked, waiting for power) is composed in the UI so it never goes stale.
test("summary leaves out live status", () => {
  const a = createSpace(db, { name: "A", kind: "general", goal: "" });
  const t = createTask(db, { spaceId: a.id, title: "one" });
  setTaskStatus(db, t.id, "blocked", { blockedReason: "Needs a login" });
  setSetting(db, "runner.waiting", JSON.stringify({ taskId: t.id, reason: "on battery" }));
  createApproval(db, { spaceId: a.id, kind: "question", title: "q", detail: "" });
  expect(briefing(db, Date.now()).summary).toBe("Nothing ran since you were last here.");
});

test("runs that all ended without finishing are described, not a bare period", () => {
  const now = Date.now();
  const a = createSpace(db, { name: "A", kind: "general", goal: "" });
  const t = createTask(db, { spaceId: a.id, title: "one" });
  seedRun(t.id, now - 1000, -1);
  expect(briefing(db, now).summary).toBe("1 run ended without finishing since you were last here.");
  seedRun(t.id, now - 500, 1);
  expect(briefing(db, now).summary).toBe("2 runs ended without finishing since you were last here.");
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
  setSetting(db, "agent.claude.limitedUntil", String(Date.now() + 60_000));
  const s = snapshot(db);
  expect(s.usage.claudeTokens24h).toBe(100);
  expect(s.power.source).toBe("battery");
  expect(s.power.keepAwake).toBe(true);
  expect(s.power.overnight).toBe(true);
  expect(s.power.waiting).toEqual({ taskId: t.id, reason: "on battery" });
  expect(s.power.pausedUntil).toBeGreaterThan(Date.now());

  setSetting(db, "runner.waiting", "");
  setSetting(db, "agent.claude.limitedUntil", String(Date.now() - 1));
  const s2 = snapshot(db);
  expect(s2.power.waiting).toBeUndefined();
  expect(s2.power.pausedUntil).toBeUndefined();
});

test("snapshot lists runs newest first, capped at 200", () => {
  const a = createSpace(db, { name: "A", kind: "general", goal: "" });
  const t = createTask(db, { spaceId: a.id, title: "one" });
  const now = Date.now();
  for (let i = 0; i < 205; i++) seedRun(t.id, now - 100_000 + i * 10, 0, i);
  db.query(
    "INSERT INTO runs (id, task_id, agent, started_at, transcript_path) VALUES ('run_live', ?, 'claude', ?, '')",
  ).run(t.id, now);
  const { runs } = snapshot(db);
  expect(runs).toHaveLength(200);
  expect(runs[0]).toEqual({
    id: "run_live",
    taskId: t.id,
    agent: "claude",
    startedAt: now,
    endedAt: null,
    exitCode: null,
    inputTokens: 0,
    outputTokens: 0,
  });
  expect(runs[1]!.inputTokens).toBe(204);
  expect(runs[1]!.outputTokens).toBe(204);
  expect(runs[199]!.inputTokens).toBe(6);
  expect(Object.keys(runs[1]!)).not.toContain("transcriptPath");
});

test("snapshot reports each agent and the open claude window", () => {
  const a = createSpace(db, { name: "A", kind: "general", goal: "" });
  const t = createTask(db, { spaceId: a.id, title: "one" });
  seedRun(t.id, Date.now(), 0, 50);
  const registry = createRegistry(db, {
    claude: { id: "claude", label: "Claude Code", run: async () => ({ status: "error", kind: "failed", message: "" }) },
  });
  expect(snapshot(db).agents).toEqual({});
  expect(snapshot(db, registry).claudeWindow).toBeNull();

  const resetsAt = Date.now() + 60_000;
  registry.recordUsage("claude", { fiveHour: { utilization: 0.6, resetsAt } });
  registry.setLimited("claude", resetsAt);
  const s = snapshot(db, registry);
  expect(s.claudeWindow).toEqual({ utilization: 0.6, resetsAt, reserve: 0.5 });
  expect(s.agents.claude).toEqual({
    label: "Claude Code", installed: true, loggedIn: null, detail: "", limitedUntil: resetsAt, tokensToday: 100,
  });

  registry.recordUsage("claude", { fiveHour: { utilization: 0.6, resetsAt: Date.now() - 1 } });
  expect(snapshot(db, registry).claudeWindow).toBeNull();
});
