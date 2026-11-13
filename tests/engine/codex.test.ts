import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { codexAdapter, codexArgv } from "../../src/engine/agents/codex";
import { SANDBOX_EXEC, seatbeltProfile } from "../../src/engine/agents/seatbelt";
import type { AgentRunInput } from "../../src/engine/agents/types";

const FAKE = join(import.meta.dir, "..", "fixtures", "fake-codex.ts");

function input(chunks: string[] = [], extra: Partial<AgentRunInput> = {}): AgentRunInput {
  return { prompt: "do it", cwd: process.cwd(), systemPrompt: "be nice", allowedTools: ["Read"], mode: "work", onChunk: (t) => chunks.push(t), ...extra };
}

// A killed child stays a zombie until launchd reaps it, and kill(pid, 0) still succeeds on a zombie.
async function goneOrZombie(pid: number): Promise<boolean> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const stat = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]).stdout.toString().trim();
    if (stat === "" || stat.startsWith("Z")) return true;
    await Bun.sleep(50);
  }
  return false;
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
    // Codex counts cached input inside input_tokens; it comes out as cache reads, as Claude reports them.
    expect(r).toEqual({ status: "ok", summary: "Did the thing.", inputTokens: 200, outputTokens: 80, cacheReadTokens: 1000 });
    expect(chunks).toContain("Did the thing.");
    expect(chunks).toContain("→ bash bun test");
  });

  test("probe: signed in, signed out, missing", async () => {
    expect(await codexAdapter(FAKE).probe!()).toEqual({ installed: true, loggedIn: true, detail: "Signed in" });
    process.env.FAKE_CODEX_SCENARIO = "logged-out";
    expect((await codexAdapter(FAKE).probe!()).loggedIn).toBe(false);
    expect((await codexAdapter("/nonexistent/codex").probe!()).installed).toBe(false);
  });

  test("flags", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atrium-codex-"));
    try {
      // The fake writes its argv inside cwd, the only place a work run may write besides its own state and temp dirs.
      process.env.FAKE_CODEX_ARGV = join(dir, "argv.json");
      // Codex's own sandbox can't start inside Atrium's (macOS refuses a nested sandbox), so the outer profile is the boundary.
      const flags = [
        "exec", "-", "-C", dir, "--sandbox", "danger-full-access", "--json", "--ephemeral",
        "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules", "-c", 'approval_policy="never"',
      ];
      await codexAdapter(FAKE).run(input([], { cwd: dir }));
      expect(JSON.parse(readFileSync(process.env.FAKE_CODEX_ARGV, "utf8"))).toEqual(flags);
      expect(codexArgv("codex", input([], { cwd: dir, mode: "review" }), "/tmp/x").slice(4)).toEqual(flags);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("codex argv is wrapped in sandbox-exec", () => {
    const state = join(homedir(), ".codex");
    const agy = [join(homedir(), ".gemini")];
    const tmp = "/tmp/atrium-agent-x";
    const work = codexArgv("codex", input(), tmp);
    expect(work.slice(0, 2)).toEqual([SANDBOX_EXEC, "-p"]);
    expect(work[2]).toBe(seatbeltProfile({ cwd: process.cwd(), writable: [process.cwd(), state, tmp], extraDenyRead: agy, denyKeychain: true }));
    expect(work[2]).toContain('(global-name-prefix "com.apple.securityd")');
    expect(work.slice(3, 5)).toEqual(["codex", "exec"]);
    const review = codexArgv("codex", input([], { mode: "review" }), tmp);
    expect(review[2]).toBe(seatbeltProfile({ cwd: process.cwd(), writable: [state, tmp], extraDenyRead: agy, denyKeychain: true }));
  });

  test("each run gets a private temp dir, removed afterwards", async () => {
    process.env.FAKE_CODEX_SCENARIO = "tmp";
    const r = await codexAdapter(FAKE).run(input([], { mode: "review" }));
    if (r.status !== "ok") throw new Error(`expected ok, got ${JSON.stringify(r)}`);
    const env = JSON.parse(r.summary);
    expect(env.TMPDIR.startsWith(join(tmpdir(), "atrium-agent-"))).toBe(true);
    expect([env.TMP, env.TEMP]).toEqual([env.TMPDIR, env.TMPDIR]);
    expect(existsSync(env.TMPDIR)).toBe(false);
  });

  test("sandbox failure never falls back to an unsandboxed run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atrium-codex-"));
    try {
      process.env.FAKE_CODEX_ARGV = join(dir, "argv.json");
      const failing = join(dir, "sandbox-exec");
      writeFileSync(failing, "#!/bin/sh\necho 'sandbox-exec: sandbox_apply: Operation not permitted' >&2\nexit 71\n");
      chmodSync(failing, 0o755);
      const paused = { status: "error" as const, kind: "failed" as const, message: "Atrium couldn't start the sandbox for Codex; this agent is paused for safety." };
      expect(await codexAdapter(FAKE, join(dir, "missing-sandbox-exec")).run(input([], { cwd: dir }))).toEqual(paused);
      expect(await codexAdapter(FAKE, failing).run(input([], { cwd: dir }))).toEqual(paused);
      expect(existsSync(process.env.FAKE_CODEX_ARGV)).toBe(false);
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
      const r = await codexAdapter(FAKE).run(input([], { cwd: dir }));
      expect(r.status).toBe("ok");
      const pid = Number(readFileSync(process.env.FAKE_CODEX_PIDFILE, "utf8"));
      expect(await goneOrZombie(pid)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
