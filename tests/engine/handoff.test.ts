import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentAdapter, AgentRunInput, AgentRunResult } from "../../src/engine/agents/types";
import { getApproval, listPending, resolveApproval } from "../../src/engine/approvals";
import { createRule } from "../../src/engine/autonomy/rules";
import { normalizeBrief } from "../../src/engine/brief";
import { openDb } from "../../src/engine/db";
import { reviewDiff } from "../../src/engine/git";
import { createRunner } from "../../src/engine/runner";
import { createSpace, type ReviewChoice, updateSpace } from "../../src/engine/spaces";
import { createTask, getTask, listTasks } from "../../src/engine/tasks";
import { tempHome, tempRepo } from "../helpers";

const FAKE_CHECK = `bun ${join(import.meta.dir, "..", "fixtures", "fake-check.ts")}`;

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
  const r = Bun.spawnSync(["git", "-c", "user.name=Atrium Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: path });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
}

const ok = (summary: string, tokens = 1): AgentRunResult => ({ status: "ok", summary, inputTokens: tokens, outputTokens: tokens });

function fake(id: string, impl: (input: AgentRunInput, n: number) => Promise<AgentRunResult> | AgentRunResult) {
  const calls: AgentRunInput[] = [];
  const adapter: AgentAdapter = {
    id,
    label: id === "claude" ? "Claude Code" : id[0]!.toUpperCase() + id.slice(1),
    async run(input) {
      calls.push(input);
      return impl(input, calls.length);
    },
  };
  return { adapter, calls };
}

// A writer that leaves each turn's status.txt (read by the fake check) from the list, then the last one again.
function writer(statuses: string[], summary = "Changed it.\nOUTCOME: done") {
  return fake("claude", (input, n) => {
    if (input.mode === "review") return ok("Looks fine.\nVERDICT: approve");
    writeFileSync(join(input.cwd, "status.txt"), `${statuses[Math.min(n, statuses.length) - 1]}\n`);
    return ok(summary);
  });
}

function start(adapters: Record<string, AgentAdapter>) {
  runner = createRunner({ db, adapters, power: async () => "ac", keepAwake: { start() {}, stop() {}, active: () => false } });
  runner.start();
  return runner;
}

async function waitFor(cond: () => boolean, ms = 8000) {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error("timed out waiting for condition");
    await Bun.sleep(5);
  }
}

function space(path: string, opts: { reviewBy?: ReviewChoice; checks?: string | null; budget?: { tokens: number; minutes: number } } = {}) {
  const s = createSpace(db, { name: "App", kind: "repo", goal: "Ship it", repoPath: path, private: false });
  return updateSpace(db, s.id, { reviewBy: opts.reviewBy ?? "auto", checks: opts.checks === undefined ? FAKE_CHECK : opts.checks, budget: opts.budget ?? null });
}

const status = (id: string) => getTask(db, id)!.status;
const reviews = (id: string) => listTasks(db).filter((t) => t.parentTaskId === id && t.kind === "review");
const approval = (taskId: string) => listPending(db).find((a) => a.taskId === taskId);
const settled = (id: string) => ["review", "blocked", "done"].includes(status(id));

