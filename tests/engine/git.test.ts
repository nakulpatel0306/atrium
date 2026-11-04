import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { branchSummary, headRef, prepareBranch, pushBranch, repoReady } from "../../src/engine/git";
import { tempRepo } from "../helpers";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function repo() {
  const r = tempRepo();
  cleanups.push(r.cleanup);
  return r.path;
}

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "atrium-plain-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function git(path: string, ...args: string[]) {
  const r = Bun.spawnSync(
    ["git", "-c", "user.name=Atrium Test", "-c", "user.email=test@atrium.local", "-c", "commit.gpgsign=false", ...args],
    { cwd: path },
  );
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
}

describe("repoReady", () => {
  test("clean repo is ready", async () => {
    expect(await repoReady(repo())).toEqual({ ok: true });
  });

  test("dirty repo is not ready", async () => {
    const path = repo();
    writeFileSync(join(path, "scratch.txt"), "x");
    const res = await repoReady(path);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("uncommitted changes");
  });

  test("missing folder and non-repo are reported", async () => {
    expect(await repoReady("/nonexistent/atrium-nope")).toEqual({ ok: false, reason: "Folder not found: /nonexistent/atrium-nope" });
    const plain = tempDir();
    expect(await repoReady(plain)).toEqual({ ok: false, reason: `Not a git repo: ${plain}` });
  });
});

describe("headRef", () => {
  test("reports the branch, or null when detached", async () => {
    const path = repo();
    const sha = git(path, "rev-parse", "HEAD");
    expect(await headRef(path)).toEqual({ branch: "main", sha });
    git(path, "checkout", "--detach");
    expect(await headRef(path)).toEqual({ branch: null, sha });
  });
});

describe("prepareBranch", () => {
  test("creates atrium/<id>", async () => {
    const path = repo();
    expect(await prepareBranch(path, "tsk_1")).toBe("atrium/tsk_1");
    expect(git(path, "branch", "--show-current")).toBe("atrium/tsk_1");
  });

  test("checks out an existing branch on retry", async () => {
    const path = repo();
    await prepareBranch(path, "tsk_1");
    git(path, "checkout", "main");
    expect(await prepareBranch(path, "tsk_1")).toBe("atrium/tsk_1");
    expect(git(path, "branch", "--show-current")).toBe("atrium/tsk_1");
  });

  test("refuses a dirty tree and leaves it untouched", async () => {
    const path = repo();
    writeFileSync(join(path, "scratch.txt"), "x");
    await expect(prepareBranch(path, "tsk_1")).rejects.toThrow("uncommitted changes");
    expect(git(path, "branch", "--show-current")).toBe("main");
    expect(readFileSync(join(path, "scratch.txt"), "utf8")).toBe("x");

    rmSync(join(path, "scratch.txt"));
    writeFileSync(join(path, "README.md"), "edited\n");
    await expect(prepareBranch(path, "tsk_1")).rejects.toThrow("uncommitted changes");
    expect(git(path, "branch", "--show-current")).toBe("main");
    expect(readFileSync(join(path, "README.md"), "utf8")).toBe("edited\n");
  });

  test("refuses main and master", async () => {
    const path = repo();
    await expect(prepareBranch(path, "main")).rejects.toThrow("Refusing to work on main");
    await expect(prepareBranch(path, "master")).rejects.toThrow("Refusing to work on main");
  });
});

describe("pushBranch", () => {
  test("without remote skips with reason", async () => {
    expect(await pushBranch(repo(), "atrium/tsk_1")).toEqual({ pushed: false, reason: "No remote configured" });
  });

  test("never pushes main or master", async () => {
    const path = repo();
    expect((await pushBranch(path, "main")).pushed).toBe(false);
    expect((await pushBranch(path, "master")).pushed).toBe(false);
  });

  test("pushes a task branch to a local bare remote", async () => {
    const path = repo();
    const bare = tempDir();
    git(bare, "init", "--bare");
    git(path, "remote", "add", "origin", bare);
    await prepareBranch(path, "tsk_1");
    expect(await pushBranch(path, "atrium/tsk_1")).toEqual({ pushed: true });
    expect(git(bare, "branch", "--list", "atrium/tsk_1")).toContain("atrium/tsk_1");
  });
});

describe("branchSummary", () => {
  test("counts one commit", async () => {
    const path = repo();
    const branch = await prepareBranch(path, "tsk_1");
    writeFileSync(join(path, "a.txt"), "one\ntwo\n");
    git(path, "add", "-A");
    git(path, "commit", "-m", "add a");
    expect(await branchSummary(path, branch, "main")).toEqual({ commits: 1, filesChanged: 1, insertions: 2, deletions: 0 });
  });

  test("throws on a nonexistent base instead of returning zeros", async () => {
    const path = repo();
    const branch = await prepareBranch(path, "tsk_1");
    await expect(branchSummary(path, branch, "nope")).rejects.toThrow();
  });
});
