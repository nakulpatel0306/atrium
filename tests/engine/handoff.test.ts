import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentAdapter, AgentRunInput, AgentRunResult } from "../../src/engine/agents/types";
import { createApproval, listPending, resolveApproval } from "../../src/engine/approvals";
import { openDb } from "../../src/engine/db";
import { listActivity } from "../../src/engine/events";
import { reviewDiff } from "../../src/engine/git";
import { afterReview } from "../../src/engine/handoff";
import { listMessages } from "../../src/engine/messages";
import { createRunner } from "../../src/engine/runner";
import { createSpace, updateSpace } from "../../src/engine/spaces";
import { createTask, getTask, listTasks, setTaskStatus, type Task } from "../../src/engine/tasks";
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

const ok = (summary: string): AgentRunResult => ({ status: "ok", summary, inputTokens: 1, outputTokens: 1 });

function fake(id: string, label: string, impl: (input: AgentRunInput) => Promise<AgentRunResult> | AgentRunResult) {
  const calls: AgentRunInput[] = [];
  const adapter: AgentAdapter = {
    id,
    label,
    async run(input) {
      calls.push(input);
      return impl(input);
    },
  };
  return { adapter, calls };
}

// The worker writes a file on a work run and another on a fix run.
function worker() {
  return fake("claude", "Claude Code", (input) => {
    const name = input.prompt.startsWith("Task: Fix:") ? "fix.txt" : "new.txt";
    writeFileSync(join(input.cwd, name), "hello\n");
    return ok(name === "fix.txt" ? "Fixed the null check." : "Added new.txt.");
  });
}

function start(adapters: Record<string, AgentAdapter>) {
  runner = createRunner({
    db,
    adapters,
    power: async () => "ac",
    keepAwake: { start() {}, stop() {}, active: () => false },
  });
  runner.start();
  return runner;
}

async function waitFor(cond: () => boolean, ms = 4000) {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error("timed out waiting for condition");
    await Bun.sleep(5);
  }
}

function reviewSpace(path: string, reviewBy: "codex" | "gemini" | "claude" | null = "codex") {
  const s = createSpace(db, { name: "App", kind: "repo", goal: "Ship it", repoPath: path, private: false });
  return updateSpace(db, s.id, { reviewBy });
}

const children = (parentId: string, kind?: Task["kind"]) =>
  listTasks(db).filter((t) => t.parentTaskId === parentId && (!kind || t.kind === kind));
const status = (id: string) => getTask(db, id)!.status;

test("work with commits queues a review to review_by", async () => {
  const path = repo();
  const s = reviewSpace(path);
  const t = createTask(db, { spaceId: s.id, title: "Add file", agent: "claude" });
  const codex = fake("codex", "Codex", () => ok("Looks fine.\nVERDICT: approve"));
  start({ claude: worker().adapter, codex: codex.adapter });
  await waitFor(() => children(t.id, "review").some((c) => c.status === "done"));

  const [review] = children(t.id, "review");
  expect(review).toMatchObject({ agent: "codex", weight: "light", allowOnBattery: true, kind: "review" });
  expect(review!.detail).toContain("+hello");
  expect(review!.detail).toContain("VERDICT: approve");
  expect(review!.detail).toContain("VERDICT: changes");

  expect(codex.calls).toHaveLength(1);
  expect(codex.calls[0]!.mode).toBe("review");
  expect(codex.calls[0]!.prompt).toContain("+hello");
  // The reviewer gets an empty scratch folder, never the repo, and it's gone afterwards.
  expect(codex.calls[0]!.cwd).not.toBe(path);
  expect(existsSync(codex.calls[0]!.cwd)).toBe(false);
  expect(git(path, "branch", "--list", `atrium/${review!.id}`)).toBe("");

  const [first] = listMessages(db, t.id);
  expect(first).toMatchObject({ fromAgent: "claude", toAgent: "codex", body: `Please review 1 file on atrium/${t.id}.` });
});

test("no review when review_by is unset", async () => {
  const path = repo();
  const s = reviewSpace(path, null);
  const t = createTask(db, { spaceId: s.id, title: "Add file", agent: "claude" });
  start({ claude: worker().adapter });
  await waitFor(() => status(t.id) === "review");
  expect(children(t.id)).toHaveLength(0);
  expect(listMessages(db, t.id)).toHaveLength(0);
});

