import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getApproval, listPending, onApprovalResolved, resolveApproval } from "../../../src/engine/approvals";
import { openDb } from "../../../src/engine/db";
import { askToRemove, CLONE_IDLE_MS, checkRemovable, DECLINE_QUIET_MS, scanIdleClones } from "../../../src/engine/repos/cleanup";
import { createCloner } from "../../../src/engine/repos/clones";
import { createRepos } from "../../../src/engine/repos";
import { actionForApproval, listClones, type RepoClone } from "../../../src/engine/repos/store";
import { createSpace, getSpace, type Space } from "../../../src/engine/spaces";
import { createTask } from "../../../src/engine/tasks";
import { tempHome } from "../../helpers";
import { type FakeGitHub, fakeGitHub, seedRemote } from "../../repos-helpers";

// Each test spawns git, the fake gh and sometimes ssh-keygen several times; slow under load.
setDefaultTimeout(30_000);

let home: ReturnType<typeof tempHome>;
let db: Database;
let gh: FakeGitHub;
let space: Space;
let clone: RepoClone;
let path: string;

beforeEach(async () => {
  home = tempHome();
  db = openDb();
  gh = fakeGitHub();
  seedRemote(gh, "demo", { ".gitignore": ".env\nsecrets/\ndist/\nnode_modules/\n" });
  space = createSpace(db, { name: "Demo", kind: "repo", goal: "g", github: "fakeuser/demo" });
  const c = createCloner(db, () => {});
  c.request(space);
  await c.settle();
  clone = listClones(db)[0]!;
  path = clone.path;
});
const unsubscribe: (() => void)[] = [];
afterEach(() => {
  while (unsubscribe.length) unsubscribe.pop()!();
  db.close();
  gh.cleanup();
  home.cleanup();
});

// As main.ts wires it: Nakul's decisions reach the repo executors through the approval listener.
const wired = () => {
  const repos = createRepos({ db, kick: () => {} });
  unsubscribe.push(onApprovalResolved(repos.onDecision));
  return repos;
};

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: process.env });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
};
const write = (rel: string, body = "x") => {
  mkdirSync(join(path, rel, ".."), { recursive: true });
  writeFileSync(join(path, rel), body);
};
const reasons = async () => {
  const r = await checkRemovable(db, clone.id);
  return r.ok ? [] : r.reasons;
};

test("a clean, fully pushed clone can be removed", async () => {
  const r = await checkRemovable(db, clone.id);
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.bytes).toBeGreaterThan(0);
});

test("build output, even with a package's .env inside node_modules, doesn't block", async () => {
  write("node_modules/pkg/.env", "SECRET=1");
  write("dist/app.js", "x");
  write(".DS_Store", "x");
  expect(await reasons()).toEqual([]);
});

const UNPUSHED_1 = "1 commit on local branches, tags or the checked-out commit isn't on GitHub.";

const cases: [string, () => void, string][] = [
  ["a modified tracked file", () => write("README.md", "changed"), "There are uncommitted changes."],
  ["an untracked file", () => write("notes.txt"), "There are files git doesn't track: notes.txt."],
  ["an ignored .env", () => write(".env", "K=1"), "There's a .env file: .env."],
  ["an ignored folder that isn't build output", () => write("secrets/key.txt"), "There are ignored files that aren't build output: secrets/."],
  ["a .env inside ignored build output", () => write("dist/.env.local", "K=1"), "There's a .env file: dist/.env.local."],
  [
    "a stash",
    () => {
      write("README.md", "changed");
      git(path, "stash", "push", "-q", "-m", "atrium-test");
    },
    "There are stashed changes.",
  ],
  ["an extra worktree", () => git(path, "worktree", "add", "-q", join(gh.base, "wt")), "There are extra worktrees."],
  [
    "a local branch with a commit",
    () => {
      git(path, "checkout", "-q", "-b", "atrium/tsk_1");
      git(path, "commit", "-q", "--allow-empty", "-m", "local");
      git(path, "checkout", "-q", "main");
    },
    UNPUSHED_1,
  ],
  [
    "a detached HEAD on an unpushed commit",
    () => {
      git(path, "checkout", "-q", "--detach");
      git(path, "commit", "-q", "--allow-empty", "-m", "detached");
    },
    UNPUSHED_1,
  ],
  [
    "a local branch named like a remote branch",
    () => {
      git(path, "checkout", "-q", "-b", "origin/main");
      git(path, "commit", "-q", "--allow-empty", "-m", "hidden");
      git(path, "checkout", "-q", "main");
    },
    UNPUSHED_1,
  ],
  [
    "an unpushed tag",
    () => {
      git(path, "checkout", "-q", "--detach");
      git(path, "commit", "-q", "--allow-empty", "-m", "tagged");
      git(path, "tag", "v-local");
      git(path, "checkout", "-q", "main");
    },
    UNPUSHED_1,
  ],
  ["GitHub out of reach", () => rmSync(join(gh.remotes, "fakeuser", "demo.git"), { recursive: true }), "Couldn't reach GitHub to confirm everything is pushed."],
  ["a queued task", () => void createTask(db, { spaceId: space.id, title: "t" }), "A task is queued or running in Demo."],
  [
    "a .git swapped for a fresh one",
    () => {
      rmSync(join(path, ".git"), { recursive: true });
      git(path, "init", "-q");
    },
    "Atrium didn't create this folder, so it never removes it.",
  ],
];

