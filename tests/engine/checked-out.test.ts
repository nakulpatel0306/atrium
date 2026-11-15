import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkedOut } from "../../src/engine/git";
import { tempRepo } from "../helpers";

// Whether a branch is open in some checkout, which decides whether the engine may move it (memory.ts acceptLine).
const repos: ReturnType<typeof tempRepo>[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.cleanup();
});

function repo() {
  const r = tempRepo();
  repos.push(r);
  return r.path;
}

const git = (path: string, args: string[], env: Record<string, string> = {}) => {
  const r = Bun.spawnSync(["git", "-c", "commit.gpgsign=false", ...args], { cwd: path, env: { ...process.env, ...env } });
  return { code: r.exitCode, out: r.stdout.toString().trim() };
};

// A task branch two commits ahead of main.
function withBranch(path: string) {
  git(path, ["checkout", "-qb", "atrium/tsk_a"]);
  for (const n of ["1", "2"]) {
    writeFileSync(join(path, "work.txt"), `${n}\n`);
    git(path, ["add", "work.txt"]);
    git(path, ["commit", "-qm", `turn ${n}`]);
  }
  git(path, ["checkout", "-q", "main"]);
}

test("a branch checked out here is open; a branch nobody has is not", async () => {
  const path = repo();
  withBranch(path);
  expect(await checkedOut(path, "atrium/tsk_a")).toBe(false);
  git(path, ["checkout", "-q", "atrium/tsk_a"]);
  expect(await checkedOut(path, "atrium/tsk_a")).toBe(true);
});

test("a branch the user is rebasing counts as open, though its checkout is detached meanwhile", async () => {
  const path = repo();
  withBranch(path);
  git(path, ["checkout", "-q", "atrium/tsk_a"]);
  // An interactive rebase stopped to edit the first commit, as a user in the middle of one leaves it.
  const r = git(path, ["rebase", "-i", "main"], { GIT_SEQUENCE_EDITOR: "sed -i.bak 's/^pick/edit/'" });
  expect(r.code).toBe(0);
  expect(git(path, ["branch", "--show-current"]).out).toBe("");
  expect(await checkedOut(path, "atrium/tsk_a")).toBe(true);
  git(path, ["rebase", "--abort"]);
  git(path, ["checkout", "-q", "main"]);
  expect(await checkedOut(path, "atrium/tsk_a")).toBe(false);
});

test("an apply-style rebase stopped on a conflict counts as open too", async () => {
  const path = repo();
  withBranch(path);
  writeFileSync(join(path, "work.txt"), "main's own\n");
  git(path, ["add", "work.txt"]);
  git(path, ["commit", "-qm", "conflicting"]);
  git(path, ["checkout", "-q", "atrium/tsk_a"]);
  expect(git(path, ["rebase", "--apply", "main"]).code).not.toBe(0);
  expect(await checkedOut(path, "atrium/tsk_a")).toBe(true);
  git(path, ["rebase", "--abort"]);
});

test("a checkout in the middle of a bisect counts every branch as open", async () => {
  const path = repo();
  withBranch(path);
  git(path, ["bisect", "start", "atrium/tsk_a", "main"]);
  expect(await checkedOut(path, "atrium/tsk_a")).toBe(true);
  git(path, ["bisect", "reset"]);
  expect(await checkedOut(path, "atrium/tsk_a")).toBe(false);
});
