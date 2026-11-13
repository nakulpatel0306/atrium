import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createApproval, resolveApproval } from "../../src/engine/approvals";
import { briefing, markSeen } from "../../src/engine/briefing";
import { logActivity } from "../../src/engine/events";
import { createRegistry } from "../../src/engine/agents/registry";
import { openDb } from "../../src/engine/db";
import { setUserName } from "../../src/engine/profile";
import { setSetting } from "../../src/engine/settings";
import { createSpace } from "../../src/engine/spaces";
import { snapshot } from "../../src/engine/state";
import { createTask, setTaskOutcome, setTaskStatus } from "../../src/engine/tasks";
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

// What Activity shows as finished: the runner's "Finished:" and "Ready for review:" lines.
function finish(spaceId: string, title: string, line = "Finished") {
  const t = createTask(db, { spaceId, title });
  logActivity(db, spaceId, "claude", `${line}: ${title}`, { taskId: t.id });
  return t;
}

test("counts the tasks Activity shows finished, and the spaces they're in", () => {
  const now = Date.now();
  const a = createSpace(db, { name: "A", kind: "general", goal: "" });
  const b = createSpace(db, { name: "B", kind: "general", goal: "" });
  finish(a.id, "one");
  finish(b.id, "two", "Ready for review");
  createApproval(db, { spaceId: a.id, kind: "question", title: "q", detail: "" });
  expect(briefing(db, now + 1).summary).toBe("Since you were last here: 2 finished across 2 spaces.");
});

test("one space reads without the space count; a task finishing twice counts once", () => {
  const now = Date.now();
  const a = createSpace(db, { name: "A", kind: "general", goal: "" });
  const t = finish(a.id, "one");
  logActivity(db, a.id, "claude", "Finished: one", { taskId: t.id });
  expect(briefing(db, now + 1).summary).toBe("Since you were last here: 1 finished.");
});

test("after a visit, today's finished work is still named instead of a bare nothing", () => {
  const a = createSpace(db, { name: "A", kind: "general", goal: "" });
  finish(a.id, "one");
  finish(a.id, "two");
  const later = Date.now() + 1000;
  markSeen(db, later - 1);
  const d = new Date(later);
  // Right after midnight, earlier lines aren't today's, so the plain line is right.
  const expected = d.getHours() === 0 && d.getMinutes() === 0 ? "Nothing ran since you were last here." : "Nothing new since you were last here. Today: 2 finished.";
  expect(briefing(db, later).summary).toBe(expected);
});

// Live status (needs you, blocked, waiting for power) is composed in the UI so it never goes stale.
test("summary leaves out live status", () => {
  const a = createSpace(db, { name: "A", kind: "general", goal: "" });
  const t = createTask(db, { spaceId: a.id, title: "one" });
  setTaskStatus(db, t.id, "blocked", { blockedReason: "Needs a login" });
  setSetting(db, "runner.waiting", JSON.stringify([{ taskId: t.id, agent: "auto", kind: "power", reason: "on battery" }]));
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
  expect(briefing(db, at(9)).greeting).toBe("Good morning.");
  setUserName(db, "Sam Rivera");
  expect(briefing(db, at(9)).greeting).toBe("Good morning, Sam.");
  expect(briefing(db, at(12)).greeting).toBe("Good afternoon, Sam.");
  expect(briefing(db, at(17)).greeting).toBe("Good afternoon, Sam.");
  expect(briefing(db, at(18)).greeting).toBe("Good evening, Sam.");
  setUserName(db, "");
  process.env.ATRIUM_MAC_NAME = "Priya Patel";
  expect(briefing(db, at(9)).greeting).toBe("Good morning, Priya.");
  process.env.ATRIUM_MAC_NAME = "";
});

