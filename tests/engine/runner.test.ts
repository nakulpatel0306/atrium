import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskWait } from "../../src/engine/agents/registry";
import type { AgentAdapter, AgentRunInput, AgentRunResult } from "../../src/engine/agents/types";
import { getApproval, listPending, onApprovalResolved, resolveApproval } from "../../src/engine/approvals";
import { createMarketsHooks } from "../../src/engine/markets/agent";
import { saveQuotes } from "../../src/engine/markets/cache";
import { createMarketData } from "../../src/engine/markets/data";
import { demoProvider } from "../../src/engine/markets/providers/demo";
import { handleStrategyDecision, proposeStrategy } from "../../src/engine/markets/strategies";
import * as rules from "../../src/engine/autonomy/rules";
import { createRule } from "../../src/engine/autonomy/rules";
import { openDb } from "../../src/engine/db";
import * as gitOps from "../../src/engine/git";
import * as scratch from "../../src/engine/scratch";
import * as storage from "../../src/engine/storage";
import { bus, listActivity } from "../../src/engine/events";
import { createRunner, recoverOnBoot } from "../../src/engine/runner";
import { getSetting, setSetting } from "../../src/engine/settings";
import { createSpace, updateSpace } from "../../src/engine/spaces";
import { createTask, getTask, listTasks, setTaskStatus } from "../../src/engine/tasks";
import { tempHome, tempRepo } from "../helpers";

let home: ReturnType<typeof tempHome>;
let db: Database;
let runner: ReturnType<typeof createRunner> | null;
const cleanups: Array<() => void> = [];

beforeEach(() => {
  home = tempHome();
  db = openDb();
  runner = null;
});
afterEach(async () => {
  await runner?.stop();
  db.close();
  home.cleanup();
  while (cleanups.length) cleanups.pop()!();
});

function repo() {
  const r = tempRepo();
  cleanups.push(r.cleanup);
  return r.path;
}

function git(path: string, ...args: string[]) {
  const r = Bun.spawnSync(
    ["git", "-c", "user.name=Atrium Test", "-c", "user.email=test@atrium.local", "-c", "commit.gpgsign=false", ...args],
    { cwd: path },
  );
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
}

function fakeAdapter(impl: (input: AgentRunInput) => Promise<AgentRunResult> | AgentRunResult = () => ok()) {
  const calls: AgentRunInput[] = [];
  const adapter: AgentAdapter = {
    id: "claude",
    label: "Claude Code",
    async run(input) {
      calls.push(input);
      return impl(input);
    },
  };
  return { adapter, calls };
}

const ok = (summary = "Did the thing."): AgentRunResult => ({ status: "ok", summary, inputTokens: 10, outputTokens: 20 });

function fakeKeepAwake() {
  let on = false;
  return {
    starts: 0,
    start() {
      if (!on) this.starts++;
      on = true;
    },
    stop() {
      on = false;
    },
    active: () => on,
  };
}

const waits = () => JSON.parse(getSetting(db, "runner.waiting") || "[]") as TaskWait[];

function start(opts: {
  adapter: AgentAdapter;
  extra?: Record<string, AgentAdapter>;
  power?: () => Promise<"ac" | "battery">;
  keepAwake?: ReturnType<typeof fakeKeepAwake>;
  stopTimeoutMs?: number;
}) {
  runner = createRunner({
    db,
    adapters: { claude: opts.adapter, ...opts.extra },
    power: opts.power ?? (async () => "ac"),
    keepAwake: opts.keepAwake ?? fakeKeepAwake(),
    stopTimeoutMs: opts.stopTimeoutMs,
  });
  runner.start();
  return runner;
}

async function waitFor(cond: () => boolean, ms = 3000) {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error("timed out waiting for condition");
    await Bun.sleep(5);
  }
}

const generalSpace = () => createSpace(db, { name: "Docs", kind: "general", goal: "Write clear docs" });
const repoSpace = (path: string) => createSpace(db, { name: "App", kind: "repo", goal: "Ship the app", repoPath: path });
const status = (id: string) => getTask(db, id)!.status;

test("runs a queued task to review and creates a review approval", async () => {
  const s = generalSpace();
  const t = createTask(db, { spaceId: s.id, title: "Write intro", detail: "Keep it short" });
  const { adapter, calls } = fakeAdapter((input) => {
    input.onChunk("working");
    return ok("Wrote the intro.");
  });
  const chunks: string[] = [];
  const off = bus.on((e) => e.type === "run-output" && chunks.push(e.chunk));
  start({ adapter });
  await waitFor(() => status(t.id) === "review");
  off();

  expect(calls).toHaveLength(1);
  expect(calls[0]!.prompt).toContain("Write intro");
  expect(calls[0]!.prompt).toContain("Keep it short");
  expect(calls[0]!.prompt).toContain("Write clear docs");
  // Away from a repo there's no git to talk about.
  expect(calls[0]!.systemPrompt).toContain("Work in the current folder.");
  expect(calls[0]!.systemPrompt).not.toMatch(/git|branch|commit|push|merge/i);
  expect(calls[0]!.allowedTools).toEqual(["Read", "Edit", "Write", "Glob", "Grep"]);
  expect(calls[0]!.cwd).toBe(join(home.home, "spaces", s.id));
  expect(existsSync(calls[0]!.cwd)).toBe(true);
  expect(chunks).toEqual(["working"]);

  const [a] = listPending(db);
  expect(a).toMatchObject({ kind: "review", title: "Write intro", taskId: t.id, spaceId: s.id });
  expect(a!.detail).toContain("Wrote the intro.");

  const run = db.query("SELECT * FROM runs WHERE task_id = ?").get(t.id) as any;
  expect(run.ended_at).not.toBeNull();
  expect(run.exit_code).toBe(0);
  expect(run.input_tokens).toBe(10);
  expect(run.output_tokens).toBe(20);
  expect(await Bun.file(run.transcript_path).text()).toContain("working");
  expect(listActivity(db, { spaceId: s.id }).some((r) => r.message.includes("Write intro"))).toBe(true);
});

test("repo task runs on atrium/<taskId> branch", async () => {
  const path = repo();
  const s = repoSpace(path);
  const t = createTask(db, { spaceId: s.id, title: "Add file" });
  const { adapter, calls } = fakeAdapter((input) => {
    writeFileSync(join(input.cwd, "new.txt"), "hello\n");
    return ok("Added new.txt.");
  });
  start({ adapter });
  await waitFor(() => status(t.id) === "review");

  const task = getTask(db, t.id)!;
  expect(task.branch).toBe("atrium/" + task.id);
  expect(git(path, "branch", "--list", "atrium/" + task.id)).toContain("atrium/" + task.id);
  expect(git(path, "branch", "--show-current")).toBe("main");
  expect(calls[0]!.cwd).toBe(path);
  expect(calls[0]!.systemPrompt).toContain("Work only on the current git branch.");
  expect(calls[0]!.systemPrompt).toContain("Atrium commits them for you.");
  expect(calls[0]!.allowedTools).toEqual([
    "Read", "Edit", "Write", "Glob", "Grep",
    "Bash(bun test*)", "Bash(bun install --ignore-scripts*)", "Bash(bunx tsc*)",
    "Bash(git status*)", "Bash(git diff*)", "Bash(git log*)",
  ]);
  const [a] = listPending(db);
  expect(a!.detail).toContain("Added new.txt.");
  expect(a!.detail).toContain(`1 commit, 1 file (+1 −0) on atrium/${task.id}`);
  expect(a!.detail.endsWith(`Branch atrium/${task.id} is on your machine — push it when you're ready.`)).toBe(true);
});

test("dirty repo blocks the task without touching files", async () => {
  const path = repo();
  const head = git(path, "rev-parse", "HEAD");
  writeFileSync(join(path, "wip.txt"), "mine");
  const s = repoSpace(path);
  const t = createTask(db, { spaceId: s.id, title: "Refactor" });
  const { adapter, calls } = fakeAdapter();
  start({ adapter });
  await waitFor(() => status(t.id) === "blocked");

  expect(getTask(db, t.id)!.blockedReason).toBe(`You have uncommitted changes in ${path}`);
  expect(calls).toHaveLength(0);
  expect(existsSync(join(path, "wip.txt"))).toBe(true);
  expect(git(path, "rev-parse", "HEAD")).toBe(head);
  expect(git(path, "branch", "--show-current")).toBe("main");
});

test("missing repo folder blocks with the folder reason", async () => {
  const path = repo();
  rmSync(path, { recursive: true, force: true });
  const s = repoSpace(path);
  const t = createTask(db, { spaceId: s.id, title: "Fix" });
  const { adapter, calls } = fakeAdapter();
  start({ adapter });
  await waitFor(() => status(t.id) === "blocked");
  expect(getTask(db, t.id)!.blockedReason).toBe(`Folder not found: ${path}`);
  expect(calls).toHaveLength(0);
});

