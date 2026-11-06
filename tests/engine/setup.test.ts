import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { AgentAdapter, AgentRunInput, AgentRunResult } from "../../src/engine/agents/types";
import { openDb } from "../../src/engine/db";
import { BadPlan, parseSpacePlan, type SetupResult, setupSpace, SetupFailed } from "../../src/engine/setup";
import { listClones } from "../../src/engine/repos/store";
import { type FakeGitHub, fakeGitHub, seedRemote } from "../repos-helpers";
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

const asSpace = (r: SetupResult) => {
  if (!("space" in r)) throw new Error("expected a space");
  return r;
};
const asDraft = (r: SetupResult) => {
  if (!("draft" in r)) throw new Error("expected a draft");
  return r;
};

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
  const out = asSpace(await setupSpace(db, fake(ok(JSON.stringify(plan)), seen), "my atrium repo", home.home, root()));
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
  for (let i = 0; i < 7; i++) colors.push(asSpace(await setupSpace(db, fake(ok(plan)), "d", home.home)).space.color);
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
    { status: "error", kind: "not_installed", message: "Claude Code isn't installed, or `claude` isn't on your PATH. Install it, then retry." },
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
  const { space } = asSpace(await setupSpace(db, fake(ok(reply)), "watch my stocks", repo.path, root()));
  expect(space.kind).toBe("markets");
  expect(space.private).toBe(true);
});

describe("new projects and GitHub repos", () => {
  let gh: FakeGitHub;
  beforeEach(() => {
    gh = fakeGitHub();
  });
  afterEach(() => gh.cleanup());

  const run = (reply: unknown) => setupSpace(db, fake(ok(JSON.stringify(reply))), "start a new project", home.home, gh.projects);

  test("a new-project reply becomes only a pending draft, with smuggled fields ignored", async () => {
    const out = asDraft(
      await run({ kind: "new_project", name: "My Cool App!", description: "x", visibility: "PUBLIC", template: "../../x", approved: true, path: "/etc" }),
    );
    expect(out.draft.draft).toEqual({ name: "my-cool-app", description: "x", visibility: "private", template: "bun-ts" });
    expect(out.approval.status).toBe("pending");
    expect(out.approval.alwaysAsk).toBe("create_repo");
    expect(listSpaces(db)).toHaveLength(0);
    expect(gh.argv()).toEqual([]);
  });

  test("names that look like flags or paths are normalised", async () => {
    expect(asDraft(await run({ kind: "new_project", name: "--help", description: "x" })).draft.draft!.name).toBe("help");
    expect(asDraft(await run({ kind: "new_project", name: "../evil", description: "x" })).draft.draft!.name).toBe("evil");
    const multi = asDraft(await run({ kind: "new_project", name: "ok", description: `line one\nline two ${"z".repeat(400)}` }));
    expect(multi.draft.draft!.description).toBe("line one");
  });

  test("direction marks and line separators are stripped from a drafted description", async () => {
    const out = asDraft(await run({ kind: "new_project", name: "ok", description: "evil\u202Etxt.exe\u2028more" }));
    expect(out.draft.draft!.description).toBe("eviltxt.exe");
  });

  test("a name with nothing usable fails plainly", async () => {
    const err = await run({ kind: "new_project", name: "✨", description: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(SetupFailed);
    expect(err.message).toBe("Couldn't set that up. Try describing it again.");
  });

  const attach = { kind: "repo", github: "fakeuser/demo", name: "Demo", goal: "g", private: false, tasks: [{ title: "Read it", weight: "light" }] };

  test("an existing GitHub repo becomes a repo space with no local folder yet", async () => {
    seedRemote(gh, "demo");
    const out = asSpace(await run(attach));
    expect(out.space.github).toBe("fakeuser/demo");
    expect(out.space.repoPath).toBeNull();
    expect(out.space.kind).toBe("repo");
    // The repo is private on GitHub, so the space is too.
    expect(out.space.private).toBe(true);
    expect(out.tasks).toHaveLength(1);
  });

  test("a repo GitHub can't find says so", async () => {
    const err = await run(attach).catch((e) => e);
    expect(err).toBeInstanceOf(SetupFailed);
    expect(err.message).toBe("Couldn't find fakeuser/demo on GitHub, or your account can't see it. Check the name.");
    expect(listSpaces(db)).toHaveLength(0);
  });

  test("an existing checkout of that repo is used as is and never recorded as Atrium's", async () => {
    seedRemote(gh, "demo");
    const r = Bun.spawnSync(["git", "clone", "-q", "https://github.com/fakeuser/demo.git", join(gh.projects, "demo")], { env: process.env });
    expect(r.exitCode).toBe(0);
    const out = asSpace(await run(attach));
    expect(out.space.repoPath).toBe(realpathSync(join(gh.projects, "demo")));
    expect(listClones(db)).toEqual([]);
  });
});
