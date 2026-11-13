import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGate } from "../../src/engine/checks/gate";
import { judge, runChecks } from "../../src/engine/checks/run";
import { tempHome, tempRepo } from "../helpers";

const FAKE_CHECK = `bun ${join(import.meta.dir, "..", "fixtures", "fake-check.ts")}`;

let home: ReturnType<typeof tempHome>;
const cleanups: Array<() => void> = [];
beforeEach(() => {
  home = tempHome();
});
afterEach(() => {
  home.cleanup();
  while (cleanups.length) cleanups.pop()!();
});

function git(path: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", "-c", "user.name=Atrium Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: path });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
}

// A repo with `files` committed on main, then a branch that `change` edits, as a writer's turn leaves it.
function branch(files: Record<string, string>, change: (path: string) => void, setup?: (path: string) => void) {
  const r = tempRepo();
  cleanups.push(r.cleanup);
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(r.path, name, ".."), { recursive: true });
    writeFileSync(join(r.path, name), body);
  }
  setup?.(r.path);
  git(r.path, "add", "-A");
  git(r.path, "commit", "-qm", "base");
  const base = git(r.path, "rev-parse", "HEAD");
  git(r.path, "checkout", "-qb", "atrium/tsk_x");
  change(r.path);
  git(r.path, "add", "-A");
  git(r.path, "commit", "-qm", "turn");
  return { path: r.path, base, head: git(r.path, "rev-parse", "HEAD") };
}

const gate = (r: { path: string; base: string; head: string }, command: string, goal = "Add totals") =>
  runGate({ repo: r.path, base: r.base, head: r.head, checks: [{ name: "Tests", command, kind: "full" }], goal, outside: [] });

describe("what passing means", () => {
  test("a test that exits 127 fails: an exit code never says a tool is missing", async () => {
    const r = branch({ "status.txt": "pass\n" }, (p) => writeFileSync(join(p, "a.ts"), "process.exit(127);\n"));
    // The writer's file makes the suite exit 127 on the branch; on the base commit it passes.
    const out = await gate(r, "if [ -e a.ts ]; then echo '1 fail'; exit 127; fi");
    expect(out.verdict).toBe("failed");
    expect(out.results![0]!.status).toBe("failed");
  });

  test("a check whose tool isn't there is unverified with a note, never passed alongside one that ran", async () => {
    const results = await runChecks(tempRepoPath(), [
      { name: "Typecheck", command: "echo ok", kind: "fast" },
      { name: "Tests", command: "no-such-runner --all", kind: "full" },
    ]);
    expect(results.map((r) => r.status)).toEqual(["passed", "missing"]);
    expect(judge(results)).toEqual({ verdict: "none", unverified: "Unverified: Tests couldn't run.", attention: ["Tests couldn't run (couldn't run), so it proves nothing."] });
  });

  test("the install never counts as a passing check, and a registry that needs a login leaves it unverified", () => {
    const base = { kind: "fast" as const, exitCode: 0, output: "", durationMs: 1 };
    const installed = { ...base, name: "Install", command: "bun install", install: true, status: "passed" as const };
    expect(judge([installed, { ...base, name: "Tests", command: "x", kind: "full", status: "missing" }]).verdict).toBe("none");
    const login = { ...installed, status: "failed" as const, exitCode: 1, output: "error: GET https://registry.example.com/x - 401" };
    expect(judge([login, { ...base, name: "Tests", command: "x", kind: "full", status: "skipped" }])).toEqual({
      verdict: "none",
      unverified: "Unverified: Atrium couldn't install the dependencies because the registry needs your login, which checks never get.",
      attention: [],
    });
    expect(judge([{ ...login, output: "error: lockfile had changes, but lockfile is frozen" }]).verdict).toBe("failed");
  });
});

function tempRepoPath() {
  const r = tempRepo();
  cleanups.push(r.cleanup);
  return r.path;
}

