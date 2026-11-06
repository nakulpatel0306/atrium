import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../../../src/engine/db";
import { latestMakers, madeLine, recordRunFiles, taskFiles } from "../../../src/engine/outputs/store";
import { createSpace } from "../../../src/engine/spaces";
import { createTask } from "../../../src/engine/tasks";
import { tempHome } from "../../helpers";

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

const run = (taskId: string, id: string) => {
  db.query("INSERT INTO runs (id, task_id, agent, started_at, transcript_path) VALUES (?, ?, 'claude', ?, '')").run(id, taskId, Date.now());
  return id;
};
const setup = () => {
  const space = createSpace(db, { name: "Weekly Planning", kind: "general", goal: "" });
  const task = createTask(db, { spaceId: space.id, title: "Groceries", agent: "claude", weight: "light" });
  return { space, task };
};

test("taskFiles keeps the newest change per path", async () => {
  const { space, task } = setup();
  const base = { taskId: task.id, spaceId: space.id, root: "space" as const };
  recordRunFiles(db, { ...base, runId: run(task.id, "run_1") }, [
    { path: "b.md", change: "created", size: 2 },
    { path: "a.md", change: "created", size: 1 },
  ]);
  await Bun.sleep(2);
  recordRunFiles(db, { ...base, runId: run(task.id, "run_2") }, [{ path: "a.md", change: "changed", size: 5 }]);
  const files = taskFiles(db, task.id);
  expect(files.map((f) => [f.path, f.change, f.runId])).toEqual([
    ["a.md", "changed", "run_2"],
    ["b.md", "created", "run_1"],
  ]);
  expect(files[0]!.size).toBe(5);
});

test("recordRunFiles keeps the first 500 by path", () => {
  const { space, task } = setup();
  const changes = Array.from({ length: 600 }, (_, i) => ({ path: `f${String(i).padStart(3, "0")}.md`, change: "created" as const, size: 1 }));
  const n = recordRunFiles(db, { runId: run(task.id, "run_1"), taskId: task.id, spaceId: space.id, root: "space" }, changes.reverse());
  expect(n).toBe(500);
  const paths = taskFiles(db, task.id).map((f) => f.path).sort();
  expect(paths[0]).toBe("f000.md");
  expect(paths.at(-1)).toBe("f499.md");
});

test("latestMakers credits the later task and skips deleted rows", async () => {
  const { space, task } = setup();
  const later = createTask(db, { spaceId: space.id, title: "Edit", agent: "claude", weight: "light" });
  recordRunFiles(db, { runId: run(task.id, "run_1"), taskId: task.id, spaceId: space.id, root: "space" }, [
    { path: "shared.md", change: "created", size: 1 },
    { path: "gone.md", change: "created", size: 1 },
  ]);
  await Bun.sleep(2);
  recordRunFiles(db, { runId: run(later.id, "run_2"), taskId: later.id, spaceId: space.id, root: "space" }, [
    { path: "shared.md", change: "changed", size: 2 },
    { path: "gone.md", change: "deleted", size: null },
  ]);
  const makers = latestMakers(db, space.id);
  expect(makers.get("space:shared.md")!.taskId).toBe(later.id);
  expect(makers.get("space:gone.md")!.taskId).toBe(task.id);
});

test("madeLine names what a run made", () => {
  const c = (path: string, change: "created" | "changed" | "deleted" = "created") => ({ path, change, size: 1 });
  expect(madeLine([c("grocery-list.md")])).toBe("Made grocery-list.md.");
  expect(madeLine([c("a.md"), c("b.md"), c("c.md")])).toBe("Made 3 files: a.md, b.md and c.md.");
  expect(madeLine(["a", "b", "c", "d", "e", "f"].map((n) => c(`${n}.md`)))).toBe("Made 6 files: a.md, b.md, c.md and 3 more.");
  expect(madeLine([c("new.md"), c("notes.md", "changed"), c("x.md", "changed"), c("old.md", "deleted")])).toBe(
    "Made new.md. Changed 2 files: notes.md and x.md. Deleted old.md.",
  );
  expect(madeLine([c("runs/r1/notes.md")], (p) => p.slice("runs/r1/".length))).toBe("Made notes.md.");
  expect(madeLine([])).toBeNull();
});
