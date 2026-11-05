import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { branchSummary, commitAll, gitSettingsFingerprint, headRef, prepareBranch, pushBranch, remoteUrl, repoReady, returnToBranch } from "../../src/engine/git";
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
  function withRemote() {
    const path = repo();
    const bare = tempDir();
    git(bare, "init", "--bare");
    git(path, "remote", "add", "origin", bare);
    return { path, bare };
  }

  test("without remote skips with reason", async () => {
    const path = repo();
    expect(await remoteUrl(path)).toBeNull();
    expect(await pushBranch(path, "atrium/tsk_1", null)).toEqual({ pushed: false, reason: "No remote configured" });
  });

  test("never pushes main or master", async () => {
    const { path, bare } = withRemote();
    expect((await pushBranch(path, "main", bare)).pushed).toBe(false);
    expect((await pushBranch(path, "master", bare)).pushed).toBe(false);
  });

  test("pushes a task branch to a local bare remote", async () => {
    const { path, bare } = withRemote();
    await prepareBranch(path, "tsk_1");
    expect(await remoteUrl(path)).toBe(bare);
    expect(await pushBranch(path, "atrium/tsk_1", bare)).toEqual({ pushed: true });
    expect(git(bare, "branch", "--list", "atrium/tsk_1")).toContain("atrium/tsk_1");
  });

  test("does not run a planted pre-push hook", async () => {
    const { path, bare } = withRemote();
    const marker = join(tempDir(), "hook-ran");
    const hook = join(path, ".git", "hooks", "pre-push");
    writeFileSync(hook, `#!/bin/sh\ntouch ${marker}\n`);
    chmodSync(hook, 0o755);
    await prepareBranch(path, "tsk_1");
    expect(await pushBranch(path, "atrium/tsk_1", bare)).toEqual({ pushed: true });
    expect(existsSync(marker)).toBe(false);
  });

  test("a push that hangs times out", async () => {
    const path = repo();
    await prepareBranch(path, "tsk_1");
    // Accepts connections and never answers, like a stalled network.
    const silent = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    cleanups.push(() => silent.stop(true));
    const started = Date.now();
    const res = await pushBranch(path, "atrium/tsk_1", `http://127.0.0.1:${silent.port}/repo.git`, 500);
    expect(res).toEqual({ pushed: false, reason: "The push timed out." });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test("a remote asking for credentials fails instead of prompting", async () => {
    const path = repo();
    await prepareBranch(path, "tsk_1");
    const auth = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("", { status: 401, headers: { "www-authenticate": 'Basic realm="x"' } }),
    });
    cleanups.push(() => auth.stop(true));
    const res = await pushBranch(path, "atrium/tsk_1", `http://127.0.0.1:${auth.port}/repo.git`);
    expect(res.pushed).toBe(false);
    expect(res.reason).toContain("terminal prompts disabled");
  });

  test("pushes to the URL captured before the run, not a rewritten remote", async () => {
    const { path, bare } = withRemote();
    const url = await remoteUrl(path);
    const other = tempDir();
    git(other, "init", "--bare");
    git(path, "remote", "set-url", "origin", other);
    await prepareBranch(path, "tsk_1");
    expect(await pushBranch(path, "atrium/tsk_1", url)).toEqual({ pushed: true });
    expect(git(bare, "branch", "--list", "atrium/tsk_1")).toContain("atrium/tsk_1");
    expect(git(other, "branch", "--list", "atrium/tsk_1")).toBe("");
  });
});

describe("gitSettingsFingerprint", () => {
  test("is stable when nothing relevant changes", async () => {
    const path = repo();
    const before = await gitSettingsFingerprint(path);
    writeFileSync(join(path, "notes.txt"), "work");
    git(path, "add", "notes.txt");
    git(path, "commit", "-m", "work");
    git(path, "checkout", "-b", "other");
    expect(await gitSettingsFingerprint(path)).toBe(before);
  });

  test("changes when config, a hook, or attributes change", async () => {
    const path = repo();
    const seen = new Set([await gitSettingsFingerprint(path)]);
    const changed = async () => {
      const fp = await gitSettingsFingerprint(path);
      expect(seen.has(fp)).toBe(false);
      seen.add(fp);
    };
    appendFileSync(join(path, ".git", "config"), '[url "x"]\n\tinsteadOf = y\n');
    await changed();
    writeFileSync(join(path, ".git", "hooks", "post-checkout"), "#!/bin/sh\n");
    await changed();
    mkdirSync(join(path, ".git", "hooks", "nested"), { recursive: true });
    writeFileSync(join(path, ".git", "hooks", "nested", "x"), "y");
    await changed();
    mkdirSync(join(path, ".git", "info"), { recursive: true });
    writeFileSync(join(path, ".git", "info", "attributes"), "* filter=evil\n");
    await changed();
    writeFileSync(join(path, ".gitattributes"), "* diff=evil\n");
    await changed();
  });

  test("follows config include files", async () => {
    const path = repo();
    const base = await gitSettingsFingerprint(path);
    writeFileSync(join(path, ".git", "extra.cfg"), "[user]\n\tname = A\n");
    appendFileSync(join(path, ".git", "config"), "[include]\n\tpath = extra.cfg\n");
    const included = await gitSettingsFingerprint(path);
    expect(included).not.toBe(base);
    writeFileSync(join(path, ".git", "extra.cfg"), '[url "x"]\n\tinsteadOf = y\n');
    expect(await gitSettingsFingerprint(path)).not.toBe(included);
  });

  test("a linked worktree sees hooks added to the shared hooks dir", async () => {
    const path = repo();
    const wt = join(tempDir(), "wt");
    git(path, "worktree", "add", "-b", "wt-branch", wt);
    const before = await gitSettingsFingerprint(wt);
    writeFileSync(join(path, ".git", "hooks", "pre-push"), "#!/bin/sh\n");
    expect(await gitSettingsFingerprint(wt)).not.toBe(before);
  });

  test("works from a subfolder", async () => {
    const path = repo();
    mkdirSync(join(path, "sub"));
    expect(await gitSettingsFingerprint(join(path, "sub"))).toBe(await gitSettingsFingerprint(path));
  });
});

