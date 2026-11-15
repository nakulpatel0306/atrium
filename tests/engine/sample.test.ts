import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../../src/engine/config";
import { openDb } from "../../src/engine/db";
import { deleteTask } from "../../src/engine/delete";
import { tierFor } from "../../src/engine/runner";
import { isSampleSpace, removeOrphanSamples, SAMPLE_ASK, startSample } from "../../src/engine/sample";
import { getSpace } from "../../src/engine/spaces";
import { createTask, setTaskStatus } from "../../src/engine/tasks";
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

test("the sample copies the bundled repo into Atrium's own folder and queues its ask there, on an empty install", async () => {
  const { space, task } = await startSample(db);
  expect(space.repoPath!.startsWith(join(config().home, "samples") + "/")).toBe(true);
  expect(existsSync(join(space.repoPath!, "tests", "cart.test.ts"))).toBe(true);
  expect(readFileSync(join(space.repoPath!, "src", "cart.ts"), "utf8")).toContain("coupon.percent");
  const log = Bun.spawnSync(["git", "log", "--format=%s"], { cwd: space.repoPath! });
  expect(log.stdout.toString().trim()).toBe("Start the sample");
  // Not private: a bundled toy repo has nothing to keep from other agents, and a private sandbox costs the writer Bash room.
  expect(getSpace(db, space.id)!.private).toBe(false);
  // A reviewer every install has, so the cost shown up front holds.
  expect(getSpace(db, space.id)!.reviewBy).toBe("claude");
  expect(task).toMatchObject({ title: SAMPLE_ASK, status: "queued", allowOnBattery: true, ignoreReserve: true, agent: "claude" });
  expect(task.loop?.stage).toBe("brief");
  expect(isSampleSpace(db, space.id)).toBe(true);
});

test("running it again while the first is still open gives the same task back", async () => {
  const first = await startSample(db);
  const again = await startSample(db);
  expect(again.task.id).toBe(first.task.id);
  setTaskStatus(db, first.task.id, "running");
  setTaskStatus(db, first.task.id, "review");
  setTaskStatus(db, first.task.id, "done");
  expect((await startSample(db)).task.id).not.toBe(first.task.id);
});

test("deleting the sample task removes its copy and its space", async () => {
  const { space, task } = await startSample(db);
  await deleteTask(db, task.id);
  expect(existsSync(space.repoPath!)).toBe(false);
  expect(getSpace(db, space.id)).toBeNull();
});

test("at start, sample copies no space points at are removed", async () => {
  const { space } = await startSample(db);
  const orphan = join(config().home, "samples", "sample-orphan");
  mkdirSync(orphan, { recursive: true });
  removeOrphanSamples(db);
  expect(existsSync(orphan)).toBe(false);
  expect(existsSync(space.repoPath!)).toBe(true);
});

test("every Claude run in the sample space uses the cheap tier; elsewhere the usual tiers hold", async () => {
  const { space, task } = await startSample(db);
  const review = createTask(db, { spaceId: space.id, title: "Review: x", kind: "review", parentTaskId: task.id });
  expect(tierFor(task, false, true)).toBe("cheap");
  expect(tierFor(review, false, true)).toBe("cheap");
  expect(tierFor(review, false, false)).toBe("strong");
  expect(tierFor(task, false, false)).toBe("default");
});