describe("checks", () => {
  test("checks that pass send the work to another vendor's review, then to you with both results", async () => {
    const path = repo();
    const s = space(path);
    const t = createTask(db, { spaceId: s.id, title: "Add totals", brief: normalizeBrief({ goal: "Show totals", acceptance: ["Totals add up"] }) });
    const claude = writer(["pass"]);
    const codex = fake("codex", () => ok("FINDING low src/a.ts:3 name could be clearer\nVERDICT: approve"));
    start({ claude: claude.adapter, codex: codex.adapter });
    await waitFor(() => status(t.id) === "review");
    // The writer is told what will judge it, as part of the brief's sections.
    expect(claude.calls[0]!.prompt).toContain("## Goal\nShow totals");
    expect(claude.calls[0]!.prompt).toContain(`\`${FAKE_CHECK}\``);
    // The reviewer gets the brief and the diff, and nothing of the writer's session.
    const reviewer = codex.calls[0]!;
    expect(reviewer.mode).toBe("review");
    expect(reviewer.prompt).toContain("## Acceptance criteria\n- Totals add up");
    expect(reviewer.prompt).toContain("+pass");
    expect(reviewer.prompt).toContain("FINDING <high|medium|low> <file>:<line>");
    expect(reviewer.prompt).not.toContain("Changed it.");
    const detail = approval(t.id)!.detail;
    expect(detail).toContain(`Checks: passed (${FAKE_CHECK}). Atrium ran them itself.`);
    expect(detail).toContain("Review by Codex: ready to merge, 1 finding.\n1. [low] src/a.ts:3 — name could be clearer");
    expect(getTask(db, t.id)!.loop!.checks).toBe("passed");
  });

  test("a failing check goes back to the writer with its output, and the next turn's pass moves it on", async () => {
    const path = repo();
    const s = space(path, { reviewBy: "off" });
    const t = createTask(db, { spaceId: s.id, title: "Add totals" });
    const claude = writer(["wrong", "pass"]);
    start({ claude: claude.adapter });
    await waitFor(() => status(t.id) === "review");
    expect(claude.calls).toHaveLength(2);
    expect(claude.calls[1]!.prompt).toContain("## Atrium's checks failed after your last turn");
    expect(claude.calls[1]!.prompt).toContain('expected "pass", got "wrong"');
    expect(getTask(db, t.id)!.loop!.checks).toBe("passed");
    // The writer's own claim never counts: a fake that said done on the failing turn still went back.
    expect(git(path, "status", "--porcelain")).toBe("");
  });

  test("with no checks to run, the result is marked unverified and still reviewed", async () => {
    const path = repo();
    const s = space(path, { checks: null });
    const t = createTask(db, { spaceId: s.id, title: "Edit notes" });
    const claude = writer(["anything"]);
    start({ claude: claude.adapter });
    await waitFor(() => status(t.id) === "review");
    const detail = approval(t.id)!.detail;
    expect(detail).toContain("Unverified: no checks found.");
    // Only Claude is installed, so a fresh Claude session reviews.
    expect(detail).toContain("Review by Claude: ready to merge.");
    expect(claude.calls.map((c) => c.mode)).toEqual(["work", "review"]);
  });

  test("a turn that changes nothing has nothing to check or review", async () => {
    const path = repo();
    const s = space(path);
    const t = createTask(db, { spaceId: s.id, title: "Look around" });
    start({ claude: fake("claude", () => ok("Nothing needed.\nOUTCOME: done")).adapter });
    await waitFor(() => status(t.id) === "review");
    expect(reviews(t.id)).toHaveLength(0);
    expect(approval(t.id)!.detail).toContain("Checks: nothing to check, since there are no file changes.");
  });
});

