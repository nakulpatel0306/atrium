import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskWait } from "../../src/engine/agents/registry";
import type { AgentAdapter, AgentRunInput, AgentRunResult } from "../../src/engine/agents/types";
import { getApproval, listPending, onApprovalResolved, resolveApproval } from "../../src/engine/approvals";
import * as rules from "../../src/engine/autonomy/rules";
import { createRule } from "../../src/engine/autonomy/rules";
import { openDb } from "../../src/engine/db";
import * as gitOps from "../../src/engine/git";
import * as scratch from "../../src/engine/scratch";
import * as snapshot from "../../src/engine/outputs/snapshot";
import { taskFiles } from "../../src/engine/outputs/store";
import * as storage from "../../src/engine/storage";
import { bus, listActivity } from "../../src/engine/events";
import { BASE_TOOLS, createRunner, engineOnlyClaim, recoverOnBoot, REPO_TOOLS, REVIEW_TOOLS } from "../../src/engine/runner";
import { capabilityLines } from "../../src/engine/capabilities";
import { OUTCOME_INSTRUCTION, outcomeLabel, outcomeText } from "../../src/engine/outcome";
import { getSetting, setSetting } from "../../src/engine/settings";
import { createSpace, getSpace, updateSpace } from "../../src/engine/spaces";
import { spaceFolder } from "../../src/engine/folders";
import { createTask, getTask, listTasks, setTaskLoop, setTaskStatus } from "../../src/engine/tasks";
import { newLoop, SIZE_BUDGETS } from "../../src/engine/loop";
import { claimAttachments, storeAttachments, withAttachments } from "../../src/engine/attachments";
import { tempHome, tempRepo } from "../helpers";
import { readdirSync } from "node:fs";
import { config } from "../../src/engine/config";
import { claudeAdapter } from "../../src/engine/agents/claude";
import { createCloner } from "../../src/engine/repos/clones";
import { listClones } from "../../src/engine/repos/store";
import { fakeGitHub, seedRemote } from "../repos-helpers";

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
    ["git", "-c", "user.name=Atrium Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args],
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
  repos?: Parameters<typeof createRunner>[0]["repos"];
}) {
  runner = createRunner({
    db,
    adapters: { claude: opts.adapter, ...opts.extra },
    power: opts.power ?? (async () => "ac"),
    keepAwake: opts.keepAwake ?? fakeKeepAwake(),
    stopTimeoutMs: opts.stopTimeoutMs,
    repos: opts.repos,
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

const realSnapshot = snapshot.snapshotFolder;
// The system prompt without the shared capability and outcome lines, which name branches for every agent.
const ownLines = (prompt: string) => prompt.split("What Atrium can and can't do right now:")[0]!;
const generalSpace = () => createSpace(db, { name: "Docs", kind: "general", goal: "Write clear docs" });
// Review is off so these stay about the run itself; the loop's checks and reviews are covered in loop.test.ts.
const repoSpace = (path: string) => updateSpace(db, createSpace(db, { name: "App", kind: "repo", goal: "Ship the app", repoPath: path }).id, { reviewBy: "off" });
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
  expect(ownLines(calls[0]!.systemPrompt)).not.toMatch(/git|branch|commit|push|merge/i);
  expect(calls[0]!.allowedTools).toEqual(["Read", "Edit", "Write", "Glob", "Grep"]);
  expect(calls[0]!.cwd).toBe(spaceFolder(getSpace(db, s.id)!));
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
    "Bash(bun test*)", "Bash(bunx tsc*)",
    "Bash(git status*)", "Bash(git diff*)", "Bash(git log*)",
  ]);
  const [a] = listPending(db);
  expect(a!.detail).toContain("Added new.txt.");
  expect(a!.detail).toContain(`1 commit, 1 file (+1 −0) on atrium/${task.id}`);
  expect(a!.detail).toContain(`Branch atrium/${task.id} is on your machine. Push it when you're ready.`);
  // The fixture repo has nothing to run, and this space has review off, and the approval says both.
  expect(a!.detail.endsWith("Unverified: no checks found. Add a check command in this space's settings or in the brief.\n\nReview: off for this space.")).toBe(true);
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
  expect(getTask(db, t.id)!.blockedReason).toBe(`The folder ${path} doesn't exist. Check the repo folder in the space settings.`);
  expect(calls).toHaveLength(0);
});

test("branch summary failure still moves to review and says so", async () => {
  const path = repo();
  const s = repoSpace(path);
  const t = createTask(db, { spaceId: s.id, title: "Rename" });
  const spy = spyOn(gitOps, "branchSummary").mockRejectedValue(new Error("Couldn't count commits: bad revision"));
  cleanups.push(() => spy.mockRestore());
  start({ adapter: fakeAdapter(() => ok("Renamed things.")).adapter });
  await waitFor(() => status(t.id) === "review");
  const [a] = listPending(db);
  expect(a!.detail).toContain("Renamed things.");
  expect(a!.detail).toContain(`Couldn't summarise the changes on atrium/${t.id}: Couldn't count commits: bad revision`);
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
  expect(listPending(db)[0]!.detail).toContain(`Branch atrium/${t.id} is on your machine. Push it when you're ready.`);
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
    `The agent changed git settings in ${path} (config, hooks, or attributes). Atrium stopped before switching branches. Check them, then retry.`,
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
  expect(getTask(db, t.id)!.blockedReason).toBe("The repo is on atrium/tsk_old, an Atrium branch. Switch back to your own branch, then retry.");
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
  expect(listActivity(db).filter((r) => r.message.startsWith("Atrium hit a problem starting the next task:")).length).toBeLessThanOrEqual(3);
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
    { taskId: t.id, agent: "auto", kind: "power", reason: "Waiting for power. Heavy work runs when your Mac is plugged in." },
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
  expect(seen).not.toBe(spaceFolder(getSpace(db, s.id)!));
  expect(existsSync(seen)).toBe(false);
  expect(codex.calls[0]!.systemPrompt).toContain("This folder is temporary");
  expect(ownLines(codex.calls[0]!.systemPrompt)).not.toMatch(/git|branch|commit/i);
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
  const kept = join(spaceFolder(getSpace(db, s.id)!), "runs", run.id);
  expect(readFileSync(join(kept, "notes.md"), "utf8")).toBe("# notes\n");
  expect(readFileSync(join(kept, "sub", "more.txt"), "utf8")).toBe("more\n");
  expect(existsSync(join(kept, "link"))).toBe(false);
  expect(listPending(db)[0]!.detail).toContain(
    `Files it left are kept in ${kept}. Left out 1 item that was a link or changed while being copied.`,
  );
});

