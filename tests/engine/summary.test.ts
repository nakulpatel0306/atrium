import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createApproval } from "../../src/engine/approvals";
import { openDb } from "../../src/engine/db";
import { setSetting } from "../../src/engine/settings";
import { proposeShape, runNow } from "../../src/engine/shape";
import { createSpace, updateSpace } from "../../src/engine/spaces";
import { summary } from "../../src/engine/summary";
import { recordRunFiles } from "../../src/engine/outputs/store";
import { createTask, setTaskLoop, setTaskOutcome, setTaskStatus } from "../../src/engine/tasks";
import { newLoop, SIZE_BUDGETS } from "../../src/engine/loop";
import { labelOf } from "../../src/engine/autonomy/kinds";
import { tempHome } from "../helpers";

const FP = "v1:code:docs:small:claude";
// A pending "stop asking about this?" suggestion, inserted directly so the test doesn't need a clean streak.
const suggest = (spaceId: string, id: string, createdAt: number) =>
  db
    .query("INSERT INTO autonomy_proposals (id, space_id, fingerprint, evidence, created_at) VALUES (?, ?, ?, '[]', ?)")
    .run(id, spaceId, FP, createdAt);

let home: ReturnType<typeof tempHome>;
let db: Database;

beforeEach(() => {
  home = tempHome();
  db = openDb();
});
afterEach(() => {
  db.close();
  home.cleanup();
});

test("summary lists pending approvals newest first with paths", () => {
  const s = createSpace(db, { name: "atrium", kind: "general", goal: "g" });
  const s2 = createSpace(db, { name: "notes", kind: "general", goal: "g" });
  createApproval(db, { spaceId: s2.id, kind: "question", title: "Which one?", detail: "" });
  const t = createTask(db, { spaceId: s.id, title: "Fix login" });
  setTaskStatus(db, t.id, "running");
  setTaskStatus(db, t.id, "review");
  createApproval(db, { spaceId: s.id, taskId: t.id, kind: "review", title: "Review Fix login", detail: "" });

  const sum = summary(db);
  expect(sum.needsYou).toBe(2);
  expect(sum.needs.map((n) => n.kind)).toEqual(["review", "question"]);
  expect(sum.needs[0]!.path).toBe(`/space/${s.id}?task=${t.id}`);
  expect(sum.needs[1]!.path).toBe(`/space/${s2.id}`);
  expect(sum.needs[0]!.spaceName).toBe(s.name);
});

test("summary skips archived spaces", () => {
  const s = createSpace(db, { name: "old", kind: "general", goal: "g" });
  createApproval(db, { spaceId: s.id, kind: "question", title: "Still there?", detail: "" });
  updateSpace(db, s.id, { status: "archived" });

  const sum = summary(db);
  expect(sum.needsYou).toBe(0);
  expect(sum.needs).toEqual([]);
});

test("summary lists failed and blocked work tasks only", () => {
  const s = createSpace(db, { name: "atrium", kind: "general", goal: "g" });
  const make = (title: string, kind: "work" | "review" = "work") => {
    const t = createTask(db, { spaceId: s.id, title, kind });
    setTaskStatus(db, t.id, "running");
    return t;
  };
  const failed = make("Ship");
  setTaskStatus(db, failed.id, "failed");
  const blocked = make("Deploy");
  setTaskStatus(db, blocked.id, "blocked", { blockedReason: "Claude is signed out" });
  setTaskStatus(db, make("Done").id, "done");
  setTaskStatus(db, make("Review it", "review").id, "failed");

  const sum = summary(db);
  expect(sum.stopped.map((x) => x.id).sort()).toEqual([failed.id, blocked.id].sort());
  expect(sum.stopped.map((x) => x.status).sort()).toEqual(["blocked", "failed"]);
  const b = sum.stopped.find((x) => x.id === blocked.id)!;
  expect(b.reason).toBe("Claude is signed out");
  expect(b.path).toBe(`/space/${s.id}?task=${blocked.id}`);
  expect(b.spaceName).toBe("atrium");
});

test("summary reports overnight", () => {
  expect(summary(db).overnight).toBe(false);
  setSetting(db, "overnight", "true");
  expect(summary(db).overnight).toBe(true);
});

