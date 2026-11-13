import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { codexStateDir, seatbeltProfile } from "../../src/engine/agents/seatbelt";
import { checkAttention } from "../../src/engine/checks/attention";
import { checkProfile } from "../../src/engine/checks/sandbox";
import { checksFor, detectChecks, hintsFrom, overrideChecks } from "../../src/engine/checks/detect";
import { failureReport, latestChecks, outcomeOf, runChecks, saveChecks, toolBins } from "../../src/engine/checks/run";
import { openDb } from "../../src/engine/db";
import { createSpace } from "../../src/engine/spaces";
import { createTask } from "../../src/engine/tasks";
import { tempHome, tempRepo } from "../helpers";

let home: ReturnType<typeof tempHome>;
const cleanups: Array<() => void> = [];
beforeEach(() => {
  home = tempHome();
});
afterEach(() => {
  home.cleanup();
  while (cleanups.length) cleanups.pop()!();
});

function repoWith(files: Record<string, string>): { path: string; sha: string } {
  const r = tempRepo();
  cleanups.push(r.cleanup);
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(r.path, name, ".."), { recursive: true });
    writeFileSync(join(r.path, name), body);
  }
  const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: r.path }).stdout.toString().trim();
  git("add", "-A");
  git("commit", "-m", "files");
  return { path: r.path, sha: git("rev-parse", "HEAD") };
}