test("branch summary failure still moves to review and says so", async () => {
  const path = repo();
  const s = repoSpace(path);
  const t = createTask(db, { spaceId: s.id, title: "Rename" });
  const spy = spyOn(gitOps, "branchSummary").mockRejectedValue(new Error("Could not count commits: bad revision"));
  cleanups.push(() => spy.mockRestore());
  start({ adapter: fakeAdapter(() => ok("Renamed things.")).adapter });
  await waitFor(() => status(t.id) === "review");
  const [a] = listPending(db);
  expect(a!.detail).toContain("Renamed things.");
  expect(a!.detail).toContain(`Couldn't summarise the changes on atrium/${t.id}: Could not count commits: bad revision`);
});

test("never pushes the task branch, even with a remote", async () => {
  const path = repo();
  const bare = mkdtempSync(join(tmpdir(), "atrium-bare-"));
  cleanups.push(() => rmSync(bare, { recursive: true, force: true }));
  git(bare, "init", "--bare");
  git(path, "remote", "add", "origin", bare);
  const push = spyOn(gitOps, "pushBranch");
  cleanups.push(() => push.mockRestore());
  const s = repoSpace(path);
  const t = createTask(db, { spaceId: s.id, title: "Ship" });
  start({
    adapter: fakeAdapter((input) => {
      writeFileSync(join(input.cwd, "x.txt"), "x\n");
      return ok();
    }).adapter,
  });
  await waitFor(() => status(t.id) === "review");
  expect(push).not.toHaveBeenCalled();
  expect(git(bare, "branch", "--list", `atrium/${t.id}`)).toBe("");
  expect(listPending(db)[0]!.detail).toContain(`Branch atrium/${t.id} is on your machine — push it when you're ready.`);
  expect(git(path, "branch", "--show-current")).toBe("main");
});

test("an agent rewriting the remote is stopped before anything is pushed", async () => {
  const path = repo();
  const bare = mkdtempSync(join(tmpdir(), "atrium-bare-"));
  const other = mkdtempSync(join(tmpdir(), "atrium-bare-"));
  cleanups.push(() => rmSync(bare, { recursive: true, force: true }), () => rmSync(other, { recursive: true, force: true }));
  git(bare, "init", "--bare");
  git(other, "init", "--bare");
  git(path, "remote", "add", "origin", bare);
  const s = repoSpace(path);
  const t = createTask(db, { spaceId: s.id, title: "Sneaky" });
  start({
    adapter: fakeAdapter((input) => {
      git(input.cwd, "remote", "set-url", "origin", other);
      return ok();
    }).adapter,
  });
  await waitFor(() => status(t.id) === "blocked");
  expect(getTask(db, t.id)!.blockedReason).toStartWith(`The agent changed git settings in ${path}`);
  expect(git(bare, "branch", "--list", `atrium/${t.id}`)).toBe("");
  expect(git(other, "branch", "--list", `atrium/${t.id}`)).toBe("");
});

test("adapter error returns the repo to the starting branch", async () => {
  const path = repo();
  git(path, "checkout", "-b", "feature");
  const s = repoSpace(path);
  const t = createTask(db, { spaceId: s.id, title: "Fail" });
  start({ adapter: fakeAdapter(() => ({ status: "error", kind: "failed", message: "boom" })).adapter });
  await waitFor(() => status(t.id) === "blocked");
  expect(getTask(db, t.id)!.blockedReason).toBe("boom");
  expect(git(path, "branch", "--show-current")).toBe("feature");
});

test("summary counts against the starting branch", async () => {
  const path = repo();
  git(path, "checkout", "-b", "feature");
  writeFileSync(join(path, "f.txt"), "f\n");
  git(path, "add", "f.txt");
  git(path, "commit", "-m", "feature work");
  const s = repoSpace(path);
  const t = createTask(db, { spaceId: s.id, title: "On feature" });
  start({
    adapter: fakeAdapter((input) => {
      writeFileSync(join(input.cwd, "g.txt"), "g\n");
      return ok();
    }).adapter,
  });
  await waitFor(() => status(t.id) === "review");
  expect(listPending(db)[0]!.detail).toContain(`1 commit, 1 file (+1 −0) on atrium/${t.id}`);
  expect(git(path, "branch", "--show-current")).toBe("feature");
});

test("git settings changed by the agent stop the run before switching branches", async () => {
  const path = repo();
  const s = repoSpace(path);
  const t = createTask(db, { spaceId: s.id, title: "Tamper" });
  const push = spyOn(gitOps, "pushBranch");
  const back = spyOn(gitOps, "returnToBranch");
  cleanups.push(() => push.mockRestore(), () => back.mockRestore());
  start({
    adapter: fakeAdapter((input) => {
      appendFileSync(join(input.cwd, ".git", "config"), '[url "x"]\n\tinsteadOf = y\n');
      return ok();
    }).adapter,
  });
  await waitFor(() => status(t.id) === "blocked");
  expect(getTask(db, t.id)!.blockedReason).toBe(
    `The agent changed git settings in ${path} (config, hooks, or attributes). Atrium stopped before switching branches — check them before retrying.`,
  );
  expect(push).not.toHaveBeenCalled();
  expect(back).not.toHaveBeenCalled();
  expect(git(path, "branch", "--show-current")).toBe(`atrium/${t.id}`);
  expect(listPending(db)).toHaveLength(0);
});

test("a leftover Atrium branch blocks instead of stacking", async () => {
  const path = repo();
  git(path, "checkout", "-b", "atrium/tsk_old");
  const s = repoSpace(path);
  const t = createTask(db, { spaceId: s.id, title: "Next" });
  const { adapter, calls } = fakeAdapter();
  start({ adapter });
  await waitFor(() => status(t.id) === "blocked");
  expect(getTask(db, t.id)!.blockedReason).toBe("Repo is on atrium/tsk_old; switch back to your branch first.");
  expect(calls).toHaveLength(0);
  expect(git(path, "branch", "--show-current")).toBe("atrium/tsk_old");
});

test("successful repo run is committed by the engine", async () => {
  const path = repo();
  const s = repoSpace(path);
  const t = createTask(db, { spaceId: s.id, title: "Add greeting" });
  start({
    adapter: fakeAdapter((input) => {
      writeFileSync(join(input.cwd, "greeting.txt"), "hi\n");
      return ok();
    }).adapter,
  });
  await waitFor(() => status(t.id) === "review");
  expect(git(path, "rev-list", "--count", `main..atrium/${t.id}`)).toBe("1");
  expect(git(path, "log", "-1", "--format=%s", `atrium/${t.id}`)).toBe("Add greeting");
  expect(listPending(db)[0]!.detail).toContain("1 commit");
});

test("run with no changes reaches review without a commit", async () => {
  const path = repo();
  const s = repoSpace(path);
  const t = createTask(db, { spaceId: s.id, title: "Look around" });
  start({ adapter: fakeAdapter(() => ok("Nothing to change.")).adapter });
  await waitFor(() => status(t.id) === "review");
  expect(git(path, "rev-list", "--count", `main..atrium/${t.id}`)).toBe("0");
  expect(listPending(db)[0]!.detail).toContain("No file changes");
});

test(".env change blocks the task without a commit", async () => {
  const path = repo();
  // A global ignore file would hide .env.local from git, and the guard only sees what git reports.
  git(path, "config", "core.excludesFile", "/dev/null");
  const s = repoSpace(path);
  const t = createTask(db, { spaceId: s.id, title: "Configure" });
  start({
    adapter: fakeAdapter((input) => {
      writeFileSync(join(input.cwd, ".env.local"), "SECRET=1\n");
      return ok();
    }).adapter,
  });
  await waitFor(() => status(t.id) === "blocked");
  expect(getTask(db, t.id)!.blockedReason).toContain(".env");
  expect(git(path, "rev-list", "--count", `main..atrium/${t.id}`)).toBe("0");
  expect(listPending(db)).toHaveLength(0);
});

test("a run that can't start is blocked once, without spinning", async () => {
  // A file where the transcripts folder should be makes every openTranscript fail.
  rmSync(join(home.home, "transcripts"), { recursive: true, force: true });
  writeFileSync(join(home.home, "transcripts"), "not a folder");
  const s = generalSpace();
  const t = createTask(db, { spaceId: s.id, title: "Doomed" });
  const { adapter, calls } = fakeAdapter();
  let ticks = 0;
  start({
    adapter,
    power: async () => {
      ticks++;
      return "ac";
    },
  });
  await waitFor(() => status(t.id) === "blocked");
  expect(getTask(db, t.id)!.blockedReason).toStartWith("Atrium couldn't start the run:");
  await Bun.sleep(100);
  expect(ticks).toBeLessThanOrEqual(6);
  expect(calls).toHaveLength(0);
  expect(db.query("SELECT COUNT(*) AS n FROM runs").get()).toEqual({ n: 0 });
});