test("a scratch run gets the task's attached files where its detail says, and they aren't kept as its work", async () => {
  const s = createSpace(db, { name: "Flat Costs", kind: "general", goal: "", private: false });
  const [a] = storeAttachments(db, s, [{ name: "receipt.png", bytes: new Uint8Array([1, 2, 3]) }]);
  const t = createTask(db, { spaceId: s.id, title: "Split it", detail: withAttachments("Split it", [a!]), agent: "codex" });
  claimAttachments(db, t.id, [a!]);
  let seen: number[] = [];
  const codex = fakeAdapter((input) => {
    seen = [...readFileSync(join(input.cwd, "Attachments", "receipt.png"))];
    writeFileSync(join(input.cwd, "split.md"), "- 3 ways\n");
    return ok("Split.");
  });
  start({ adapter: fakeAdapter().adapter, extra: { codex: { ...codex.adapter, id: "codex", label: "Codex" } } });
  await waitFor(() => status(t.id) === "review");
  expect(seen).toEqual([1, 2, 3]);
  expect(codex.calls[0]!.prompt).toContain("- Attachments/receipt.png");
  const run = db.query("SELECT id FROM runs WHERE task_id = ?").get(t.id) as { id: string };
  const kept = join(spaceFolder(getSpace(db, s.id)!), "runs", run.id);
  expect(readdirSync(kept)).toEqual(["split.md"]);
});

test("an agent that swaps Attachments for a link to an outside folder never gets a file there deleted", async () => {
  const s = createSpace(db, { name: "Flat Costs", kind: "general", goal: "", private: false });
  const [a] = storeAttachments(db, s, [{ name: "receipt.png", bytes: new Uint8Array([1, 2, 3]) }]);
  const t = createTask(db, { spaceId: s.id, title: "Split it", detail: withAttachments("Split it", [a!]), agent: "codex" });
  claimAttachments(db, t.id, [a!]);
  const outside = mkdtempSync(join(tmpdir(), "atrium-outside-"));
  cleanups.push(() => rmSync(outside, { recursive: true, force: true }));
  // Same name, same bytes: exactly what a path-based cleanup would have mistaken for its own copy.
  mkdirSync(join(outside, "Attachments"));
  writeFileSync(join(outside, "Attachments", "receipt.png"), new Uint8Array([1, 2, 3]));
  const codex = fakeAdapter((input) => {
    rmSync(join(input.cwd, "Attachments"), { recursive: true });
    symlinkSync(join(outside, "Attachments"), join(input.cwd, "Attachments"));
    writeFileSync(join(input.cwd, "notes.md"), "edited\n");
    return ok("Done.");
  });
  start({ adapter: fakeAdapter().adapter, extra: { codex: { ...codex.adapter, id: "codex", label: "Codex" } } });
  await waitFor(() => status(t.id) === "review");
  expect([...readFileSync(join(outside, "Attachments", "receipt.png"))]).toEqual([1, 2, 3]);
  expect(readFileSync(join(spaceFolder(getSpace(db, s.id)!), "Attachments", "receipt.png"))).toEqual(Buffer.from([1, 2, 3]));
});