describe("detecting checks", () => {
  test("package.json scripts run as their text from the base commit", async () => {
    const { path, sha } = repoWith({
      "package.json": JSON.stringify({ scripts: { typecheck: "tsc", lint: "eslint .", test: "vitest run" } }),
      "pnpm-lock.yaml": "",
    });
    expect(await detectChecks(path, sha)).toEqual([
      { name: "Typecheck", command: "tsc", kind: "fast", node: true },
      { name: "Lint", command: "eslint .", kind: "fast", node: true },
      { name: "Tests", command: "vitest run", kind: "full", node: true },
    ]);
  });

  test("a bun project with TypeScript and test files but no scripts still gets tsc and bun test", async () => {
    const { path, sha } = repoWith({
      "package.json": JSON.stringify({ devDependencies: { typescript: "5" }, scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
      "bun.lock": "",
      "tsconfig.json": "{}",
      "src/a.test.ts": "",
    });
    expect((await detectChecks(path, sha)).map((c) => c.command)).toEqual(["bunx tsc --noEmit", "bun test"]);
  });

  test("Makefile, pyproject, Cargo and go.mod each give their commands", async () => {
    const make = repoWith({ Makefile: "lint:\n\techo\ntest: build\n\techo\nVAR := 1\n" });
    expect((await detectChecks(make.path, make.sha)).map((c) => c.command)).toEqual(['make -f "$ATRIUM_CHECK_FILES/Makefile" lint', 'make -f "$ATRIUM_CHECK_FILES/Makefile" test']);
    const py = repoWith({ "pyproject.toml": "[tool.ruff]\n[tool.pytest.ini_options]\n", "uv.lock": "" });
    expect((await detectChecks(py.path, py.sha)).map((c) => c.command)).toEqual(["uv run ruff check .", "uv run pytest"]);
    const rust = repoWith({ "Cargo.toml": "[package]\n" });
    expect((await detectChecks(rust.path, rust.sha)).map((c) => c.command)).toEqual(["cargo check", "cargo clippy", "cargo test"]);
    const go = repoWith({ "go.mod": "module example.com/x\n" });
    expect((await detectChecks(go.path, go.sha)).map((c) => c.command)).toEqual(["go vet ./...", "go test ./..."]);
  });

  test("CLAUDE.md and AGENTS.md hints fill in what the scripts don't say", async () => {
    const { path, sha } = repoWith({ "CLAUDE.md": "Run `bun test ./tests/unit` then `bunx tsc --noEmit`.", "package.json": "{}" });
    expect((await detectChecks(path, sha)).map((c) => c.command)).toEqual(["bunx tsc --noEmit", "bun test ./tests/unit"]);
    expect(hintsFrom("Use `make lint` and `pytest -q`")).toEqual({ lint: "make lint", test: "pytest -q" });
  });

  test("a repo with nothing to run has no checks", async () => {
    const { path, sha } = repoWith({ "notes.md": "hi" });
    expect(await detectChecks(path, sha)).toEqual([]);
  });

  test("an agent that rewrites the test script in its tree doesn't change what runs", async () => {
    const { path, sha } = repoWith({ "package.json": JSON.stringify({ scripts: { test: "echo base-tests-ran; exit 1" } }) });
    writeFileSync(join(path, "package.json"), JSON.stringify({ scripts: { test: "exit 0" } }));
    const checks = await detectChecks(path, sha);
    expect(checks.map((c) => c.command)).toEqual(["echo base-tests-ran; exit 1"]);
    const [r] = await runChecks(path, checks);
    expect(r!.status).toBe("failed");
    expect(r!.output).toContain("base-tests-ran");
  });

  test("a Makefile check runs the base commit's Makefile, not the agent's copy", async () => {
    const { path, sha } = repoWith({ Makefile: "test:\n\t@echo base-make; exit 1\n" });
    writeFileSync(join(path, "Makefile"), "test:\n\t@true\n");
    const [r] = await runChecks(path, await detectChecks(path, sha));
    expect(r!.status).toBe("failed");
    expect(r!.output).toContain("base-make");
  });

  test("a space's own commands replace detection; a brief's verify replaces the test run", () => {
    const detected = [
      { name: "Typecheck", command: "bunx tsc --noEmit", kind: "fast" as const },
      { name: "Tests", command: "bun test", kind: "full" as const },
    ];
    expect(overrideChecks("make lint\n\nmake test")).toEqual([
      { name: "make lint", command: "make lint", kind: "fast", node: false },
      { name: "make test", command: "make test", kind: "full", node: false },
    ]);
    expect(checksFor(detected, { spaceChecks: null, verify: "bun test tests/a.test.ts" }).map((c) => c.command)).toEqual(["bunx tsc --noEmit", "bun test tests/a.test.ts"]);
    expect(checksFor(detected, { spaceChecks: "make ci", verify: "auto" }).map((c) => c.command)).toEqual(["make ci"]);
  });
});

describe("running checks", () => {
  const dir = () => repoWith({}).path;

  test("passing and failing commands, with the failing output kept for the writer", async () => {
    const cwd = dir();
    const results = await runChecks(cwd, [
      { name: "Lint", command: "echo lint ok", kind: "fast" },
      { name: "Tests", command: "echo 'expected 2, got 3' >&2; exit 1", kind: "full" },
    ]);
    expect(results.map((r) => r.status)).toEqual(["passed", "failed"]);
    expect(results[1]!.output).toContain("expected 2, got 3");
    expect(outcomeOf(results)).toBe("failed");
    expect(failureReport(results)).toContain("`echo 'expected 2, got 3' >&2; exit 1` failed (exit 1)");
  });

  test("a failing fast check skips the full test run", async () => {
    const results = await runChecks(dir(), [
      { name: "Tests", command: "echo ran > ran.txt", kind: "full" },
      { name: "Typecheck", command: "exit 2", kind: "fast" },
    ]);
    expect(results.map((r) => [r.name, r.status])).toEqual([["Typecheck", "failed"], ["Tests", "skipped"]]);
  });

  test("a tool that isn't installed couldn't run, which leaves the result unverified", async () => {
    const results = await runChecks(dir(), [{ name: "Lint", command: "no-such-tool-here --check", kind: "fast" }]);
    expect(results[0]!.status).toBe("missing");
    expect(outcomeOf(results)).toBe("none");
  });

  test("a check that runs too long is stopped", async () => {
    const results = await runChecks(dir(), [{ name: "Tests", command: "sleep 30", kind: "full" }], { timeoutMs: 300 });
    expect(results[0]!.status).toBe("timeout");
    expect(outcomeOf(results)).toBe("failed");
  });

  test("checks write in the repo but nowhere else, and see none of the engine's secrets", async () => {
    const cwd = dir();
    const outside = join(home.home, "outside.txt");
    process.env.ATRIUM_TEST_SECRET = "s3cret";
    try {
      const results = await runChecks(cwd, [
        { name: "Write", command: `echo hi > inside.txt && (echo no > ${outside} || true) && echo "secret=[$ATRIUM_TEST_SECRET]"`, kind: "full" },
      ]);
      expect(results[0]!.status).toBe("passed");
      expect(results[0]!.output).toContain("secret=[]");
    } finally {
      delete process.env.ATRIUM_TEST_SECRET;
    }
    expect(existsSync(join(cwd, "inside.txt"))).toBe(true);
    expect(existsSync(outside)).toBe(false);
  });

  test("a check can call its own local server but not Atrium's port or the internet", async () => {
    const atrium = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("atrium") });
    process.env.ATRIUM_PORT = String(atrium.port);
    try {
      const script = [
        "bun -e 'const s=Bun.serve({port:0,hostname:\"127.0.0.1\",fetch:()=>new Response(\"own\")}); console.log(await (await fetch(`http://127.0.0.1:${s.port}/`)).text()); s.stop()'",
        `(curl -s -m 2 http://127.0.0.1:${atrium.port}/ || echo atrium-blocked)`,
        "(curl -s -m 2 -o /dev/null http://1.1.1.1/ && echo internet-open || echo internet-blocked)",
      ].join("; ");
      const [r] = await runChecks(dir(), [{ name: "Net", command: script, kind: "full" }]);
      expect(r!.output).toContain("own");
      expect(r!.output).toContain("atrium-blocked");
      expect(r!.output).toContain("internet-blocked");
      expect(r!.output).not.toContain("internet-open");
    } finally {
      delete process.env.ATRIUM_PORT;
      atrium.stop(true);
    }
  });

  test("results are stored per turn and the latest turn's are listed", async () => {
    const db: Database = openDb();
    const space = createSpace(db, { name: "App", kind: "repo", goal: "", repoPath: "/tmp/x" });
    const task = createTask(db, { spaceId: space.id, title: "Fix" });
    const result = { name: "Tests", command: "bun test", kind: "full" as const, exitCode: 1, output: "1 fail", durationMs: 5 };
    saveChecks(db, task.id, null, [{ ...result, status: "failed" }]);
    await Bun.sleep(2);
    saveChecks(db, task.id, null, [{ ...result, status: "passed", exitCode: 0 }]);
    expect(latestChecks(db, task.id).map((c) => c.status)).toEqual(["passed"]);
    db.close();
  });
});

