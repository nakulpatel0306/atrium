import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentRunInput } from "../../src/engine/agents/types";
import { listPending } from "../../src/engine/approvals";
import { childrenOf, childState, discardFanout, FanoutRefused, mergeParts, pickAttempt, restartAs } from "../../src/engine/fanout";
import { asksBeforeStarting } from "../../src/engine/needs";
import { newLoop, SIZE_BUDGETS } from "../../src/engine/loop";
import { normalizeBrief } from "../../src/engine/brief";
import { chooseShape, proposeShape, runNow, type ShapeKind } from "../../src/engine/shape";
import { getSpace } from "../../src/engine/spaces";
import { createTask, getTask, setTaskLoop } from "../../src/engine/tasks";
import { updateSpace } from "../../src/engine/spaces";
import { FAKE_CHECK, fake, git, loopHarness, ok, waitFor } from "./loop-harness";

const h = loopHarness();

// A task that starts with its brief's pre-pass, as Enter makes one.
function asked(spaceId: string, title: string) {
  const t = createTask(h.db, { spaceId, title, detail: title });
  return setTaskLoop(h.db, t.id, { ...newLoop(SIZE_BUDGETS.medium), stage: "brief" });
}

const PARTS = [
  { title: "Add the endpoint", goal: "Serve totals", files: ["api.txt"] },
  { title: "Write the docs", goal: "Document totals", files: ["docs.txt"] },
];

// A task the user chose a costlier shape for, as the ⌘↩ card or the switch on a running task leaves it: its brief and
// the approved shape, ready to fan out.
function chosen(spaceId: string, title: string, raw: { kind: string } & Record<string, unknown>) {
  const ctx = { size: "medium" as const, checksFound: true };
  const t = createTask(h.db, { spaceId, title, detail: title, brief: normalizeBrief({ goal: title, size: "medium" }) });
  const shape = chooseShape(proposeShape(raw, ctx), raw.kind as ShapeKind, ctx, title);
  return setTaskLoop(h.db, t.id, { ...newLoop(SIZE_BUDGETS.medium), shape });
}

// Claude as the pre-pass (proposing `shape`), the writer of each part or attempt, and the judge.
function claudeFor(shape: unknown, write: (input: AgentRunInput, n: number) => void = () => {}, judge = "SCORE 1 6 fine\nSCORE 2 9 cleaner") {
  let writes = 0;
  return fake("claude", (input) => {
    if (input.prompt.includes("Write the brief as JSON")) return ok(JSON.stringify({ goal: "Totals", size: "medium", acceptance: ["It works"], shape }));
    if (input.prompt.includes("Several attempts at the same task")) return ok(judge);
    if (input.mode === "review") return ok("Fine.\nVERDICT: approve");
    writes++;
    write(input, writes);
    return ok("Did my part.\nOUTCOME: done");
  });
}

