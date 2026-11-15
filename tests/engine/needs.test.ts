import { describe, expect, test } from "bun:test";
import { newLoop, SIZE_BUDGETS, type LoopState } from "../../src/engine/loop";
import { attentionQueue, batchApprovable, needsYouCount, type QueueInput } from "../../src/engine/needs";

const loop = (patch: Partial<LoopState> = {}): LoopState => ({ ...newLoop(SIZE_BUDGETS.small), ...patch });
type T = QueueInput["tasks"][number];
const task = (id: string, patch: Partial<T> = {}): T => ({ id, kind: "work", status: "queued", spaceId: "s1", parentTaskId: null, loop: null, outcome: null, updatedAt: 0, ...patch });
const input = (patch: Partial<QueueInput> = {}): QueueInput => ({
  spaces: [{ id: "s1" }, { id: "s2" }],
  approvals: [],
  proposals: [],
  tasks: [],
  learning: { memory: [] },
  ...patch,
});
const clean = loop({ stage: "ready", checks: "passed", reviews: [{ reviewer: "codex", verdict: "approve", findings: [], skipped: null }] });

describe("attentionQueue", () => {
  test("puts the longest-blocked item first, whatever its kind", () => {
    const q = attentionQueue(
      input({
        approvals: [{ id: "a1", spaceId: "s1", taskId: "t1", kind: "review", alwaysAsk: null, createdAt: 300 }],
        proposals: [{ id: "p1", spaceId: "s2", createdAt: 200 }],
        tasks: [
          task("t1", { status: "review", updatedAt: 300 }),
          task("t2", { updatedAt: 100, loop: loop({ stage: "brief", questions: [{ question: "Which one?", options: [] }] }) }),
        ],
      }),
    );
    expect(q.map((i) => [i.kind, i.key])).toEqual([
      ["question", "t2"],
      ["suggestion", "p1"],
      ["review", "a1"],
    ]);
  });

  test("breaks a tie by space, in the order the spaces are listed", () => {
    const q = attentionQueue(
      input({
        approvals: [
          { id: "b", spaceId: "s2", taskId: null, kind: "question", alwaysAsk: null, createdAt: 100 },
          { id: "a", spaceId: "s1", taskId: null, kind: "question", alwaysAsk: null, createdAt: 100 },
        ],
      }),
    );
    expect(q.map((i) => i.key)).toEqual(["a", "b"]);
  });

  test("includes budget and loop pauses, but not a paused part, whose parent asks instead", () => {
    const paused = loop({ paused: { kind: "budget", diagnosis: "over budget" } });
    const q = attentionQueue(
      input({
        tasks: [
          task("t1", { status: "blocked", loop: paused, updatedAt: 10 }),
          task("parent", { status: "queued", loop: loop({ stage: "parts" }), updatedAt: 20 }),
          task("part", { status: "blocked", parentTaskId: "parent", loop: { ...paused, role: "part" }, updatedAt: 5 }),
          task("other", { status: "blocked", loop: null, updatedAt: 1 }),
        ],
      }),
    );
    expect(q.map((i) => [i.kind, i.key])).toEqual([
      ["paused", "t1"],
      ["stuck", "parent"],
    ]);
  });

  test("lists CLAUDE.md proposals and a running task's split suggestion last, and never counts them", () => {
    const suggested = loop({ shape: { kind: "single", reason: "r", proposed: "split", scouts: [], parts: [], attempts: 0, approved: false, mixVendors: false, checksFound: true } });
    const s = input({
      learning: { memory: [{ id: "m1", spaceId: "s1", taskId: null, createdAt: 1 }] },
      tasks: [task("run", { status: "running", loop: suggested, updatedAt: 2 }), task("done", { status: "done", loop: suggested, updatedAt: 0 })],
      approvals: [{ id: "a1", spaceId: "s1", taskId: null, kind: "question", alwaysAsk: null, createdAt: 999 }],
    });
    const q = attentionQueue(s);
    expect(q.map((i) => [i.kind, i.key, i.low])).toEqual([
      ["approval", "a1", false],
      ["memory", "m1", true],
      ["shape", "run", true],
    ]);
    expect(needsYouCount(s)).toBe(1);
  });

  test("leaves out archived spaces but keeps an Atrium-wide question", () => {
    const q = attentionQueue(
      input({
        spaces: [{ id: "s1" }],
        approvals: [
          { id: "gone", spaceId: "s9", taskId: null, kind: "question", alwaysAsk: null, createdAt: 1 },
          { id: "wide", spaceId: null, taskId: null, kind: "question", alwaysAsk: "create_repo", createdAt: 2 },
        ],
        learning: { memory: [{ id: "m9", spaceId: "s9", taskId: null, createdAt: 1 }] },
      }),
    );
    expect(q.map((i) => i.key)).toEqual(["wide"]);
  });

  test("reads an older state with no memory list", () => {
    const s = { spaces: [{ id: "s1" }], approvals: [], proposals: [], tasks: [task("t", { status: "blocked", loop: loop({ paused: { kind: "loop", diagnosis: "d" } }) })] };
    expect(needsYouCount(s)).toBe(1);
  });
});

