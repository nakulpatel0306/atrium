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

const gate = (r: { path: string; base: string; head: string }, command: string, signal?: AbortSignal) =>
  runGate({ repo: r.path, base: r.base, head: r.head, checks: [{ name: "Tests", command, kind: "full" }], outside: [], signal });

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
    expect(judge(results)).toEqual({ verdict: "none", unverified: "Unverified: Tests couldn't run.", attention: ["Tests couldn't run (its tool isn't installed here), so it proves nothing."] });
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
  // The bug's own test fails on the base commit, as it does before any fix.
  const failingBase = (change: (p: string) => void) => branch({ "status.txt": "wrong\n" }, change);

  test("a change that leaves the base's failing test failing is never passed: it's unverified, with a note", async () => {
    // The noop probe: only a comment changes, and the test the task should fix still fails.
    const out = await gate(failingBase((p) => writeFileSync(join(p, "notes.txt"), "// tidy\n")), FAKE_CHECK);
    expect(out.verdict).toBe("none");
    expect(out.unverified).toBe("Unverified: Tests was already failing before this task.");
    expect(out.attention).toContain("Tests was already failing before this task and still fails, so it proves nothing about this change.");
    expect(out.alreadyFailing.map((f) => f.name)).toEqual(["Tests"]);
    expect(out.alreadyFailing[0]!.excerpt).toContain('expected "pass", got "wrong"');
  });

  test("a check that passed on the base commit and fails now is a real failure, whatever its output", async () => {
    const r = branch({ "status.txt": "pass\n" }, (p) => writeFileSync(join(p, "status.txt"), "wrong\n"));
    const out = await gate(r, FAKE_CHECK);
    expect([out.verdict, out.alreadyFailing]).toEqual(["failed", []]);
  });

  test("a check that failed on the base commit and passes now is simply passed", async () => {
    const out = await gate(failingBase((p) => writeFileSync(join(p, "status.txt"), "pass\n")), FAKE_CHECK);
    expect([out.verdict, out.alreadyFailing]).toEqual(["passed", []]);
  });

  test("type debt on the base commit never skips the tests, so what the change breaks is still found", async () => {
    // The tsdebt probe: 35 type errors already, one more added, and the tests broken.
    const debt = Array.from({ length: 35 }, (_, i) => `src/old${i}.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.`).join("\n");
    const r = branch({ "errors.txt": `${debt}\n`, "status.txt": "pass\n" }, (p) => {
      writeFileSync(join(p, "errors.txt"), `src/aa.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.\n${debt}\n`);
      writeFileSync(join(p, "status.txt"), "wrong\n");
    });
    const out = await runGate({
      repo: r.path,
      base: r.base,
      head: r.head,
      checks: [
        { name: "Typecheck", command: "cat errors.txt; exit 2", kind: "fast" },
        { name: "Tests", command: FAKE_CHECK, kind: "full" },
      ],
      outside: [],
    });
    expect(out.results!.map((c) => [c.name, c.status])).toEqual([["Typecheck", "failed"], ["Tests", "failed"]]);
    expect(out.verdict).toBe("failed");
    expect(out.alreadyFailing.map((f) => f.name)).toEqual(["Typecheck"]);
  });

  test("a Stop during the base run ends it at once and leaves nothing cached", async () => {
    const r = branch({ "status.txt": "pass\n" }, (p) => writeFileSync(join(p, "new.txt"), "x"));
    // Fails at once on the branch; on the base commit it would run for half a minute.
    const command = "if [ -e new.txt ]; then exit 1; else sleep 30; fi";
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 400);
    const started = Date.now();
    await gate(r, command, stop.signal);
    expect(Date.now() - started).toBeLessThan(8000);
    // A later gate runs the base again, rather than reading a cut-short result.
    const again = await gate(r, command.replace("sleep 30", "exit 1"));
    expect(again.alreadyFailing.map((f) => f.name)).toEqual(["Tests"]);
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

  test("a dependency copy that fails leaves the result unverified, never installs into half a copy", async () => {
    const r = branch(
      { ".gitignore": "node_modules\n", "package.json": '{ "name": "demo" }\n', "bun.lock": "{}\n" },
      (p) => writeFileSync(join(p, "package.json"), '{ "name": "demo", "version": "1.0.1" }\n'),
      (p) => {
        mkdirSync(join(p, "node_modules", "locked"), { recursive: true });
        writeFileSync(join(p, "node_modules", "locked", "x"), "x");
        Bun.spawnSync(["chmod", "000", join(p, "node_modules", "locked")]);
      },
    );
    cleanups.push(() => Bun.spawnSync(["chmod", "-R", "755", join(r.path, "node_modules")]));
    const out = await gate(r, "true");
    expect(out.verdict).toBe("none");
    expect(out.unverified).toBe("Unverified: Atrium couldn't copy node_modules for the install, so it didn't install or run the checks.");
  });

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
    expect([loop.checks, loop.outside, loop.attention, loop.alreadyFailing, loop.unverified]).toEqual(["passed", null, [], [], null]);
    db.close();
  });
});