describe("the checks' own sandbox", () => {
  test("only check runs open loopback; the agent profile keeps it shut", () => {
    const agent = seatbeltProfile({ cwd: "/tmp/repo", writable: ["/tmp/repo"] });
    expect(agent).toContain('(deny network-outbound (remote ip "localhost:*"))');
    expect(agent).not.toContain('(allow network-outbound (remote tcp "localhost:*")');
    const check = checkProfile("/tmp/repo", ["/tmp/repo"]);
    expect(check.startsWith(seatbeltProfile({ cwd: "/tmp/repo", writable: ["/tmp/repo"], extraDenyRead: [codexStateDir(), join(homedir(), ".gemini")], denyKeychain: true }))).toBe(true);
    for (const port of [7420, 7421, 22, 9229]) expect(check).toContain(`(remote tcp "localhost:${port}")`);
  });

  test("no agent adapter builds its sandbox from the check profile", async () => {
    for (const file of ["claude.ts", "codex.ts", "gemini.ts", "seatbelt.ts"]) {
      const src = await Bun.file(join(import.meta.dir, "..", "..", "src", "engine", "agents", file)).text();
      expect(src).not.toMatch(/checkProfile|wrapCheck|checks\/sandbox/);
    }
  });

  test("the default engine port is shut to checks even when another one is configured", async () => {
    let atrium: ReturnType<typeof Bun.serve>;
    try {
      atrium = Bun.serve({ port: 7420, hostname: "127.0.0.1", fetch: () => new Response("atrium") });
    } catch {
      // An engine already holds 7420 on this Mac, which the run below checks just the same.
    }
    process.env.ATRIUM_PORT = "7499";
    try {
      const [r] = await runChecks(repoWith({}).path, [{ name: "Net", command: "curl -s -m 2 http://127.0.0.1:7420/ || echo shut", kind: "full" }]);
      expect(r!.output).toContain("shut");
    } finally {
      delete process.env.ATRIUM_PORT;
      atrium!?.stop(true);
    }
  });
});