describe("router", () => {
  test("a single or scouts proposal runs at once; nothing waits for the user", async () => {
    const s = h.space(h.repo());
    const t = asked(s.id, "Fix the typo");
    const claude = claudeFor({ kind: "scouts", reason: "find every caller first", scouts: ["Where is total() called?"] }, (input) => writeFileSync(join(input.cwd, "work.txt"), "x\n"));
    h.start({ claude: claude.adapter });
    await waitFor(() => h.status(t.id) === "review");
    expect(h.task(t.id).loop!.shape).toMatchObject({ kind: "scouts", reason: "find every caller first", approved: false });
  });

  test("a costlier proposal doesn't hold Enter back: the task runs as one writer at once, with the suggestion kept", async () => {
    const s = h.space(h.repo());
    const t = asked(s.id, "Totals everywhere");
    const claude = claudeFor({ kind: "split", reason: "two independent pieces", parts: PARTS }, (input) => writeFileSync(join(input.cwd, "work.txt"), "x\n"));
    h.start({ claude: claude.adapter });
    await waitFor(() => h.status(t.id) === "review");
    const loop = h.task(t.id).loop!;
    expect(loop.shape).toMatchObject({ kind: "single", proposed: "split", approved: false });
    expect(asksBeforeStarting(h.task(t.id))).toBe(false);
    expect(childrenOf(h.db, h.task(t.id))).toEqual([]);
    expect(claude.calls.filter((c) => c.mode === "work")).toHaveLength(1);
  });

  test("taking the suggestion stops the one writer and starts over from the brief as the parts", async () => {
    const path = h.repo();
    const s = h.space(path);
    const t = asked(s.id, "Totals everywhere");
    const claude = claudeFor({ kind: "split", reason: "two independent pieces", parts: PARTS }, () => {});
    const writer = fake("claude", async (input, n) => {
      // The single writer's turn waits until it's stopped; the parts' turns write their files.
      if (input.mode === "work" && !input.prompt.includes("Part ") && n === 2) {
        writeFileSync(join(input.cwd, "work.txt"), "half\n");
        await new Promise<void>((r) => (input.signal!.aborted ? r() : input.signal!.addEventListener("abort", () => r())));
        return { status: "error", kind: "failed", message: "Stopped" };
      }
      if (input.mode === "work") writeFileSync(join(input.cwd, input.prompt.includes("Serve totals") ? "api.txt" : "docs.txt"), "x\n");
      return claude.adapter.run(input);
    });
    h.start({ claude: writer.adapter });
    await waitFor(() => h.status(t.id) === "running" && h.task(t.id).loop?.stage === "writing");
    const { loopRoute } = await import("../../src/server/loop");
    const url = `http://127.0.0.1/api/tasks/${t.id}/shape`;
    const res = await loopRoute(h.db, undefined, h.runner!.kick, h.runner!.stopTask, new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "split" }) }), new URL(url));
    expect(res!.status).toBe(200);
    await waitFor(() => h.task(t.id).loop?.stage === "pick", 20000);
    expect(childrenOf(h.db, h.task(t.id)).map((c) => c.title)).toEqual(["Add the endpoint", "Write the docs"]);
    // The one writer's branch went, so the merge can take its name.
    expect(git(path, "branch", "--list", `atrium/${t.id}`)).toBe("");
    expect(h.task(t.id).loop!.shape).toMatchObject({ kind: "split", approved: true });
  }, 30000);
});

describe("split", () => {
  test("approved parts run as their own tasks on their own branches, then merge into one branch that's checked", async () => {
    const path = h.repo();
    const s = h.space(path);
    const t = chosen(s.id, "Totals everywhere", { kind: "split", reason: "two independent pieces", parts: PARTS });
    const claude = claudeFor({ kind: "split", reason: "two independent pieces", parts: PARTS }, (input) => {
      const file = input.prompt.includes("Serve totals") ? "api.txt" : "docs.txt";
      writeFileSync(join(input.cwd, file), `${file}\n`);
    });
    h.start({ claude: claude.adapter });
    await waitFor(() => h.task(t.id).loop?.stage === "pick", 15000);
    const parts = childrenOf(h.db, h.task(t.id));
    expect(parts.map((p) => [p.title, childState(p), p.branch])).toEqual([
      ["Add the endpoint", "ready", `atrium/${parts[0]!.id}`],
      ["Write the docs", "ready", `atrium/${parts[1]!.id}`],
    ]);
    // Each part has its own brief, scoped to its files, and makes no approval of its own.
    expect(parts[0]!.brief).toMatchObject({ goal: "Serve totals", lookFirst: ["api.txt"], size: "small" });
    expect(listPending(h.db).filter((a) => parts.some((p) => p.id === a.taskId))).toEqual([]);
    // The parent waits on the user, in one item.
    expect(asksBeforeStarting(h.task(t.id))).toBe(true);
    await mergeParts(h.db, t.id, getSpace(h.db, s.id)!);
    h.runner!.kick();
    await waitFor(() => h.status(t.id) === "review");
    expect(git(path, "show", `atrium/${t.id}:api.txt`)).toBe("api.txt");
    expect(git(path, "show", `atrium/${t.id}:docs.txt`)).toBe("docs.txt");
    expect(git(path, "branch", "--show-current")).toBe("main");
    // The merge holds the parts' commits, so their own branches went.
    for (const p of parts) expect(git(path, "branch", "--list", p.branch!)).toBe("");
    // The merge went through Atrium's own checks, with no writer turn in between.
    const parent = h.task(t.id);
    expect(parent.loop!.checks).toBe("passed");
    expect(claude.calls.filter((c) => c.mode === "work")).toHaveLength(2);
    expect(listPending(h.db).find((a) => a.taskId === t.id)!.detail).toContain("Merged 2 parts");
  });

  test("parts that changed the same lines aren't merged; the user is told to open their pull requests", async () => {
    const path = h.repo();
    const s = h.space(path);
    const t = chosen(s.id, "Totals everywhere", { kind: "split", parts: PARTS });
    const claude = claudeFor({ kind: "split", parts: PARTS }, (input) => writeFileSync(join(input.cwd, "README.md"), input.prompt.includes("Serve totals") ? "one\n" : "two\n"));
    h.start({ claude: claude.adapter });
    await waitFor(() => h.task(t.id).loop?.stage === "pick", 15000);
    await expect(mergeParts(h.db, t.id, getSpace(h.db, s.id)!)).rejects.toThrow(FanoutRefused);
    expect(git(path, "branch", "--list", `atrium/${t.id}`)).toBe("");
  });
});