test("a tick that keeps failing does not spin", async () => {
  const s = generalSpace();
  createTask(db, { spaceId: s.id, title: "Any" });
  let ticks = 0;
  let broken = true;
  start({
    adapter: fakeAdapter().adapter,
    power: async () => {
      ticks++;
      // Every settings write in the tick now throws, and report's activity row emits `changed`.
      if (broken) db.exec("DROP TABLE IF EXISTS settings");
      return "ac";
    },
  });
  await Bun.sleep(150);
  expect(ticks).toBeLessThanOrEqual(3);
  expect(listActivity(db).filter((r) => r.message.startsWith("Runner error:")).length).toBeLessThanOrEqual(3);
  broken = false;
  db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
});

test("heavy task waits on battery and stays queued with reason in runner.waiting", async () => {
  const s = generalSpace();
  const t = createTask(db, { spaceId: s.id, title: "Big job", weight: "heavy" });
  const { adapter, calls } = fakeAdapter();
  start({ adapter, power: async () => "battery" });
  await waitFor(() => waits().length > 0);

  expect(waits()).toEqual([
    { taskId: t.id, agent: "auto", kind: "power", reason: "Waiting for power: heavy work runs when plugged in" },
  ]);
  expect(getSetting(db, "power.source")).toBe("battery");
  expect(status(t.id)).toBe("queued");
  expect(calls).toHaveLength(0);
});

test("light task runs on battery while a heavy one waits", async () => {
  const s = generalSpace();
  const heavy = createTask(db, { spaceId: s.id, title: "Big job", weight: "heavy" });
  const light = createTask(db, { spaceId: s.id, title: "Small job", weight: "light" });
  const { adapter } = fakeAdapter();
  start({ adapter, power: async () => "battery" });
  await waitFor(() => status(light.id) === "review");
  expect(status(heavy.id)).toBe("queued");
});

test("waiting on power does not spin the runner", async () => {
  const s = generalSpace();
  createTask(db, { spaceId: s.id, title: "Big job", weight: "heavy" });
  const { adapter, calls } = fakeAdapter();
  let ticks = 0;
  const r = start({
    adapter,
    power: async () => {
      ticks++;
      return "battery";
    },
  });
  await waitFor(() => waits().length > 0);
  for (let i = 0; i < 50; i++) {
    r.kick();
    bus.emit({ type: "changed" });
  }
  await Bun.sleep(100);
  const settled = ticks;
  expect(settled).toBeLessThanOrEqual(6);
  await Bun.sleep(100);
  expect(ticks).toBe(settled);
  expect(calls).toHaveLength(0);
});

test("power check failure is treated as AC", async () => {
  const s = generalSpace();
  const t = createTask(db, { spaceId: s.id, title: "Big job", weight: "heavy" });
  const { adapter } = fakeAdapter();
  start({
    adapter,
    power: async () => {
      throw new Error("pmset missing");
    },
  });
  await waitFor(() => status(t.id) === "review");
  expect(getSetting(db, "power.source")).toBe("ac");
});

test("archived space tasks are not picked", async () => {
  const s = generalSpace();
  const t = createTask(db, { spaceId: s.id, title: "Old" });
  updateSpace(db, s.id, { status: "archived" });
  const { adapter, calls } = fakeAdapter();
  start({ adapter });
  await Bun.sleep(50);
  expect(calls).toHaveLength(0);
  expect(status(t.id)).toBe("queued");
});

test("adapter error blocks task with plain message", async () => {
  const s = generalSpace();
  const t = createTask(db, { spaceId: s.id, title: "Try" });
  const { adapter } = fakeAdapter(() => ({
    status: "error",
    kind: "not_logged_in",
    message: "Claude Code is logged out. Run `claude` once to log in.",
  }));
  start({ adapter });
  await waitFor(() => status(t.id) === "blocked");
  expect(getTask(db, t.id)!.blockedReason).toBe("Claude Code is logged out. Run `claude` once to log in.");
  const run = db.query("SELECT * FROM runs WHERE task_id = ?").get(t.id) as any;
  expect(run.ended_at).not.toBeNull();
  expect(run.exit_code).toBe(1);
});

test("adapter throwing blocks the task and closes the run", async () => {
  const s = generalSpace();
  const t = createTask(db, { spaceId: s.id, title: "Try" });
  const { adapter } = fakeAdapter(() => {
    throw new Error("Invalid allowedTools entry: --x");
  });
  start({ adapter });
  await waitFor(() => status(t.id) === "blocked");
  expect(getTask(db, t.id)!.blockedReason).toContain("Invalid allowedTools entry: --x");
  const run = db.query("SELECT * FROM runs WHERE task_id = ?").get(t.id) as any;
  expect(run.ended_at).not.toBeNull();
  expect(run.exit_code).toBe(1);
});

test("rate limit pauses the runner until retryAfter", async () => {
  const s = generalSpace();
  const first = createTask(db, { spaceId: s.id, title: "One" });
  const second = createTask(db, { spaceId: s.id, title: "Two" });
  const retryAfter = Date.now() + 60 * 60_000;
  const { adapter, calls } = fakeAdapter(() => ({
    status: "error",
    kind: "rate_limited",
    message: "Claude usage limit reached",
    retryAfter,
  }));
  const r = start({ adapter });
  await waitFor(() => getSetting(db, "agent.claude.limitedUntil") !== null);
  r.kick();
  await Bun.sleep(50);

  expect(getSetting(db, "agent.claude.limitedUntil")).toBe(String(retryAfter));
  expect(getSetting(db, "runner.pausedUntil")).toBeNull();
  expect(calls).toHaveLength(1);
  expect(status(first.id)).toBe("queued");
  expect(status(second.id)).toBe("queued");
});

test("runner resumes once limitedUntil has passed", async () => {
  const s = generalSpace();
  const t = createTask(db, { spaceId: s.id, title: "One" });
  setSetting(db, "agent.claude.limitedUntil", String(Date.now() - 1000));
  const { adapter } = fakeAdapter();
  start({ adapter });
  await waitFor(() => status(t.id) === "review");
});

test("a limited codex does not pause claude tasks", async () => {
  const s = createSpace(db, { name: "Docs", kind: "general", goal: "", private: false });
  const viaCodex = createTask(db, { spaceId: s.id, title: "Codex job", agent: "codex" });
  const viaClaude = createTask(db, { spaceId: s.id, title: "Claude job", agent: "claude" });
  setSetting(db, "agent.codex.limitedUntil", String(Date.now() + 3600_000));
  const claude = fakeAdapter();
  const codex = fakeAdapter();
  start({ adapter: claude.adapter, extra: { codex: { ...codex.adapter, id: "codex", label: "Codex" } } });
  await waitFor(() => status(viaClaude.id) === "review");
  expect(status(viaCodex.id)).toBe("queued");
  expect(codex.calls).toHaveLength(0);
});

test("a review task runs its agent in review mode", async () => {
  const s = generalSpace();
  const review = createTask(db, { spaceId: s.id, title: "Review it", kind: "review" });
  const work = createTask(db, { spaceId: s.id, title: "Do it" });
  const { adapter, calls } = fakeAdapter();
  start({ adapter });
  await waitFor(() => status(review.id) === "done" && status(work.id) === "review");
  expect(calls.map((c) => [c.prompt.includes("Review it"), c.mode])).toEqual([[true, "review"], [false, "work"]]);
  expect(calls[0]!.systemPrompt).toContain("You are reviewing another agent's work");
  // Reviews read the diff in their prompt, so Claude gets no edit tools for them.
  expect(calls[0]!.allowedTools).toEqual(["Read", "Glob", "Grep"]);
});

test("a general-space codex run uses a fresh scratch folder that is removed afterwards", async () => {
  const s = createSpace(db, { name: "Docs", kind: "general", goal: "", private: false });
  const t = createTask(db, { spaceId: s.id, title: "Codex job", agent: "codex" });
  let seen = "";
  const codex = fakeAdapter((input) => {
    seen = input.cwd;
    expect(existsSync(input.cwd)).toBe(true);
    return ok();
  });
  start({ adapter: fakeAdapter().adapter, extra: { codex: { ...codex.adapter, id: "codex", label: "Codex" } } });
  await waitFor(() => status(t.id) === "review");
  expect(seen).not.toBe(join(home.home, "spaces", s.id));
  expect(existsSync(seen)).toBe(false);
  expect(codex.calls[0]!.systemPrompt).toContain("This folder is temporary");
  expect(codex.calls[0]!.systemPrompt).not.toMatch(/git|branch|commit/i);
});