describe("where the checks run", () => {
  test("checks run on the commit in a tree of their own: nothing they write reaches the user's checkout", async () => {
    const r = branch({ "status.txt": "pass\n" }, (p) => writeFileSync(join(p, "status.txt"), "pass\n\n"));
    const out = await gate(r, `${FAKE_CHECK} && echo made > made-by-check.txt`);
    expect(out.verdict).toBe("passed");
    expect(existsSync(join(r.path, "made-by-check.txt"))).toBe(false);
    expect(git(r.path, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree "))).toHaveLength(1);
  });

  test("checks use the user's dependencies read-only", async () => {
    const r = branch({ ".gitignore": "node_modules\n" }, (p) => writeFileSync(join(p, "a.txt"), "x"), (p) => {
      mkdirSync(join(p, "node_modules", "dep"), { recursive: true });
      writeFileSync(join(p, "node_modules", "dep", "index.js"), "theirs");
    });
    const out = await gate(r, "cat node_modules/dep/index.js && (echo planted > node_modules/dep/index.js || echo write-denied)");
    expect(out.results![0]!.output).toContain("theirs");
    expect(out.results![0]!.output).toContain("write-denied");
    expect(readFileSync(join(r.path, "node_modules", "dep", "index.js"), "utf8")).toBe("theirs");
  });

  test("a changed lockfile is installed into a private copy that never reaches the user's node_modules", async () => {
    const r = branch(
      { ".gitignore": "node_modules\n", "package.json": '{ "name": "demo" }\n', "local-pkg/package.json": '{ "name": "local-pkg", "version": "1.0.0" }\n', "local-pkg/index.js": "module.exports = 1;\n" },
      (p) => {
        writeFileSync(join(p, "package.json"), '{ "name": "demo", "dependencies": { "local-pkg": "file:./local-pkg" } }\n');
        Bun.spawnSync(["bun", "install", "--lockfile-only"], { cwd: p });
      },
      (p) => {
        Bun.spawnSync(["bun", "install"], { cwd: p });
        mkdirSync(join(p, "node_modules"), { recursive: true });
        writeFileSync(join(p, "node_modules", "theirs.txt"), "the user's own");
      },
    );
    const before = readdirSync(join(r.path, "node_modules")).sort();
    const out = await gate(r, "test -e node_modules/local-pkg/index.js && test -e node_modules/theirs.txt && echo installed");
    expect(out.results!.map((c) => [c.name, c.status])).toEqual([["Install", "passed"], ["Tests", "passed"]]);
    expect(out.attention.some((n) => n.startsWith("This change edits how checks run: bun.lock, package.json"))).toBe(true);
    expect(readdirSync(join(r.path, "node_modules")).sort()).toEqual(before);
    expect(existsSync(join(r.path, "node_modules", "local-pkg"))).toBe(false);
  });
});

describe("checks that were already failing", () => {
  const failingBase = (change: (p: string) => void) => branch({ "status.txt": "wrong\n" }, change);

  test("a check failing the same way on the base commit doesn't count against the task", async () => {
    const out = await gate(failingBase((p) => writeFileSync(join(p, "other.txt"), "x")), FAKE_CHECK);
    expect(out.preexisting).toEqual(["Tests"]);
    expect(out.verdict).toBe("none");
  });

  test("a check that now fails differently, or that the task is meant to fix, still counts", async () => {
    const worse = await gate(failingBase((p) => writeFileSync(join(p, "status.txt"), "worse\n")), FAKE_CHECK);
    expect([worse.verdict, worse.preexisting]).toEqual(["failed", []]);
    const meant = await gate(failingBase((p) => writeFileSync(join(p, "other.txt"), "x")), FAKE_CHECK, "Fix the failing tests");
    expect([meant.verdict, meant.preexisting]).toEqual(["failed", []]);
  });
});

describe("fail-closed edges", () => {
  for (const install of [true, false]) {
    test(`a committed node_modules link pointing outside the tree is replaced, never written through (${install ? "install" : "no install"})`, async () => {
      const outside = mkdtempSync(join(tmpdir(), "atrium-outside-"));
      cleanups.push(() => rmSync(outside, { recursive: true, force: true }));
      const pkg = (v: string) => `{ "name": "demo", "version": "${v}", "dependencies": { "local-pkg": "file:./local-pkg" } }\n`;
      const r = branch({ "package.json": pkg("1.0.0"), "local-pkg/package.json": '{ "name": "local-pkg", "version": "1.0.0" }\n' }, (p) => {
        rmSync(join(p, "node_modules"), { recursive: true, force: true });
        symlinkSync(outside, join(p, "node_modules"));
        if (install) writeFileSync(join(p, "package.json"), pkg("1.0.1"));
      }, (p) => Bun.spawnSync(["bun", "install"], { cwd: p }));
      const out = await gate(r, "echo planted > node_modules/planted; mkdir -p node_modules/x; true");
      expect(out.results![0]!.install ?? false).toBe(install);
      expect(readdirSync(outside)).toEqual([]);
    });
  }

  test("the install can't write through a dependency folder linked to the user's own", async () => {
    const { installProfile } = await import("../../src/engine/checks/sandbox");
    const theirs = tempRepoPath();
    mkdirSync(join(theirs, "node_modules"));
    const tree = tempRepoPath();
    symlinkSync(join(theirs, "node_modules"), join(tree, "node_modules"));
    const tmp = mkdtempSync(join(tmpdir(), "atrium-agent-"));
    cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
    const write = Bun.spawnSync(["/usr/bin/sandbox-exec", "-p", installProfile(tree, tmp), "/bin/sh", "-c", "echo x > node_modules/planted"], { cwd: tree });
    expect(write.exitCode).not.toBe(0);
    expect(existsSync(join(theirs, "node_modules", "planted"))).toBe(false);
  });

  test("the outside snapshot reads only regular files, never hangs on a FIFO, and counts oversized or unsnapshotted config as changed", async () => {
    const { changedOutside, outsideSnapshot } = await import("../../src/engine/checks/attention");
    const path = tempRepoPath();
    writeFileSync(join(path, ".gitignore"), ".npmrc\nbunfig.toml\n.yarnrc\n");
    git(path, "add", "-A");
    git(path, "commit", "-qm", "ignore");
    Bun.spawnSync(["mkfifo", join(path, ".npmrc")]);
    symlinkSync("/etc/hosts", join(path, "bunfig.toml"));
    writeFileSync(join(path, ".yarnrc"), "x".repeat(2 * 1024 * 1024));
    // git doesn't list a FIFO at all, so it's never opened; the link is recorded by its target, never followed, and
    // like an oversized file it's never taken as unchanged, since a retarget could otherwise go unseen.
    const snap = await outsideSnapshot(path);
    expect(snap).toEqual({ "bunfig.toml": "link:/etc/hosts", ".yarnrc": "oversize" });
    expect((await changedOutside(path, snap)).sort()).toEqual([".yarnrc", "bunfig.toml"]);
    expect((await changedOutside(path, null)).sort()).toEqual([".yarnrc", "bunfig.toml"]);
  });

  test("a stored loop missing fields reads with the defaults, the outside snapshot missing", async () => {
    const { openDb } = await import("../../src/engine/db");
    const { createSpace } = await import("../../src/engine/spaces");
    const { createTask, getTask } = await import("../../src/engine/tasks");
    const db = openDb();
    const s = createSpace(db, { name: "App", kind: "repo", goal: "", repoPath: "/tmp/x" });
    const t = createTask(db, { spaceId: s.id, title: "Fix" });
    db.query("UPDATE tasks SET loop = ? WHERE id = ?").run(JSON.stringify({ stage: "writing", checks: "passed" }), t.id);
    const loop = getTask(db, t.id)!.loop!;
    expect([loop.checks, loop.outside, loop.attention, loop.preexisting, loop.unverified]).toEqual(["passed", null, [], [], null]);
    db.close();
  });
});