describe("best of N", () => {
  test("attempts that fail the gate are dropped, the judge scores the rest, and the pick becomes the task's branch", async () => {
    const path = h.repo();
    const s = h.space(path);
    const t = chosen(s.id, "Speed up totals", { kind: "best_of_n", reason: "several plausible designs", attempts: 3 });
    // The first attempt breaks the check; the other two pass with different work.
    const claude = claudeFor({ kind: "best_of_n", reason: "several plausible designs", attempts: 3 }, (input, n) => {
      writeFileSync(join(input.cwd, "status.txt"), n === 1 ? "wrong\n" : "pass\n");
      writeFileSync(join(input.cwd, "work.txt"), `attempt ${n}\n`);
    }, "SCORE 1 6 works but slow\nSCORE 2 9 cleaner and faster");
    h.start({ claude: claude.adapter });
    await waitFor(() => h.task(t.id).loop?.stage === "pick", 20000);
    const attempts = childrenOf(h.db, h.task(t.id));
    expect(attempts.map(childState)).toEqual(["dropped", "ready", "ready"]);
    // A dropped attempt isn't sent back: it got one turn.
    expect(getTask(h.db, attempts[0]!.id)!.blockedReason).toMatch(/^Dropped: its checks failed/);
    expect(claude.calls.filter((c) => c.mode === "work")).toHaveLength(3);
    // The judge saw only the survivors, fenced, and its scores sit by each.
    const judge = claude.calls.find((c) => c.prompt.includes("Several attempts"))!;
    expect(judge.model).toBe("opus");
    expect(judge.allowedTools).toEqual([]);
    expect(judge.prompt).toMatch(/--- attempt 1 [0-9a-f]{12} ---[\s\S]*\+attempt 2/);
    expect(judge.prompt).not.toContain("+attempt 1");
    expect(h.task(t.id).loop!.fanout!.scores).toEqual({
      [attempts[1]!.id]: { score: 6, comment: "works but slow" },
      [attempts[2]!.id]: { score: 9, comment: "cleaner and faster" },
    });
    // A dropped attempt can't be picked; the judge's favourite is only advice.
    await expect(pickAttempt(h.db, t.id, attempts[0]!.id, getSpace(h.db, s.id)!)).rejects.toThrow(FanoutRefused);
    const head = git(path, "rev-parse", attempts[1]!.branch!);
    await pickAttempt(h.db, t.id, attempts[1]!.id, getSpace(h.db, s.id)!);
    h.runner!.kick();
    await waitFor(() => h.status(t.id) === "review");
    expect(git(path, "rev-parse", `atrium/${t.id}`)).toBe(head);
    // The kept commit reads as the task's own, not as "attempt 2 of 3".
    expect(git(path, "log", "-1", "--format=%s", `atrium/${t.id}`)).toBe("Speed up totals");
    for (const a of attempts) expect(git(path, "branch", "--list", a.branch!)).toBe("");
    // The checks ran on that commit already, so their result carries over without another run.
    expect(h.task(t.id).loop!.checks).toBe("passed");
    expect(h.db.query("SELECT COUNT(*) AS n FROM checks WHERE task_id = ?").get(t.id)).toEqual({ n: 0 });
  });

  test("when no attempt passes, the task stops and says so, with nothing to pick", async () => {
    const s = h.space(h.repo());
    const t = chosen(s.id, "Speed up totals", { kind: "best_of_n", attempts: 2 });
    const claude = claudeFor({ kind: "best_of_n", attempts: 2 }, (input) => {
      writeFileSync(join(input.cwd, "status.txt"), "wrong\n");
      writeFileSync(join(input.cwd, "work.txt"), "x\n");
    });
    h.start({ claude: claude.adapter });
    await waitFor(() => h.status(t.id) === "blocked", 15000);
    expect(h.task(t.id).blockedReason).toContain("None of the 2 attempts passed Atrium's checks");
    // Nothing needs the attempts' branches any more.
    const path = getSpace(h.db, s.id)!.repoPath!;
    await waitFor(() => git(path, "branch", "--list", "atrium/*").split("\n").filter(Boolean).length === 0);
    expect(claude.calls.some((c) => c.prompt.includes("Several attempts"))).toBe(false);
  });
});

