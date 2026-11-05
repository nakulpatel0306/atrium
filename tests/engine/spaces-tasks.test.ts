import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../../src/engine/db";
import { bus, listActivity, logActivity, type EngineEvent } from "../../src/engine/events";
import { getSetting, setSetting } from "../../src/engine/settings";
import { createSpace, getSpace, listSpaces, setSpaceRepo, updateSpace } from "../../src/engine/spaces";
import { createTask, InvalidTransition, listTasks, setTaskStatus } from "../../src/engine/tasks";
import { tempHome } from "../helpers";

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

const space = () => createSpace(db, { name: "Docs", kind: "general", goal: "write" });

test("createSpace defaults private to true and status active", () => {
  const s = space();
  expect(s.private).toBe(true);
  expect(s.status).toBe("active");
  expect(getSpace(db, s.id)).toEqual(s);
});

test("archived spaces are hidden from listSpaces by default", () => {
  const s = space();
  updateSpace(db, s.id, { status: "archived" });
  expect(listSpaces(db)).toHaveLength(0);
  expect(listSpaces(db, { includeArchived: true })).toHaveLength(1);
});

test("createTask defaults to queued heavy auto", () => {
  const t = createTask(db, { spaceId: space().id, title: "x" });
  expect(t.status).toBe("queued");
  expect(t.weight).toBe("heavy");
  expect(t.agent).toBe("auto");
  expect(t.allowOnBattery).toBe(false);
});

test("setTaskStatus rejects done→running", () => {
  const t = createTask(db, { spaceId: space().id, title: "x" });
  setTaskStatus(db, t.id, "running");
  setTaskStatus(db, t.id, "review");
  setTaskStatus(db, t.id, "done");
  expect(() => setTaskStatus(db, t.id, "running")).toThrow(InvalidTransition);
});

test("blocked task stores reason; requeue clears it", () => {
  const t = createTask(db, { spaceId: space().id, title: "x" });
  const b = setTaskStatus(db, t.id, "blocked", { blockedReason: "needs input" });
  expect(b.blockedReason).toBe("needs input");
  expect(setTaskStatus(db, t.id, "queued").blockedReason).toBeNull();
});

test("listTasks filters by status, oldest first", () => {
  const sp = space();
  const a = createTask(db, { spaceId: sp.id, title: "a" });
  const b = createTask(db, { spaceId: sp.id, title: "b" });
  setTaskStatus(db, b.id, "running");
  expect(listTasks(db, { spaceId: sp.id }).map((t) => t.id)).toEqual([a.id, b.id]);
  expect(listTasks(db, { status: ["running"] }).map((t) => t.id)).toEqual([b.id]);
});

test("mutations emit changed", () => {
  const seen: EngineEvent[] = [];
  const off = bus.on((e) => seen.push(e));
  space();
  off();
  expect(seen).toContainEqual({ type: "changed" });
});

test("logActivity stores rows newest first and emits changed", () => {
  const sp = space();
  logActivity(db, sp.id, "me", "first");
  logActivity(db, null, "me", "second");
  const seen: EngineEvent[] = [];
  const off = bus.on((e) => seen.push(e));
  logActivity(db, sp.id, "me", "third");
  off();
  expect(seen).toEqual([{ type: "changed" }]);
  expect(listActivity(db).map((a) => a.message)).toEqual(["third", "second", "first"]);
  expect(listActivity(db, { spaceId: sp.id, limit: 1 }).map((a) => a.message)).toEqual(["third"]);
});

test("settings round-trip", () => {
  expect(getSetting(db, "k")).toBeNull();
  setSetting(db, "k", "v");
  expect(getSetting(db, "k")).toBe("v");
});

test("setSetting emits changed only when the value changes", () => {
  const seen: EngineEvent[] = [];
  const off = bus.on((e) => seen.push(e));
  setSetting(db, "k", "v");
  expect(seen).toHaveLength(1);
  setSetting(db, "k", "v");
  expect(seen).toHaveLength(1);
  setSetting(db, "k", "w");
  off();
  expect(seen).toHaveLength(2);
});

test("setSpaceRepo sets and clears repoPath and github", () => {
  const s = createSpace(db, { name: "Demo", kind: "repo", goal: "g", github: "fakeuser/demo" });
  expect(s.github).toBe("fakeuser/demo");
  expect(s.repoPath).toBeNull();
  const set = setSpaceRepo(db, s.id, { repoPath: "/p/demo" });
  expect(set.repoPath).toBe("/p/demo");
  expect(set.github).toBe("fakeuser/demo");
  const cleared = setSpaceRepo(db, s.id, { repoPath: null, github: null });
  expect(cleared.repoPath).toBeNull();
  expect(cleared.github).toBeNull();
});