describe("review rounds", () => {
  test("findings go back to the writer, who answers each; at most two rounds, then you", async () => {
    const path = repo();
    const s = space(path, { checks: null });
    const t = createTask(db, { spaceId: s.id, title: "Add totals" });
    let turn = 0;
    const claude = fake("claude", (input) => {
      turn++;
      writeFileSync(join(input.cwd, "status.txt"), `turn ${turn}\n`);
      return ok(turn === 1 ? "Added totals.\nOUTCOME: done" : "Handled it.\nTRIAGE 1 fixed - added the guard\nOUTCOME: done");
    });
    const codex = fake("codex", () => ok("FINDING high status.txt:1 misses empty input\nVERDICT: changes"));
    start({ claude: claude.adapter, codex: codex.adapter });
    await waitFor(() => status(t.id) === "review");
    expect(codex.calls).toHaveLength(2);
    expect(claude.calls).toHaveLength(3);
    expect(claude.calls[1]!.prompt).toContain("## Review findings");
    expect(claude.calls[1]!.prompt).toContain("1. [high] status.txt:1 — misses empty input");
    const detail = approval(t.id)!.detail;
    expect(detail).toContain("Review round 1 by Codex: asked for changes, 1 finding.\n1. [high] status.txt:1 — misses empty input → fixed: added the guard");
    expect(detail).toContain("Review round 2 by Codex");
    expect(detail).not.toContain("TRIAGE");
    expect(detail.startsWith("Handled it.")).toBe(true);
  });

  test("a writer that declines everything isn't reviewed again on the same code", async () => {
    const path = repo();
    const s = space(path, { checks: null });
    const t = createTask(db, { spaceId: s.id, title: "Add totals" });
    const claude = fake("claude", (input, n) => {
      if (n === 1) writeFileSync(join(input.cwd, "status.txt"), "v1\n");
      return ok(n === 1 ? "Added.\nOUTCOME: done" : "Kept it.\nTRIAGE 1 declined - the brief asks for this name\nOUTCOME: done");
    });
    const codex = fake("codex", () => ok("FINDING medium - rename it\nVERDICT: changes"));
    start({ claude: claude.adapter, codex: codex.adapter });
    await waitFor(() => status(t.id) === "review");
    expect(codex.calls).toHaveLength(1);
    expect(approval(t.id)!.detail).toContain("1. [medium] rename it → declined: the brief asks for this name");
  });

  test("an auto review avoids the writer's vendor; an explicit one is kept even when it's the writer", async () => {
    const path = repo();
    const s = space(path, { checks: null });
    const t = createTask(db, { spaceId: s.id, title: "Add totals", agent: "codex" });
    const codex = fake("codex", (input) => {
      if (input.mode === "work") writeFileSync(join(input.cwd, "status.txt"), "x\n");
      return ok(input.mode === "work" ? "Done.\nOUTCOME: done" : "VERDICT: approve");
    });
    const claude = fake("claude", () => ok("Fine.\nVERDICT: approve"));
    start({ claude: claude.adapter, codex: codex.adapter });
    await waitFor(() => status(t.id) === "review");
    expect(claude.calls.map((c) => c.mode)).toEqual(["review"]);
    expect(codex.calls.map((c) => c.mode)).toEqual(["work"]);
  });

  test("a reviewer the space shuts out is skipped and the work goes on to you", async () => {
    const path = repo();
    const s = space(path, { checks: null, reviewBy: "codex" });
    updateSpace(db, s.id, { private: true });
    const t = createTask(db, { spaceId: s.id, title: "Add totals" });
    start({ claude: writer(["x"]).adapter, codex: fake("codex", () => ok("VERDICT: approve")).adapter });
    await waitFor(() => status(t.id) === "review");
    expect(approval(t.id)!.detail).toContain("Review: Codex's review didn't happen. Codex can't work here: this space is private");
  });

  test("sending the work back starts a new attempt with its own review rounds", async () => {
    const path = repo();
    const s = space(path, { checks: null });
    const t = createTask(db, { spaceId: s.id, title: "Add totals" });
    let turn = 0;
    const claude = fake("claude", (input) => {
      if (input.mode === "review") return ok("VERDICT: approve");
      writeFileSync(join(input.cwd, "status.txt"), `v${++turn}\n`);
      return ok("Done.\nOUTCOME: done");
    });
    start({ claude: claude.adapter });
    await waitFor(() => status(t.id) === "review");
    resolveApproval(db, approval(t.id)!.id, "reject", "Use a table");
    await waitFor(() => status(t.id) === "review" && reviews(t.id).length === 2);
    expect(getTask(db, t.id)!.loop!.reviews).toHaveLength(1);
  });
});