test("files a scratch run leaves are kept with the run, and the approval says where", async () => {
  const s = createSpace(db, { name: "Docs", kind: "general", goal: "", private: false });
  const t = createTask(db, { spaceId: s.id, title: "Write notes", agent: "codex" });
  const codex = fakeAdapter((input) => {
    writeFileSync(join(input.cwd, "notes.md"), "# notes\n");
    mkdirSync(join(input.cwd, "sub"));
    writeFileSync(join(input.cwd, "sub", "more.txt"), "more\n");
    symlinkSync("/etc/hosts", join(input.cwd, "link"));
    return ok("Wrote notes.");
  });
  start({ adapter: fakeAdapter().adapter, extra: { codex: { ...codex.adapter, id: "codex", label: "Codex" } } });
  await waitFor(() => status(t.id) === "review");
  const run = db.query("SELECT id FROM runs WHERE task_id = ?").get(t.id) as { id: string };
  const kept = join(home.home, "spaces", s.id, "runs", run.id);
  expect(readFileSync(join(kept, "notes.md"), "utf8")).toBe("# notes\n");
  expect(readFileSync(join(kept, "sub", "more.txt"), "utf8")).toBe("more\n");
  expect(existsSync(join(kept, "link"))).toBe(false);
  expect(listPending(db)[0]!.detail).toContain(
    `Files it left are kept in ${kept}. Left out 1 item that was a link or changed while being copied.`,
  );
});

test("launch re-checks the agent and holds a task the space no longer allows", async () => {
  const path = repo();
  const s = createSpace(db, { name: "App", kind: "repo", goal: "", repoPath: path, private: false });
  const t = createTask(db, { spaceId: s.id, title: "Codex job", agent: "codex" });
  const codex = fakeAdapter();
  const real = gitOps.prepareBranch;
  let flipped = false;
  // The space turns private while git is busy, after the queue check passed.
  const spy = spyOn(gitOps, "prepareBranch").mockImplementation(async (...args) => {
    flipped = true;
    updateSpace(db, s.id, { private: true });
    return real(...args);
  });
  try {
    start({ adapter: fakeAdapter().adapter, extra: { codex: { ...codex.adapter, id: "codex", label: "Codex" } } });
    await waitFor(() => waits().length > 0);
  } finally {
    spy.mockRestore();
  }
  expect(flipped).toBe(true);
  expect(codex.calls).toHaveLength(0);
  expect(status(t.id)).toBe("queued");
  expect(git(path, "branch", "--show-current")).toBe("main");
  expect(waits()).toEqual([
    {
      taskId: t.id,
      agent: "codex",
      kind: "private_space",
      reason: "Codex can't work here: this space is private, so only Claude works in it.",
    },
  ]);
});

test("run row records the resolved agent for auto tasks", async () => {
  const s = generalSpace();
  const t = createTask(db, { spaceId: s.id, title: "Auto job", agent: "auto" });
  start({ adapter: fakeAdapter().adapter });
  await waitFor(() => status(t.id) === "review");
  expect((db.query("SELECT agent FROM runs WHERE task_id = ?").get(t.id) as any).agent).toBe("claude");
  expect(getTask(db, t.id)!.agent).toBe("auto");
});

test("a task the registry holds back shows its reason as the waiting line", async () => {
  const s = createSpace(db, { name: "Notes", kind: "general", goal: "", private: true });
  const t = createTask(db, { spaceId: s.id, title: "Secret job", agent: "codex" });
  const codex = fakeAdapter();
  const r = start({ adapter: fakeAdapter().adapter, extra: { codex: { ...codex.adapter, id: "codex", label: "Codex" } } });
  r.kick();
  await waitFor(() => waits().length > 0);
  expect(waits()).toEqual([
    {
      taskId: t.id,
      agent: "codex",
      kind: "private_space",
      reason: "Codex can't work here: this space is private, so only Claude works in it.",
    },
  ]);
  expect(status(t.id)).toBe("queued");
  expect(codex.calls).toHaveLength(0);
});

test("a run that reports usage feeds the claude reserve", async () => {
  const s = generalSpace();
  const t = createTask(db, { spaceId: s.id, title: "Usage job" });
  const resetsAt = Date.now() + 3600_000;
  const { adapter } = fakeAdapter(() => ({ ...ok(), usage: { fiveHour: { utilization: 0.7, resetsAt } } }));
  const r = start({ adapter });
  await waitFor(() => status(t.id) === "review");
  expect(r.registry.inReserve()).toEqual({ until: resetsAt });
});

test("legacy runner.pausedUntil migrates to agent.claude.limitedUntil", async () => {
  const s = generalSpace();
  const t = createTask(db, { spaceId: s.id, title: "Waits" });
  const until = Date.now() + 3600_000;
  setSetting(db, "runner.pausedUntil", String(until));
  const { adapter, calls } = fakeAdapter();
  const r = start({ adapter });
  await waitFor(() => getSetting(db, "agent.claude.limitedUntil") !== null);
  r.kick();
  await Bun.sleep(50);
  expect(getSetting(db, "agent.claude.limitedUntil")).toBe(String(until));
  expect(getSetting(db, "runner.pausedUntil")).toBeNull();
  expect(calls).toHaveLength(0);
  expect(status(t.id)).toBe("queued");
});

test("recoverOnBoot requeues running tasks", async () => {
  const s = generalSpace();
  const t = createTask(db, { spaceId: s.id, title: "Interrupted" });
  const idle = createTask(db, { spaceId: s.id, title: "Idle" });
  setTaskStatus(db, t.id, "running");
  db.query("INSERT INTO runs (id, task_id, agent, started_at, transcript_path) VALUES (?, ?, ?, ?, ?)").run(
    "run_1",
    t.id,
    "claude",
    Date.now(),
    "/tmp/x.log",
  );

  expect(await recoverOnBoot(db)).toBe(1);
  expect(status(t.id)).toBe("queued");
  expect(status(idle.id)).toBe("queued");
  const run = db.query("SELECT * FROM runs WHERE id = 'run_1'").get() as any;
  expect(run.exit_code).toBe(-1);
  expect(run.ended_at).not.toBeNull();
  expect(listActivity(db).map((r) => r.message)).toContain("Engine restarted; requeued Interrupted");
});

test("overnight mode starts keep-awake on AC with work and stops when queue empties", async () => {
  setSetting(db, "overnight", "true");
  const s = generalSpace();
  const t = createTask(db, { spaceId: s.id, title: "Night job" });
  let finish!: () => void;
  const gate = new Promise<void>((r) => (finish = r));
  const { adapter } = fakeAdapter(async () => {
    await gate;
    return ok();
  });
  const ka = fakeKeepAwake();
  start({ adapter, keepAwake: ka });
  await waitFor(() => status(t.id) === "running");
  await waitFor(() => ka.active());
  expect(getSetting(db, "power.keepAwake")).toBe("true");

  finish();
  await waitFor(() => status(t.id) === "review");
  await waitFor(() => !ka.active());
  await waitFor(() => getSetting(db, "power.keepAwake") === "false");
});

test("overnight mode does not keep awake on battery", async () => {
  setSetting(db, "overnight", "true");
  const s = generalSpace();
  createTask(db, { spaceId: s.id, title: "Big job", weight: "heavy" });
  const { adapter } = fakeAdapter();
  const ka = fakeKeepAwake();
  start({ adapter, keepAwake: ka, power: async () => "battery" });
  await waitFor(() => getSetting(db, "power.keepAwake") !== null);
  expect(ka.starts).toBe(0);
  expect(getSetting(db, "power.keepAwake")).toBe("false");
});

test("concurrent kicks never run a task twice", async () => {
  const s = generalSpace();
  const t = createTask(db, { spaceId: s.id, title: "Once" });
  let finish!: () => void;
  const gate = new Promise<void>((r) => (finish = r));
  const { adapter, calls } = fakeAdapter(async () => {
    await gate;
    return ok();
  });
  const r = start({ adapter });
  for (let i = 0; i < 20; i++) r.kick();
  await waitFor(() => status(t.id) === "running");
  for (let i = 0; i < 20; i++) r.kick();
  await Bun.sleep(30);
  finish();
  await waitFor(() => status(t.id) === "review");
  expect(calls).toHaveLength(1);
});

