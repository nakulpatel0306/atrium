import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createApproval } from "../../src/engine/approvals";
import { openDb } from "../../src/engine/db";
import { setSetting } from "../../src/engine/settings";
import { createSpace, updateSpace } from "../../src/engine/spaces";
import { summary } from "../../src/engine/summary";
import { createTask, setTaskStatus } from "../../src/engine/tasks";
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
  expect(sum.needs[0]).toEqual({ id: "prp_new", kind: "suggestion", title: `Stop asking about ${labelOf(FP)}?`, spaceName: "Docs", path: "/" });
  expect(sum.needs[1]!.id).toBe(a.id);
});

test("summary skips suggestions in archived spaces", () => {
  const s = createSpace(db, { name: "Docs", kind: "general", goal: "g" });
  suggest(s.id, "prp_1", Date.now());
  updateSpace(db, s.id, { status: "archived" });
  expect(summary(db).needsYou).toBe(0);
});

test("summary counts price alerts like any other approval", () => {
  const s = createSpace(db, { name: "Stocks", kind: "markets", goal: "" });
  createApproval(db, { spaceId: s.id, kind: "alert", title: "AAPL price above $200.00", detail: "d" });
  expect(summary(db)).toMatchObject({
    needsYou: 1,
    needs: [{ kind: "alert", title: "AAPL price above $200.00", spaceName: "Stocks", path: `/space/${s.id}` }],
  });
});