describe("a base that already fails a check", () => {
  // The repo's tests fail before any task (status.txt says so), and its lint, a second check, passes.
  function failingBase() {
    const path = h.repo();
    writeFileSync(join(path, "status.txt"), "wrong\n");
    writeFileSync(join(path, "lint.txt"), "pass\n");
    git(path, "add", "-A");
    git(path, "commit", "-qm", "tests already fail");
    const s = h.space(path);
    updateSpace(h.db, s.id, { checks: `${FAKE_CHECK} lint.txt\n${FAKE_CHECK}` });
    return { path, s };
  }

  test("an attempt that only leaves an already-failing check failing survives, unverified; a new failure drops one", async () => {
    const { s } = failingBase();
    const t = chosen(s.id, "Speed up totals", { kind: "best_of_n", attempts: 2 });
    const claude = claudeFor({ kind: "best_of_n", attempts: 2 }, (input, n) => {
      writeFileSync(join(input.cwd, "work.txt"), `attempt ${n}\n`);
      if (n === 2) writeFileSync(join(input.cwd, "lint.txt"), "bad\n");
    });
    h.start({ claude: claude.adapter });
    await waitFor(() => h.task(t.id).loop?.stage === "pick", 20000);
    const attempts = childrenOf(h.db, h.task(t.id));
    expect(attempts.map(childState)).toEqual(["ready", "dropped"]);
    expect(attempts[0]!.loop).toMatchObject({ checks: "none" });
    expect(attempts[0]!.loop!.unverified).toContain("already failing");
    expect(getTask(h.db, attempts[1]!.id)!.blockedReason).toContain("its checks failed (");
    expect(getTask(h.db, attempts[1]!.id)!.blockedReason).toContain("lint.txt");
  });

  test("a part isn't sent back over a check that was already failing; the merged branch's gate decides", async () => {
    const { s } = failingBase();
    const t = chosen(s.id, "Totals everywhere", { kind: "split", parts: PARTS });
    const claude = claudeFor({ kind: "split", parts: PARTS }, (input) => {
      const file = input.prompt.includes("Serve totals") ? "api.txt" : "docs.txt";
      writeFileSync(join(input.cwd, file), `${file}\n`);
    });
    h.start({ claude: claude.adapter });
    await waitFor(() => h.task(t.id).loop?.stage === "pick", 20000);
    // One writer turn per part, with no "still fails as before" send-back.
    expect(claude.calls.filter((c) => c.mode === "work")).toHaveLength(2);
    expect(claude.calls.some((c) => c.prompt.includes("## Still failing"))).toBe(false);
  });
});

test("a fan-out waiting on a stuck part can still be set aside: its children end and their branches go", async () => {
  const path = h.repo();
  const s = h.space(path);
  const t = chosen(s.id, "Totals everywhere", { kind: "split", parts: PARTS });
  // The first part's agent fails outright, so that part is blocked and the parent keeps waiting on it.
  const claude = fake("claude", (input) => {
    if (input.mode === "work" && input.prompt.includes("Serve totals")) {
      writeFileSync(join(input.cwd, "api.txt"), "half\n");
      return { status: "error", kind: "failed", message: "Claude Code exited with code 1" };
    }
    if (input.mode === "work") writeFileSync(join(input.cwd, "docs.txt"), "docs\n");
    return ok(input.mode === "review" ? "Fine.\nVERDICT: approve" : "Did my part.\nOUTCOME: done");
  });
  h.start({ claude: claude.adapter });
  await waitFor(() => childrenOf(h.db, h.task(t.id)).map(childState).join() === "stuck,ready", 20000);
  expect(h.task(t.id).loop!.stage).toBe("parts");
  await discardFanout(h.db, t.id, getSpace(h.db, s.id)!);
  expect(h.status(t.id)).toBe("done");
  expect(childrenOf(h.db, h.task(t.id)).map((c) => c.status)).toEqual(["done", "done"]);
  expect(git(path, "branch", "--list", "atrium/*")).toBe("");
}, 40000);