test("an outcome for a task moved off running mid-run is discarded", async () => {
  const s = generalSpace();
  const t = createTask(db, { spaceId: s.id, title: "Moved away" });
  const { adapter } = fakeAdapter(() => {
    setTaskStatus(db, t.id, "queued");
    setTaskStatus(db, t.id, "blocked", { blockedReason: "held" });
    return ok();
  });
  start({ adapter });
  await waitFor(() => listActivity(db).some((r) => r.message.startsWith("Discarded")));
  await Bun.sleep(20);
  expect(getTask(db, t.id)).toMatchObject({ status: "blocked", blockedReason: "held" });
  expect(listPending(db)).toHaveLength(0);
  const run = db.query("SELECT * FROM runs WHERE task_id = ?").get(t.id) as any;
  expect(run.ended_at).not.toBeNull();
  expect(run.exit_code).toBe(0);
  const messages = listActivity(db).map((r) => r.message);
  expect(messages.filter((m) => m.startsWith("Discarded"))).toEqual([
    "Discarded the result for Moved away: the task was moved while it ran.",
  ]);
  expect(messages.some((m) => m.startsWith("Runner error:"))).toBe(false);
});

// Resolves when the run is aborted, the way the Claude adapter does after killing its child.
const untilAborted = (input: AgentRunInput) =>
  new Promise<AgentRunResult>((resolve) =>
    input.signal!.addEventListener("abort", () => resolve({ status: "error", kind: "failed", message: "Stopped" })),
  );

test("stop aborts a running task, requeues it, and puts the repo back", async () => {
  const path = repo();
  git(path, "checkout", "-b", "feature");
  const s = repoSpace(path);
  const t = createTask(db, { spaceId: s.id, title: "Long job" });
  let aborted = false;
  const r = start({
    adapter: fakeAdapter(async (input) => {
      const res = await untilAborted(input);
      aborted = true;
      return res;
    }).adapter,
  });
  await waitFor(() => status(t.id) === "running");
  const started = Date.now();
  await r.stop();
  runner = null;
  expect(Date.now() - started).toBeLessThan(2000);
  expect(aborted).toBe(true);
  expect(status(t.id)).toBe("queued");
  expect(git(path, "branch", "--show-current")).toBe("feature");
  expect(listActivity(db).map((a) => a.message)).toContain("Engine stopped; requeued Long job");
  expect(listActivity(db).some((a) => a.message.startsWith("Blocked"))).toBe(false);
});

test("stop gives up waiting on a run that ignores the abort", async () => {
  const s = generalSpace();
  const t = createTask(db, { spaceId: s.id, title: "Stubborn" });
  let finish!: () => void;
  const gate = new Promise<void>((res) => (finish = res));
  const r = start({
    adapter: fakeAdapter(async () => {
      await gate;
      return ok();
    }).adapter,
    stopTimeoutMs: 200,
  });
  await waitFor(() => status(t.id) === "running");
  const started = Date.now();
  await r.stop();
  runner = null;
  expect(Date.now() - started).toBeLessThan(1500);
  finish();
  await Bun.sleep(30);
});

test("a repo run records the branch it started from and its git settings", async () => {
  const path = repo();
  git(path, "checkout", "-b", "feature");
  const before = await gitOps.gitSettingsFingerprint(path);
  const s = repoSpace(path);
  const t = createTask(db, { spaceId: s.id, title: "Record" });
  start({ adapter: fakeAdapter().adapter });
  await waitFor(() => status(t.id) === "review");
  expect(db.query("SELECT start_ref, git_fingerprint FROM runs WHERE task_id = ?").get(t.id)).toEqual({
    start_ref: "feature",
    git_fingerprint: before,
  });
});

const tampered = (path: string) =>
  `The agent changed git settings in ${path} (config, hooks, or attributes). Atrium stopped before switching branches — check them before retrying.`;

