import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApproval, resolveApproval } from "../../../src/engine/approvals";
import { openDb } from "../../../src/engine/db";
import { cloneRepo, fetchOrigin, initialCommit, remoteIsEmpty } from "../../../src/engine/repos/gitops";
import { PushRefused, pushInitialMain } from "../../../src/engine/repos/push";
import { tempHome } from "../../helpers";
import { type FakeGitHub, fakeGitHub, seedRemote } from "../../repos-helpers";

// Each test spawns git, the fake gh and sometimes ssh-keygen several times; slow under load.
setDefaultTimeout(30_000);

let home: ReturnType<typeof tempHome>;
let db: Database;
let gh: FakeGitHub;
let dir: string;

beforeEach(() => {
  home = tempHome();
  db = openDb();
  gh = fakeGitHub();
  dir = join(gh.projects, "demo");
  mkdirSync(dir);
  writeFileSync(join(dir, "README.md"), "# demo\n");
});
afterEach(() => {
  db.close();
  gh.cleanup();
  home.cleanup();
});

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: process.env });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};

const bare = (name = "demo") => {
  const path = join(gh.remotes, "fakeuser", `${name}.git`);
  mkdirSync(join(gh.remotes, "fakeuser"), { recursive: true });
  git(gh.remotes, "init", "-q", "--bare", "-b", "main", path);
  return path;
};

const repoAsk = (kind: "create_repo" | "remove_clone" = "create_repo") =>
  createApproval(db, { spaceId: null, kind: "question", title: "Create?", detail: "", alwaysAsk: kind });

test("initialCommit makes one plain commit as the configured identity", async () => {
  const sha = await initialCommit(dir);
  expect(git(dir, "rev-parse", "HEAD").out.trim()).toBe(sha);
  expect(git(dir, "rev-list", "--count", "HEAD").out.trim()).toBe("1");
  expect(git(dir, "log", "-1", "--format=%B").out).toBe("Initial commit\n\n");
  expect(git(dir, "log", "-1", "--format=%ae").out.trim()).toBe("test@atrium.local");
  expect(git(dir, "branch", "--show-current").out.trim()).toBe("main");
  const body = git(dir, "log", "-1", "--format=%B").out;
  const trailers = Bun.spawnSync(["git", "interpret-trailers", "--parse"], { stdin: Buffer.from(body), env: process.env }).stdout.toString();
  expect(trailers).toBe("");
});

test("with signing on, the first commit is signed", async () => {
  gh.withSigning();
  await initialCommit(dir);
  expect(git(dir, "cat-file", "commit", "HEAD").out).toMatch(/^gpgsig /m);
});

test("broken signing stops before anything else", async () => {
  gh.withSigning();
  rmSync(join(gh.base, "k"));
  rmSync(join(gh.base, "k.pub"));
  await expect(initialCommit(dir)).rejects.toThrow(
    "Git couldn't sign the first commit, so nothing was pushed. Check your signing key setup, then approve again.",
  );
});

test("no git identity says how to set one", async () => {
  writeFileSync(gh.gitconfig, "[commit]\n\tgpgsign = false\n");
  await expect(initialCommit(dir)).rejects.toThrow(
    "Set your git name and email first (git config --global user.name / user.email), then approve again.",
  );
});

test("pushInitialMain refuses anything but Nakul's own yes on a new repo", async () => {
  await initialCommit(dir);
  const remote = bare();
  const url = "https://github.com/fakeuser/demo.git";
  const pending = repoAsk();
  await expect(pushInitialMain(db, pending.id, dir, url)).rejects.toThrow(PushRefused);
  const rejected = repoAsk();
  resolveApproval(db, rejected.id, "reject");
  await expect(pushInitialMain(db, rejected.id, dir, url)).rejects.toThrow("Only your own yes on a new repo can push.");
  const byRule = repoAsk();
  // As if a rule's decision had slipped past the DB's CHECK: the code must still refuse it.
  db.exec("PRAGMA ignore_check_constraints = ON");
  db.query("UPDATE approvals SET status = 'approved', decided_by = 'rule', resolved_at = 1 WHERE id = ?").run(byRule.id);
  db.exec("PRAGMA ignore_check_constraints = OFF");
  await expect(pushInitialMain(db, byRule.id, dir, url)).rejects.toThrow(PushRefused);
  const wrongKind = repoAsk("remove_clone");
  resolveApproval(db, wrongKind.id, "approve");
  await expect(pushInitialMain(db, wrongKind.id, dir, url)).rejects.toThrow(PushRefused);
  expect(git(remote, "rev-parse", "--verify", "-q", "main").code).not.toBe(0);
});

test("pushInitialMain pushes main on Nakul's yes", async () => {
  const sha = await initialCommit(dir);
  const remote = bare();
  const yes = repoAsk();
  resolveApproval(db, yes.id, "approve");
  await pushInitialMain(db, yes.id, dir, "https://github.com/fakeuser/demo.git");
  expect(git(remote, "log", "-1", "--format=%H", "main").out.trim()).toBe(sha);
});

test("a push nobody answers times out", async () => {
  await initialCommit(dir);
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  try {
    const yes = repoAsk();
    resolveApproval(db, yes.id, "approve");
    const started = Date.now();
    await expect(pushInitialMain(db, yes.id, dir, `http://127.0.0.1:${server.port}/x.git`, 500)).rejects.toThrow(
      "GitHub didn't answer within 30 seconds.",
    );
    expect(Date.now() - started).toBeLessThan(5000);
  } finally {
    server.stop(true);
  }
});

test("cloneRepo clears other credential helpers before naming gh", async () => {
  seedRemote(gh, "demo");
  const realGit = Bun.which("git")!;
  const bin = join(gh.base, "bin");
  mkdirSync(bin);
  const argvLog = join(gh.base, "git-argv.log");
  writeFileSync(join(bin, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${argvLog}'\nexec '${realGit}' "$@"\n`);
  chmodSync(join(bin, "git"), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    const dest = join(gh.projects, "cloned");
    await cloneRepo("https://github.com/fakeuser/demo.git", dest);
    expect(git(dest, "log", "-1", "--format=%s").out.trim()).toBe("init");
    const line = (await Bun.file(argvLog).text()).split("\n").find((l) => l.includes(" clone "))!;
    const cleared = line.indexOf("credential.helper= ");
    const named = line.indexOf(`credential.helper=!${process.env.ATRIUM_GH_BIN} auth git-credential`);
    expect(cleared).toBeGreaterThanOrEqual(0);
    expect(named).toBeGreaterThan(cleared);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("fetchOrigin reports a remote that's gone", async () => {
  const remote = seedRemote(gh, "demo");
  const dest = join(gh.projects, "cloned");
  await cloneRepo("https://github.com/fakeuser/demo.git", dest);
  expect(await fetchOrigin(dest)).toEqual({ ok: true });
  rmSync(remote, { recursive: true, force: true });
  const res = await fetchOrigin(dest);
  expect(res.ok).toBe(false);
});

test("remoteIsEmpty tells an empty repo from one with commits", async () => {
  bare("empty");
  seedRemote(gh, "full");
  expect(await remoteIsEmpty("https://github.com/fakeuser/empty.git")).toBe(true);
  expect(await remoteIsEmpty("https://github.com/fakeuser/full.git")).toBe(false);
});