for (const [name, setup, reason] of cases) {
  test(`refused for ${name}`, async () => {
    setup();
    expect(await reasons()).toEqual([reason]);
  });
}

test("a folder Nakul made is never Atrium's to remove", async () => {
  const mine = join(gh.projects, "mine");
  mkdirSync(mine);
  git(mine, "init", "-q");
  const s = createSpace(db, { name: "Mine", kind: "repo", goal: "g", repoPath: mine });
  expect(s.repoPath).toBe(mine);
  db.exec("UPDATE repo_clones SET status = 'removed'");
  expect(await reasons()).toEqual(["Atrium didn't create this folder, so it never removes it."]);
  expect(await askToRemove(db, clone.id)).toEqual({ reasons: ["Atrium didn't create this folder, so it never removes it."] });
  expect(listPending(db)).toEqual([]);
});

test("idle clones are offered for removal once, and a no keeps it quiet for 30 days", async () => {
  const repos = wired();
  const base = Math.max(clone.lastUsedAt, getSpace(db, space.id)!.updatedAt);
  expect(await scanIdleClones(db, base + CLONE_IDLE_MS - 1000)).toBe(0);
  expect(await scanIdleClones(db, base + CLONE_IDLE_MS)).toBe(1);
  expect(await scanIdleClones(db, base + CLONE_IDLE_MS)).toBe(0);
  const [ask] = listPending(db);
  expect(ask!.alwaysAsk).toBe("remove_clone");
  expect(ask!.spaceId).toBeNull();
  expect(ask!.title).toBe("Remove the local copy of fakeuser/demo?");
  expect(ask!.detail).toContain("Everything is committed and on GitHub, so nothing is lost");
  resolveApproval(db, ask!.id, "reject");
  await repos.settle();
  const declined = listClones(db)[0]!.declinedAt!;
  expect(declined).toBeGreaterThan(0);
  expect(actionForApproval(db, ask!.id)!.status).toBe("rejected");
  expect(await scanIdleClones(db, declined + 29 * 86_400_000)).toBe(0);
  expect(await scanIdleClones(db, declined + DECLINE_QUIET_MS + 86_400_000)).toBe(1);
});

test("Nakul's yes removes the folder and keeps the space's GitHub link", async () => {
  const repos = wired();
  const asked = await askToRemove(db, clone.id);
  if (!("approval" in asked)) throw new Error(asked.reasons.join(" "));
  resolveApproval(db, asked.approval.id, "approve");
  await repos.settle();
  expect(existsSync(path)).toBe(false);
  expect(listClones(db)[0]!.status).toBe("removed");
  expect(getSpace(db, space.id)).toMatchObject({ repoPath: null, github: "fakeuser/demo" });
  expect(actionForApproval(db, asked.approval.id)!.status).toBe("done");
});

test("a .env planted after the yes is caught by the fresh check", async () => {
  const repos = wired();
  const asked = await askToRemove(db, clone.id);
  if (!("approval" in asked)) throw new Error("expected an approval");
  write(".env", "K=1");
  resolveApproval(db, asked.approval.id, "approve");
  await repos.settle();
  expect(existsSync(join(path, ".env"))).toBe(true);
  const action = actionForApproval(db, asked.approval.id)!;
  expect(action.status).toBe("failed");
  expect(action.error).toContain("There's a .env file: .env.");
});

test("a removal decided by a rule removes nothing", async () => {
  const repos = wired();
  const asked = await askToRemove(db, clone.id);
  if (!("approval" in asked)) throw new Error("expected an approval");
  db.query("UPDATE approvals SET status = 'approved', decided_by = 'rule', resolved_at = 1 WHERE id = ?").run(asked.approval.id);
  repos.onDecision(getApproval(db, asked.approval.id)!, "approve");
  await repos.settle();
  expect(existsSync(join(path, "README.md"))).toBe(true);
  expect(actionForApproval(db, asked.approval.id)!.status).toBe("failed");
});

test("after removal, the space clones again when a task needs it", async () => {
  const repos = wired();
  const asked = await askToRemove(db, clone.id);
  if (!("approval" in asked)) throw new Error("expected an approval");
  resolveApproval(db, asked.approval.id, "approve");
  await repos.settle();
  repos.requestClone(getSpace(db, space.id)!);
  await repos.settle();
  expect(existsSync(join(path, "README.md"))).toBe(true);
  expect(listClones(db).map((c) => c.status)).toEqual(["removed", "present"]);
});