test("summary counts pending suggestions as things that need you", () => {
  const s = createSpace(db, { name: "Docs", kind: "general", goal: "g" });
  const a = createApproval(db, { spaceId: s.id, kind: "question", title: "Which?", detail: "" });
  suggest(s.id, "prp_new", a.createdAt + 1000);
  const answered = createSpace(db, { name: "Old", kind: "general", goal: "g" });
  suggest(answered.id, "prp_done", a.createdAt + 2000);
  db.query("UPDATE autonomy_proposals SET status = 'never' WHERE id = 'prp_done'").run();

  const sum = summary(db);
  expect(sum.needsYou).toBe(2);
  expect(sum.needs[0]).toEqual({ id: "prp_new", kind: "suggestion", title: `Stop asking about ${labelOf(FP)}?`, spaceName: "Docs", path: "/", files: 0, outcome: null });
  expect(sum.needs[1]!.id).toBe(a.id);
});

test("summary skips suggestions in archived spaces", () => {
  const s = createSpace(db, { name: "Docs", kind: "general", goal: "g" });
  suggest(s.id, "prp_1", Date.now());
  updateSpace(db, s.id, { status: "archived" });
  expect(summary(db).needsYou).toBe(0);
});

test("summary shows an Atrium-wide question as Atrium's", () => {
  const a = createApproval(db, { spaceId: null, kind: "question", title: 'Create GitHub repo "demo"?', detail: "", alwaysAsk: "create_repo" });
  const sum = summary(db);
  expect(sum.needs).toContainEqual({ id: a.id, kind: "question", title: 'Create GitHub repo "demo"?', spaceName: "Atrium", path: "/", files: 0, outcome: null });
  expect(sum.needsYou).toBe(1);
});

test("a review need says how many files its task made", () => {
  const s = createSpace(db, { name: "Weekly Planning", kind: "general", goal: "g" });
  const t = createTask(db, { spaceId: s.id, title: "Make a grocery list" });
  setTaskStatus(db, t.id, "running");
  setTaskStatus(db, t.id, "review");
  db.query("INSERT INTO runs (id, task_id, agent, started_at, transcript_path) VALUES ('run_1', ?, 'claude', 1, '')").run(t.id);
  recordRunFiles(db, { runId: "run_1", taskId: t.id, spaceId: s.id, root: "space" }, [
    ...["a.md", "b.md", "c.md", "d.ics"].map((path) => ({ path, change: "created" as const, size: 1 })),
    { path: "old.md", change: "deleted" as const, size: null },
  ]);
  createApproval(db, { spaceId: s.id, taskId: t.id, kind: "review", title: "Make a grocery list", detail: "" });
  const needs = summary(db).needs;
  expect(needs.find((n) => n.kind === "review")!.files).toBe(4);
  expect(needs.find((n) => n.kind === "review")!.path).toBe(`/space/${s.id}?task=${t.id}`);
});

test("needs carry the task's outcome", () => {
  const s = createSpace(db, { name: "Notes", kind: "general", goal: "" });
  const t = createTask(db, { spaceId: s.id, title: "Write three files" });
  setTaskStatus(db, t.id, "running");
  setTaskStatus(db, t.id, "review");
  setTaskOutcome(db, t.id, "partial", "one left.");
  const review = createApproval(db, { spaceId: s.id, taskId: t.id, kind: "review", title: t.title, detail: "" });
  const done = createTask(db, { spaceId: s.id, title: "Answer" });
  setTaskStatus(db, done.id, "running");
  setTaskStatus(db, done.id, "review");
  setTaskOutcome(db, done.id, "done", null);
  const ok = createApproval(db, { spaceId: s.id, taskId: done.id, kind: "review", title: done.title, detail: "" });
  const needs = new Map(summary(db).needs.map((n) => [n.id, n]));
  expect(needs.get(review.id)).toMatchObject({ outcome: "partial" });
  expect(needs.get(ok.id)).toMatchObject({ outcome: null });
});

test("a task asking before it starts counts toward the badge and opens on its task", () => {
  const s = createSpace(db, { name: "atrium", kind: "repo", goal: "g", repoPath: "/tmp/x" });
  const t = createTask(db, { spaceId: s.id, title: "Add totals" });
  setTaskLoop(db, t.id, { ...newLoop(SIZE_BUDGETS.small), stage: "brief", questions: [{ question: "Weekly or monthly?", options: ["Weekly", "Monthly"] }] });
  const sum = summary(db);
  expect(sum.needsYou).toBe(1);
  expect(sum.needs[0]).toEqual({ id: t.id, kind: "question", title: "Add totals: Weekly or monthly?", spaceName: "atrium", path: `/space/${s.id}?task=${t.id}`, files: 0, outcome: null });
});

