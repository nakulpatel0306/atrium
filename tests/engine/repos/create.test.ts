import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getApproval, resolveApproval } from "../../../src/engine/approvals";
import { openDb } from "../../../src/engine/db";
import { createProject, recoverRepoActions } from "../../../src/engine/repos/create";
import type { ProjectDraft } from "../../../src/engine/repos/names";
import { draftProject, getRepoAction, listClones, pendingRepoActions } from "../../../src/engine/repos/store";
import { listActivity } from "../../../src/engine/events";
import { listSpaces } from "../../../src/engine/spaces";
import { tempHome } from "../../helpers";
import { type FakeGitHub, fakeGitHub } from "../../repos-helpers";

// Each test spawns git, the fake gh and sometimes ssh-keygen several times; slow under load.
setDefaultTimeout(30_000);

let home: ReturnType<typeof tempHome>;
let db: Database;
let gh: FakeGitHub;
let kicks: number;
beforeEach(() => {
  home = tempHome();
  db = openDb();
  gh = fakeGitHub();
  kicks = 0;
});
afterEach(() => {
  db.close();
  gh.cleanup();
  home.cleanup();
});

const d: ProjectDraft = { name: "demo", description: "x", visibility: "private", template: "bun-ts" };
const deps = (over: { ghTimeoutMs?: number } = {}) => ({ kick: () => void kicks++, ...over });
const git = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", ...args], { cwd, env: process.env }).stdout.toString();
const bare = (name = "demo") => join(gh.remotes, "fakeuser", `${name}.git`);
const staging = () => readdirSync(gh.projects).filter((e) => e.startsWith(".atrium-new-"));

function approved(draft: ProjectDraft = d) {
  const { action, approval } = draftProject(db, draft);
  resolveApproval(db, approval.id, "approve");
  return action;
}

test("Nakul's yes creates the repo, first commit, push, space and clone row", async () => {
  const done = await createProject(db, approved().id, deps());
  expect(done.status).toBe("done");
  const final = join(gh.projects, "demo");
  for (const f of ["package.json", "README.md", "CLAUDE.md", ".gitignore", "src/index.ts"]) expect(existsSync(join(final, f))).toBe(true);
  expect(git(bare(), "rev-parse", "main").trim()).toBe(git(final, "rev-parse", "HEAD").trim());
  expect(git(final, "log", "-1", "--format=%B")).toBe("Initial commit\n\n");
  expect(git(final, "config", "--get", "remote.origin.url").trim()).toBe("https://github.com/fakeuser/demo.git");
  const [space] = listSpaces(db);
  expect(space).toMatchObject({ kind: "repo", name: "demo", goal: "x", github: "fakeuser/demo", private: true, repoPath: final });
  expect(done.spaceId).toBe(space!.id);
  expect(listClones(db)).toMatchObject([{ origin: "new_project", path: final, github: "fakeuser/demo", spaceId: space!.id }]);
  expect(gh.argv()).toEqual([
    ["api", "user", "--jq", ".login"],
    ["repo", "create", "--private", "--description=x", "--", "demo"],
  ]);
  expect(staging()).toEqual([]);
  expect(kicks).toBe(1);
});

test("a public repo makes a non-private space", async () => {
  await createProject(db, approved({ ...d, visibility: "public" }).id, deps());
  expect(gh.argv()[1]).toContain("--public");
  expect(listSpaces(db)[0]!.private).toBe(false);
});

test("with signing on, the pushed commit is signed", async () => {
  gh.withSigning();
  await createProject(db, approved().id, deps());
  expect(git(bare(), "cat-file", "commit", "main")).toMatch(/^gpgsig /m);
});

test("a taken name fails plainly and leaves a fresh draft", async () => {
  gh.env("name_taken");
  const failed = await createProject(db, approved().id, deps());
  expect(failed.status).toBe("failed");
  expect(failed.error).toBe('You already have a GitHub repo called "demo". Change the name and approve again.');
  const [next] = pendingRepoActions(db);
  expect(next!.draft).toEqual(d);
  expect(getApproval(db, next!.approvalId)!.detail).toContain("Last try failed: You already have a GitHub repo");
  expect(existsSync(join(gh.projects, "demo"))).toBe(false);
  expect(staging()).toEqual([]);
  expect(listSpaces(db)).toEqual([]);
});