describe("ending a fan-out leaves the user's own work", () => {
  test("a branch with a commit Atrium didn't make is kept, and the activity says so", async () => {
    const path = h.repo();
    const s = h.space(path);
    const t = chosen(s.id, "Speed up totals", { kind: "best_of_n", attempts: 2 });
    const claude = claudeFor({}, (input, n) => writeFileSync(join(input.cwd, "work.txt"), `attempt ${n}\n`), "SCORE 1 6 fine\nSCORE 2 9 cleaner");
    h.start({ claude: claude.adapter });
    await waitFor(() => h.task(t.id).loop?.stage === "pick", 20000);
    const [first, second] = childrenOf(h.db, h.task(t.id));
    // The user adds a commit of their own on the second attempt's branch.
    git(path, "checkout", "-q", second!.branch!);
    writeFileSync(join(path, "mine.txt"), "mine\n");
    git(path, "add", "-A");
    git(path, "commit", "-qm", "my own change");
    git(path, "checkout", "-q", "main");
    await pickAttempt(h.db, t.id, first!.id, getSpace(h.db, s.id)!);
    expect(git(path, "branch", "--list", first!.branch!)).toBe("");
    expect(git(path, "branch", "--list", second!.branch!)).toContain(second!.branch!);
    const said = (h.db.query("SELECT message FROM activity ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as { message: string }).message;
    expect(said).toContain(`Kept ${second!.branch}: it has commits Atrium didn't make`);
    expect(said).not.toContain("deleted");
  }, 30000);

  test("starting over as another shape changes the task first, and keeps a branch the user added to", async () => {
    const path = h.repo();
    const s = h.space(path);
    const shape = runNow(proposeShape({ kind: "split", reason: "two pieces", parts: PARTS }, { size: "medium", checksFound: true }));
    const t = createTask(h.db, { spaceId: s.id, title: "Totals.", brief: normalizeBrief({ goal: "Totals", size: "medium" }) });
    git(path, "branch", `atrium/${t.id}`);
    const tip = git(path, "rev-parse", `atrium/${t.id}`);
    // Atrium last left the branch one commit back; the user has added one since.
    setTaskLoop(h.db, t.id, { ...newLoop(SIZE_BUDGETS.medium), shape, said: "Did some.", headSha: "0".repeat(40) });
    h.db.query("UPDATE tasks SET branch = ?, status = 'blocked' WHERE id = ?").run(`atrium/${t.id}`, t.id);
    await restartAs(h.db, t.id, chooseShape(shape, "split", { size: "medium", checksFound: true }, "Totals"), getSpace(h.db, s.id)!);
    expect(h.task(t.id)).toMatchObject({ status: "queued", loop: { said: null, shape: { kind: "split", approved: true } } });
    expect(git(path, "rev-parse", `atrium/${t.id}`)).toBe(tip);
    const said = (h.db.query("SELECT message FROM activity ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as { message: string }).message;
    expect(said).toBe(`Started "Totals." over as 2 parts, from its brief. Kept atrium/${t.id}: it has commits Atrium didn't make, or git wouldn't delete it. Remove it before merging or picking.`);
  });
});

test("a switch whose writer finished before the stop landed is refused, and the task is left as it is", async () => {
  const path = h.repo();
  const s = h.space(path);
  const shape = runNow(proposeShape({ kind: "split", reason: "two pieces", parts: PARTS }, { size: "medium", checksFound: true }));
  const t = createTask(h.db, { spaceId: s.id, title: "Totals", brief: normalizeBrief({ goal: "Totals", size: "medium" }) });
  setTaskLoop(h.db, t.id, { ...newLoop(SIZE_BUDGETS.medium), shape, said: "Did it." });
  h.db.query("UPDATE tasks SET status = 'running' WHERE id = ?").run(t.id);
  const { loopRoute } = await import("../../src/server/loop");
  // The stop comes back "finished": the writer answered first and the task moved on to review.
  const stop = async (id: string) => {
    h.db.query("UPDATE tasks SET status = 'review' WHERE id = ?").run(id);
    setTaskLoop(h.db, id, { ...getTask(h.db, id)!.loop!, stage: "ready" });
    return "finished";
  };
  const url = `http://127.0.0.1/api/tasks/${t.id}/shape`;
  const call = loopRoute(h.db, undefined, () => {}, stop, new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "split" }) }), new URL(url));
  await expect(call).rejects.toMatchObject({ status: 409, message: "It finished before it could be stopped, so its work stands. Send it back if you want another shape." });
  expect(h.task(t.id)).toMatchObject({ status: "review", loop: { said: "Did it.", shape: { kind: "single" } } });
});