test("no review when the run made no commits", async () => {
  const path = repo();
  const s = reviewSpace(path);
  const t = createTask(db, { spaceId: s.id, title: "Look around", agent: "claude" });
  const idle = fake("claude", "Claude Code", () => ok("Nothing to change."));
  start({ claude: idle.adapter, codex: fake("codex", "Codex", () => ok("x")).adapter });
  await waitFor(() => status(t.id) === "review");
  expect(children(t.id)).toHaveLength(0);
});

test("no review by the same agent that did the work", async () => {
  const path = repo();
  const s = reviewSpace(path, "claude");
  const t = createTask(db, { spaceId: s.id, title: "Add file", agent: "claude" });
  start({ claude: worker().adapter });
  await waitFor(() => status(t.id) === "review");
  expect(children(t.id)).toHaveLength(0);
});

test("review diff excludes .env paths and is capped at 60 KB", async () => {
  const path = repo();
  git(path, "checkout", "-b", "atrium/tsk_x");
  mkdirSync(join(path, "config"));
  writeFileSync(join(path, "config", ".env.local"), "SECRET=1\n");
  writeFileSync(join(path, "prod.env"), "SECRET=2\n");
  writeFileSync(join(path, ".ENV"), "SECRET=3\n");
  writeFileSync(join(path, "small.txt"), "visible\n");
  writeFileSync(join(path, "zbig.txt"), "x".repeat(100) + "\n" + "y\n".repeat(50_000));
  git(path, "add", "-A");
  git(path, "commit", "-m", "mixed");
  git(path, "checkout", "main");

  const { diff, files } = await reviewDiff(path, "main", "atrium/tsk_x");
  expect(diff).not.toContain("SECRET");
  expect(diff).not.toMatch(/\.env/i);
  expect(diff).toContain("+visible");
  expect(files).toBe(2);
  const lines = diff.split("\n");
  expect(lines.at(-1)).toMatch(/^\[The rest of the diff was cut at 60 KB/);
  expect(Buffer.byteLength(diff)).toBeLessThan(60 * 1024 + 200);
});

test("approve verdict appends the review to the approval", async () => {
  const path = repo();
  const s = reviewSpace(path);
  const t = createTask(db, { spaceId: s.id, title: "Add file", agent: "claude" });
  const codex = fake("codex", "Codex", () => ok("Clean change, tests cover it.\nVERDICT: approve"));
  start({ claude: worker().adapter, codex: codex.adapter });
  await waitFor(() => children(t.id, "review").some((c) => c.status === "done"));

  const [a] = listPending(db);
  expect(a!.taskId).toBe(t.id);
  expect(a!.detail).toContain("**Codex reviewed:** Clean change, tests cover it.");
  expect(children(t.id, "fix")).toHaveLength(0);
  expect(listMessages(db, t.id).at(-1)).toMatchObject({
    fromAgent: "codex",
    toAgent: "claude",
    body: "Clean change, tests cover it.\nVERDICT: approve",
  });
});

test("changes verdict queues one fix on the same branch; a second changes verdict does not queue another", async () => {
  const path = repo();
  const s = reviewSpace(path);
  const t = createTask(db, { spaceId: s.id, title: "Add file", agent: "auto" });
  const claude = worker();
  const verdict = "new.txt has no trailing newline check.\nVERDICT: changes";
  start({ claude: claude.adapter, codex: fake("codex", "Codex", () => ok(verdict)).adapter });
  await waitFor(() => children(t.id, "fix").some((c) => c.status === "done"));

  const [fix] = children(t.id, "fix");
  expect(fix).toMatchObject({ agent: "claude", kind: "fix", status: "done" });
  expect(fix!.detail).toContain("new.txt has no trailing newline check.");
  const fixCall = claude.calls.find((c) => c.prompt.startsWith("Task: Fix:"))!;
  expect(fixCall.cwd).toBe(path);
  expect(fixCall.mode).toBe("work");

  // Both commits sit on the parent's branch; no branch was made for the fix.
  expect(git(path, "rev-list", "--count", `main..atrium/${t.id}`)).toBe("2");
  expect(git(path, "show", `atrium/${t.id}:fix.txt`)).toBe("hello");
  expect(git(path, "branch", "--list", `atrium/${fix!.id}`)).toBe("");
  expect(git(path, "branch", "--show-current")).toBe("main");

  const [a] = listPending(db);
  expect(a!.taskId).toBe(t.id);
  expect(a!.detail).toContain("Fix in progress");
  expect(a!.detail).toContain("Fixed the null check.");
  expect(a!.detail).toContain(`2 commits, 2 files (+2 −0) on atrium/${t.id}`);
  expect(children(t.id, "review")).toHaveLength(1);

  const [review] = children(t.id, "review");
  afterReview(db, review!, ok("Still wrong.\nVERDICT: changes"));
  expect(children(t.id, "fix")).toHaveLength(1);
});

test("resolving the parent cancels pending review and fix tasks", () => {
  const s = createSpace(db, { name: "App", kind: "general", goal: "" });
  const parent = createTask(db, { spaceId: s.id, title: "Work" });
  setTaskStatus(db, parent.id, "running");
  setTaskStatus(db, parent.id, "review");
  const a = createApproval(db, { spaceId: s.id, taskId: parent.id, kind: "review", title: "Work", detail: "" });
  const review = createTask(db, { spaceId: s.id, title: "Review: Work", kind: "review", parentTaskId: parent.id, agent: "codex" });
  const fix = createTask(db, { spaceId: s.id, title: "Fix: Work", kind: "fix", parentTaskId: parent.id, agent: "claude" });
  setTaskStatus(db, fix.id, "blocked", { blockedReason: "x" });

  resolveApproval(db, a.id, "approve");
  expect(status(parent.id)).toBe("done");
  expect(status(review.id)).toBe("done");
  expect(status(fix.id)).toBe("done");
  const skipped = listActivity(db, { spaceId: s.id }).filter((r) => r.message.startsWith("Skipped: you already decided"));
  expect(skipped).toHaveLength(2);
});

test("engine stop during review requeues the review and leaves the parent approval pending", async () => {
  const path = repo();
  const s = reviewSpace(path);
  const t = createTask(db, { spaceId: s.id, title: "Add file", agent: "claude" });
  let started = false;
  const codex = fake(
    "codex",
    "Codex",
    (input) =>
      new Promise((resolve) => {
        started = true;
        input.signal!.addEventListener("abort", () => resolve({ status: "error", kind: "failed", message: "killed" }));
      }),
  );
  const r = start({ claude: worker().adapter, codex: codex.adapter });
  await waitFor(() => started);
  const before = listPending(db)[0]!.detail;
  await r.stop();
  runner = null;

  const [review] = children(t.id, "review");
  expect(review!.status).toBe("queued");
  const [a] = listPending(db);
  expect(a!.taskId).toBe(t.id);
  expect(a!.detail).toBe(before);
});

test("a review the secret guard refuses is skipped with a message and the approval untouched", async () => {
  const path = repo();
  const s = reviewSpace(path);
  const t = createTask(db, { spaceId: s.id, title: "Add file", agent: "claude" });
  const claude = worker();
  // The work run makes the space private, so Codex may no longer see it when the review comes up.
  const original = claude.adapter.run;
  claude.adapter.run = async (input) => {
    const res = await original(input);
    updateSpace(db, s.id, { private: true });
    return res;
  };
  const codex = fake("codex", "Codex", () => ok("x"));
  start({ claude: claude.adapter, codex: codex.adapter });
  await waitFor(() => children(t.id, "review").some((c) => c.status === "done"));

  expect(codex.calls).toHaveLength(0);
  const last = listMessages(db, t.id).at(-1)!;
  expect(last.fromAgent).toBe("atrium");
  expect(last.body).toContain("this space is private");
  const [a] = listPending(db);
  expect(a!.detail).not.toContain("reviewed:");
});

test("a failed review adds a message and leaves the approval untouched", async () => {
  const path = repo();
  const s = reviewSpace(path);
  const t = createTask(db, { spaceId: s.id, title: "Add file", agent: "claude" });
  const codex = fake("codex", "Codex", () => ({ status: "error", kind: "failed", message: "Codex crashed" }));
  start({ claude: worker().adapter, codex: codex.adapter });
  await waitFor(() => children(t.id, "review").some((c) => c.status === "blocked"));

  expect(listMessages(db, t.id).at(-1)!.body).toContain("Codex crashed");
  const [a] = listPending(db);
  expect(a!.detail).not.toContain("reviewed:");
  expect(a!.detail).not.toContain("Fix in progress");
});
