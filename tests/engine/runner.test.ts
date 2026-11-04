import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentAdapter, AgentRunInput, AgentRunResult } from "../../src/engine/agents/types";
import { listPending } from "../../src/engine/approvals";
import { openDb } from "../../src/engine/db";
import { bus, listActivity } from "../../src/engine/events";
import { createRunner, recoverOnBoot } from "../../src/engine/runner";
import { getSetting, setSetting } from "../../src/engine/settings";
import { createSpace, updateSpace } from "../../src/engine/spaces";
import { createTask, getTask, setTaskStatus } from "../../src/engine/tasks";
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

function start(opts: {
  adapter: AgentAdapter;
  power?: () => Promise<"ac" | "battery">;
  keepAwake?: ReturnType<typeof fakeKeepAwake>;
}) {
  runner = createRunner({
    db,
    adapters: { claude: opts.adapter },
    power: opts.power ?? (async () => "ac"),
    keepAwake: opts.keepAwake ?? fakeKeepAwake(),
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
  expect(calls[0]!.systemPrompt).toContain("Never push or merge");
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
    git(input.cwd, "add", "new.txt");
    git(input.cwd, "commit", "-m", "add new");
    return ok("Added new.txt.");
  });
  start({ adapter });
  await waitFor(() => status(t.id) === "review");

  const task = getTask(db, t.id)!;
  expect(task.branch).toBe("atrium/" + task.id);
  expect(git(path, "branch", "--show-current")).toBe("atrium/" + task.id);
  expect(calls[0]!.cwd).toBe(path);
  expect(calls[0]!.allowedTools).toEqual([
    "Read", "Edit", "Write", "Glob", "Grep",
    "Bash(bun test*)", "Bash(bun run *)", "Bash(bun install*)", "Bash(bunx tsc*)",
    "Bash(git add *)", "Bash(git commit *)", "Bash(git status*)", "Bash(git diff*)", "Bash(git log*)",
  ]);
  const [a] = listPending(db);
  expect(a!.detail).toContain("Added new.txt.");
  expect(a!.detail).toContain(`1 commit, 1 file (+1 −0) on atrium/${task.id}`);
  expect(a!.detail).toContain("No remote configured");
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
  // Deleting the starting branch makes branchSummary fail.
  const { adapter } = fakeAdapter((input) => {
    git(input.cwd, "branch", "-D", "main");
    return ok("Renamed things.");
  });
  start({ adapter });
  await waitFor(() => status(t.id) === "review");
  const [a] = listPending(db);
  expect(a!.detail).toContain("Renamed things.");
  expect(a!.detail).toContain("Couldn't summarise the changes on atrium/");
});

test("heavy task waits on battery and stays queued with reason in runner.waiting", async () => {
  const s = generalSpace();
  const t = createTask(db, { spaceId: s.id, title: "Big job", weight: "heavy" });
  const { adapter, calls } = fakeAdapter();
  start({ adapter, power: async () => "battery" });
  await waitFor(() => getSetting(db, "runner.waiting") !== null);

  expect(JSON.parse(getSetting(db, "runner.waiting")!)).toEqual({
    taskId: t.id,
    reason: "Waiting for power: heavy work runs when plugged in",
  });
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
  await waitFor(() => getSetting(db, "runner.waiting") !== null);
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
  await waitFor(() => getSetting(db, "runner.pausedUntil") !== null);
  r.kick();
  await Bun.sleep(50);

  expect(getSetting(db, "runner.pausedUntil")).toBe(String(retryAfter));
  expect(calls).toHaveLength(1);
  expect(status(first.id)).toBe("queued");
  expect(status(second.id)).toBe("queued");
});

test("runner resumes once pausedUntil has passed", async () => {
  const s = generalSpace();
  const t = createTask(db, { spaceId: s.id, title: "One" });
  setSetting(db, "runner.pausedUntil", String(Date.now() - 1000));
  const { adapter } = fakeAdapter();
  start({ adapter });
  await waitFor(() => status(t.id) === "review");
});

test("recoverOnBoot requeues running tasks", () => {
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

  expect(recoverOnBoot(db)).toBe(1);
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

test("an error after a run is logged instead of crashing the engine", async () => {
  const s = generalSpace();
  const t = createTask(db, { spaceId: s.id, title: "Moved away" });
  // Requeueing mid-run makes the final running→review move invalid.
  const { adapter } = fakeAdapter(() => {
    setTaskStatus(db, t.id, "queued");
    setTaskStatus(db, t.id, "blocked", { blockedReason: "held" });
    return ok();
  });
  start({ adapter });
  await waitFor(() => listActivity(db).some((r) => r.message.startsWith("Runner error:")));
  const run = db.query("SELECT * FROM runs WHERE task_id = ?").get(t.id) as any;
  expect(run.exit_code).toBe(0);
});