// Mirrors what launch records: the starting branch and the git settings as they were before the run.
async function crashedRun(path: string, startRef: string, opts: { fingerprint?: boolean } = {}) {
  const fingerprint = opts.fingerprint === false ? null : await gitOps.gitSettingsFingerprint(path);
  const s = repoSpace(path);
  const t = createTask(db, { spaceId: s.id, title: "Crashed" });
  git(path, "checkout", "-b", `atrium/${t.id}`);
  writeFileSync(join(path, "early.txt"), "early\n");
  git(path, "add", "early.txt");
  git(path, "commit", "-m", "early agent work");
  db.query(
    "INSERT INTO runs (id, task_id, agent, started_at, transcript_path, start_ref, git_fingerprint) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run("run_crashed", t.id, "claude", Date.now(), "/tmp/x.log", startRef, fingerprint);
  return t;
}

test("recoverOnBoot puts a repo left on the task branch back on its starting branch", async () => {
  const path = repo();
  git(path, "checkout", "-b", "feature");
  const t = await crashedRun(path, "feature");
  setTaskStatus(db, t.id, "running");
  expect(await recoverOnBoot(db)).toBe(1);
  expect(status(t.id)).toBe("queued");
  expect(git(path, "branch", "--show-current")).toBe("feature");
});

test("a task whose repo is still on its own branch resumes from the stored start", async () => {
  const path = repo();
  git(path, "checkout", "-b", "feature");
  const t = await crashedRun(path, "feature");
  start({
    adapter: fakeAdapter((input) => {
      writeFileSync(join(input.cwd, "late.txt"), "late\n");
      return ok();
    }).adapter,
  });
  await waitFor(() => status(t.id) === "review");
  expect(listPending(db)[0]!.detail).toContain(`2 commits, 2 files (+2 −0) on atrium/${t.id}`);
  expect(git(path, "branch", "--show-current")).toBe("feature");
});

test("agent leftovers on the task's own branch block with the agent message", async () => {
  const path = repo();
  git(path, "checkout", "-b", "feature");
  const t = await crashedRun(path, "feature");
  writeFileSync(join(path, "half.txt"), "wip");
  const { adapter, calls } = fakeAdapter();
  start({ adapter });
  await waitFor(() => status(t.id) === "blocked");
  expect(getTask(db, t.id)!.blockedReason).toBe(
    `The agent left uncommitted changes on atrium/${t.id} in ${path}. Commit or stash them on that branch, switch back to feature, then retry.`,
  );
  expect(calls).toHaveLength(0);
});

test("a task that keeps hitting the usage limit is blocked after three tries", async () => {
  const s = generalSpace();
  const t = createTask(db, { spaceId: s.id, title: "Limited" });
  // A reset time already past lets the runner retry straight away.
  const { adapter, calls } = fakeAdapter(() => ({
    status: "error",
    kind: "rate_limited",
    message: "Claude usage limit reached",
    retryAfter: Date.now() - 1000,
  }));
  start({ adapter });
  await waitFor(() => status(t.id) === "blocked");
  expect(calls).toHaveLength(3);
  expect(getTask(db, t.id)!.blockedReason).toBe(
    "Claude kept reporting a usage limit for this task; retry when you're ready.",
  );
});

test("a run that ends another way resets the usage-limit count", async () => {
  const s = generalSpace();
  const t = createTask(db, { spaceId: s.id, title: "Flaky" });
  const outcomes: AgentRunResult[] = [
    { status: "error", kind: "rate_limited", message: "limit", retryAfter: Date.now() - 1000 },
    { status: "error", kind: "rate_limited", message: "limit", retryAfter: Date.now() - 1000 },
    ok(),
  ];
  const { adapter, calls } = fakeAdapter(() => outcomes.shift()!);
  start({ adapter });
  await waitFor(() => status(t.id) === "review");
  expect(calls).toHaveLength(3);
});

test("a transcript write failure doesn't fail the run", async () => {
  const s = generalSpace();
  const t = createTask(db, { spaceId: s.id, title: "Disk full" });
  const spy = spyOn(storage, "openTranscript").mockReturnValue({
    path: join(home.home, "unwritable.log"),
    append() {
      throw new Error("ENOSPC: no space left on device");
    },
    close() {},
  });
  cleanups.push(() => spy.mockRestore());
  start({
    adapter: fakeAdapter((input) => {
      input.onChunk("still working");
      return ok("Finished anyway.");
    }).adapter,
  });
  await waitFor(() => status(t.id) === "review");
  expect(listPending(db)[0]!.detail).toContain("Finished anyway.");
});

test("recoverOnBoot leaves a tampered repo on the task branch and blocks the task", async () => {
  const path = repo();
  git(path, "checkout", "-b", "feature");
  const t = await crashedRun(path, "feature");
  setTaskStatus(db, t.id, "running");
  appendFileSync(join(path, ".git", "config"), '[core]\n\tpager = "touch /tmp/pwned"\n');
  const back = spyOn(gitOps, "returnToBranch");
  cleanups.push(() => back.mockRestore());
  expect(await recoverOnBoot(db)).toBe(1);
  expect(getTask(db, t.id)).toMatchObject({ status: "blocked", blockedReason: tampered(path) });
  expect(back).not.toHaveBeenCalled();
  expect(git(path, "branch", "--show-current")).toBe(`atrium/${t.id}`);
});

test("recoverOnBoot blocks when the crashed run has no stored git settings", async () => {
  const path = repo();
  git(path, "checkout", "-b", "feature");
  const t = await crashedRun(path, "feature", { fingerprint: false });
  setTaskStatus(db, t.id, "running");
  expect(await recoverOnBoot(db)).toBe(1);
  expect(getTask(db, t.id)).toMatchObject({ status: "blocked", blockedReason: tampered(path) });
  expect(git(path, "branch", "--show-current")).toBe(`atrium/${t.id}`);
});

test("a resume on a tampered task branch is blocked instead of run", async () => {
  const path = repo();
  git(path, "checkout", "-b", "feature");
  const t = await crashedRun(path, "feature");
  appendFileSync(join(path, ".git", "config"), '[url "x"]\n\tinsteadOf = y\n');
  const { adapter, calls } = fakeAdapter();
  start({ adapter });
  await waitFor(() => status(t.id) === "blocked");
  expect(getTask(db, t.id)!.blockedReason).toBe(tampered(path));
  expect(calls).toHaveLength(0);
  expect(git(path, "branch", "--show-current")).toBe(`atrium/${t.id}`);
});

test("a resume without stored git settings is blocked", async () => {
  const path = repo();
  git(path, "checkout", "-b", "feature");
  const t = await crashedRun(path, "feature", { fingerprint: false });
  const { adapter, calls } = fakeAdapter();
  start({ adapter });
  await waitFor(() => status(t.id) === "blocked");
  expect(getTask(db, t.id)!.blockedReason).toBe(tampered(path));
  expect(calls).toHaveLength(0);
});

test("every held-back task gets its own wait, with the kind the dashboard shows", async () => {
  const path = repo();
  writeFileSync(join(path, ".env"), "X=1\n");
  const secretRepo = createSpace(db, { name: "App", kind: "repo", goal: "", repoPath: path, private: false });
  const open = createSpace(db, { name: "Docs", kind: "general", goal: "", private: false });
  const busyRepo = createSpace(db, { name: "Busy", kind: "repo", goal: "", repoPath: repo(), private: false });
  const resetsAt = Date.now() + 3600_000;
  setSetting(db, "usage.claude.fiveHour", JSON.stringify({ utilization: 0.9, resetsAt }));
  const limit = Date.now() + 600_000;
  setSetting(db, "agent.codex.limitedUntil", String(limit));
  // Repo work on auto goes to Claude, so the reserve holds it.
  const auto = createTask(db, { spaceId: busyRepo.id, title: "Auto repo job", agent: "auto" });
  const secret = createTask(db, { spaceId: secretRepo.id, title: "Codex in a repo with .env", agent: "codex" });
  const limited = createTask(db, { spaceId: open.id, title: "Limited codex", agent: "codex" });
  const signedOut = createTask(db, { spaceId: open.id, title: "Signed-out gemini", agent: "gemini" });
  const codex = fakeAdapter();
  const gemini: AgentAdapter = {
    ...fakeAdapter().adapter,
    id: "gemini",
    label: "Gemini",
    probe: async () => ({ installed: true, loggedIn: false, detail: "Run `agy` once in a terminal to sign in." }),
  };
  start({ adapter: fakeAdapter().adapter, extra: { codex: { ...codex.adapter, id: "codex", label: "Codex" }, gemini } });
  await waitFor(() => waits().length === 4);

  const byTask = Object.fromEntries(waits().map((w) => [w.taskId, w]));
  expect(byTask[auto.id]).toMatchObject({ agent: "claude", kind: "reserve", until: resetsAt });
  expect(byTask[secret.id]).toMatchObject({ agent: "codex", kind: "env_files" });
  expect(byTask[limited.id]).toMatchObject({ agent: "codex", kind: "limited", until: limit });
  expect(byTask[signedOut.id]).toMatchObject({
    agent: "gemini",
    kind: "signed_out",
    reason: "Gemini is signed out. Run `agy` once in a terminal to sign in.",
  });
  expect(codex.calls).toHaveLength(0);
});

test("a task queued behind a running one waits as busy", async () => {
  const s = generalSpace();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { adapter } = fakeAdapter(async () => {
    await gate;
    return ok();
  });
  const first = createTask(db, { spaceId: s.id, title: "First", weight: "light" });
  const second = createTask(db, { spaceId: s.id, title: "Second", weight: "light" });
  start({ adapter });
  await waitFor(() => status(first.id) === "running" && waits().length === 1);
  expect(waits()).toEqual([
    { taskId: second.id, agent: "claude", kind: "busy", reason: "Waiting for the task already running in this space to finish." },
  ]);
  release();
  await waitFor(() => status(second.id) === "review");
  await waitFor(() => waits().length === 0);
});

const clean = (path: string) => git(path, "status", "--porcelain") === "";
const subject = (path: string, ref: string) => git(path, "log", "-1", "--format=%s", ref);

test("a repo run that hits the usage limit saves its edits as a WIP commit and resumes on that branch", async () => {
  const path = repo();
  const s = repoSpace(path);
  const t = createTask(db, { spaceId: s.id, title: "Half done" });
  const resetsAt = Date.now() + 3600_000;
  const outcomes: Array<(input: AgentRunInput) => AgentRunResult> = [
    (input) => {
      writeFileSync(join(input.cwd, "a.txt"), "a\n");
      return {
        status: "error",
        kind: "rate_limited",
        message: "Claude usage limit reached",
        retryAfter: Date.now() + 3600_000,
        usage: { fiveHour: { utilization: 1, resetsAt } },
      };
    },
    (input) => {
      writeFileSync(join(input.cwd, "b.txt"), "b\n");
      return ok();
    },
  ];
  const r = start({ adapter: fakeAdapter((input) => outcomes.shift()!(input)).adapter });
  await waitFor(() => getSetting(db, "agent.claude.limitedUntil") !== null && status(t.id) === "queued");
  expect(git(path, "branch", "--show-current")).toBe("main");
  expect(clean(path)).toBe(true);
  expect(subject(path, `atrium/${t.id}`)).toBe("WIP (stopped): Half done");
  expect(git(path, "show", `atrium/${t.id}:a.txt`)).toBe("a");
  // Usage carried on the error result still feeds the reserve.
  expect(r.registry.inReserve()).toEqual({ until: resetsAt });

  setSetting(db, "agent.claude.limitedUntil", String(Date.now() - 1000));
  setSetting(db, "usage.claude.fiveHour", JSON.stringify({ utilization: 0, resetsAt }));
  r.kick();
  await waitFor(() => status(t.id) === "review");
  expect(listPending(db)[0]!.detail).toContain(`2 commits, 2 files (+2 −0) on atrium/${t.id}`);
});

test("stopping the engine mid-run saves the agent's edits on its branch and requeues", async () => {
  const path = repo();
  git(path, "checkout", "-b", "feature");
  const s = repoSpace(path);
  const t = createTask(db, { spaceId: s.id, title: "Long edit" });
  const r = start({
    adapter: fakeAdapter(async (input) => {
      writeFileSync(join(input.cwd, "partial.txt"), "partial\n");
      return untilAborted(input);
    }).adapter,
  });
  await waitFor(() => status(t.id) === "running");
  await Bun.sleep(20);
  await r.stop();
  runner = null;
  expect(status(t.id)).toBe("queued");
  expect(git(path, "branch", "--show-current")).toBe("feature");
  expect(clean(path)).toBe(true);
  expect(subject(path, `atrium/${t.id}`)).toBe("WIP (stopped): Long edit");
  expect(listActivity(db).some((a) => a.message.startsWith("Blocked"))).toBe(false);
});

test("a failed repo run saves its edits, puts the repo back, and says how to carry on", async () => {
  const path = repo();
  const s = repoSpace(path);
  const t = createTask(db, { spaceId: s.id, title: "Crashy" });
  start({
    adapter: fakeAdapter((input) => {
      writeFileSync(join(input.cwd, "c.txt"), "c\n");
      return { status: "error", kind: "failed", message: "boom" };
    }).adapter,
  });
  await waitFor(() => status(t.id) === "blocked");
  expect(getTask(db, t.id)!.blockedReason).toBe(
    `boom. Atrium saved the agent's unfinished edits as a WIP commit on atrium/${t.id}; retry to carry on from there.`,
  );
  expect(git(path, "branch", "--show-current")).toBe("main");
  expect(clean(path)).toBe(true);
  expect(subject(path, `atrium/${t.id}`)).toBe("WIP (stopped): Crashy");
});

test("a commit refusal says where the changes are and what to do next", async () => {
  const path = repo();
  git(path, "config", "core.excludesFile", "/dev/null");
  const s = repoSpace(path);
  const t = createTask(db, { spaceId: s.id, title: "Secrets" });
  start({
    adapter: fakeAdapter((input) => {
      writeFileSync(join(input.cwd, ".env"), "X=1\n");
      return ok();
    }).adapter,
  });
  await waitFor(() => status(t.id) === "blocked");
  expect(getTask(db, t.id)!.blockedReason).toBe(
    `Refusing to commit a .env file: .env. The changes are still uncommitted on atrium/${t.id} in ${path}. Commit or stash them on that branch, switch back to main, then retry.`,
  );
});

test("a review that would go to the agent that did the work is skipped at launch", async () => {
  const s = createSpace(db, { name: "Docs", kind: "general", goal: "", private: false });
  const parent = createTask(db, { spaceId: s.id, title: "Work", agent: "codex" });
  db.query("INSERT INTO runs (id, task_id, agent, started_at, transcript_path) VALUES (?, ?, ?, ?, ?)").run(
    "run_w", parent.id, "codex", Date.now(), "/tmp/x.log",
  );
  setTaskStatus(db, parent.id, "running");
  setTaskStatus(db, parent.id, "review");
  // Nakul switched the review to auto, which resolves to the free agent that did the work.
  const review = createTask(db, { spaceId: s.id, title: "Review: Work", kind: "review", parentTaskId: parent.id, agent: "auto" });
  const codex = fakeAdapter();
  start({ adapter: fakeAdapter().adapter, extra: { codex: { ...codex.adapter, id: "codex", label: "Codex" } } });
  await waitFor(() => status(review.id) === "done");
  expect(codex.calls).toHaveLength(0);
  expect(listActivity(db).some((a) => a.message.includes("Codex did the work, so it can't review it too"))).toBe(true);
});

test("a scratch copy whose sandbox won't start keeps nothing and the approval says so", async () => {
  const s = createSpace(db, { name: "Docs", kind: "general", goal: "", private: false });
  const t = createTask(db, { spaceId: s.id, title: "Write notes", agent: "codex" });
  const real = scratch.keepScratch;
  const spy = spyOn(scratch, "keepScratch").mockImplementation((src, dest) => real(src, dest, { sandboxExec: "/nonexistent/sandbox-exec" }));
  cleanups.push(() => spy.mockRestore());
  const codex = fakeAdapter((input) => {
    writeFileSync(join(input.cwd, "notes.md"), "# notes\n");
    return ok("Wrote notes.");
  });
  start({ adapter: fakeAdapter().adapter, extra: { codex: { ...codex.adapter, id: "codex", label: "Codex" } } });
  await waitFor(() => status(t.id) === "review");
  const run = db.query("SELECT id FROM runs WHERE task_id = ?").get(t.id) as { id: string };
  expect(existsSync(join(home.home, "spaces", s.id, "runs", run.id))).toBe(false);
  expect(listPending(db)[0]!.detail).toContain(
    "Atrium couldn't keep the files it left: the sandbox for copying them didn't start. They were removed with the temporary folder.",
  );
});

test("recoverOnBoot sweeps Atrium temp folders older than a day", async () => {
  const old = mkdtempSync(join(tmpdir(), "atrium-run-"));
  const oldAgent = mkdtempSync(join(tmpdir(), "atrium-agent-"));
  const fresh = mkdtempSync(join(tmpdir(), "atrium-run-"));
  const other = mkdtempSync(join(tmpdir(), "atrium-repo-"));
  cleanups.push(() => [old, oldAgent, fresh, other].forEach((d) => rmSync(d, { recursive: true, force: true })));
  const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000);
  for (const d of [old, oldAgent, other]) utimesSync(d, twoDaysAgo, twoDaysAgo);
  await recoverOnBoot(db);
  expect(existsSync(old)).toBe(false);
  expect(existsSync(oldAgent)).toBe(false);
  expect(existsSync(fresh)).toBe(true);
  expect(existsSync(other)).toBe(true);
});

