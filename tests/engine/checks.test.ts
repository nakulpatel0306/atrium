import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checksFor, detectChecks, hintsFrom, overrideChecks } from "../../src/engine/checks/detect";
import { failureReport, latestChecks, outcomeOf, runChecks, saveChecks } from "../../src/engine/checks/run";
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
  test("package.json scripts run with the package manager the lockfile names", async () => {
    const { path, sha } = repoWith({
      "package.json": JSON.stringify({ scripts: { typecheck: "tsc", lint: "eslint .", test: "vitest" } }),
      "pnpm-lock.yaml": "",
    });
    expect(await detectChecks(path, sha)).toEqual([
      { name: "Typecheck", command: "pnpm run typecheck", kind: "fast" },
      { name: "Lint", command: "pnpm run lint", kind: "fast" },
      { name: "Tests", command: "pnpm run test", kind: "full" },
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
    expect((await detectChecks(make.path, make.sha)).map((c) => c.command)).toEqual(["make lint", "make test"]);
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

  test("detection reads the commit it's given, not the working tree", async () => {
    const { path, sha } = repoWith({ "package.json": JSON.stringify({ scripts: { test: "vitest" } }) });
    writeFileSync(join(path, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
    expect((await detectChecks(path, sha)).map((c) => c.command)).toEqual(["npm run test"]);
  });

  test("a space's own commands replace detection; a brief's verify replaces the test run", () => {
    const detected = [
      { name: "Typecheck", command: "bunx tsc --noEmit", kind: "fast" as const },
      { name: "Tests", command: "bun test", kind: "full" as const },
    ];
    expect(overrideChecks("make lint\n\nmake test")).toEqual([
      { name: "make lint", command: "make lint", kind: "fast" },
      { name: "make test", command: "make test", kind: "full" },
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
