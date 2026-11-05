import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeAdapter, sandboxSettings } from "../../src/engine/agents/claude";
import { config } from "../../src/engine/config";
import type { AgentRunInput } from "../../src/engine/agents/types";

const FAKE = join(import.meta.dir, "..", "fixtures", "fake-claude.ts");

function input(chunks: string[] = []): AgentRunInput {
  return { prompt: "do it", cwd: process.cwd(), systemPrompt: "be nice", allowedTools: ["Read", "Edit"], mode: "work", onChunk: (t) => chunks.push(t) };
}

afterEach(() => {
  delete process.env.FAKE_CLAUDE_MODE;
  delete process.env.FAKE_CLAUDE_LIMIT_TEXT;
  delete process.env.FAKE_CLAUDE_TEXT;
  delete process.env.FAKE_CLAUDE_ARGV;
});

describe("claudeAdapter", () => {
  test("ok run streams chunks and returns usage", async () => {
    const chunks: string[] = [];
    const r = await claudeAdapter(FAKE).run(input(chunks));
    expect(chunks).toContain("Looking at the repo.");
    expect(chunks).toContain("→ Read /repo/README.md");
    expect(r).toEqual({ status: "ok", summary: "All done.", inputTokens: 120, outputTokens: 45 });
  });

  test("successful run near the limit (allowed_warning) still returns ok", async () => {
    process.env.FAKE_CLAUDE_MODE = "ok_warning";
    const r = await claudeAdapter(FAKE).run(input());
    expect(r.status).toBe("ok");
  });

  test("reports five-hour and seven-day window usage in epoch ms", async () => {
    process.env.FAKE_CLAUDE_MODE = "ok_usage";
    const r = await claudeAdapter(FAKE).run(input());
    expect(r).toMatchObject({
      status: "ok",
      usage: {
        fiveHour: { utilization: 0.14, resetsAt: 1893459600_000 },
        sevenDay: { utilization: 0.31, resetsAt: 1893801600_000 },
      },
    });
  });

  test("a five-hour window without its own reset uses the event's resetsAt", async () => {
    process.env.FAKE_CLAUDE_MODE = "ok_usage_no_reset";
    const r = await claudeAdapter(FAKE).run(input());
    expect(r).toMatchObject({ usage: { fiveHour: { utilization: 0.14, resetsAt: 1893456000_000 } } });
  });

  test("probe: installed with unknown sign-in, or missing", async () => {
    expect(await claudeAdapter(FAKE).probe!()).toEqual({ installed: true, loggedIn: null, detail: "Installed" });
    expect((await claudeAdapter("/nonexistent/claude").probe!()).installed).toBe(false);
  });

  test("missing binary maps to not_installed", async () => {
    const r = await claudeAdapter("/nonexistent/claude").run(input());
    expect(r).toEqual({ status: "error", kind: "not_installed", message: "Claude Code isn't installed or not on PATH" });
  });

  test("rate limit maps to rate_limited with retryAfter in the future", async () => {
    process.env.FAKE_CLAUDE_MODE = "rate_limited";
    const r = await claudeAdapter(FAKE).run(input());
    expect(r.status).toBe("error");
    if (r.status !== "error") return;
    expect(r.kind).toBe("rate_limited");
    expect(r.retryAfter).toBe(1893456000 * 1000);
  });

  test("a rate limit still carries the window usage", async () => {
    process.env.FAKE_CLAUDE_MODE = "rate_limited_usage";
    const r = await claudeAdapter(FAKE).run(input());
    expect(r).toMatchObject({ status: "error", kind: "rate_limited", usage: { fiveHour: { utilization: 1, resetsAt: 1893456000_000 } } });
  });

  test("rate limit text without an event still maps, parsing the epoch", async () => {
    process.env.FAKE_CLAUDE_MODE = "rate_limited_text";
    const r = await claudeAdapter(FAKE).run(input());
    if (r.status !== "error") throw new Error("expected error");
    expect(r.kind).toBe("rate_limited");
    expect(r.retryAfter).toBe(1893456000 * 1000);
  });

  test("rate limit text without a reset time falls back to ~30 minutes", async () => {
    process.env.FAKE_CLAUDE_MODE = "rate_limited_text";
    process.env.FAKE_CLAUDE_LIMIT_TEXT = "You've hit your usage limit.";
    const before = Date.now();
    const r = await claudeAdapter(FAKE).run(input());
    if (r.status !== "error") throw new Error("expected error");
    expect(r.kind).toBe("rate_limited");
    expect(r.retryAfter!).toBeGreaterThanOrEqual(before + 30 * 60_000);
    expect(r.retryAfter!).toBeLessThan(before + 31 * 60_000);
  });

  test("logged out maps to not_logged_in", async () => {
    process.env.FAKE_CLAUDE_MODE = "logged_out";
    const r = await claudeAdapter(FAKE).run(input());
    expect(r).toEqual({ status: "error", kind: "not_logged_in", message: "Claude Code is logged out. Run `claude` once to log in." });
  });

  test("crash maps to failed with stderr tail", async () => {
    process.env.FAKE_CLAUDE_MODE = "crash";
    const r = await claudeAdapter(FAKE).run(input());
    if (r.status !== "error") throw new Error("expected error");
    expect(r.kind).toBe("failed");
    expect(r.message).toContain("boom: something exploded");
  });

  test("a crash is a failure even when the agent was talking about rate limits or logins", async () => {
    process.env.FAKE_CLAUDE_MODE = "crash_after_text";
    for (const text of ["I'll add rate limiting to the API.", "Building the login page now."]) {
      process.env.FAKE_CLAUDE_TEXT = text;
      const r = await claudeAdapter(FAKE).run(input());
      if (r.status !== "error") throw new Error("expected error");
      expect(r.kind).toBe("failed");
      expect(r.message).toContain("boom: something exploded");
    }
  });

  test("always passes .env, .git, and .claude deny rules and project/local settings only", async () => {
    process.env.FAKE_CLAUDE_MODE = "argv";
    const r = await claudeAdapter(FAKE).run(input());
    if (r.status !== "ok") throw new Error("expected ok");
    const { argv } = JSON.parse(r.summary) as { argv: string[] };
    const i = argv.indexOf("--disallowedTools");
    expect(argv.slice(i + 1)).toEqual([
      // APFS is case-insensitive, so .ENV opens .env: bracket forms spell out each letter's case, plain forms stay too.
      ...["Read", "Edit", "Write"].flatMap((tool) => [
        `${tool}(**/.env*)`,
        `${tool}(**/.env*/**)`,
        `${tool}(**/*.env)`,
        `${tool}(**/*.env/**)`,
        `${tool}(**/.[eE][nN][vV]*)`,
        `${tool}(**/.[eE][nN][vV]*/**)`,
        `${tool}(**/*.[eE][nN][vV])`,
        `${tool}(**/*.[eE][nN][vV]/**)`,
      ]),
      "Bash(cat *.env*)",
      "Edit(**/.git/**)",
      "Write(**/.git/**)",
      "Edit(**/.claude/**)",
      "Write(**/.claude/**)",
      // The sandbox does not cover the Read tool.
      "Read(~/.ssh/**)",
      "Read(~/.aws/**)",
      "Read(~/.gnupg/**)",
      "Read(~/.config/gh/**)",
      // Atrium's own DB and transcripts hold other spaces' work. "//" anchors the rule at the filesystem root.
      `Read(/${config().home}/**)`,
    ]);
    expect(argv[argv.indexOf("--setting-sources") + 1]).toBe("project,local");
    // dontAsk makes allowedTools a strict allowlist; acceptEdits would auto-approve unlisted Edit/Write.
    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("dontAsk");
  });

  test("prompt goes over stdin, never argv", async () => {
    process.env.FAKE_CLAUDE_MODE = "argv";
    const r = await claudeAdapter(FAKE).run({ ...input(), prompt: "--help" });
    if (r.status !== "ok") throw new Error("expected ok");
    const { argv, stdin } = JSON.parse(r.summary) as { argv: string[]; stdin: string };
    expect(stdin).toBe("--help");
    expect(argv).not.toContain("--help");
  });

  test("abort kills the run and reports it as stopped", async () => {
    process.env.FAKE_CLAUDE_MODE = "slow";
    const controller = new AbortController();
    const chunks: string[] = [];
    const started = Date.now();
    const running = claudeAdapter(FAKE).run({ ...input(chunks), signal: controller.signal });
    while (!chunks.length) await Bun.sleep(10);
    controller.abort();
    expect(await running).toEqual({ status: "error", kind: "failed", message: "Stopped" });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test("rejects flag-like allowedTools entries", async () => {
    await expect(claudeAdapter(FAKE).run({ ...input(), allowedTools: ["Read", "--dangerously-skip-permissions"] })).rejects.toThrow(/allowedTools/);
  });

  test("sandboxSettings embeds the run directory", () => {
    const { sandbox } = JSON.parse(sandboxSettings("/x/repo"));
    expect(sandbox.filesystem.denyRead).toContain("/x/repo/**/.env*");
    for (const p of ["~/**/.env*", "~/**/*.env", "/x/repo/**/*.env", "~/**/.[eE][nN][vV]*", "~/**/*.[eE][nN][vV]", "/x/repo/**/.[eE][nN][vV]*", "/x/repo/**/*.[eE][nN][vV]"]) {
      expect(sandbox.filesystem.denyRead).toContain(p);
    }
    expect(sandbox.filesystem.denyRead).toContain("~/.ssh");
    expect(sandbox.filesystem.denyRead).toContain(config().home);
    expect(sandbox.enabled).toBe(true);
    expect(sandbox.failIfUnavailable).toBe(true);
    expect(sandbox.allowUnsandboxedCommands).toBe(false);
    // Auto-allow would let sandboxed Bash bypass the allowedTools allowlist.
    expect(sandbox.autoAllowBashIfSandboxed).toBe(false);
    expect(sandbox.network.allowedDomains).toEqual(["registry.npmjs.org"]);
  });

  test("run passes sandbox and isolation flags", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atrium-argv-"));
    const argvFile = join(dir, "argv.json");
    process.env.FAKE_CLAUDE_ARGV = argvFile;
    const r = await claudeAdapter(FAKE).run(input());
    expect(r.status).toBe("ok");
    const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
    rmSync(dir, { recursive: true });
    expect(argv[argv.indexOf("--settings") + 1]).toBe(sandboxSettings(process.cwd()));
    expect(argv).toContain("--strict-mcp-config");
    expect(argv).toContain("--no-session-persistence");
    expect(argv.slice(argv.indexOf("--disallowedTools") + 1)).toContain("Read(~/.ssh/**)");
  });

  test("sandbox unavailable is reported plainly", async () => {
    process.env.FAKE_CLAUDE_MODE = "sandbox_unavailable";
    const r = await claudeAdapter(FAKE).run(input());
    if (r.status !== "error") throw new Error("expected error");
    expect(r.kind).toBe("failed");
    expect(r.message).toStartWith("Claude's sandbox isn't available on this Mac");
  });
});
