import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexAdapter } from "../../src/engine/agents/codex";
import type { AgentRunInput } from "../../src/engine/agents/types";

const FAKE = join(import.meta.dir, "..", "fixtures", "fake-codex.ts");

function input(chunks: string[] = [], extra: Partial<AgentRunInput> = {}): AgentRunInput {
  return { prompt: "do it", cwd: process.cwd(), systemPrompt: "be nice", allowedTools: ["Read"], mode: "work", onChunk: (t) => chunks.push(t), ...extra };
}

afterEach(() => {
  delete process.env.FAKE_CODEX_SCENARIO;
  delete process.env.FAKE_CODEX_ARGV;
  delete process.env.FAKE_CODEX_PIDFILE;
});

describe("codexAdapter", () => {
  test("ok run returns the last agent message and tokens", async () => {
    const chunks: string[] = [];
    const r = await codexAdapter(FAKE).run(input(chunks));
    expect(r).toEqual({ status: "ok", summary: "Did the thing.", inputTokens: 1200, outputTokens: 80 });
    expect(chunks).toContain("Did the thing.");
    expect(chunks).toContain("→ bash bun test");
  });

  test("flags", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atrium-codex-"));
    try {
      process.env.FAKE_CODEX_ARGV = join(dir, "argv.json");
      const argv = () => JSON.parse(readFileSync(process.env.FAKE_CODEX_ARGV!, "utf8"));
      const flags = (sandbox: string) => [
        "exec", "-", "-C", process.cwd(), "--sandbox", sandbox, "--json", "--ephemeral",
        "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules", "-c", 'approval_policy="never"',
      ];
      await codexAdapter(FAKE).run(input());
      expect(argv()).toEqual(flags("workspace-write"));
      await codexAdapter(FAKE).run(input([], { mode: "review" }));
      expect(argv()).toEqual(flags("read-only"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("prompt goes over stdin with the system prompt first", async () => {
    process.env.FAKE_CODEX_SCENARIO = "echo";
    const r = await codexAdapter(FAKE).run(input());
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.summary).toBe("be nice\n\ndo it");
  });

  test("usage limit is rate_limited with a parsed reset", async () => {
    process.env.FAKE_CODEX_SCENARIO = "limit";
    const r = await codexAdapter(FAKE).run(input());
    if (r.status !== "error") throw new Error("expected error");
    expect(r.kind).toBe("rate_limited");
    expect(r.message).toBe("Codex usage limit reached; resets at 3:40 PM");
    const when = new Date(r.retryAfter!);
    expect([when.getHours(), when.getMinutes()]).toEqual([15, 40]);
    expect(r.retryAfter!).toBeGreaterThan(Date.now());
    expect(r.retryAfter!).toBeLessThanOrEqual(Date.now() + 24 * 3600_000);
  });

  test("logged out", async () => {
    process.env.FAKE_CODEX_SCENARIO = "logged-out";
    const r = await codexAdapter(FAKE).run(input());
    expect(r).toEqual({ status: "error", kind: "not_logged_in", message: "Codex is logged out. Run `codex login` once in a terminal." });
  });

  test("missing binary", async () => {
    const r = await codexAdapter("/nonexistent/codex").run(input());
    expect(r).toMatchObject({ status: "error", kind: "not_installed" });
  });

  test("failure", async () => {
    process.env.FAKE_CODEX_SCENARIO = "fail";
    const r = await codexAdapter(FAKE).run(input());
    expect(r).toEqual({ status: "error", kind: "failed", message: "boom" });
  });

  test("abort", async () => {
    process.env.FAKE_CODEX_SCENARIO = "slow";
    const ctl = new AbortController();
    const run = codexAdapter(FAKE).run(input([], { signal: ctl.signal }));
    setTimeout(() => ctl.abort(), 300);
    expect(await run).toEqual({ status: "error", kind: "failed", message: "Stopped" });
  });

  test("exit 0 without turn.completed is a failure", async () => {
    process.env.FAKE_CODEX_SCENARIO = "no-turn";
    const r = await codexAdapter(FAKE).run(input());
    expect(r).toMatchObject({ status: "error", kind: "failed" });
  });

  test("background children are killed when the run ends", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atrium-codex-"));
    try {
      process.env.FAKE_CODEX_SCENARIO = "stray";
      process.env.FAKE_CODEX_PIDFILE = join(dir, "pid");
      const r = await codexAdapter(FAKE).run(input());
      expect(r.status).toBe("ok");
      const pid = Number(readFileSync(process.env.FAKE_CODEX_PIDFILE, "utf8"));
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
