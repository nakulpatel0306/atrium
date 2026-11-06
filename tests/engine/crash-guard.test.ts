import { expect, test } from "bun:test";
import { join } from "node:path";

// In a process of its own: a stray rejection and a thrown callback are logged, secrets hidden, and it lives on.
test("a late background failure is logged and the engine keeps running", async () => {
  const guard = join(import.meta.dir, "../../src/engine/crash-guard.ts");
  const script = `
    const { installCrashGuard } = await import(${JSON.stringify(guard)});
    installCrashGuard();
    Promise.reject(new Error("clone landed late token=abc123"));
    setTimeout(() => { throw new Error("lookup after delete"); }, 10);
    setTimeout(() => console.log("still running"), 60);
  `;
  const proc = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect(code).toBe(0);
  expect(out).toContain("still running");
  expect(err).toContain("Atrium caught a failure nothing else handled and kept running: Error: clone landed late token=[redacted]");
  expect(err).toContain("Atrium caught an error nothing else handled and kept running: Error: lookup after delete");
  expect(err).not.toContain("abc123");
});