// Earned autonomy: a rule Nakul said yes to, created a second ago so the results below are newer than it.
function yesRule(spaceId: string, fingerprint = "v1:code:docs:small:claude") {
  const id = `prp_${Math.random().toString(36).slice(2, 8)}`;
  db.query("INSERT INTO autonomy_proposals (id, space_id, fingerprint, evidence, status, created_at, answered_at) VALUES (?, ?, ?, '[]', 'yes', 1, 1)").run(
    id,
    spaceId,
    fingerprint,
  );
  return createRule(db, id, Date.now() - 1000);
}

const writesDoc = (name = "docs/a.md") =>
  fakeAdapter((input) => {
    mkdirSync(join(input.cwd, "docs"), { recursive: true });
    writeFileSync(join(input.cwd, name), "one\ntwo\nthree\nfour\nfive\n");
    return ok("Added a note.");
  });

function gated(id: string, summary: string) {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const calls: AgentRunInput[] = [];
  const adapter: AgentAdapter = {
    id,
    label: id,
    async run(input) {
      calls.push(input);
      const stopped = await Promise.race([gate.then(() => false), new Promise<boolean>((r) => input.signal?.addEventListener("abort", () => r(true)))]);
      return stopped ? { status: "error", kind: "failed", message: "Stopped" } : ok(summary);
    },
  };
  return { adapter, calls, release };
}

const approvalFor = (taskId: string) => db.query("SELECT id FROM approvals WHERE task_id = ? ORDER BY rowid DESC").get(taskId) as { id: string } | null;
const reviewOf = (taskId: string) => listTasks(db).find((t) => t.parentTaskId === taskId && t.kind === "review");
const reviewSpaceBy = (path: string) => updateSpace(db, createSpace(db, { name: "App", kind: "repo", goal: "", repoPath: path, private: false }).id, { reviewBy: "codex" });

test("a work approval stores its action kind", async () => {
  const path = repo();
  const s = repoSpace(path);
  const docs = createTask(db, { spaceId: s.id, title: "Docs" });
  start({ adapter: writesDoc().adapter });
  await waitFor(() => status(docs.id) === "review");
  await runner!.stop();
  expect(getApproval(db, approvalFor(docs.id)!.id)!.fingerprint).toBe("v1:code:docs:small:claude");

  git(path, "checkout", "main");
  const code = createTask(db, { spaceId: s.id, title: "Code" });
  start({
    adapter: fakeAdapter((input) => {
      mkdirSync(join(input.cwd, "src"), { recursive: true });
      writeFileSync(join(input.cwd, "src/x.ts"), "export {};\n");
      return ok();
    }).adapter,
  });
  await waitFor(() => status(code.id) === "review");
  expect(getApproval(db, approvalFor(code.id)!.id)!.fingerprint).toBeNull();
});

test("an active rule approves a matching result on its own", async () => {
  const path = repo();
  const s = repoSpace(path);
  const rule = yesRule(s.id);
  const t = createTask(db, { spaceId: s.id, title: "Add a note" });
  start({ adapter: writesDoc().adapter });
  await waitFor(() => status(t.id) === "done");
  const a = getApproval(db, approvalFor(t.id)!.id)!;
  expect(a).toMatchObject({ status: "approved", decidedBy: "rule", ruleId: rule.id });
  expect(listPending(db)).toEqual([]);
  expect(listActivity(db).some((x) => x.actor === "atrium" && x.message.startsWith('Approved by your rule "docs changes (Markdown in docs/ or a README/CHANGELOG) up to 50 lines from Claude"'))).toBe(true);
  // Atrium still never merges: the work stays on its branch.
  expect(git(path, "rev-list", "--count", `main..atrium/${t.id}`)).toBe("1");
});

test("a rule waits for the space's review", async () => {
  const path = repo();
  const s = reviewSpaceBy(path);
  yesRule(s.id);
  const t = createTask(db, { spaceId: s.id, title: "Add a note", agent: "claude" });
  const codex = gated("codex", "Reads well.\nVERDICT: approve");
  start({ adapter: writesDoc().adapter, extra: { codex: codex.adapter } });
  await waitFor(() => codex.calls.length === 1);
  expect(getApproval(db, approvalFor(t.id)!.id)!.status).toBe("pending");
  codex.release();
  await waitFor(() => status(t.id) === "done");
  expect(getApproval(db, approvalFor(t.id)!.id)!.decidedBy).toBe("rule");
  expect(reviewOf(t.id)!.status).toBe("done");
});

test("a review asking for changes keeps the result waiting", async () => {
  const path = repo();
  const s = reviewSpaceBy(path);
  yesRule(s.id);
  const t = createTask(db, { spaceId: s.id, title: "Add a note", agent: "claude" });
  const codex = fakeAdapter(() => ok("Typo on line 2.\nVERDICT: changes"));
  start({ adapter: writesDoc().adapter, extra: { codex: { ...codex.adapter, id: "codex", label: "Codex" } } });
  await waitFor(() => listTasks(db).some((x) => x.parentTaskId === t.id && x.kind === "fix" && x.status === "done"));
  await runner!.stop();
  runner = null;
  expect(getApproval(db, approvalFor(t.id)!.id)!.status).toBe("pending");
  expect(status(t.id)).toBe("review");
});