describe("returnToBranch", () => {
  test("switches back on a clean tree", async () => {
    const path = repo();
    await prepareBranch(path, "tsk_1");
    expect(await returnToBranch(path, "main")).toBe("ok");
    expect(git(path, "branch", "--show-current")).toBe("main");
  });

  test("reports a dirty tree and stays put", async () => {
    const path = repo();
    await prepareBranch(path, "tsk_1");
    writeFileSync(join(path, "left.txt"), "x");
    expect(await returnToBranch(path, "main")).toBe("dirty");
    expect(git(path, "branch", "--show-current")).toBe("atrium/tsk_1");
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

describe("commitAll", () => {
  test("commits all changes with the given message", async () => {
    const path = repo();
    writeFileSync(join(path, "README.md"), "# changed\n");
    writeFileSync(join(path, "new.txt"), "new\n");
    expect(await commitAll(path, "Add things")).toEqual({ committed: true, files: 2 });
    expect(git(path, "log", "-1", "--format=%s")).toBe("Add things");
    expect(git(path, "status", "--porcelain")).toBe("");
  });

  test("with no changes does nothing", async () => {
    const path = repo();
    const head = git(path, "rev-parse", "HEAD");
    expect(await commitAll(path, "Nothing")).toEqual({ committed: false, files: 0 });
    expect(git(path, "rev-parse", "HEAD")).toBe(head);
  });

  test("refuses .env files at any depth and stages nothing", async () => {
    const path = repo();
    // A global ignore file would hide .env.local, and the test needs it visible to git.
    git(path, "config", "core.excludesFile", "/dev/null");
    writeFileSync(join(path, "ok.txt"), "ok\n");
    mkdirSync(join(path, "config"));
    writeFileSync(join(path, "config", ".env.local"), "SECRET=1\n");
    await expect(commitAll(path, "Oops")).rejects.toThrow("Refusing to commit a .env file: config/.env.local");
    expect(git(path, "diff", "--cached", "--name-only")).toBe("");
  });

  test("ignores hooks", async () => {
    const path = repo();
    const hook = join(path, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    chmodSync(hook, 0o755);
    writeFileSync(join(path, "a.txt"), "a\n");
    expect(await commitAll(path, "Hooked")).toEqual({ committed: true, files: 1 });
  });

  test("refuses a custom filter driver", async () => {
    const path = repo();
    const pwned = join(tempDir(), "pwned");
    git(path, "config", "filter.evil.clean", `touch ${pwned}`);
    writeFileSync(join(path, ".gitattributes"), "* filter=evil\n");
    writeFileSync(join(path, "README.md"), "# changed\n");
    await expect(commitAll(path, "Evil")).rejects.toThrow(
      'Refusing to commit: this repo\'s git config defines a "evil" filter that would run a program during commit. Commit these changes yourself if you trust it.',
    );
    expect(existsSync(pwned)).toBe(false);
    expect(git(path, "diff", "--cached", "--name-only")).toBe("");
  });

  test("allows git-lfs filters", async () => {
    const path = repo();
    git(path, "config", "filter.lfs.clean", "git-lfs clean -- %f");
    git(path, "config", "filter.lfs.smudge", "git-lfs smudge -- %f");
    git(path, "config", "filter.lfs.process", "git-lfs filter-process");
    writeFileSync(join(path, "a.txt"), "a\n");
    expect(await commitAll(path, "Lfs")).toEqual({ committed: true, files: 1 });
  });

  test("refuses an lfs-named driver that runs something else", async () => {
    const path = repo();
    git(path, "config", "filter.lfs.clean", "sh -c evil");
    writeFileSync(join(path, "a.txt"), "a\n");
    await expect(commitAll(path, "Fake lfs")).rejects.toThrow('defines a "lfs" filter');
  });

  test("unstages and refuses if settings change during staging", async () => {
    const path = repo();
    writeFileSync(join(path, "a.txt"), "a\n");
    const head = git(path, "rev-parse", "HEAD");
    // Each call returns a new value, as if config changed between the first read and the one after staging.
    let n = 0;
    await expect(commitAll(path, "Racy", async () => `fp${n++}`)).rejects.toThrow(
      "Refusing to commit: git settings changed while committing.",
    );
    expect(git(path, "diff", "--cached", "--name-only")).toBe("");
    expect(git(path, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(path, "a.txt"), "utf8")).toBe("a\n");
  });
});