describe("batchApprovable", () => {
  const review = { kind: "review" as const, alwaysAsk: null };
  const done = (l: LoopState) => task("t", { status: "review", outcome: "done", loop: l });

  test("takes the sample's own result: an approval with one low note nobody was asked to answer", () => {
    const sample = { ...clean, reviews: [{ reviewer: "claude", verdict: "approve" as const, findings: [{ severity: "low" as const, file: "src/cart.ts", line: 12, reason: "Rounding is a choice.", resolution: null }], skipped: null }] };
    expect(batchApprovable(review, done(sample))).toBe(true);
  });

  test("takes a clean result: checks passed, no notes, every finding fixed", () => {
    const fixed = { ...clean, reviews: [{ reviewer: "codex", verdict: "approve" as const, findings: [{ severity: "low" as const, file: null, line: null, reason: "r", resolution: { action: "fixed" as const, note: "" } }], skipped: null }] };
    expect(batchApprovable(review, done(clean))).toBe(true);
    expect(batchApprovable(review, done(fixed))).toBe(true);
  });

  test("never takes anything with notes, unverified or failed checks, open findings or a review that didn't happen", () => {
    const cases: LoopState[] = [
      { ...clean, attention: ["The change edits check config: bunfig.toml."] },
      { ...clean, noChanges: true },
      { ...clean, checks: "none" },
      { ...clean, checks: "failed" },
      { ...clean, unverified: "the install didn't happen" },
      { ...clean, alreadyFailing: [{ name: "lint", before: "", now: "" }] },
      { ...clean, reviews: [{ reviewer: "codex", verdict: "changes", findings: [{ severity: "low", file: null, line: null, reason: "r", resolution: null }], skipped: null }] },
      { ...clean, reviews: [{ reviewer: "codex", verdict: "changes", findings: [{ severity: "low", file: null, line: null, reason: "r", resolution: { action: "declined", note: "" } }], skipped: null }] },
      { ...clean, reviews: [{ reviewer: "codex", verdict: null, findings: [], skipped: "Codex timed out" }] },
      { ...clean, reviews: [{ reviewer: "codex", verdict: "approve", findings: [{ severity: "medium", file: null, line: null, reason: "r", resolution: null }], skipped: null }] },
      { ...clean, reviews: [] },
    ];
    for (const l of cases) expect(batchApprovable(review, done(l))).toBe(false);
  });

  test("never takes a result the agent didn't finish, a question, or one only the user may decide", () => {
    expect(batchApprovable(review, task("t", { status: "review", outcome: "partial", loop: clean }))).toBe(false);
    expect(batchApprovable({ kind: "question", alwaysAsk: null }, done(clean))).toBe(false);
    expect(batchApprovable({ kind: "review", alwaysAsk: "create_repo" }, done(clean))).toBe(false);
    expect(batchApprovable(review, undefined)).toBe(false);
    expect(batchApprovable(review, task("t", { status: "review", outcome: "done", loop: null }))).toBe(false);
  });
});