test("a review without a verdict keeps the result waiting", async () => {
  const path = repo();
  const s = reviewSpaceBy(path);
  yesRule(s.id);
  const t = createTask(db, { spaceId: s.id, title: "Add a note", agent: "claude" });
  const codex = fakeAdapter(() => ok("Seems fine I guess."));
  start({ adapter: writesDoc().adapter, extra: { codex: { ...codex.adapter, id: "codex", label: "Codex" } } });
  await waitFor(() => reviewOf(t.id)?.status === "done");
  await runner!.stop();
  runner = null;
  expect(getApproval(db, approvalFor(t.id)!.id)!.status).toBe("pending");
});

test("rule applies after a review that finished after a restart", async () => {
  const path = repo();
  const s = reviewSpaceBy(path);
  yesRule(s.id);
  const t = createTask(db, { spaceId: s.id, title: "Add a note", agent: "claude" });
  const first = gated("codex", "VERDICT: approve");
  start({ adapter: writesDoc().adapter, extra: { codex: first.adapter } });
  await waitFor(() => first.calls.length === 1);
  await runner!.stop();
  expect(reviewOf(t.id)!.status).toBe("queued");
  expect(getApproval(db, approvalFor(t.id)!.id)!.status).toBe("pending");
  const second = fakeAdapter(() => ok("All good.\nVERDICT: approve"));
  start({ adapter: writesDoc().adapter, extra: { codex: { ...second.adapter, id: "codex", label: "Codex" } } });
  await waitFor(() => status(t.id) === "done");
  expect(getApproval(db, approvalFor(t.id)!.id)!.decidedBy).toBe("rule");
});

test("branch deleted before review ends", async () => {
  const path = repo();
  const s = reviewSpaceBy(path);
  yesRule(s.id);
  const t = createTask(db, { spaceId: s.id, title: "Add a note", agent: "claude" });
  const codex = gated("codex", "VERDICT: approve");
  start({ adapter: writesDoc().adapter, extra: { codex: codex.adapter } });
  await waitFor(() => codex.calls.length === 1);
  git(path, "branch", "-D", `atrium/${t.id}`);
  codex.release();
  await waitFor(() => reviewOf(t.id)?.status === "done");
  await runner!.stop();
  runner = null;
  expect(getApproval(db, approvalFor(t.id)!.id)!.status).toBe("pending");
  expect(listActivity(db).some((x) => x.message.startsWith("Couldn't check your rules"))).toBe(false);
});

test("a deleted file is never auto-approved", async () => {
  const path = repo();
  mkdirSync(join(path, "docs"));
  writeFileSync(join(path, "docs/old.md"), "old\n");
  git(path, "add", "-A");
  git(path, "commit", "-m", "old doc");
  const s = repoSpace(path);
  yesRule(s.id);
  const t = createTask(db, { spaceId: s.id, title: "Swap docs" });
  start({
    adapter: fakeAdapter((input) => {
      rmSync(join(input.cwd, "docs/old.md"));
      writeFileSync(join(input.cwd, "docs/a.md"), "new\n");
      return ok();
    }).adapter,
  });
  await waitFor(() => status(t.id) === "review");
  const a = getApproval(db, approvalFor(t.id)!.id)!;
  expect(a.status).toBe("pending");
  expect(a.fingerprint).toBeNull();
});

test("a general text answer is rule-approved, but not one that left files in the space folder", async () => {
  const s = generalSpace();
  yesRule(s.id, "v1:general:text:claude");
  const text = createTask(db, { spaceId: s.id, title: "Answer" });
  start({ adapter: fakeAdapter(() => ok("The answer is 42.")).adapter });
  await waitFor(() => status(text.id) === "done");
  expect(getApproval(db, approvalFor(text.id)!.id)).toMatchObject({ decidedBy: "rule", fingerprint: "v1:general:text:claude" });
  await runner!.stop();

  const files = createTask(db, { spaceId: s.id, title: "Write a file" });
  start({
    adapter: fakeAdapter((input) => {
      writeFileSync(join(input.cwd, "notes.txt"), "hi\n");
      return ok("Wrote notes.");
    }).adapter,
  });
  await waitFor(() => status(files.id) === "review");
  expect(getApproval(db, approvalFor(files.id)!.id)).toMatchObject({ status: "pending", fingerprint: null });
});

test("a failing rule check leaves the result waiting and says so", async () => {
  const path = repo();
  const s = repoSpace(path);
  yesRule(s.id);
  const t = createTask(db, { spaceId: s.id, title: "Add a note" });
  const spy = spyOn(rules, "applyRule").mockImplementation(() => {
    throw new Error("disk on fire");
  });
  cleanups.push(() => spy.mockRestore());
  start({ adapter: writesDoc().adapter });
  await waitFor(() => listActivity(db).some((x) => x.message.startsWith("Couldn't check your rules")));
  expect(listActivity(db).map((x) => x.message)).toContain("Couldn't check your rules for Add a note: disk on fire. It's waiting for you as usual.");
  expect(status(t.id)).toBe("review");
  expect(getApproval(db, approvalFor(t.id)!.id)!.status).toBe("pending");
});

describe("markets spaces", () => {
  const IN_SESSION = Date.parse("2026-11-05T15:00:00Z");
  const noKeys = { get: async () => null, set: async () => {}, remove: async () => {} };
  let offStrategy: () => void = () => {};
  afterEach(() => offStrategy());

  function marketsRunner(adapter: AgentAdapter) {
    setSetting(db, "markets.provider", "demo");
    const data = createMarketData({ db, keychain: noKeys, now: () => IN_SESSION, providers: { demo: demoProvider({ now: () => IN_SESSION }) } });
    runner = createRunner({ db, adapters: { claude: adapter }, power: async () => "ac", keepAwake: fakeKeepAwake(), markets: createMarketsHooks(db, { data, now: () => IN_SESSION }) });
    runner.start();
    return runner;
  }

  test("markets strategy run settles without a review", async () => {
    const space = createSpace(db, { name: "Stocks", kind: "markets", goal: "paper" });
    offStrategy = onApprovalResolved((a, d) => handleStrategyDecision(db, a, d));
    const s = proposeStrategy(db, space.id, { name: "Momentum", rules: "r", symbols: ["AAPL"], cadence: "open", maxPositionValue: 2000, maxTradesPerDay: 3 }, "claude");
    resolveApproval(db, s.approvalId!, "approve");
    saveQuotes(db, [{ key: "AAPL", price: 100, prevClose: 99, at: IN_SESSION, source: "demo", freshness: "demo" }]);
    const block = '```atrium-markets\n{"orders":[{"symbol":"AAPL","side":"buy","qty":5,"reason":"Above SMA20"}]}\n```\nAnalysis, not advice.';
    const { adapter, calls } = fakeAdapter(() => ok(block));
    const task = createTask(db, { spaceId: space.id, title: "Paper strategy: Momentum (9:45 AM ET)", agent: "claude", weight: "light", strategyId: s.id });
    marketsRunner(adapter);
    await waitFor(() => getTask(db, task.id)!.status === "done");
    expect(listPending(db)).toHaveLength(0);
    expect(db.query("SELECT COUNT(*) AS n FROM paper_fills").get()).toEqual({ n: 1 });
    expect(listActivity(db).map((a) => a.message)).toContain("Paper strategy run: 1 filled, 0 refused");
    expect(calls[0]!.prompt).toContain("Market data as of");
    expect(calls[0]!.systemPrompt).toContain("Analysis, not advice");
  });

  test("markets analysis task ends in review with the label", async () => {
    const space = createSpace(db, { name: "Stocks", kind: "markets", goal: "watch" });
    const { adapter, calls } = fakeAdapter(() => ok('Holdings moved with the market.\n\n```atrium-markets\n{"orders":[{"symbol":"AAPL","side":"buy","qty":1,"reason":"x"}]}\n```\nAnalysis, not advice.'));
    const task = createTask(db, { spaceId: space.id, title: "Explain today's move", agent: "claude", weight: "light" });
    marketsRunner(adapter);
    await waitFor(() => getTask(db, task.id)!.status === "review");
    const a = listPending(db)[0]!;
    expect(a.detail).toContain("Holdings moved with the market.");
    expect(a.detail).toContain("Paper orders only run from an approved strategy; ignored 1.");
    expect(calls[0]!.systemPrompt).toContain("This is a markets space. Atrium never places real trades and you can't either.");
    expect(calls[0]!.prompt).toContain("Market data as of");
  });
});
