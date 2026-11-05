import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { geminiAdapter } from "../../src/engine/agents/gemini";
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
      process.env.FAKE_AGY_ARGV = join(dir, "argv.json");
      const argv = (): string[] => JSON.parse(readFileSync(process.env.FAKE_AGY_ARGV!, "utf8"));
      await geminiAdapter(FAKE).run(input());
      const work = argv();
      expect(work.slice(0, 2)).toEqual(["-p", "be nice\n\ndo it"]);
      expect(work[work.indexOf("--mode") + 1]).toBe("accept-edits");
      for (const f of ["--sandbox", "--disable-slash-commands", "--settings"]) expect(work).toContain(f);
      expect(work[work.indexOf("--output-format") + 1]).toBe("stream-json");
      expect(work[work.indexOf("--model") + 1]).toBe("gemini-3.8-flash-medium");
      expect(work[work.indexOf("--print-timeout") + 1]).toBe("900s");
      expect(JSON.parse(work[work.indexOf("--settings") + 1]!).allowNonWorkspaceAccess).toBe(false);

      await geminiAdapter(FAKE).run(input([], { mode: "review" }));
      const review = argv();
      expect(review[review.indexOf("--mode") + 1]).toBe("plan");
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

  test("an auto-denied action is a failure, not an empty success", async () => {
    process.env.FAKE_AGY_SCENARIO = "denied";
    const r = await geminiAdapter(FAKE).run(input());
    if (r.status !== "error") throw new Error("expected error");
    expect(r.kind).toBe("failed");
    expect(r.message).toContain("auto-denied");
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