test("an attached file the agent changed is kept with its work", async () => {
  const s = createSpace(db, { name: "Flat Costs", kind: "general", goal: "", private: false });
  const [a] = storeAttachments(db, s, [{ name: "list.csv", bytes: new TextEncoder().encode("a,b\n") }]);
  const t = createTask(db, { spaceId: s.id, title: "Total it", detail: withAttachments("Total it", [a!]), agent: "codex" });
  claimAttachments(db, t.id, [a!]);
  const codex = fakeAdapter((input) => {
    writeFileSync(join(input.cwd, "Attachments", "list.csv"), "a,b,total\n");
    return ok("Added totals.");
  });
  start({ adapter: fakeAdapter().adapter, extra: { codex: { ...codex.adapter, id: "codex", label: "Codex" } } });
  await waitFor(() => status(t.id) === "review");
  const run = db.query("SELECT id FROM runs WHERE task_id = ?").get(t.id) as { id: string };
  const kept = join(spaceFolder(getSpace(db, s.id)!), "runs", run.id);
  expect(readFileSync(join(kept, "Attachments", "list.csv"), "utf8")).toBe("a,b,total\n");
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
  expect(listActivity(db).map((r) => r.message)).toContain("The engine restarted, so Interrupted is back in the queue.");
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
  expect(messages.some((m) => m.startsWith("Atrium hit a problem starting the next task:"))).toBe(false);
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
  const { adapter, calls } = fakeAdapter(async (input) => {
    const res = await untilAborted(input);
    aborted = true;
    return res;
  });
  const r = start({ adapter });
  await waitFor(() => calls.length > 0);
  const started = Date.now();
  await r.stop();
  runner = null;
  expect(Date.now() - started).toBeLessThan(2000);
  expect(aborted).toBe(true);
  expect(status(t.id)).toBe("queued");
  expect(git(path, "branch", "--show-current")).toBe("feature");
  expect(listActivity(db).map((a) => a.message)).toContain("The engine stopped, so Long job is back in the queue.");
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

test("stopTask stops a running task: blocked with your word, edits saved on its branch, repo put back", async () => {
  const path = repo();
  git(path, "checkout", "-b", "feature");
  const s = repoSpace(path);
  const t = createTask(db, { spaceId: s.id, title: "Long job" });
  const seen: string[][] = [];
  const r = start({
    adapter: fakeAdapter(async (input) => {
      seen.push(readdirSync(input.cwd).filter((f) => f.endsWith(".txt")));
      if (seen.length > 1) return ok("Carried on.");
      writeFileSync(join(input.cwd, "half.txt"), "half done\n");
      return untilAborted(input);
    }).adapter,
  });
  await waitFor(() => status(t.id) === "running");
  await Bun.sleep(20);
  expect(await r.stopTask(t.id)).toBe("stopped");
  const task = getTask(db, t.id)!;
  expect(task.status).toBe("blocked");
  expect(task.blockedReason).toBe(`You stopped this task. Atrium saved the agent's unfinished edits as a WIP commit on atrium/${t.id}; retry to carry on from there.`);
  expect(git(path, "branch", "--show-current")).toBe("feature");
  expect(git(path, "status", "--porcelain")).toBe("");
  expect(git(path, "log", "-1", "--format=%s", `atrium/${t.id}`)).toBe("WIP (stopped): Long job");
  const lines = listActivity(db).map((a) => a.message);
  expect(lines).toContain(`Stopped by you: Long job. Atrium saved the agent's unfinished edits as a WIP commit on atrium/${t.id}; retry to carry on from there.`);
  expect(lines.some((m) => m.startsWith("The engine stopped"))).toBe(false);
  // It doesn't start again on its own.
  await Bun.sleep(50);
  expect(status(t.id)).toBe("blocked");
  // Retry carries on from the saved edits on the task's branch.
  setTaskStatus(db, t.id, "queued");
  r.kick();
  await waitFor(() => status(t.id) === "review");
  expect(seen).toEqual([[], ["half.txt"]]);
});

test("two stops of the same run, from the dashboard and the terminal at once, both hear stopped", async () => {
  const path = repo();
  const s = repoSpace(path);
  const t = createTask(db, { spaceId: s.id, title: "Long job" });
  const r = start({ adapter: fakeAdapter(async (input) => untilAborted(input)).adapter });
  await waitFor(() => status(t.id) === "running");
  await Bun.sleep(20);
  expect(await Promise.all([r.stopTask(t.id), r.stopTask(t.id)])).toEqual(["stopped", "stopped"]);
  expect(status(t.id)).toBe("blocked");
});

test("stopTask leaves no agent process behind", async () => {
  const s = generalSpace();
  const t = createTask(db, { spaceId: s.id, title: "Spawns a child" });
  const pidFile = join(home.home, "child.pid");
  const { runAgentProcess } = await import("../../src/engine/agents/process");
  const r = start({
    adapter: fakeAdapter(async (input) => {
      const res = await runAgentProcess(["bash", "-c", `sleep 30 & echo $! > ${pidFile}; wait`], { cwd: input.cwd, stdin: "", signal: input.signal, onLine() {} });
      return "notInstalled" in res && res.notInstalled ? ok() : { status: "error", kind: "failed", message: "Stopped" };
    }).adapter,
  });
  await waitFor(() => status(t.id) === "running" && existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "");
  const child = Number(readFileSync(pidFile, "utf8").trim());
  expect(await r.stopTask(t.id)).toBe("stopped");
  expect(status(t.id)).toBe("blocked");
  expect(getTask(db, t.id)!.blockedReason).toBe("You stopped this task. Retry to run it again.");
  expect(() => process.kill(child, 0)).toThrow();
});

test("an agent that ignores SIGTERM is killed after the grace period", async () => {
  const { runAgentProcess } = await import("../../src/engine/agents/process");
  const controller = new AbortController();
  const pidFile = join(home.home, "stubborn.pid");
  const started = Date.now();
  const running = runAgentProcess(["bash", "-c", `trap '' TERM; echo $$ > ${pidFile}; while true; do sleep 0.05; done`], { cwd: home.home, stdin: "", signal: controller.signal, abortGraceMs: 200, onLine() {} });
  await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "");
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  controller.abort();
  const res = await running;
  expect("aborted" in res && res.aborted).toBe(true);
  expect(Date.now() - started).toBeLessThan(3000);
  expect(() => process.kill(pid, 0)).toThrow();
});

test("stopTask says timeout while the run hasn't wound down, then the task ends stopped", async () => {
  const s = generalSpace();
  const t = createTask(db, { spaceId: s.id, title: "Slow to stop" });
  let finish!: () => void;
  const gate = new Promise<void>((res) => (finish = res));
  const r = start({
    adapter: fakeAdapter(async (input) => {
      await untilAborted(input);
      await gate;
      return { status: "error", kind: "failed", message: "Stopped" };
    }).adapter,
    stopTimeoutMs: 30,
  });
  await waitFor(() => status(t.id) === "running");
  expect(await r.stopTask(t.id)).toBe("timeout");
  expect(status(t.id)).toBe("running");
  finish();
  await waitFor(() => status(t.id) === "blocked");
  expect(getTask(db, t.id)!.blockedReason).toBe("You stopped this task. Retry to run it again.");
});

test("stopTask says finished when the agent had already answered, and its result stands", async () => {
  const path = repo();
  const s = repoSpace(path);
  const t = createTask(db, { spaceId: s.id, title: "Nearly done" });
  // Hold the run in its after-work step, as a slow commit would.
  let release!: () => void;
  const held = new Promise<void>((res) => (release = res));
  const real = gitOps.commitAll;
  const spy = spyOn(gitOps, "commitAll").mockImplementation(async (...a: Parameters<typeof real>) => {
    await held;
    return real(...a);
  });
  cleanups.push(() => spy.mockRestore());
  const r = start({ adapter: fakeAdapter(() => ok("All done.")).adapter });
  await waitFor(() => spy.mock.calls.length > 0);
  const outcome = r.stopTask(t.id);
  release();
  expect(await outcome).toBe("finished");
  expect(status(t.id)).toBe("review");
  expect(listActivity(db).some((a) => a.message.startsWith("Stopped by you"))).toBe(false);
});

for (const [label, result, expectStatus] of [
  ["failed", { status: "error", kind: "failed", message: "The CLI crashed" }, "blocked"],
  ["hit a usage limit", { status: "error", kind: "rate_limited", message: "Claude hit its limit", retryAfter: Date.now() + 60_000 }, "queued"],
] as const) {
  test(`a stop that lands after the agent ${label} keeps what the agent said`, async () => {
    const path = repo();
    const s = repoSpace(path);
    const t = createTask(db, { spaceId: s.id, title: "Answered already" });
    let release!: () => void;
    const held = new Promise<void>((res) => (release = res));
    const real = gitOps.commitAll;
    const spy = spyOn(gitOps, "commitAll").mockImplementation(async (...a: Parameters<typeof real>) => {
      await held;
      return real(...a);
    });
    cleanups.push(() => spy.mockRestore());
    const r = start({ adapter: fakeAdapter(() => result as AgentRunResult).adapter });
    await waitFor(() => spy.mock.calls.length > 0);
    const outcome = r.stopTask(t.id);
    release();
    expect(await outcome).toBe("finished");
    expect(status(t.id)).toBe(expectStatus);
    if (expectStatus === "blocked") expect(getTask(db, t.id)!.blockedReason).toBe("The CLI crashed");
    expect(listActivity(db).some((a) => a.message.startsWith("Stopped by you"))).toBe(false);
  });
}

test("stopping a review sends the work on to you, saying the review didn't happen", async () => {
  const path = repo();
  const s = repoSpace(path);
  const parent = createTask(db, { spaceId: s.id, title: "Work" });
  setTaskLoop(db, parent.id, { ...newLoop(SIZE_BUDGETS.medium), stage: "review", checks: "none", report: ["Did the work."] });
  const review = createTask(db, { spaceId: s.id, title: "Review: Work", kind: "review", parentTaskId: parent.id, agent: "claude" });
  const r = start({ adapter: fakeAdapter(async (input) => untilAborted(input)).adapter });
  await waitFor(() => status(review.id) === "running");
  expect(await r.stopTask(review.id)).toBe("stopped");
  expect(status(review.id)).toBe("blocked");
  await waitFor(() => status(parent.id) === "review");
  expect(listPending(db)[0]!.detail).toContain("Review: Claude's review didn't happen. You stopped the review.");
});

test("fix tasks and approval-bound reviews from the old handoff end on boot; the work still waits for you", async () => {
  const s = generalSpace();
  const parent = createTask(db, { spaceId: s.id, title: "Add a note" });
  setTaskStatus(db, parent.id, "running");
  setTaskStatus(db, parent.id, "review");
  const { createApproval } = await import("../../src/engine/approvals");
  const a = createApproval(db, { spaceId: s.id, taskId: parent.id, kind: "review", title: "Add a note", detail: "Added it." });
  const fix = createTask(db, { spaceId: s.id, title: "Fix: Add a note", kind: "fix", parentTaskId: parent.id, approvalId: a.id });
  const review = createTask(db, { spaceId: s.id, title: "Review: Add a note", kind: "review", parentTaskId: parent.id, approvalId: a.id });
  await recoverOnBoot(db);
  expect([status(fix.id), status(review.id), status(parent.id)]).toEqual(["done", "done", "review"]);
  expect(getApproval(db, a.id)!.status).toBe("pending");
  expect(listActivity(db).map((x) => x.message)).toContain("Ended: Fix: Add a note. Reviews now run before work reaches you, so this older step won't run; decide on the work as usual.");
});

test("stopTask stops only the task asked for, and says no for one that isn't running", async () => {
  const s = generalSpace();
  const other = createSpace(db, { name: "Other", kind: "general", goal: "g" });
  const idle = createTask(db, { spaceId: other.id, title: "Waiting its turn" });
  setTaskStatus(db, idle.id, "blocked", { blockedReason: "x" });
  const t = createTask(db, { spaceId: s.id, title: "Running" });
  const r = start({ adapter: fakeAdapter(async (input) => untilAborted(input)).adapter });
  await waitFor(() => status(t.id) === "running");
  expect(await r.stopTask(idle.id)).toBe("not-running");
  expect(status(t.id)).toBe("running");
  expect(await r.stopTask(t.id)).toBe("stopped");
  expect(await r.stopTask(t.id)).toBe("not-running");
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
  `The agent changed git settings in ${path} (config, hooks, or attributes). Atrium stopped before switching branches. Check them, then retry.`;

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
  expect(existsSync(join(spaceFolder(getSpace(db, s.id)!), "runs", run.id))).toBe(false);
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
    return ok("Added a note.\nOUTCOME: done");
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

test("a rule decides only once the space's review has approved", async () => {
  const path = repo();
  const s = reviewSpaceBy(path);
  yesRule(s.id);
  const t = createTask(db, { spaceId: s.id, title: "Add a note", agent: "claude" });
  const codex = gated("codex", "Reads well.\nVERDICT: approve");
  start({ adapter: writesDoc().adapter, extra: { codex: codex.adapter } });
  await waitFor(() => codex.calls.length === 1);
  // Nothing reaches Nakul, or a rule, before the review is in.
  expect(approvalFor(t.id)).toBeNull();
  codex.release();
  await waitFor(() => status(t.id) === "done");
  expect(getApproval(db, approvalFor(t.id)!.id)!.decidedBy).toBe("rule");
  expect(reviewOf(t.id)!.status).toBe("done");
});

test("a review asking for changes keeps the result waiting, even after the writer fixed it", async () => {
  const path = repo();
  const s = reviewSpaceBy(path);
  yesRule(s.id);
  const t = createTask(db, { spaceId: s.id, title: "Add a note", agent: "claude" });
  const codex = fakeAdapter(() => ok("FINDING medium docs/a.md:2 typo\nVERDICT: changes"));
  start({ adapter: writesDoc().adapter, extra: { codex: { ...codex.adapter, id: "codex", label: "Codex" } } });
  await waitFor(() => status(t.id) === "review");
  await runner!.stop();
  runner = null;
  expect(getApproval(db, approvalFor(t.id)!.id)!.status).toBe("pending");
  expect(getTask(db, t.id)!.loop!.triaged).toBe(true);
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
  expect(approvalFor(t.id)).toBeNull();
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
  start({ adapter: fakeAdapter(() => ok("The answer is 42.\nOUTCOME: done")).adapter });
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

describe("attached GitHub repos", () => {
  test("a task in a space with no local copy waits while it's cloned, then runs on its branch", async () => {
    const gh = fakeGitHub();
    cleanups.push(gh.cleanup);
    seedRemote(gh, "demo");
    const s = createSpace(db, { name: "Demo", kind: "repo", goal: "g", github: "fakeuser/demo" });
    const t = createTask(db, { spaceId: s.id, title: "Read the README", weight: "light" });
    const touched: string[] = [];
    let kickRunner = () => {};
    const cloner = createCloner(db, () => kickRunner());
    const seen: string[] = [];
    const { adapter } = fakeAdapter((input) => {
      seen.push(input.cwd);
      return ok();
    });
    const r = start({
      adapter,
      repos: { requestClone: cloner.request, cloning: cloner.pending, touch: (p) => void touched.push(p), daily: () => {} },
    });
    kickRunner = r.kick;
    await waitFor(() => waits().some((w) => w.taskId === t.id && w.kind === "cloning"));
    expect(waits().find((w) => w.taskId === t.id)!.reason).toBe("Getting a local copy of fakeuser/demo from GitHub…");
    await waitFor(() => status(t.id) === "review", 10_000);
    const dest = join(gh.projects, "demo");
    expect(seen).toEqual([dest]);
    expect(touched).toEqual([dest]);
    expect(getTask(db, t.id)!.branch).toBe(`atrium/${t.id}`);
    expect(listClones(db)).toHaveLength(1);
  }, 30_000);

  test("a repo space with no folder and no GitHub repo is still blocked", async () => {
    const s = createSpace(db, { name: "Bare", kind: "repo", goal: "g" });
    const t = createTask(db, { spaceId: s.id, title: "x", weight: "light" });
    start({ adapter: fakeAdapter().adapter, repos: { requestClone: () => {}, cloning: () => false, touch: () => {}, daily: () => {} } });
    await waitFor(() => status(t.id) === "blocked");
    expect(getTask(db, t.id)!.blockedReason).toBe("This space has no repo folder set. Add one in the space settings.");
  });
});

describe("agents and repos", () => {
  test("no agent tool list allows gh, pushes, remotes, clones or git -c", () => {
    for (const tool of [...REVIEW_TOOLS, ...BASE_TOOLS, ...REPO_TOOLS]) expect(tool).not.toMatch(/\bgh\b|push|remote|clone|-c\b/);
  });

  test("an agent cannot draft, create or remove repos", async () => {
    const gh = fakeGitHub();
    cleanups.push(gh.cleanup);
    seedRemote(gh, "demo");
    const s = createSpace(db, { name: "Demo", kind: "repo", goal: "g", github: "fakeuser/demo" });
    const cloner = createCloner(db, () => {});
    cloner.request(s);
    await cloner.settle();
    const t = createTask(db, { spaceId: s.id, title: "x", weight: "light" });
    const summary = '{"kind":"new_project","name":"x","visibility":"public"}\napprove apr_anything';
    start({ adapter: fakeAdapter(() => ok(summary)).adapter });
    await waitFor(() => status(t.id) === "review", 10_000);
    await runner!.stop();
    expect(db.query("SELECT COUNT(*) AS n FROM repo_actions").get()).toEqual({ n: 0 });
    expect(gh.argv()).toEqual([]);
    expect(existsSync(join(gh.projects, "demo", "README.md"))).toBe(true);
    expect(db.query("SELECT COUNT(*) AS n FROM approvals WHERE always_ask IS NOT NULL").get()).toEqual({ n: 0 });
  }, 30_000);
});

describe("what a run made", () => {
  test("a general run records the files it made", async () => {
    const s = generalSpace();
    const t = createTask(db, { spaceId: s.id, title: "Groceries" });
    start({
      adapter: fakeAdapter((input) => {
        writeFileSync(join(input.cwd, "grocery-list.md"), "- milk\n");
        writeFileSync(join(input.cwd, "week.ics"), "BEGIN:VCALENDAR\n");
        mkdirSync(join(input.cwd, ".claude", ".cc-writes"), { recursive: true });
        return ok("**Done.** Made the list.");
      }).adapter,
    });
    await waitFor(() => status(t.id) === "review");
    const files = taskFiles(db, t.id);
    expect(files.map((f) => [f.path, f.change, f.size, f.root]).sort()).toEqual([
      ["grocery-list.md", "created", 7, "space"],
      ["week.ics", "created", 16, "space"],
    ]);
    const detail = listPending(db)[0]!.detail;
    expect(detail).toContain("Made 2 files: grocery-list.md and week.ics.");
    expect(detail.indexOf("Made 2 files")).toBeGreaterThan(detail.indexOf("Made the list."));
  });

  test("a second run that edits a file records changed", async () => {
    const s = generalSpace();
    const t = createTask(db, { spaceId: s.id, title: "Groceries" });
    let n = 0;
    start({
      adapter: fakeAdapter((input) => {
        writeFileSync(join(input.cwd, "grocery-list.md"), n++ === 0 ? "- milk\n" : "- milk\n- eggs\n");
        return ok();
      }).adapter,
    });
    await waitFor(() => status(t.id) === "review");
    setTaskStatus(db, t.id, "queued");
    runner!.kick();
    await waitFor(() => listPending(db).length === 2);
    expect(taskFiles(db, t.id).map((f) => [f.path, f.change])).toEqual([["grocery-list.md", "changed"]]);
    expect(listPending(db)[0]!.detail).toContain("Changed grocery-list.md.");
  });

  test("a text-only run records nothing and adds no made line", async () => {
    const s = generalSpace();
    const t = createTask(db, { spaceId: s.id, title: "Answer" });
    start({ adapter: fakeAdapter(() => ok("Just text.")).adapter });
    await waitFor(() => status(t.id) === "review");
    expect(taskFiles(db, t.id)).toEqual([]);
    expect(listPending(db)[0]!.detail).not.toMatch(/Made |Changed |Deleted /);
  });

  test("a scratch run records kept files under runs/<runId>/", async () => {
    const s = createSpace(db, { name: "Docs", kind: "general", goal: "", private: false });
    const t = createTask(db, { spaceId: s.id, title: "Write notes", agent: "codex" });
    const codex = fakeAdapter((input) => {
      writeFileSync(join(input.cwd, "notes.md"), "# notes\n");
      return ok("Wrote notes.");
    });
    start({ adapter: fakeAdapter().adapter, extra: { codex: { ...codex.adapter, id: "codex", label: "Codex" } } });
    await waitFor(() => status(t.id) === "review");
    const run = db.query("SELECT id FROM runs WHERE task_id = ?").get(t.id) as { id: string };
    expect(taskFiles(db, t.id).map((f) => [f.path, f.change])).toEqual([[`runs/${run.id}/notes.md`, "created"]]);
    expect(listPending(db)[0]!.detail).toContain("Made notes.md.");
  });

  test("a repo run records the branch diff", async () => {
    const path = repo();
    const s = repoSpace(path);
    const t = createTask(db, { spaceId: s.id, title: "Add x" });
    start({
      adapter: fakeAdapter((input) => {
        mkdirSync(join(input.cwd, "src"), { recursive: true });
        writeFileSync(join(input.cwd, "src", "x.ts"), "export const x = 1;\n");
        return ok();
      }).adapter,
    });
    await waitFor(() => status(t.id) === "review");
    const [f] = taskFiles(db, t.id);
    expect(f).toMatchObject({ root: "branch", ref: `atrium/${t.id}`, path: "src/x.ts", change: "created", insertions: 1 });
    expect(listPending(db)[0]!.detail).not.toContain("Made src/x.ts.");
  });

  test("a recording failure doesn't change the outcome", async () => {
    const s = generalSpace();
    const t = createTask(db, { spaceId: s.id, title: "Groceries" });
    const snap = spyOn(snapshot, "snapshotFolder");
    let calls = 0;
    snap.mockImplementation((dir, opts) => {
      if (calls++ === 1) throw new Error("EACCES: permission denied");
      return realSnapshot(dir, opts);
    });
    try {
      start({
        adapter: fakeAdapter((input) => {
          writeFileSync(join(input.cwd, "a.md"), "a");
          return ok();
        }).adapter,
      });
      await waitFor(() => status(t.id) === "review");
    } finally {
      snap.mockRestore();
    }
    expect(listActivity(db).map((a) => a.message)).toContain(
      "Couldn't list the files this run made: EACCES: permission denied. The work itself is saved; open the space's Files tab to see the folder.",
    );
  });

  test("a blocked run still records what it left", async () => {
    const s = generalSpace();
    const t = createTask(db, { spaceId: s.id, title: "Groceries" });
    start({
      adapter: fakeAdapter((input) => {
        writeFileSync(join(input.cwd, "half.md"), "half");
        return { status: "error", kind: "failed", message: "It broke." };
      }).adapter,
    });
    await waitFor(() => status(t.id) === "blocked");
    expect(taskFiles(db, t.id).map((f) => f.path)).toEqual(["half.md"]);
  });
});

describe("honest outcomes", () => {
  const finish = async (title: string, summary: string, space = generalSpace()) => {
    const t = createTask(db, { spaceId: space.id, title });
    const { adapter, calls } = fakeAdapter(() => ok(summary));
    start({ adapter });
    await waitFor(() => status(t.id) === "review");
    return { t: getTask(db, t.id)!, a: getApproval(db, approvalFor(t.id)!.id)!, calls, space };
  };
  const activity = (spaceId: string) => listActivity(db, { spaceId }).map((x) => x.message);

  test("writer prompts end with the capabilities and the outcome instruction; reviews get neither", async () => {
    const path = repo();
    const s = reviewSpaceBy(path);
    const t = createTask(db, { spaceId: s.id, title: "Add a note", agent: "claude" });
    const codex = fakeAdapter(() => ok("FINDING medium docs/a.md:2 typo\nVERDICT: changes"));
    const claude = writesDoc();
    start({ adapter: claude.adapter, extra: { codex: { ...codex.adapter, id: "codex", label: "Codex" } } });
    await waitFor(() => status(t.id) === "review");
    const lines = capabilityLines();
    // The first turn, then the one that answers the review.
    expect(claude.calls).toHaveLength(2);
    for (const call of claude.calls) {
      for (const l of lines) expect(call.systemPrompt).toContain(l);
      expect(call.systemPrompt.endsWith(OUTCOME_INSTRUCTION)).toBe(true);
      expect(call.systemPrompt).toContain("Finish with a 2–4 sentence summary");
    }
    expect(codex.calls[0]!.systemPrompt).not.toContain("OUTCOME");
    expect(codex.calls[0]!.systemPrompt).not.toContain(lines[1]!);
    await runner!.stop();
    runner = null;
    const general = await finish("Write intro", "Wrote it.\nOUTCOME: done");
    expect(general.calls[0]!.systemPrompt.endsWith(OUTCOME_INSTRUCTION)).toBe(true);
    for (const l of lines) expect(general.calls[0]!.systemPrompt).toContain(l);
  });

  test("couldnt is stored, stripped from the text, and gets no kind", async () => {
    const { t, a, space } = await finish("Summarise notes.md", "Wrote it.\nOUTCOME: couldnt - no number.");
    expect([t.status, t.outcome, t.outcomeReason]).toEqual(["review", "couldnt", "no number."]);
    expect(a.detail.startsWith("Wrote it.")).toBe(true);
    expect(a.detail).not.toContain("OUTCOME");
    expect(getApproval(db, a.id)!.fingerprint).toBeNull();
    expect(activity(space.id)).toContain("Couldn't do: Summarise notes.md. No number.");
  });

  test("partial", async () => {
    const { t, a, space } = await finish("Write three files", "Wrote two.\nOUTCOME: partial - the third needs your notes.");
    expect([t.outcome, t.outcomeReason]).toEqual(["partial", "the third needs your notes."]);
    expect(getApproval(db, a.id)!.fingerprint).toBeNull();
    expect(activity(space.id)).toContain("Partly done: Write three files. The third needs your notes.");
  });

  test("no outcome line is unknown", async () => {
    const { t, a, space } = await finish("Answer", "The answer is 42.");
    expect([t.outcome, t.outcomeReason]).toEqual(["unknown", null]);
    expect(getApproval(db, a.id)!.fingerprint).toBeNull();
    expect(activity(space.id)).toContain("Ready for review: Answer");
  });

  test("done keeps its kind", async () => {
    const { t, a, space } = await finish("Answer", "The answer is 42.\nOUTCOME: done");
    expect(t.outcome).toBe("done");
    expect(getApproval(db, a.id)!.fingerprint).toBe("v1:general:text:claude");
    expect(a.detail).toBe("The answer is 42.");
    expect(activity(space.id)).toContain("Ready for review: Answer");
  });

  test("done can't stand for something Atrium can't do or only Atrium can do", async () => {
    const msg = await finish("Send the text to Dana", "Here's the text.\nOUTCOME: done");
    expect([msg.t.outcome, msg.t.outcomeReason]).toEqual(["couldnt", "Atrium can't send texts or email, and nothing was sent."]);
    expect(getApproval(db, msg.a.id)!.fingerprint).toBeNull();
    await runner!.stop();
    runner = null;
    const repoTask = await finish("Create a new GitHub repo for the blog", "Made a plan.\nOUTCOME: done");
    expect([repoTask.t.outcome, repoTask.t.outcomeReason]).toEqual(["couldnt", "Only Atrium can create repos, after your yes, and none was created."]);
    expect(getApproval(db, repoTask.a.id)!.fingerprint).toBeNull();
  });

  test("engineOnlyClaim", () => {
    for (const t of ["Send the text to Dana", "Text mom happy birthday", "Can you send him a message", "iMessage Dana", "Let Dana know dinner is at 8", "Reach out to Dana"]) {
      expect([t, engineOnlyClaim(t)]).toEqual([t, "message"]);
    }
    for (const t of ["Create a new GitHub repo", "set up the repository", "make a repo for notes"]) expect(engineOnlyClaim(t)).toBe("repo");
    for (const t of ["Draft a text to Dana", "Summarise notes.md", "Write the message copy", "Write the repo notes", "Send PR to review"]) {
      expect([t, engineOnlyClaim(t)]).toEqual([t, null]);
    }
  });
});

describe("final review", () => {
  test("I1: an agent claiming done on 'Send the text to Dana' never ends up looking done", async () => {
    const space = createSpace(db, { name: "Text Dana", kind: "general", goal: "" });
    const t = createTask(db, { spaceId: space.id, title: "Send the text to Dana" });
    start({ adapter: fakeAdapter(() => ok("Here's the text: hey!\nOUTCOME: done")).adapter });
    await waitFor(() => status(t.id) === "review");
    const task = getTask(db, t.id)!;
    // What the user reads on the card must say nothing was sent, not "the agent didn't say".
    expect(outcomeText(task.outcome, task.outcomeReason)).toContain("nothing was sent");
    resolveApproval(db, approvalFor(t.id)!.id, "approve");
    // Once accepted, the task list must not show a plain done check.
    expect(outcomeLabel(getTask(db, t.id)!.outcome!)).not.toBeNull();
    expect(listActivity(db, { spaceId: space.id }).map((r) => r.message)).toContain("Accepted anyway: Send the text to Dana. It says it couldn't do this.");
  });

  test("M1: ordinary repo task titles aren't treated as sends", () => {
    for (const t of ["Text formatting fixes in the editor", "Message queue retry logic", "Email template redesign", "Send button styling", "DM inbox layout"]) {
      expect([t, engineOnlyClaim(t)]).toEqual([t, null]);
    }
  });

  test("a request for the agent's own output isn't a send", () => {
    for (const t of ["Send me a summary of notes.md", "Email Template Redesign", "Message Queue cleanup", "Let me know what's in notes.md", "Send my notes to the folder"]) {
      expect([t, engineOnlyClaim(t)]).toEqual([t, null]);
    }
  });

  test("lowercase sends, as typed in the command bar, still count", () => {
    for (const t of ["text dana that I'm late", "reach out to dana", "let dana know I'm on my way", "Text Dana"]) expect([t, engineOnlyClaim(t)]).toEqual([t, "message"]);
  });

  test("M1: a repo space never applies the send check", async () => {
    const path = repo();
    const s = repoSpace(path);
    const t = createTask(db, { spaceId: s.id, title: "Text Dana's avatar fallback" });
    start({ adapter: writesDoc().adapter });
    await waitFor(() => status(t.id) === "review");
    expect(getTask(db, t.id)!.outcome).toBe("done");
  });

  test("a repo space never applies the engine-only check", async () => {
    const path = repo();
    const s = repoSpace(path);
    const t = createTask(db, { spaceId: s.id, title: "Create a repo layout for the avatar fallback" });
    start({ adapter: writesDoc().adapter });
    await waitFor(() => status(t.id) === "review");
    expect(getTask(db, t.id)!.outcome).toBe("done");
  });
});

describe("steer", () => {
  test("a steered Claude run stops, keeps its edits on the branch and starts again with the note", async () => {
    const path = repo();
    git(path, "checkout", "-b", "feature");
    git(path, "remote", "add", "origin", "https://github.com/fakeuser/app.git");
    const s = repoSpace(path);
    const t = createTask(db, { spaceId: s.id, title: "Add a footer" });
    const dir = mkdtempSync(join(tmpdir(), "atrium-steer-"));
    process.env.FAKE_CLAUDE_MODE = "slow";
    cleanups.push(() => {
      delete process.env.FAKE_CLAUDE_MODE;
      delete process.env.FAKE_CLAUDE_STDIN;
      rmSync(dir, { recursive: true, force: true });
    });
    const r = start({ adapter: claudeAdapter(join(import.meta.dir, "../fixtures/fake-claude.ts")) });
    await waitFor(() => status(t.id) === "running" && git(path, "branch", "--show-current") === `atrium/${t.id}`, 10000);
    // What the agent had written so far.
    writeFileSync(join(path, "footer.html"), "<footer>half</footer>\n");
    // The next run answers at once and keeps a copy of its prompt.
    process.env.FAKE_CLAUDE_MODE = "ok";
    process.env.FAKE_CLAUDE_STDIN = join(dir, "stdin.txt");
    const note = "Use the brand colour for the footer links";
    expect(await r.steerTask(t.id, note)).toBe("steered");
    expect(git(path, "log", "-1", "--format=%s", `atrium/${t.id}`)).toBe("WIP (steered): Add a footer");
    expect(git(path, "show", `atrium/${t.id}:footer.html`)).toBe("<footer>half</footer>");
    expect(listActivity(db).map((a) => a.message)).toContain(`You steered: ${note}`);

    await waitFor(() => status(t.id) === "review", 15000);
    const prompt = readFileSync(join(dir, "stdin.txt"), "utf8");
    expect(prompt).toContain(`Note from you while this was running: ${note}\nThe changes made so far are already on this branch. Continue from them; don't start over.`);
    const runs = db.query("SELECT transcript_path, start_ref, remote_url FROM runs WHERE task_id = ? ORDER BY started_at, rowid").all(t.id) as {
      transcript_path: string;
      start_ref: string;
      remote_url: string;
    }[];
    expect(runs).toHaveLength(2);
    // Both runs started from the user's branch and read the remote before the agent ran.
    expect(runs.map((x) => [x.start_ref, x.remote_url])).toEqual([
      ["feature", "https://github.com/fakeuser/app.git"],
      ["feature", "https://github.com/fakeuser/app.git"],
    ]);
    expect(readFileSync(runs[1]!.transcript_path, "utf8").split("\n")[0]).toBe(`— You steered: ${note} —`);
    // Same branch, edits still there, repo back where it was.
    expect(getTask(db, t.id)!.branch).toBe(`atrium/${t.id}`);
    expect(git(path, "show", `atrium/${t.id}:footer.html`)).toBe("<footer>half</footer>");
    expect(git(path, "branch", "--show-current")).toBe("feature");
  }, 30000);

  test("steering a task that isn't running says so", async () => {
    const s = generalSpace();
    const t = createTask(db, { spaceId: s.id, title: "Not started" });
    const r = start({ adapter: fakeAdapter(async (input) => untilAborted(input)).adapter, power: async () => "battery" });
    setTaskStatus(db, t.id, "blocked", { blockedReason: "x" });
    expect(await r.steerTask(t.id, "change it")).toBe("not-running");
  });

  test("a stop that lands with a steer wins: the task ends stopped, not requeued", async () => {
    const path = repo();
    const s = repoSpace(path);
    const t = createTask(db, { spaceId: s.id, title: "Long job" });
    const r = start({ adapter: fakeAdapter(async (input) => untilAborted(input)).adapter });
    await waitFor(() => status(t.id) === "running");
    const [stopped, steered] = await Promise.all([r.stopTask(t.id), r.steerTask(t.id, "never mind")]);
    expect(stopped).toBe("stopped");
    expect(steered).toBe("not-running");
    expect(status(t.id)).toBe("blocked");
  });
});

describe("steer edge cases", () => {
  test("a second note while the first is on its way is refused as pending", async () => {
    const path = repo();
    const s = repoSpace(path);
    const t = createTask(db, { spaceId: s.id, title: "Long job" });
    let finish!: () => void;
    const gate = new Promise<void>((res) => (finish = res));
    const r = start({
      adapter: fakeAdapter(async (input) => {
        await untilAborted(input);
        await gate;
        return { status: "error", kind: "failed", message: "Stopped" };
      }).adapter,
      stopTimeoutMs: 30,
    });
    await waitFor(() => status(t.id) === "running");
    expect(await r.steerTask(t.id, "first")).toBe("timeout");
    expect(r.steerPending(t.id)).toBe(true);
    expect(await r.steerTask(t.id, "second")).toBe("pending");
    finish();
    await waitFor(() => listActivity(db).some((a) => a.message === "You steered: first"));
    expect(listActivity(db).some((a) => a.message === "You steered: second")).toBe(false);
  });

  test("a steered task whose next start is blocked drops its note's marker", async () => {
    const path = repo();
    const s = repoSpace(path);
    const t = createTask(db, { spaceId: s.id, title: "Long job" });
    const real = gitOps.repoReady;
    let calls = 0;
    const spy = spyOn(gitOps, "repoReady").mockImplementation(async (p: string) => (++calls === 1 ? real(p) : { ok: false as const, reason: "The folder moved." }));
    cleanups.push(() => spy.mockRestore());
    const r = start({ adapter: fakeAdapter(async (input) => untilAborted(input)).adapter });
    await waitFor(() => status(t.id) === "running");
    expect(await r.steerTask(t.id, "use tabs")).toBe("steered");
    await waitFor(() => status(t.id) === "blocked");
    expect(r.steerPending(t.id)).toBe(false);
  });

  test("a steered run that can't save its edits ends blocked, and the steer says so", async () => {
    const path = repo();
    const s = repoSpace(path);
    const t = createTask(db, { spaceId: s.id, title: "Long job" });
    const spy = spyOn(gitOps, "commitAll").mockImplementation(async () => {
      throw new Error("Refusing to commit: this repo uses git filters (e.g. LFS). Commit these changes yourself.");
    });
    cleanups.push(() => spy.mockRestore());
    const r = start({
      adapter: fakeAdapter(async (input) => {
        writeFileSync(join(input.cwd, "half.txt"), "half\n");
        return untilAborted(input);
      }).adapter,
    });
    await waitFor(() => status(t.id) === "running");
    expect(await r.steerTask(t.id, "use tabs")).toBe("blocked");
    expect(getTask(db, t.id)!.blockedReason).toContain("Refusing to commit");
    expect(r.steerPending(t.id)).toBe(false);
  });
});

describe("live changes", () => {
  test("a Claude file edit in a repo run tells the dashboard, throttled per task", async () => {
    const path = repo();
    const s = repoSpace(path);
    const t = createTask(db, { spaceId: s.id, title: "Edit things" });
    const seen: number[] = [];
    const off = bus.on((e) => e.type === "diff-changed" && e.taskId === t.id && seen.push(Date.now()));
    cleanups.push(off);
    runner = createRunner({
      db,
      adapters: {
        claude: fakeAdapter(async (input) => {
          input.onChunk("→ Read README.md");
          for (let i = 0; i < 5; i++) input.onChunk(`→ Edit src/file${i}.ts`);
          await Bun.sleep(150);
          input.onChunk("→ Write notes.md");
          return ok();
        }).adapter,
      },
      power: async () => "ac",
      keepAwake: fakeKeepAwake(),
      diffWatch: { windowMs: 100 },
    });
    runner.start();
    await waitFor(() => status(t.id) === "review");
    // The first edit at once, the burst behind it once the window closed, then the later write.
    expect(seen).toHaveLength(3);
    expect(seen[1]! - seen[0]!).toBeGreaterThanOrEqual(90);
  });

  test("an agent that doesn't report edits is checked on a timer only while its repo run lasts", async () => {
    const path = repo();
    const s = repoSpace(path);
    const t = createTask(db, { spaceId: s.id, title: "Codex work" });
    let n = 0;
    const off = bus.on((e) => e.type === "diff-changed" && n++);
    cleanups.push(off);
    // Registered where the task resolves, but with Codex's id, which is what decides how edits are noticed.
    const codex: AgentAdapter = { id: "codex", label: "Codex", run: async () => (await Bun.sleep(130), ok()) };
    runner = createRunner({ db, adapters: { claude: codex }, power: async () => "ac", keepAwake: fakeKeepAwake(), diffWatch: { windowMs: 10, pollMs: 40 } });
    runner.start();
    await waitFor(() => status(t.id) === "review");
    expect(n).toBeGreaterThanOrEqual(2);
    const after = n;
    await Bun.sleep(120);
    expect(n).toBe(after);
  });
});
