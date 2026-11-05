import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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

const root = () => dirname(repo.path);

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
  expect(() => parseSpacePlan(text, root())).toThrow(BadPlan);
});

const planWith = (repoPath: string) =>
  JSON.stringify({ name: "X", kind: "repo", goal: "g", repoPath, private: true, tasks: [] });

test("parseSpacePlan stores the realpath of a repo inside the projects root", () => {
  expect(parseSpacePlan(planWith(repo.path), root()).repoPath).toBe(realpathSync(repo.path));
});

test("parseSpacePlan rejects a relative repoPath", () => {
  expect(() => parseSpacePlan(planWith(basename(repo.path)), root())).toThrow(/absolute/);
});

test("parseSpacePlan rejects a repo outside the projects root", () => {
  const other = tempRepo();
  try {
    expect(() => parseSpacePlan(planWith(other.path), repo.path)).toThrow(/inside/);
  } finally {
    other.cleanup();
  }
});

test("parseSpacePlan rejects the projects root itself and a file", () => {
  expect(() => parseSpacePlan(planWith(root()), root())).toThrow(BadPlan);
  expect(() => parseSpacePlan(planWith(join(repo.path, "README.md")), root())).toThrow(/folder/);
});

test("parseSpacePlan rejects a folder that is not a git repo", () => {
  const dir = mkdtempSync(join(tmpdir(), "atrium-plain-"));
  try {
    expect(() => parseSpacePlan(planWith(dir), tmpdir())).toThrow(/git/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseSpacePlan rejects a symlink inside the root that points outside it", () => {
  const rootDir = mkdtempSync(join(tmpdir(), "atrium-root-"));
  try {
    writeFileSync(join(rootDir, ".keep"), "");
    mkdirSync(join(rootDir, "sub"));
    symlinkSync(repo.path, join(rootDir, "sub", "link"));
    expect(() => parseSpacePlan(planWith(join(rootDir, "sub", "link")), join(rootDir, "sub"))).toThrow(/inside/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("parseSpacePlan defaults private to true when missing or not a boolean", () => {
  const base = { name: "X", kind: "general", goal: "g", tasks: [] };
  expect(parseSpacePlan(JSON.stringify(base)).private).toBe(true);
  expect(parseSpacePlan(JSON.stringify({ ...base, private: "no" })).private).toBe(true);
  expect(parseSpacePlan(JSON.stringify({ ...base, private: false })).private).toBe(false);
});

test("parseSpacePlan rejects bad kind, long name, too many tasks, and no JSON", () => {
  const base = { name: "X", kind: "general", goal: "g", private: true, tasks: [] as unknown[] };
  expect(() => parseSpacePlan(JSON.stringify({ ...base, kind: "other" }))).toThrow(BadPlan);
  expect(() => parseSpacePlan(JSON.stringify({ ...base, name: "x".repeat(41) }))).toThrow(BadPlan);
  const tasks = Array.from({ length: 9 }, () => ({ title: "t", weight: "light" }));
  expect(() => parseSpacePlan(JSON.stringify({ ...base, tasks }))).toThrow(BadPlan);
  expect(() => parseSpacePlan("no json here")).toThrow(BadPlan);
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
  const out = await setupSpace(db, fake(ok(JSON.stringify(plan)), seen), "my atrium repo", home.home, root());
  expect(out.space.name).toBe("Atrium");
  expect(out.space.repoPath).toBe(realpathSync(repo.path));
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

test("adapter setup problems pass the adapter's plain message through", async () => {
  const cases: Extract<AgentRunResult, { status: "error" }>[] = [
    { status: "error", kind: "not_installed", message: "Claude Code isn't installed or not on PATH" },
    { status: "error", kind: "not_logged_in", message: "Claude Code is logged out. Run `claude` once to log in." },
    { status: "error", kind: "rate_limited", message: "Claude usage limit reached; resets at 3:00 PM", retryAfter: 1 },
  ];
  for (const bad of cases) {
    const err = await setupSpace(db, fake(bad), "x", home.home).catch((e) => e);
    expect(err).toBeInstanceOf(SetupFailed);
    expect(err.message).toBe(bad.message);
  }
  expect(listSpaces(db, { includeArchived: true })).toHaveLength(0);
});

test("a plain agent failure keeps the try-again message", async () => {
  const bad: AgentRunResult = { status: "error", kind: "failed", message: "boom" };
  const err = await setupSpace(db, fake(bad), "x", home.home).catch((e) => e);
  expect(err.message).toBe("Couldn't set that up. Try describing it again.");
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

test("markets plans are accepted", async () => {
  const reply = JSON.stringify({ name: "Stocks", kind: "markets", goal: "watch and paper trade", tasks: [] });
  const { space } = await setupSpace(db, fake(ok(reply)), "watch my stocks", repo.path, root());
  expect(space.kind).toBe("markets");
  expect(space.private).toBe(true);
});