describe("pauses", () => {
  test("the same failure twice pauses with a diagnosis; a hint carries on and an explanation changes nothing", async () => {
    const path = repo();
    const s = space(path, { reviewBy: "off" });
    const t = createTask(db, { spaceId: s.id, title: "Add totals" });
    let explained = false;
    const claude = fake("claude", (input) => {
      if (input.mode === "review") {
        explained = true;
        return ok("The test expects the file to say pass; nothing writes it.");
      }
      const hinted = input.prompt.includes("Hint from you after a pause: write pass");
      writeFileSync(join(input.cwd, "status.txt"), hinted ? "pass\n" : "wrong\n");
      // A new commit each turn, so the check runs again and fails the same way.
      writeFileSync(join(input.cwd, "attempt.txt"), `${claude.calls.length}\n`);
      return ok("Tried.\nOUTCOME: done");
    });
    const r = start({ claude: claude.adapter });
    await waitFor(() => status(t.id) === "blocked");
    const paused = getTask(db, t.id)!;
    expect(paused.blockedReason).toBe(`Paused: The same check failed the same way twice in a row (${FAKE_CHECK}).`);
    expect(paused.loop!.paused!.kind).toBe("loop");

    const { loopRoute } = await import("../../src/server/loop");
    const call = (path: string, body: unknown = {}) =>
      loopRoute(db, undefined, r.kick, new Request(`http://127.0.0.1/api/tasks/${t.id}/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), new URL(`http://127.0.0.1/api/tasks/${t.id}/${path}`));
    await call("explain");
    await waitFor(() => explained && status(t.id) === "blocked");
    const after = getTask(db, t.id)!;
    expect(after.loop!.explanation).toBe("The test expects the file to say pass; nothing writes it.");
    // It reads and runs nothing: no edits, no Bash, with the branch's commits and diff handed to it instead.
    const explain = claude.calls.at(-1)!;
    expect(explain.allowedTools).toEqual(["Read", "Glob", "Grep"]);
    expect(explain.prompt).toContain("Commits on this branch:");
    expect(explain.prompt).toContain("+wrong");
    expect(after.blockedReason).toContain("It explained the problem below");

    await call("hint", { note: "write pass" });
    await waitFor(() => status(t.id) === "review");
    expect(getTask(db, t.id)!.loop!.checks).toBe("passed");
  });

  test("going over the token budget pauses instead of trying again", async () => {
    const path = repo();
    const s = space(path, { reviewBy: "off", budget: { tokens: 10, minutes: 30 } });
    const t = createTask(db, { spaceId: s.id, title: "Add totals" });
    const claude = fake("claude", (input) => {
      writeFileSync(join(input.cwd, "status.txt"), "wrong\n");
      return ok("Tried.\nOUTCOME: done", 20);
    });
    start({ claude: claude.adapter });
    await waitFor(() => status(t.id) === "blocked");
    expect(claude.calls).toHaveLength(1);
    expect(getTask(db, t.id)!.blockedReason).toBe("Paused: It used 40 tokens, its budget.");
  });

  test("an agent repeating the same edit is stopped mid-run and paused", async () => {
    const path = repo();
    const s = space(path, { reviewBy: "off" });
    const t = createTask(db, { spaceId: s.id, title: "Add totals" });
    const claude = fake("claude", async (input) => {
      writeFileSync(join(input.cwd, "status.txt"), "half\n");
      for (let i = 0; i < 3; i++) input.onTool?.("Edit", { file_path: "status.txt", old_string: "a", new_string: "b" });
      if (!input.signal?.aborted) await new Promise((r) => input.signal?.addEventListener("abort", r));
      return { status: "error", kind: "failed", message: "Stopped" };
    });
    start({ claude: claude.adapter });
    await waitFor(() => status(t.id) === "blocked");
    const task = getTask(db, t.id)!;
    expect(task.blockedReason).toContain("Paused: It made the same edit (status.txt) 3 times.");
    expect(task.blockedReason).toContain(`WIP commit on atrium/${t.id}`);
  });
});

describe("changes to the checks themselves", () => {
  function yesRule(spaceId: string) {
    db.query("INSERT INTO autonomy_proposals (id, space_id, fingerprint, evidence, status, created_at, answered_at) VALUES ('prp_x', ?, 'v1:code:docs:small:claude', '[]', 'yes', 1, 1)").run(spaceId);
    return createRule(db, "prp_x", Date.now() - 1000);
  }

  // Writes a plain doc, which a docs rule covers, and when asked also marks a test as skipped in it.
  const docsWriter = (skip: boolean) =>
    fake("claude", (input) => {
      mkdirSync(join(input.cwd, "docs"), { recursive: true });
      writeFileSync(join(input.cwd, "docs", "a.md"), skip ? "one\ntwo\nUse test.skip( on the slow ones.\n" : "one\ntwo\nthree\nfour\nfive\n");
      return ok("Added a note.\nOUTCOME: done");
    });

  test("a change that edits how checks run is flagged to the reviewer and to you", async () => {
    const path = repo();
    const s = space(path, { checks: null });
    const t = createTask(db, { spaceId: s.id, title: "Add totals" });
    const claude = fake("claude", (input) => {
      writeFileSync(join(input.cwd, "package.json"), '{"scripts":{"test":"exit 0"}}\n');
      return ok("Done.\nOUTCOME: done");
    });
    const codex = fake("codex", () => ok("VERDICT: approve"));
    start({ claude: claude.adapter, codex: codex.adapter });
    await waitFor(() => status(t.id) === "review");
    expect(codex.calls[0]!.prompt).toContain("## Look closely\nAtrium noticed this change touches its own checks.");
    expect(codex.calls[0]!.prompt).toContain("This change edits how checks run: package.json.");
    expect(approval(t.id)!.detail).toContain("Look closely:\n- This change edits how checks run: package.json.");
  });

  test("a note on the checks keeps a matching rule from approving it", async () => {
    const s = space(repo(), { checks: null });
    yesRule(s.id);
    const t = createTask(db, { spaceId: s.id, title: "Add a note" });
    start({ claude: docsWriter(true).adapter, codex: fake("codex", () => ok("VERDICT: approve")).adapter });
    await waitFor(() => settled(t.id));
    // Stopping waits for the run in hand, rules included, so what's left is what the rules decided.
    await runner!.stop();
    runner = null;
    expect(status(t.id)).toBe("review");
    expect(getTask(db, t.id)!.loop!.attention).toEqual(["This change marks tests as skipped."]);
    // The rule's kind matches; only the note keeps it waiting.
    expect(getApproval(db, approval(t.id)!.id)!.fingerprint).toBe("v1:code:docs:small:claude");
  });

  test("the same change without a note is approved by the rule", async () => {
    const s = space(repo(), { checks: null });
    yesRule(s.id);
    const t = createTask(db, { spaceId: s.id, title: "Add a note" });
    start({ claude: docsWriter(false).adapter, codex: fake("codex", () => ok("VERDICT: approve")).adapter });
    await waitFor(() => status(t.id) === "done");
  });

});

describe("review diffs", () => {
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
    const { diff, files, truncated } = await reviewDiff(path, "main", "atrium/tsk_x");
    expect(truncated).toBe(true);
    expect(diff).not.toContain("SECRET");
    expect(diff).not.toMatch(/\.env/i);
    expect(diff).toContain("+visible");
    expect(files).toBe(2);
    expect(diff.split("\n").at(-1)).toMatch(/^\[The rest of the diff was cut at 60 KB/);
    expect(Buffer.byteLength(diff)).toBeLessThan(60 * 1024 + 200);
  });

  test("a single line over 60 KB is cut at a character boundary, not dropped", async () => {
    const path = repo();
    git(path, "checkout", "-b", "atrium/tsk_y");
    writeFileSync(join(path, "wide.txt"), "é".repeat(40_000));
    git(path, "add", "-A");
    git(path, "commit", "-m", "wide");
    git(path, "checkout", "main");
    const { diff, truncated } = await reviewDiff(path, "main", "atrium/tsk_y");
    expect(truncated).toBe(true);
    expect(diff).toContain("éééé");
    expect(diff).not.toContain("�");
  });
});
