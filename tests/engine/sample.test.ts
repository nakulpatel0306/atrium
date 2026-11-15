import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../../src/engine/db";
import { tierFor } from "../../src/engine/runner";
import { isSampleSpace, SAMPLE_ASK, startSample } from "../../src/engine/sample";
import { getSpace } from "../../src/engine/spaces";
import { createTask } from "../../src/engine/tasks";
import { tempHome } from "../helpers";

let home: ReturnType<typeof tempHome>;
let db: Database;
const made: string[] = [];
beforeEach(() => {
  home = tempHome();
  db = openDb();
});
afterEach(() => {
  db.close();
  home.cleanup();
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("the sample copies the bundled repo to a temp folder and queues its ask there, on an empty install", async () => {
  const { space, task } = await startSample(db);
  made.push(space.repoPath!);
  expect(space.repoPath).not.toContain(home.home);
  expect(existsSync(join(space.repoPath!, "tests", "cart.test.ts"))).toBe(true);
  expect(readFileSync(join(space.repoPath!, "src", "cart.ts"), "utf8")).toContain("coupon.percent");
  const log = Bun.spawnSync(["git", "log", "--format=%s"], { cwd: space.repoPath! });
  expect(log.stdout.toString().trim()).toBe("Start the sample");
  // A reviewer every install has, so the cost shown up front holds.
  expect(getSpace(db, space.id)!.reviewBy).toBe("claude");
  expect(task).toMatchObject({ title: SAMPLE_ASK, status: "queued", allowOnBattery: true, agent: "claude" });
  expect(task.loop?.stage).toBe("brief");
  expect(isSampleSpace(db, space.id)).toBe(true);
});

test("every Claude run in the sample space uses the cheap tier; elsewhere the usual tiers hold", async () => {
  const { space, task } = await startSample(db);
  made.push(space.repoPath!);
  const review = createTask(db, { spaceId: space.id, title: "Review: x", kind: "review", parentTaskId: task.id });
  expect(tierFor(task, false, true)).toBe("cheap");
  expect(tierFor(review, false, true)).toBe("cheap");
  expect(tierFor(review, false, false)).toBe("strong");
  expect(tierFor(task, false, false)).toBe("default");
});