test("signed out or offline stops before repo create", async () => {
  for (const mode of ["logged_out", "offline"]) {
    gh.env(mode);
    const failed = await createProject(db, approved({ ...d, name: `d-${mode}` }).id, deps());
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatch(mode === "offline" ? /^Couldn't reach GitHub/ : /^gh is signed out/);
  }
  expect(gh.argv().every((a) => a[0] === "api")).toBe(true);
});

test("a hung gh times out and leaves nothing behind", async () => {
  gh.env("hang");
  const failed = await createProject(db, approved().id, deps({ ghTimeoutMs: 300 }));
  expect(failed.error).toMatch(/^GitHub didn't answer within 30 seconds/);
  expect(readdirSync(gh.projects)).toEqual([]);
});

test("broken signing fails before the repo is created", async () => {
  gh.withSigning();
  Bun.spawnSync(["rm", join(gh.base, "k"), join(gh.base, "k.pub")]);
  const failed = await createProject(db, approved().id, deps());
  expect(failed.error).toMatch(/^Git couldn't sign the first commit/);
  expect(gh.argv()).toEqual([["api", "user", "--jq", ".login"]]);
  expect(readdirSync(gh.projects)).toEqual([]);
});

test("a failed push keeps the empty repo, and the retry reuses it", async () => {
  gh.env("readonly_remote");
  const failed = await createProject(db, approved().id, deps());
  Bun.spawnSync(["chmod", "-R", "u+w", bare()]);
  gh.env("ok");
  expect(failed.status).toBe("failed");
  expect(failed.error).not.toMatch(/GitHub said|fatal/);
  expect(listActivity(db).find((a) => a.message.startsWith("Couldn't create demo"))!.message).toContain("GitHub said:");
  expect(failed.remoteUrl).toBe("https://github.com/fakeuser/demo");
  const [retry] = pendingRepoActions(db);
  expect(retry!.remoteUrl).toBe("https://github.com/fakeuser/demo");
  expect(getApproval(db, retry!.approvalId)!.detail).toContain("Reusing the empty repo https://github.com/fakeuser/demo.");
  resolveApproval(db, retry!.approvalId, "approve");
  const done = await createProject(db, retry!.id, deps());
  expect(done.status).toBe("done");
  expect(gh.argv().filter((a) => a[1] === "create")).toHaveLength(1);
});

test("a reused repo that has commits is never pushed over", async () => {
  const { action, approval } = draftProject(db, d, { remoteUrl: "https://github.com/fakeuser/demo" });
  Bun.spawnSync(["git", "init", "-q", "--bare", "-b", "main", bare()], { env: process.env });
  const seed = join(gh.base, "seed");
  mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  git(seed, "commit", "-q", "--allow-empty", "-m", "theirs");
  git(seed, "push", "-q", bare(), "main");
  resolveApproval(db, approval.id, "approve");
  const failed = await createProject(db, action.id, deps());
  expect(failed.error).toBe(
    "https://github.com/fakeuser/demo already has commits Atrium didn't make, so it won't push over them. Pick a new name.",
  );
  expect(git(bare(), "log", "-1", "--format=%s", "main").trim()).toBe("theirs");
});

test("boot turns a run that was cut off into a fresh draft and clears its staging folder", () => {
  const { action } = draftProject(db, d);
  db.query("UPDATE repo_actions SET status = 'running', remote_url = 'https://github.com/fakeuser/demo' WHERE id = ?").run(action.id);
  mkdirSync(join(gh.projects, `.atrium-new-${action.id}`));
  expect(recoverRepoActions(db)).toBe(1);
  expect(getRepoAction(db, action.id)).toMatchObject({ status: "failed", error: "Atrium stopped while creating demo." });
  expect(staging()).toEqual([]);
  const [next] = pendingRepoActions(db);
  expect(next!.remoteUrl).toBe("https://github.com/fakeuser/demo");
});

test("an approval decided by a rule never creates anything", async () => {
  const { action, approval } = draftProject(db, d);
  // As if a rule's decision had slipped past the DB's CHECK: the code must still refuse it.
  db.exec("PRAGMA ignore_check_constraints = ON");
  db.query("UPDATE approvals SET status = 'approved', decided_by = 'rule', resolved_at = 1 WHERE id = ?").run(approval.id);
  db.exec("PRAGMA ignore_check_constraints = OFF");
  const failed = await createProject(db, action.id, deps());
  expect(failed).toMatchObject({ status: "failed", error: "Only your own yes can create a repo." });
  expect(gh.argv()).toEqual([]);
});

test("a folder that appears after the yes is left alone", async () => {
  const action = approved();
  mkdirSync(join(gh.projects, "Demo"));
  const failed = await createProject(db, action.id, deps());
  expect(failed.error).toMatch(/^A folder named "Demo" already exists/);
  expect(readdirSync(join(gh.projects, "Demo"))).toEqual([]);
  expect(gh.argv()).toEqual([]);
});

test("a retry after a successful push picks up the repo Atrium already pushed", async () => {
  // As if the first run pushed and then stopped before the space was made.
  const seed = join(gh.base, "first-run");
  mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  git(seed, "commit", "-q", "--allow-empty", "-m", "Initial commit");
  const sha = git(seed, "rev-parse", "HEAD").trim();
  Bun.spawnSync(["git", "init", "-q", "--bare", "-b", "main", bare()], { env: process.env });
  git(seed, "push", "-q", bare(), "main");
  const { action, approval } = draftProject(db, { ...d, description: "new words" }, { remoteUrl: "https://github.com/fakeuser/demo", pushedSha: sha, lastError: "Atrium stopped while creating demo." });
  expect(approval.detail).toContain("Picking up https://github.com/fakeuser/demo, where Atrium already pushed the first commit.");
  resolveApproval(db, approval.id, "approve");
  const done = await createProject(db, action.id, deps());
  expect(done.status).toBe("done");
  expect(git(join(gh.projects, "demo"), "rev-parse", "HEAD").trim()).toBe(sha);
  expect(gh.argv().some((a) => a[1] === "create")).toBe(false);
  // The reused repo gets the description Nakul approved this time.
  expect(gh.argv()).toContainEqual(["repo", "edit", "fakeuser/demo", "--description=new words"]);
});
