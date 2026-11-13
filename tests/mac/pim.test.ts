import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..", "..");
const canBuild = process.platform === "darwin" && !!Bun.which("swiftc");
const swift = (dir: string) => readdirSync(join(root, dir)).filter((f) => f.endsWith(".swift")).map((f) => join(root, dir, f));

test.skipIf(!canBuild)(
  "atrium-pim's parsing and output pass their tests",
  () => {
    const dir = mkdtempSync(join(tmpdir(), "atrium-pim-"));
    try {
      const bin = join(dir, "pim-tests");
      const build = Bun.spawnSync(["swiftc", "-target", "arm64-apple-macos14.0", ...swift("mac/Sources/PimCore"), join(root, "mac/Tests/Pim/main.swift"), "-o", bin], { stdout: "pipe", stderr: "pipe" });
      if (build.exitCode !== 0) throw new Error(`swiftc failed:\n${build.stderr.toString().slice(0, 1500)}`);
      const run = Bun.spawnSync([bin], { stdout: "pipe", stderr: "pipe" });
      expect(run.stdout.toString()).toMatch(/\d+ passed, 0 failed/);
      expect(run.exitCode).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  120_000,
);

// The fake the engine's tests use answers every command the real helper documents, and nothing else.
test("the fake helper and the real one name the same commands", () => {
  const real = readFileSync(join(root, "mac/Sources/Pim/main.swift"), "utf8");
  const fake = readFileSync(join(root, "tests/fixtures/fake-pim.ts"), "utf8");
  const commands = (src: string) => [...src.matchAll(/case "((?:mail|cal)\.[a-z]+|status|allow)"/g)].map((m) => m[1]).sort();
  expect(commands(fake)).toEqual(commands(real));
  const documented = readFileSync(join(root, "src/engine/mail/pim.ts"), "utf8");
  for (const c of commands(real)) expect(documented).toContain(`atrium-pim ${c}`);
});
