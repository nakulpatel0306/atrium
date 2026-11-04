import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter, AgentRunInput, AgentRunResult } from "../../src/engine/agents/types";
import { openDb } from "../../src/engine/db";
import { BadPlan, parseSpacePlan, setupSpace, SetupFailed } from "../../src/engine/setup";
import { listSpaces } from "../../src/engine/spaces";
import { listTasks } from "../../src/engine/tasks";
import { tempHome, tempRepo } from "../helpers";

let home: ReturnType<typeof tempHome>;
let repo: ReturnType<typeof tempRepo>;
let db: Database;

beforeEach(() => {
  home = tempHome();
  repo = tempRepo();
  db = openDb();
});
afterEach(() => {
  db.close();
  repo.cleanup();
  home.cleanup();
});

const fake = (result: AgentRunResult, seen?: AgentRunInput[]): AgentAdapter => ({
  id: "fake",
  label: "Fake",
  run: async (input) => {
    seen?.push(input);
    return result;
  },
});
const ok = (summary: string): AgentRunResult => ({ status: "ok", summary, inputTokens: 1, outputTokens: 1 });

test("parseSpacePlan accepts fenced JSON with prose around it", () => {
  const plan = parseSpacePlan(
    `Here you go:\n\`\`\`json\n{"name":"Docs","kind":"general","goal":"write docs","private":false,"tasks":[{"title":"Outline","weight":"light"}]}\n\`\`\`\nDone.`,
  );
  expect(plan.name).toBe("Docs");
  expect(plan.private).toBe(false);
  expect(plan.tasks).toEqual([{ title: "Outline", weight: "light" }]);
});

test("parseSpacePlan rejects missing name", () => {
  expect(() => parseSpacePlan(`{"kind":"general","goal":"g","private":true,"tasks":[]}`)).toThrow(BadPlan);
});

test("parseSpacePlan rejects nonexistent repoPath", () => {
  const text = `{"name":"X","kind":"repo","goal":"g","repoPath":"/no/such/dir-atrium","private":true,"tasks":[]}`;
  expect(() => parseSpacePlan(text)).toThrow(BadPlan);
});

test("parseSpacePlan rejects bad kind, long name, too many tasks, and no JSON", () => {
  const base = { name: "X", kind: "general", goal: "g", private: true, tasks: [] as unknown[] };
  expect(() => parseSpacePlan(JSON.stringify({ ...base, kind: "other" }))).toThrow(BadPlan);
  expect(() => parseSpacePlan(JSON.stringify({ ...base, name: "x".repeat(41) }))).toThrow(BadPlan);
  const tasks = Array.from({ length: 9 }, () => ({ title: "t", weight: "light" }));
  expect(() => parseSpacePlan(JSON.stringify({ ...base, tasks }))).toThrow(BadPlan);
  expect(() => parseSpacePlan("no json here")).toThrow(BadPlan);
});

test("parseSpacePlan expands ~ in repoPath to an absolute path", () => {
  const plan = parseSpacePlan(`{"name":"H","kind":"repo","goal":"g","repoPath":"~","private":true,"tasks":[]}`);
  expect(plan.repoPath).toBe(homedir());
});

test("setupSpace creates space and tasks from a fake adapter", async () => {
  const seen: AgentRunInput[] = [];
  const plan = {
    name: "Atrium",
    kind: "repo",
    goal: "ship it",
    repoPath: repo.path,
    private: true,
    tasks: [{ title: "Fix lint", detail: "run it", weight: "light" }, { title: "Write docs", weight: "heavy" }],
  };
  const out = await setupSpace(db, fake(ok(JSON.stringify(plan)), seen), "my atrium repo", home.home);
  expect(out.space.name).toBe("Atrium");
  expect(out.space.repoPath).toBe(repo.path);
  expect(out.tasks.map((t) => [t.title, t.weight, t.detail])).toEqual([
    ["Fix lint", "light", "run it"],
    ["Write docs", "heavy", ""],
  ]);
  expect(listTasks(db, { spaceId: out.space.id })).toHaveLength(2);
  expect(seen[0]!.prompt).toContain("my atrium repo");
  expect(seen[0]!.allowedTools).toEqual(["Read", "Glob"]);
  expect(seen[0]!.cwd).toBe(home.home);
});

test("setupSpace cycles the six palette colors by space count", async () => {
  const plan = JSON.stringify({ name: "S", kind: "general", goal: "g", private: true, tasks: [] });
  const colors: string[] = [];
  for (let i = 0; i < 7; i++) colors.push((await setupSpace(db, fake(ok(plan)), "d", home.home)).space.color);
  expect(colors.slice(0, 6)).toEqual(["#7c7cf5", "#4cb782", "#4ea7fc", "#f2c94c", "#b07cf5", "#eb5757"]);
  expect(colors[6]).toBe(colors[0]!);
});

test("malformed agent output creates nothing", async () => {
  const err = await setupSpace(db, fake(ok("sorry, no")), "x", home.home).catch((e) => e);
  expect(err).toBeInstanceOf(SetupFailed);
  expect(err.message).toBe("Couldn't set that up. Try describing it again.");
  expect(listSpaces(db, { includeArchived: true })).toHaveLength(0);
});

test("adapter error creates nothing", async () => {
  const bad: AgentRunResult = { status: "error", kind: "failed", message: "boom" };
  await expect(setupSpace(db, fake(bad), "x", home.home)).rejects.toBeInstanceOf(SetupFailed);
  expect(listSpaces(db, { includeArchived: true })).toHaveLength(0);
});

test("a failure while writing tasks rolls back the space", async () => {
  const plan = JSON.stringify({ name: "S", kind: "general", goal: "g", private: true, tasks: [{ title: "t", weight: "light" }] });
  db.run("CREATE TRIGGER no_tasks BEFORE INSERT ON tasks BEGIN SELECT RAISE(ABORT, 'nope'); END");
  await expect(setupSpace(db, fake(ok(plan)), "x", home.home)).rejects.toBeInstanceOf(SetupFailed);
  expect(listSpaces(db, { includeArchived: true })).toHaveLength(0);
});

test("default cwd is ~/dev-workspace", async () => {
  const seen: AgentRunInput[] = [];
  const plan = JSON.stringify({ name: "S", kind: "general", goal: "g", private: true, tasks: [] });
  await setupSpace(db, fake(ok(plan), seen), "x");
  expect(seen[0]!.cwd).toBe(join(homedir(), "dev-workspace"));
});