test("a split waiting on a part that stopped asks too, through the one definition", async () => {
  const { needsYouCount } = await import("../../src/engine/needs");
  const { snapshot } = await import("../../src/engine/state");
  const s = createSpace(db, { name: "atrium", kind: "repo", goal: "g", repoPath: "/tmp/x" });
  const parent = createTask(db, { spaceId: s.id, title: "Totals" });
  setTaskLoop(db, parent.id, { ...newLoop(SIZE_BUDGETS.small), stage: "parts", fanout: { kind: "split", children: [], scores: {}, judgeNote: null } });
  const part = createTask(db, { spaceId: s.id, title: "Part A", parentTaskId: parent.id });
  setTaskLoop(db, part.id, { ...newLoop(SIZE_BUDGETS.small), role: "part" });
  // While the part runs, the parent asks nothing.
  expect(summary(db).needsYou).toBe(0);
  db.query("UPDATE tasks SET status = 'blocked', blocked_reason = 'Paused' WHERE id = ?").run(part.id);
  const sum = summary(db);
  expect(sum.needsYou).toBe(1);
  expect(sum.needs[0]!.title).toBe("Totals: one of its parts stopped: give it a hint, retry it, or set the parts aside");
  expect(needsYouCount(snapshot(db))).toBe(1);
});

test("parts waiting for a decision count like questions; a suggested shape doesn't", () => {
  const s = createSpace(db, { name: "atrium", kind: "repo", goal: "g", repoPath: "/tmp/x" });
  const shaped = createTask(db, { spaceId: s.id, title: "Totals" });
  const parts = [{ title: "A", goal: "a", files: ["a.ts"] }, { title: "B", goal: "b", files: ["b.ts"] }];
  const shape = proposeShape({ kind: "split", reason: "two pieces", parts }, { size: "medium", checksFound: true });
  setTaskLoop(db, shaped.id, { ...newLoop(SIZE_BUDGETS.small), stage: "writing", shape: runNow(shape) });
  const picking = createTask(db, { spaceId: s.id, title: "Speed" });
  setTaskLoop(db, picking.id, { ...newLoop(SIZE_BUDGETS.small), stage: "pick", fanout: { kind: "best_of_n", children: [], scores: {}, judgeNote: null } });
  const sum = summary(db);
  expect(sum.needsYou).toBe(1);
  expect(sum.needs.map((n) => n.title)).toEqual(["Speed: pick one of its attempts"]);
});

test("every needs-you counter uses the one definition", async () => {
  const { needsYouCount } = await import("../../src/engine/needs");
  const { snapshot } = await import("../../src/engine/state");
  const { needsCount } = await import("../../src/dashboard/components/NeedsYou");
  const { liveStatus } = await import("../../src/dashboard/summary");
  const { statusLine } = await import("../../src/cli");
  const s = createSpace(db, { name: "atrium", kind: "repo", goal: "g", repoPath: "/tmp/x" });
  createApproval(db, { spaceId: s.id, kind: "question", title: "Which one?", detail: "" });
  suggest(s.id, "prp_1", Date.now());
  const t = createTask(db, { spaceId: s.id, title: "Add totals" });
  setTaskLoop(db, t.id, { ...newLoop(SIZE_BUDGETS.small), stage: "brief", questions: [{ question: "Weekly?", options: [] }] });
  // An archived space's approvals stay in the database but count nowhere.
  const old = updateSpace(db, createSpace(db, { name: "old", kind: "general", goal: "g" }).id, { status: "archived" });
  createApproval(db, { spaceId: old.id, kind: "question", title: "Old question", detail: "" });
  const state = snapshot(db);
  expect(needsYouCount(state)).toBe(3);
  expect(summary(db).needsYou).toBe(3);
  expect(needsCount(state)).toBe(3);
  expect(liveStatus(state)).toContain("3 things need you");
  expect(statusLine(state, "http://127.0.0.1:7420")).toContain("3 needs you");
});
