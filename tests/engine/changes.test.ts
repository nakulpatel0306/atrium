import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { taskChanges } from "../../src/engine/changes";
import { openDb } from "../../src/engine/db";
import * as gitOps from "../../src/engine/git";
import { createSpace } from "../../src/engine/spaces";
import { createTask, setTaskStatus } from "../../src/engine/tasks";
import { tempHome, tempRepo } from "../helpers";

let home: ReturnType<typeof tempHome>;
let db: Database;
const cleanups: Array<() => void> = [];
beforeEach(() => {
  home = tempHome();
  db = openDb();
});
afterEach(() => {
  db.close();
  home.cleanup();
  while (cleanups.length) cleanups.pop()!();
});

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-c", "user.name=Atrium Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
};

test("a filter the agent plants after the settings check never runs while its changes are read", async () => {
  const r = tempRepo();
  cleanups.push(r.cleanup);
  const marker = join(mkdtempSync(join(tmpdir(), "atrium-marker-")), "ran");
  cleanups.push(() => rmSync(join(marker, ".."), { recursive: true, force: true }));
  const space = createSpace(db, { name: "App", kind: "repo", goal: "g", repoPath: r.path });
  const task = createTask(db, { spaceId: space.id, title: "Edit" });
  git(r.path, "checkout", "-q", "-b", `atrium/${task.id}`);
  const baseline = await gitOps.gitSettingsFingerprint(r.path);
  db.query("INSERT INTO runs (id, task_id, agent, started_at, transcript_path, start_ref, git_fingerprint) VALUES ('run_1', ?, 'claude', 1, '/tmp/none', 'main', ?)").run(task.id, baseline);
  setTaskStatus(db, task.id, "running", { branch: `atrium/${task.id}` });
  writeFileSync(join(r.path, "README.md"), "# fixture\nedited\n");
  // The check passes (it ran before the plant); then the agent plants a filter every attribute source selects.
  const check = spyOn(gitOps, "gitSettingsFingerprint").mockImplementation(async () => {
    git(r.path, "config", "filter.evil.clean", `touch ${marker}; cat`);
    git(r.path, "config", "filter.evil.process", `touch ${marker}`);
    writeFileSync(join(r.path, ".gitattributes"), "* filter=evil\n");
    writeFileSync(join(r.path, ".git", "info", "attributes"), "* filter=evil\n");
    return baseline;
  });
  cleanups.push(() => check.mockRestore());
  const d = await taskChanges(db, task.id);
  expect(check).toHaveBeenCalled();
  expect(d.files.find((f) => f.path === "README.md")).toMatchObject({ status: "modified", additions: 1, deletions: 0 });
  expect(existsSync(marker)).toBe(false);
  // Reading again, with the filter already in place, runs nothing either.
  await taskChanges(db, task.id);
  expect(existsSync(marker)).toBe(false);
});
