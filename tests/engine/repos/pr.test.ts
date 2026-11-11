import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApproval } from "../../../src/engine/approvals";
import { openDb } from "../../../src/engine/db";
import { listActivity } from "../../../src/engine/events";
import { githubSlug, openPullRequest, PrFailed, prInfo } from "../../../src/engine/repos/pr";
import { PushRefused } from "../../../src/engine/repos/push";
import { createSpace } from "../../../src/engine/spaces";
import { createTask, getTask, setTaskStatus, type Task } from "../../../src/engine/tasks";
import { tempHome } from "../../helpers";
import { type FakeGitHub, fakeGitHub, seedRemote } from "../../repos-helpers";

// Each test spawns git and the fake gh several times; slow under load.
setDefaultTimeout(30_000);

let home: ReturnType<typeof tempHome>;
let db: Database;
let gh: FakeGitHub;
const cleanups: Array<() => void> = [];
beforeEach(() => {
  home = tempHome();
  db = openDb();
  gh = fakeGitHub();
});
afterEach(() => {
  db.close();
  while (cleanups.length) cleanups.pop()!();
  gh.cleanup();
  home.cleanup();
});

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: process.env });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
};
const REMOTE = "https://github.com/fakeuser/app";

// A local clone of fakeuser/app with a finished task's commit on atrium/<id>, as a review leaves it.
function finishedTask(opts: { remote?: string | null; start?: string; status?: Task["status"] } = {}) {
  seedRemote(gh, "app");
  const parent = mkdtempSync(join(tmpdir(), "atrium-clone-"));
  cleanups.push(() => rmSync(parent, { recursive: true, force: true }));
  const path = join(parent, "app");
  git(parent, "clone", "-q", REMOTE, "app");
  const space = createSpace(db, { name: "App", kind: "repo", goal: "g", repoPath: path });
  const task = createTask(db, { spaceId: space.id, title: "Add a footer" });
  const branch = `atrium/${task.id}`;
  git(path, "checkout", "-q", "-b", branch);
  writeFileSync(join(path, "footer.html"), "<footer></footer>\n");
  git(path, "add", "-A");
  git(path, "commit", "-q", "-m", "Add a footer");
  git(path, "checkout", "-q", "main");
  db.query("INSERT INTO runs (id, task_id, agent, started_at, transcript_path, start_ref, remote_url) VALUES ('run_1', ?, 'claude', 1, '/tmp/none', ?, ?)").run(
    task.id,
    opts.start ?? "main",
    opts.remote === undefined ? REMOTE : opts.remote,
  );
  setTaskStatus(db, task.id, "running", { branch });
  setTaskStatus(db, task.id, opts.status ?? "review");
  createApproval(db, { spaceId: space.id, taskId: task.id, kind: "review", title: task.title, detail: `Added a footer.\n\nBranch ${branch} is on your machine. Push it when you're ready.` });
  return { path, space, task, branch };
}

const pushApprovals = () => db.query("SELECT * FROM approvals WHERE always_ask = 'push'").all() as { status: string; decided_by: string; rule_id: string | null; task_id: string }[];

test("githubSlug reads the GitHub remote forms and nothing else", () => {
  expect(githubSlug("https://github.com/fakeuser/app")).toBe("fakeuser/app");
  expect(githubSlug("https://github.com/fakeuser/app.git")).toBe("fakeuser/app");
  expect(githubSlug("git@github.com:fakeuser/my.app.git")).toBe("fakeuser/my.app");
  expect(githubSlug("ssh://git@github.com/fakeuser/app.git")).toBe("fakeuser/app");
  expect(githubSlug("https://gitlab.example.com/fakeuser/app.git")).toBeNull();
  expect(githubSlug("https://github.com/fakeuser/app/extra")).toBeNull();
  expect(githubSlug("/tmp/local.git")).toBeNull();
});

test("prInfo offers the branch, target, repo and default title and body", async () => {
  const { task, branch } = finishedTask();
  expect(await prInfo(db, task.id)).toEqual({
    eligible: true,
    url: null,
    branch,
    base: "main",
    repo: "fakeuser/app",
    title: "Add a footer",
    body: "Added a footer.\n\nOpened from Atrium.",
  });
});

test("prInfo says why a task can't open one", async () => {
  const noRemote = finishedTask({ remote: null });
  expect(await prInfo(db, noRemote.task.id)).toMatchObject({ eligible: false, reason: "This repo had no GitHub remote when the task ran, so there's nowhere to open a pull request." });
  db.query("UPDATE runs SET remote_url = ? WHERE task_id = ?").run(REMOTE, noRemote.task.id);
  git(noRemote.path, "branch", "-D", noRemote.branch);
  expect(await prInfo(db, noRemote.task.id)).toMatchObject({ eligible: false, reason: `The branch ${noRemote.branch} isn't in the repo anymore.` });
  const s = createSpace(db, { name: "Docs", kind: "general", goal: "g" });
  const t = createTask(db, { spaceId: s.id, title: "Write" });
  expect(await prInfo(db, t.id)).toMatchObject({ eligible: false });
});