describe("changes to the checks themselves", () => {
  function branchWith(base: Record<string, string>, change: (path: string) => void): { path: string; base: string; head: string } {
    const { path, sha } = repoWith(base);
    const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: path }).stdout.toString().trim();
    git("checkout", "-q", "-b", "atrium/tsk_x");
    change(path);
    git("add", "-A");
    git("commit", "-qm", "agent");
    return { path, base: sha, head: git("rev-parse", "HEAD") };
  }

  test("editing check config, CI scripts the checks call, or a test runner's config is named", async () => {
    const r = branchWith({ "package.json": "{}", "scripts/ci.sh": "bun test", "src/a.ts": "" }, (p) => {
      writeFileSync(join(p, "package.json"), '{"scripts":{"test":"exit 0"}}');
      writeFileSync(join(p, "vitest.config.ts"), "export default {}");
      writeFileSync(join(p, "src/a.ts"), "export const a = 1;");
    });
    const notes = await checkAttention(r.path, r.base, r.head, [{ name: "Tests", command: "./scripts/ci.sh", kind: "full" }]);
    expect(notes).toEqual(["This change edits how checks run: package.json, vitest.config.ts."]);
  });

  test("removed test files and newly skipped tests are named; a plain code change says nothing", async () => {
    const r = branchWith({ "tests/a.test.ts": "test('a', () => {})", "tests/b.test.ts": "test('b', () => {})", "src/a.ts": "" }, (p) => {
      rmSync(join(p, "tests/a.test.ts"));
      writeFileSync(join(p, "tests/b.test.ts"), "test.skip('b', () => {})");
    });
    expect(await checkAttention(r.path, r.base, r.head, [])).toEqual([
      "This change removes test files: 2 before, 1 now.",
      "This change marks tests as skipped.",
    ]);
    const plain = branchWith({ "src/a.ts": "" }, (p) => writeFileSync(join(p, "src/a.ts"), "export const a = 2;"));
    expect(await checkAttention(plain.path, plain.base, plain.head, [])).toEqual([]);
  });
});

describe("what a check can be made to run", () => {
  test("a Makefile's includes come from the base commit too; one Atrium can't resolve is named", async () => {
    const { path, sha } = repoWith({ Makefile: "include mk/rules.mk\n-include $(LOCAL).mk\n", "mk/rules.mk": "test:\n\t@echo base-rules; exit 1\n" });
    writeFileSync(join(path, "mk/rules.mk"), "test:\n\t@true\n");
    const checks = await detectChecks(path, sha);
    expect(checks[0]!.notes).toEqual(["The Makefile includes $(LOCAL).mk, which Atrium couldn't take from the commit the task started on."]);
    const [r] = await runChecks(path, checks);
    expect(r!.status).toBe("failed");
    expect(r!.output).toContain("base-rules");
  });

  test("a wildcard include is matched against the base commit's files", async () => {
    const { path, sha } = repoWith({ Makefile: "include mk/*.mk\n", "mk/a.mk": "test:\n\t@echo from-a\n" });
    const [r] = await runChecks(path, await detectChecks(path, sha));
    expect(r!.output).toContain("from-a");
  });

  test("only package-manager checks see node_modules/.bin, and after the system PATH's own tools never", async () => {
    const path = repoWith({}).path;
    mkdirSync(join(path, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(path, "node_modules", ".bin", "planted-tool"), "#!/bin/sh\necho planted\n", { mode: 0o755 });
    const [js, other] = await runChecks(path, [
      { name: "Lint", command: "planted-tool", kind: "fast", node: true },
      { name: "Make", command: "planted-tool", kind: "fast" },
    ]);
    expect(js!.output).toContain("planted");
    expect(other!.status).toBe("missing");
  });

  test("package scripts are node checks; make, cargo, go and pytest aren't", async () => {
    const { path, sha } = repoWith({ "package.json": JSON.stringify({ scripts: { lint: "eslint ." } }), "go.mod": "module example.com/x\n" });
    expect((await detectChecks(path, sha)).map((c) => [c.command, c.node])).toEqual([
      ["go vet ./...", false],
      ["eslint .", true],
      ["go test ./...", false],
    ]);
  });

  test("tool snapshots differ once something is planted in node_modules/.bin", () => {
    const path = repoWith({}).path;
    const before = toolBins(path);
    mkdirSync(join(path, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(path, "node_modules", ".bin", "tsc"), "#!/bin/sh\nexit 0\n");
    expect(toolBins(path)).not.toBe(before);
  });
});
