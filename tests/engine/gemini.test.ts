import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { geminiAdapter, geminiArgv } from "../../src/engine/agents/gemini";
import { SANDBOX_EXEC, seatbeltProfile } from "../../src/engine/agents/seatbelt";
import type { AgentRunInput } from "../../src/engine/agents/types";

const FAKE = join(import.meta.dir, "..", "fixtures", "fake-agy.ts");

function input(chunks: string[] = [], extra: Partial<AgentRunInput> = {}): AgentRunInput {
  return { prompt: "do it", cwd: process.cwd(), systemPrompt: "be nice", allowedTools: ["Read"], mode: "work", onChunk: (t) => chunks.push(t), ...extra };
}

afterEach(() => {
  delete process.env.FAKE_AGY_SCENARIO;
  delete process.env.FAKE_AGY_ARGV;
});

describe("geminiAdapter", () => {
  test("ok run returns the final response and tokens", async () => {
    const r = await geminiAdapter(FAKE).run(input());
    expect(r).toEqual({ status: "ok", summary: "Did the thing.", inputTokens: 1200, outputTokens: 80 });
  });

  test("text deltas stream as chunks and tool steps show as → <tool> <command>", async () => {
    const chunks: string[] = [];
    await geminiAdapter(FAKE).run(input(chunks));
    expect(chunks).toContain("Did the thing.");
    expect(chunks).toContain("→ run_command bun test");
  });

  test("flags", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atrium-agy-"));
    try {
      // The fake writes its argv inside cwd, the only place a work run may write besides its own state and temp dirs.
      process.env.FAKE_AGY_ARGV = join(dir, "argv.json");
      await geminiAdapter(FAKE).run(input([], { cwd: dir }));
      const work: string[] = JSON.parse(readFileSync(process.env.FAKE_AGY_ARGV, "utf8"));
      expect(work.slice(0, 2)).toEqual(["-p", "be nice\n\ndo it"]);
      expect(work[work.indexOf("--mode") + 1]).toBe("accept-edits");
      for (const f of ["--sandbox", "--disable-slash-commands", "--settings"]) expect(work).toContain(f);
      expect(work[work.indexOf("--output-format") + 1]).toBe("stream-json");
      expect(work[work.indexOf("--model") + 1]).toBe("gemini-3.8-flash-medium");
      expect(work[work.indexOf("--print-timeout") + 1]).toBe("900s");
      expect(JSON.parse(work[work.indexOf("--settings") + 1]!).allowNonWorkspaceAccess).toBe(false);

      const review = geminiArgv("agy", input([], { mode: "review" }), "/tmp/x");
      expect(review[review.indexOf("--mode") + 1]).toBe("plan");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("agy argv is wrapped in sandbox-exec, with only its own state and the login keychain readable", () => {
    const state = join(homedir(), ".gemini", "antigravity-cli");
    const tmp = "/tmp/atrium-agent-x";
    const sandbox = { extraDenyRead: [join(homedir(), ".codex")], allowRead: [join(homedir(), "Library", "Keychains", "login.keychain-db")] };
    const work = geminiArgv("agy", input(), tmp);
    expect(work.slice(0, 2)).toEqual([SANDBOX_EXEC, "-p"]);
    expect(work[2]).toBe(seatbeltProfile({ cwd: process.cwd(), writable: [process.cwd(), state, tmp], ...sandbox }));
    expect(work.slice(3, 5)).toEqual(["agy", "-p"]);
    // agy signs in through the Keychain, so only Codex's profile cuts securityd off.
    expect(work[2]).not.toContain("com.apple.securityd");
    const review = geminiArgv("agy", input([], { mode: "review" }), tmp);
    expect(review[2]).toBe(seatbeltProfile({ cwd: process.cwd(), writable: [state, tmp], ...sandbox }));
  });

  test("each run gets a private temp dir, removed afterwards", async () => {
    process.env.FAKE_AGY_SCENARIO = "tmp";
    const r = await geminiAdapter(FAKE).run(input([], { mode: "review" }));
    if (r.status !== "ok") throw new Error(`expected ok, got ${JSON.stringify(r)}`);
    const env = JSON.parse(r.summary);
    expect(env.TMPDIR.startsWith(join(tmpdir(), "atrium-agent-"))).toBe(true);
    expect([env.TMP, env.TEMP]).toEqual([env.TMPDIR, env.TMPDIR]);
    expect(existsSync(env.TMPDIR)).toBe(false);
  });

  test("sandbox failure never falls back to an unsandboxed run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atrium-agy-"));
    try {
      process.env.FAKE_AGY_ARGV = join(dir, "argv.json");
      const failing = join(dir, "sandbox-exec");
      writeFileSync(failing, "#!/bin/sh\necho 'sandbox-exec: sandbox_apply: Operation not permitted' >&2\nexit 71\n");
      chmodSync(failing, 0o755);
      const paused = { status: "error" as const, kind: "failed" as const, message: "Atrium couldn't start the sandbox for Gemini; this agent is paused for safety." };
      expect(await geminiAdapter(FAKE, join(dir, "missing-sandbox-exec")).run(input([], { cwd: dir }))).toEqual(paused);
      expect(await geminiAdapter(FAKE, failing).run(input([], { cwd: dir }))).toEqual(paused);
      expect(existsSync(process.env.FAKE_AGY_ARGV)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a prompt starting with - can't parse as a flag, and multi-line prompts arrive intact", async () => {
    process.env.FAKE_AGY_SCENARIO = "echo";
    const r = await geminiAdapter(FAKE).run(input([], { systemPrompt: "-x\nline two", prompt: "task" }));
    if (r.status !== "ok") throw new Error("expected ok");
    expect(r.summary).toBe("\n-x\nline two\n\ntask");
  });

  test("quota is rate_limited", async () => {
    process.env.FAKE_AGY_SCENARIO = "quota";
    const before = Date.now();
    const r = await geminiAdapter(FAKE).run(input());
    if (r.status !== "error") throw new Error("expected error");
    expect(r.kind).toBe("rate_limited");
    expect(Math.abs(r.retryAfter! - (before + (2 * 60 + 5) * 60_000))).toBeLessThan(10_000);
  });

  test("auth is not_logged_in", async () => {
    process.env.FAKE_AGY_SCENARIO = "auth";
    const r = await geminiAdapter(FAKE).run(input());
    expect(r).toEqual({ status: "error", kind: "not_logged_in", message: "Run `agy` once in a terminal to sign in." });
  });

  test("other failures surface the CLI's message", async () => {
    process.env.FAKE_AGY_SCENARIO = "fail";
    const r = await geminiAdapter(FAKE).run(input());
    expect(r).toEqual({ status: "error", kind: "failed", message: "boom" });
  });

  test("an auto-denied action is a plain-language failure, with agy's own words kept in the transcript", async () => {
    process.env.FAKE_AGY_SCENARIO = "denied";
    const chunks: string[] = [];
    const r = await geminiAdapter(FAKE).run(input(chunks));
    expect(r).toEqual({
      status: "error",
      kind: "failed",
      message: "Gemini finished without an answer, likely because it needed a tool Atrium doesn't allow. Try Claude or Codex for this task.",
    });
    expect(chunks.some((c) => c.includes("auto-denied"))).toBe(true);
  });

  test("missing binary is not_installed", async () => {
    const r = await geminiAdapter("/nonexistent/agy").run(input());
    if (r.status !== "error") throw new Error("expected error");
    expect(r.kind).toBe("not_installed");
  });

  test("abort reads as Stopped", async () => {
    process.env.FAKE_AGY_SCENARIO = "slow";
    const ac = new AbortController();
    const p = geminiAdapter(FAKE).run(input([], { signal: ac.signal }));
    setTimeout(() => ac.abort(), 300);
    expect(await p).toEqual({ status: "error", kind: "failed", message: "Stopped" });
  });

  test("a probe whose signal fires is killed instead of left running", async () => {
    process.env.FAKE_AGY_SCENARIO = "slow";
    const started = Date.now();
    await geminiAdapter(FAKE).probe!(AbortSignal.timeout(200));
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test("probe: signed in, signed out, no gemini models, missing", async () => {
    expect(await geminiAdapter(FAKE).probe!()).toEqual({ installed: true, loggedIn: true, detail: "Signed in" });
    process.env.FAKE_AGY_SCENARIO = "auth";
    expect(await geminiAdapter(FAKE).probe!()).toEqual({ installed: true, loggedIn: false, detail: "Run `agy` once in a terminal to sign in." });
    process.env.FAKE_AGY_SCENARIO = "no-models";
    const none = await geminiAdapter(FAKE).probe!();
    expect(none.installed).toBe(true);
    expect(none.loggedIn).toBeNull();
    expect(await geminiAdapter("/nonexistent/agy").probe!()).toEqual({
      installed: false, loggedIn: null, detail: "Antigravity (agy) isn't installed or not on PATH",
    });
  });
});