test("Push and open PR pushes the branch to the remote read before the run and opens the PR", async () => {
  const { path, task, branch } = finishedTask();
  // The agent pointing origin somewhere else afterwards changes nothing.
  git(path, "remote", "set-url", "origin", "https://github.com/someoneelse/app");
  expect(await openPullRequest(db, task.id, { title: "Add a footer", body: "Opened from Atrium." })).toEqual({ url: "https://github.com/fakeuser/app/pull/1" });
  expect(git(join(gh.remotes, "fakeuser", "app.git"), "rev-parse", branch)).toBe(git(path, "rev-parse", branch));
  expect(getTask(db, task.id)!.prUrl).toBe("https://github.com/fakeuser/app/pull/1");
  expect(listActivity(db).map((a) => a.message)).toContain("Opened pull request https://github.com/fakeuser/app/pull/1");
  // The yes is on record as Nakul's own, for a push only he can decide.
  expect(pushApprovals()).toEqual([expect.objectContaining({ status: "approved", decided_by: "you", rule_id: null, task_id: task.id })]);
  const create = gh.argv().find((a) => a[0] === "pr")!;
  expect(create).toEqual(["pr", "create", "--repo=fakeuser/app", `--head=${branch}`, "--base=main", "--title=Add a footer", "--body=Opened from Atrium."]);
});

test("a PR that already exists for the branch is stored and counts as success", async () => {
  const { task } = finishedTask({ status: "done" });
  gh.env("pr_exists");
  expect(await openPullRequest(db, task.id, { title: "t", body: "b" })).toEqual({ url: "https://github.com/fakeuser/app/pull/7" });
  expect(getTask(db, task.id)!.prUrl).toBe("https://github.com/fakeuser/app/pull/7");
});

// The bare repo turns pushes down the way GitHub words it.
function refuse(message: string) {
  const hook = join(gh.remotes, "fakeuser", "app.git", "hooks", "pre-receive");
  writeFileSync(hook, `#!/bin/sh\necho "${message}" >&2\nexit 1\n`);
  chmodSync(hook, 0o755);
}

test("a push GitHub turns down is refused in plain words, and no PR is opened", async () => {
  const { task } = finishedTask();
  refuse("ERROR: Permission to fakeuser/app.git denied to fakeuser.");
  const err = await openPullRequest(db, task.id, { title: "t", body: "b" }).catch((e) => e);
  expect(err).toBeInstanceOf(PushRefused);
  expect(err.message).toBe("Your GitHub account can't push to fakeuser/app. Check that you have write access, then try again.");
  expect(gh.argv().some((a) => a[0] === "pr")).toBe(false);
  expect(getTask(db, task.id)!.prUrl).toBeNull();
  refuse("error: GH006: Protected branch update failed for refs/heads/x.");
  const again = await openPullRequest(db, task.id, { title: "t", body: "b" }).catch((e) => e);
  expect(again).toBeInstanceOf(PushRefused);
  expect(again.message).toBe("GitHub turned the push down because of a branch rule on fakeuser/app. Check the repo's branch rules, then try again.");
});

test("gh signed out fails with what to do next", async () => {
  const { task } = finishedTask();
  gh.env("logged_out");
  const err = await openPullRequest(db, task.id, { title: "t", body: "b" }).catch((e) => e);
  expect(err).toBeInstanceOf(PrFailed);
  expect(err.message).toBe("gh is signed out of GitHub. Run `gh auth login` in a terminal, then try again.");
  expect(getTask(db, task.id)!.prUrl).toBeNull();
});

test("no permission to open a PR fails in plain words", async () => {
  const { task } = finishedTask();
  gh.env("pr_denied");
  const err = await openPullRequest(db, task.id, { title: "t", body: "b" }).catch((e) => e);
  expect(err).toBeInstanceOf(PrFailed);
  expect(err.message).toBe("Your GitHub account can't open pull requests on fakeuser/app. Check your access, then try again.");
});

test("a task that isn't finished, or has no GitHub remote, is refused before anything is pushed", async () => {
  const { task } = finishedTask({ remote: "https://gitlab.example.com/fakeuser/app.git" });
  await expect(openPullRequest(db, task.id, { title: "t", body: "b" })).rejects.toBeInstanceOf(PushRefused);
  expect(pushApprovals()).toEqual([]);
  expect(gh.argv()).toEqual([]);
});