test("snapshot defaults and settings-derived power, usage", () => {
  const s0 = snapshot(db);
  expect(s0.power).toEqual({ source: "ac", overnight: false, keepAwake: false });
  expect(s0.waits).toEqual({});
  expect(s0.usage.claudeTokens24h).toBe(0);

  const a = createSpace(db, { name: "A", kind: "general", goal: "" });
  const t = createTask(db, { spaceId: a.id, title: "one" });
  seedRun(t.id, Date.now(), 0, 50);
  seedRun(t.id, Date.now() - 48 * 3600_000, 0, 1000);
  setSetting(db, "power.source", "battery");
  setSetting(db, "power.keepAwake", "true");
  setSetting(db, "overnight", "true");
  setSetting(db, "runner.waiting", JSON.stringify([{ taskId: t.id, agent: "auto", kind: "power", reason: "on battery" }]));
  setSetting(db, "agent.claude.limitedUntil", String(Date.now() + 60_000));
  const s = snapshot(db);
  expect(s.usage.claudeTokens24h).toBe(100);
  expect(s.power.source).toBe("battery");
  expect(s.power.keepAwake).toBe(true);
  expect(s.power.overnight).toBe(true);
  expect(s.waits).toEqual({ [t.id]: { taskId: t.id, agent: "auto", kind: "power", reason: "on battery" } });
  expect(s.power.pausedUntil).toBeGreaterThan(Date.now());

  setSetting(db, "runner.waiting", "[]");
  setSetting(db, "agent.claude.limitedUntil", String(Date.now() - 1));
  const s2 = snapshot(db);
  expect(s2.waits).toEqual({});
  // The single object an older engine left behind reads as no waits until the runner's next pass.
  setSetting(db, "runner.waiting", JSON.stringify({ taskId: t.id, reason: "on battery" }));
  expect(snapshot(db).waits).toEqual({});
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

test("briefing counts rule approvals", () => {
  const now = Date.now();
  const a = createSpace(db, { name: "A", kind: "general", goal: "" });
  db.query("INSERT INTO autonomy_proposals (id, space_id, fingerprint, evidence, status, created_at) VALUES ('prp_b', ?, 'v1:code:docs:small:claude', '[]', 'yes', 1)").run(a.id);
  db.query("INSERT INTO autonomy_rules (id, space_id, fingerprint, proposal_id, created_at, expires_at) VALUES ('rul_b', ?, 'v1:code:docs:small:claude', 'prp_b', 1, ?)").run(a.id, now + 86_400_000);
  markSeen(db, now - 60_000);
  for (const title of ["one", "two", "three"]) {
    const t = createTask(db, { spaceId: a.id, title });
    logActivity(db, a.id, "claude", `Ready for review: ${title}`, { taskId: t.id });
    setTaskStatus(db, t.id, "running");
    setTaskStatus(db, t.id, "review");
    const ap = createApproval(db, { spaceId: a.id, taskId: t.id, kind: "review", title, detail: "" });
    resolveApproval(db, ap.id, "approve", undefined, title === "three" ? undefined : { id: "rul_b", label: "docs" });
  }
  expect(briefing(db, now + 1).summary).toBe("Since you were last here: 3 finished. 2 results approved by your rules.");
});

test("one rule approval reads in the singular, and older ones are left out", () => {
  const now = Date.now();
  const a = createSpace(db, { name: "A", kind: "general", goal: "" });
  db.query("INSERT INTO autonomy_proposals (id, space_id, fingerprint, evidence, status, created_at) VALUES ('prp_b', ?, 'v1:code:docs:small:claude', '[]', 'yes', 1)").run(a.id);
  db.query("INSERT INTO autonomy_rules (id, space_id, fingerprint, proposal_id, created_at, expires_at) VALUES ('rul_b', ?, 'v1:code:docs:small:claude', 'prp_b', 1, ?)").run(a.id, now + 86_400_000);
  for (const title of ["old", "new"]) {
    const t = createTask(db, { spaceId: a.id, title });
    setTaskStatus(db, t.id, "running");
    setTaskStatus(db, t.id, "review");
    const ap = createApproval(db, { spaceId: a.id, taskId: t.id, kind: "review", title, detail: "" });
    resolveApproval(db, ap.id, "approve", undefined, { id: "rul_b", label: "docs" });
    if (title === "old") db.query("UPDATE approvals SET resolved_at = ? WHERE id = ?").run(now - 120_000, ap.id);
  }
  markSeen(db, now - 60_000);
  expect(briefing(db, now).summary).toBe("Nothing ran since you were last here. 1 result approved by your rules.");
});

test("undone rule approvals aren't counted", () => {
  const now = Date.now();
  const a = createSpace(db, { name: "A", kind: "general", goal: "" });
  db.query("INSERT INTO autonomy_proposals (id, space_id, fingerprint, evidence, status, created_at) VALUES ('prp_b', ?, 'v1:code:docs:small:claude', '[]', 'yes', 1)").run(a.id);
  db.query("INSERT INTO autonomy_rules (id, space_id, fingerprint, proposal_id, created_at, expires_at) VALUES ('rul_b', ?, 'v1:code:docs:small:claude', 'prp_b', 1, ?)").run(a.id, now + 86_400_000);
  markSeen(db, now - 60_000);
  for (const title of ["kept", "undone"]) {
    const t = createTask(db, { spaceId: a.id, title });
    setTaskStatus(db, t.id, "running");
    setTaskStatus(db, t.id, "review");
    const ap = createApproval(db, { spaceId: a.id, taskId: t.id, kind: "review", title, detail: "" });
    resolveApproval(db, ap.id, "approve", undefined, { id: "rul_b", label: "docs" });
    if (title === "undone") db.query("UPDATE approvals SET undone_at = ? WHERE id = ?").run(now, ap.id);
  }
  expect(briefing(db, now).summary).toBe("Nothing ran since you were last here. 1 result approved by your rules.");
});

test("the briefing says how many couldn't be done", () => {
  const now = Date.now();
  const a = createSpace(db, { name: "A", kind: "general", goal: "" });
  const one = createTask(db, { spaceId: a.id, title: "one" });
  const two = createTask(db, { spaceId: a.id, title: "two" });
  logActivity(db, a.id, "claude", "Couldn't do: one. No number.", { taskId: one.id });
  logActivity(db, a.id, "claude", "Finished: two", { taskId: two.id });
  setTaskOutcome(db, one.id, "couldnt", "no number.");
  setTaskOutcome(db, two.id, "done", null);
  // A "couldn't" isn't finished work: it's named on its own.
  expect(briefing(db, now + 1).summary).toBe("Since you were last here: 1 finished. 1 couldn't be done; open it to see why.");
  const three = createTask(db, { spaceId: a.id, title: "three" });
  logActivity(db, a.id, "claude", "Couldn't do: three. No file.", { taskId: three.id });
  setTaskOutcome(db, three.id, "couldnt", "no file.");
  expect(briefing(db, now + 1).summary).toBe("Since you were last here: 1 finished. 2 couldn't be done; open them to see why.");
});

test("only couldn't-do results since the last visit don't read as nothing ran", () => {
  const now = Date.now();
  const a = createSpace(db, { name: "A", kind: "general", goal: "" });
  const one = createTask(db, { spaceId: a.id, title: "one" });
  logActivity(db, a.id, "claude", "Couldn't do: one. No number.", { taskId: one.id });
  setTaskOutcome(db, one.id, "couldnt", "no number.");
  expect(briefing(db, now + 1).summary).toBe("1 couldn't be done; open it to see why.");
});
