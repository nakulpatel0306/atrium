import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..", "..");
const canBuild = process.platform === "darwin" && !!Bun.which("swiftc");
const swift = (dir: string) => readdirSync(join(root, dir)).filter((f) => f.endsWith(".swift")).map((f) => join(root, dir, f));

test.skipIf(!canBuild)(
  "Swift core decisions pass their tests",
  () => {
    const dir = mkdtempSync(join(tmpdir(), "atrium-core-"));
    try {
      const bin = join(dir, "core-tests");
      const build = Bun.spawnSync(
        ["swiftc", "-target", "arm64-apple-macos14.0", ...swift("mac/Sources/Core"), join(root, "mac/Tests/main.swift"), "-o", bin],
        { stdout: "pipe", stderr: "pipe" },
      );
      if (build.exitCode !== 0) throw new Error(`swiftc failed:\n${build.stderr.toString().slice(0, 1500)}`);
      const run = Bun.spawnSync([bin], { stdout: "pipe", stderr: "pipe" });
      const out = run.stdout.toString();
      expect(out).toMatch(/\d+ passed, 0 failed/);
      expect(run.exitCode).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  120_000,
);

test("the Mac file picker offers exactly what the ask bar attaches", async () => {
  const { ALLOWED_EXT } = await import("../../src/engine/attachment-rules");
  const source = await Bun.file(join(root, "mac/Sources/Core/Decide.swift")).text();
  const list = source.match(/let pickerExtensions = \[([^\]]*)\]/)?.[1] ?? "";
  const swiftList = [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
  expect(swiftList).toEqual([...ALLOWED_EXT].sort());
});
