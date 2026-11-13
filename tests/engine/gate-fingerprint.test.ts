// The base cache's key reads nothing from the user's lockfiles, so a FIFO or a huge file in their place can't stall it.
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { baseResults } from "../../src/engine/checks/gate";
import { tempRepo } from "../helpers";

let cleanup = () => {};
afterEach(() => cleanup());

test("a FIFO where a lockfile should be doesn't block the base run", async () => {
  const repo = tempRepo();
  cleanup = repo.cleanup;
  Bun.spawnSync(["mkfifo", join(repo.path, "bun.lock")]);
  const base = Bun.spawnSync(["git", "-C", repo.path, "rev-parse", "HEAD"]).stdout.toString().trim();
  const started = Date.now();
  const out = await baseResults(repo.path, base, []);
  expect(Date.now() - started).toBeLessThan(5000);
  expect(out).toEqual([]);
});
