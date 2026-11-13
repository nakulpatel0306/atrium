import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atriumDenyPaths } from "../../src/engine/agents/atrium-paths";
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
    expect(r).toEqual({ status: "ok", summary: "All done.", inputTokens: 120, outputTokens: 45, cacheReadTokens: 0, cacheWriteTokens: 0, contextTokens: 15 });
  });

  test("per-model totals, subagents included, and the main agent's context come back with the result", async () => {
    process.env.FAKE_CLAUDE_MODEL_USAGE = JSON.stringify({
      "claude-sonnet-5-5": { inputTokens: 120, outputTokens: 45, cacheReadInputTokens: 900, cacheCreationInputTokens: 30 },
      "claude-haiku-5-5": { inputTokens: 400, outputTokens: 80, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    });
    process.env.FAKE_CLAUDE_CONTEXT = "42000";
    try {
      const r = await claudeAdapter(FAKE).run(input([]));
      expect(r).toMatchObject({
        status: "ok",
        contextTokens: 42015,
        models: [
          { model: "claude-sonnet-5-5", inputTokens: 120, outputTokens: 45, cacheReadTokens: 900, cacheWriteTokens: 30 },
          { model: "claude-haiku-5-5", inputTokens: 400, outputTokens: 80, cacheReadTokens: 0, cacheWriteTokens: 0 },
        ],
      });
    } finally {
      delete process.env.FAKE_CLAUDE_MODEL_USAGE;
      delete process.env.FAKE_CLAUDE_CONTEXT;
    }
  });

  test("a kept session starts under its id or resumes it; the tier's fallback model and subagents pass through", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atrium-argv-"));
    process.env.FAKE_CLAUDE_ARGV = join(dir, "argv.json");
    const id = "0b0e7c1a-3c1d-4c5e-9f00-2a1b3c4d5e6f";
    const argv = async (extra: Partial<AgentRunInput>) => {
      expect((await claudeAdapter(FAKE).run({ ...input(), ...extra })).status).toBe("ok");
      return JSON.parse(readFileSync(join(dir, "argv.json"), "utf8")) as string[];
    };
    try {
      const fresh = await argv({ session: { id, resume: false } });
      expect(fresh[fresh.indexOf("--session-id") + 1]).toBe(id);
      expect(fresh).not.toContain("--no-session-persistence");
      const warm = await argv({ session: { id, resume: true }, model: "opus", fallbackModel: "sonnet" });
      expect(warm[warm.indexOf("--resume") + 1]).toBe(id);
      expect(warm[warm.indexOf("--fallback-model") + 1]).toBe("sonnet");
      const scouts = { "atrium-scout": { description: "Reads", prompt: "Read only.", tools: ["Read"], model: "haiku", background: false } };
      const withAgents = await argv({ agents: scouts });
      expect(JSON.parse(withAgents[withAgents.indexOf("--agents") + 1]!)).toEqual(scouts);
      await expect(claudeAdapter(FAKE).run({ ...input(), session: { id: "--dangerously-skip-permissions", resume: true } })).rejects.toThrow("Invalid session id");
      await expect(claudeAdapter(FAKE).run({ ...input(), model: "--x" })).rejects.toThrow("Invalid model");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("cache reads and writes are reported apart from fresh input, which is most of what Claude Code reads", async () => {
    process.env.FAKE_CLAUDE_CACHE_READ = "250000";
    process.env.FAKE_CLAUDE_CACHE_WRITE = "9000";
    try {
      const r = await claudeAdapter(FAKE).run(input([]));
      expect(r).toMatchObject({ status: "ok", inputTokens: 120, cacheReadTokens: 250000, cacheWriteTokens: 9000 });
    } finally {
      delete process.env.FAKE_CLAUDE_CACHE_READ;
      delete process.env.FAKE_CLAUDE_CACHE_WRITE;
    }
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
    expect(r).toEqual({ status: "error", kind: "not_installed", message: "Claude Code isn't installed, or `claude` isn't on your PATH. Install it, then retry." });
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
      // The Keychain CLI, which would hand an agent whatever the login keychain holds.
      "Bash(security *)",
      // GitHub is the engine's alone.
      "Bash(gh *)",
      "Bash(git push*)",
      "Bash(git remote*)",
      "Bash(git clone*)",
      "Bash(git -c*)",
      // Sending and controlling apps are the engine's alone, matched anywhere in the command.
      "Bash(*osascript*)",
      "Bash(*shortcuts*)",
      "Bash(*automator*)",
      "Bash(open *)",
      "Bash(* open *)",
      "Bash(*/open *)",
      "Edit(**/.git/**)",
      "Write(**/.git/**)",
      "Edit(**/node_modules/**)",
      "Write(**/node_modules/**)",
      "Edit(**/.venv/**)",
      "Write(**/.venv/**)",
      "Edit(**/.claude/**)",
      "Write(**/.claude/**)",
      // The sandbox does not cover the Read tool.
      "Read(~/.ssh/**)",
      "Read(~/.aws/**)",
      "Read(~/.gnupg/**)",
      "Read(~/.config/gh/**)",
      "Read(~/Library/Messages/**)",
      "Read(~/Library/Application Support/AddressBook/**)",
      "Read(~/Library/Contacts/**)",
      // Atrium's DB, transcripts and other spaces' folders. "//" anchors the rule at the filesystem root.
      ...atriumDenyPaths(process.cwd()).flatMap((p) => [`Read(/${p})`, `Read(/${p}/**)`]),
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
    expect(sandbox.filesystem.denyRead).toContain(join(config().home, "atrium.db"));
    expect(sandbox.filesystem.denyRead).toContain(join(config().home, "spaces"));
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

  test("run denies gh, pushes, remotes and clones, and drops GitHub credentials from the env", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atrium-argv-"));
    process.env.FAKE_CLAUDE_ARGV = join(dir, "argv.json");
    process.env.FAKE_CLAUDE_ENV = join(dir, "env.json");
    const saved = { sock: process.env.SSH_AUTH_SOCK, token: process.env.GH_TOKEN };
    process.env.SSH_AUTH_SOCK = "/tmp/atrium-fake-agent.sock";
    process.env.GH_TOKEN = "fake-token-for-test";
    try {
      expect((await claudeAdapter(FAKE).run(input())).status).toBe("ok");
      const argv = JSON.parse(readFileSync(join(dir, "argv.json"), "utf8")) as string[];
      const denied = argv.slice(argv.indexOf("--disallowedTools") + 1);
      for (const rule of ["Bash(gh *)", "Bash(git push*)", "Bash(git remote*)", "Bash(git clone*)", "Bash(git -c*)"]) expect(denied).toContain(rule);
      const names = JSON.parse(readFileSync(join(dir, "env.json"), "utf8")) as string[];
      expect(names).not.toContain("SSH_AUTH_SOCK");
      expect(names).not.toContain("GH_TOKEN");
      expect(names).toContain("PATH");
    } finally {
      delete process.env.FAKE_CLAUDE_ENV;
      for (const [k, v] of [["SSH_AUTH_SOCK", saved.sock], ["GH_TOKEN", saved.token]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(dir, { recursive: true });
    }
  });

  test("sandbox unavailable is reported plainly", async () => {
    process.env.FAKE_CLAUDE_MODE = "sandbox_unavailable";
    const r = await claudeAdapter(FAKE).run(input());
    if (r.status !== "error") throw new Error("expected error");
    expect(r.kind).toBe("failed");
    expect(r.message).toStartWith("Claude's sandbox isn't available on this Mac");
  });
});

describe("fake claude write_files mode", () => {
  test("copies the fixture files into the run folder and answers with the summary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atrium-fake-write-"));
    const fixtures = join(import.meta.dir, "..", "fixtures", "plan-9");
    try {
      process.env.FAKE_CLAUDE_MODE = "write_files";
      process.env.FAKE_CLAUDE_FILES = fixtures;
      process.env.FAKE_CLAUDE_SUMMARY = join(fixtures, "summary.md");
      process.env.FAKE_CLAUDE_CC_DIR = "1";
      const r = await claudeAdapter(FAKE).run({ ...input(), cwd: dir });
      expect(r.status).toBe("ok");
      expect(r.status === "ok" && r.summary).toBe(readFileSync(join(fixtures, "summary.md"), "utf8"));
      expect(readFileSync(join(dir, "grocery-list.md"), "utf8")).toBe(readFileSync(join(fixtures, "grocery-list.md"), "utf8"));
      expect(existsSync(join(dir, "week-of-nov-9.ics"))).toBe(true);
      expect(existsSync(join(dir, "summary.md"))).toBe(false);
      expect(statSync(join(dir, ".claude", ".cc-writes")).mode & 0o777).toBe(0o700);
    } finally {
      for (const k of ["FAKE_CLAUDE_FILES", "FAKE_CLAUDE_SUMMARY", "FAKE_CLAUDE_CC_DIR"]) delete process.env[k];
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("by_prompt answers by what the prompt says", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atrium-replies-"));
  try {
    const replies = join(dir, "replies.json");
    writeFileSync(replies, JSON.stringify([["Dana", "texting"], ["Summarise", "OUTCOME: couldnt - no file."]]));
    process.env.FAKE_CLAUDE_MODE = "by_prompt";
    process.env.FAKE_CLAUDE_REPLIES = replies;
    const run = async (prompt: string) => {
      const r = await claudeAdapter(FAKE).run({ ...input(), prompt });
      return r.status === "ok" ? r.summary : r.message;
    };
    expect(await run("Summarise notes.md")).toBe("OUTCOME: couldnt - no file.");
    expect(await run("send Dana a message")).toBe("texting");
    expect(await run("something else")).toBe("All done.");
  } finally {
    delete process.env.FAKE_CLAUDE_MODE;
    delete process.env.FAKE_CLAUDE_REPLIES;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("I4: per-run settings pin Apple Events and every sandbox-widening switch off", () => {
  const s = JSON.parse(sandboxSettings(process.cwd()));
  expect(s.sandbox.allowAppleEvents).toBe(false);
  expect(s.sandbox.allowUnsandboxedCommands).toBe(false);
  expect(s.sandbox.enableWeakerNestedSandbox).toBe(false);
  expect(s.sandbox.enableWeakerNetworkIsolation).toBe(false);
  expect(s.sandbox.network).toEqual({ allowedDomains: ["registry.npmjs.org"], allowLocalBinding: false, allowAllUnixSockets: false });
});

test("M7: Claude can't read the Messages or Contacts stores", () => {
  const s = JSON.parse(sandboxSettings(process.cwd()));
  for (const p of ["~/Library/Messages", "~/Library/Application Support/AddressBook", "~/Library/Contacts"]) expect(s.sandbox.filesystem.denyRead).toContain(p);
});

test("I4: osascript, shortcuts and open are denied anywhere in a command", async () => {
  process.env.FAKE_CLAUDE_MODE = "argv";
  try {
    const r = await claudeAdapter(FAKE).run(input());
    if (r.status !== "ok") throw new Error("expected ok");
    const { argv } = JSON.parse(r.summary) as { argv: string[] };
    const denied = argv.slice(argv.indexOf("--disallowedTools") + 1);
    for (const rule of ["Bash(*osascript*)", "Bash(*shortcuts*)", "Bash(*automator*)", "Bash(open *)", "Bash(* open *)", "Read(~/Library/Messages/**)"]) expect(denied).toContain(rule);
  } finally {
    delete process.env.FAKE_CLAUDE_MODE;
  }
});

// ---- Private runs ----
import { privateReadRules, privateReads } from "../../src/engine/agents/private-paths";
import { MIN_PRIVATE_VERSION, TOO_OLD, atLeast } from "../../src/engine/agents/claude";
import { homedir } from "node:os";

const argvOf = async (over: Partial<AgentRunInput>) => {
  const dir = mkdtempSync(join(tmpdir(), "atrium-argv-"));
  const argvFile = join(dir, "argv.json");
  process.env.FAKE_CLAUDE_ARGV = argvFile;
  const r = await claudeAdapter(FAKE).run({ ...input(), ...over });
  expect(r.status).toBe("ok");
  const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
  rmSync(dir, { recursive: true });
  return argv;
};

test("card data: a private run has no Bash, reads only its own folder, and keeps the pinned settings", async () => {
  const argv = await argvOf({ allowedTools: ["Read", "Edit", "Write", "Glob", "Grep"], privateData: true });
  const settings = JSON.parse(argv[argv.indexOf("--settings") + 1]!);
  expect(argv[argv.indexOf("--setting-sources") + 1]).toBe("project,local");
  expect(settings.permissions).toEqual({ blockReadsOutsideWorkingDirectories: true });
  expect(settings.permissions.additionalDirectories).toBeUndefined();
  const allowed = argv.slice(argv.indexOf("--allowedTools") + 1, argv.indexOf("--disallowedTools"));
  expect(allowed.some((t) => t.startsWith("Bash"))).toBe(false);
  // No allow rule names a path, so nothing widens reads beyond the working directory.
  expect(allowed.every((t) => !t.includes("("))).toBe(true);
  const denied = argv.slice(argv.indexOf("--disallowedTools") + 1);
  expect(denied).toContain("Bash");
  expect(denied).toContain(`Read(/${join(realpathSync(homedir()), "Downloads")}/**)`);
  // The sandbox denies the whole home folder and re-opens only this run's folder.
  expect(settings.sandbox.filesystem.denyRead).toContain(realpathSync(homedir()));
  expect(settings.sandbox.filesystem.denyRead).toContain("/Users/Shared");
  expect(settings.sandbox.filesystem.allowRead).toEqual([realpathSync(process.cwd())]);
});

test("card data: an ordinary run is unchanged", async () => {
  const argv = await argvOf({});
  const settings = JSON.parse(argv[argv.indexOf("--settings") + 1]!);
  expect(settings.permissions).toBeUndefined();
  expect(settings.sandbox.filesystem.allowRead).toBeUndefined();
  expect(argv.slice(argv.indexOf("--disallowedTools") + 1)).not.toContain("Bash");
});

test("card data: a private run with no tools allowed has none at all", async () => {
  const argv = await argvOf({ allowedTools: [], privateData: true });
  expect(argv[argv.indexOf("--tools") + 1]).toBe("");
  expect(argv).not.toContain("--allowedTools");
  expect(argv.slice(argv.indexOf("--disallowedTools") + 1)).toContain("mcp__*");
});

describe("a private repo's run, which keeps its test commands", () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "atrium-home-")));
    for (const d of ["Atrium/investing/run-x", "Atrium/investing/other-run", "Atrium/other", "Documents/taxes", "Downloads", "Desktop", "Projects", "outside"]) mkdirSync(join(root, d), { recursive: true });
    symlinkSync(join(root, "outside"), join(root, "Atrium", "linked"));
    symlinkSync(join(root, "Documents"), join(root, "Docs"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const csv = (dir: string) => join(dir, "**", "*.[cC][sS][vV]");

  test("only its own folder stays open; siblings at every level, links and their targets are denied", () => {
    const { denyRead } = privateReads(join(root, "Atrium", "investing", "run-x"), { bash: true, home: root });
    expect(denyRead).toContain(csv(join(root, "Atrium", "other")));
    expect(denyRead).toContain(csv(join(root, "Atrium", "investing", "other-run")));
    expect(denyRead).toContain(csv(join(root, "Projects")));
    expect(denyRead).toContain(join(root, "Atrium", "investing", "*.[cC][sS][vV]"));
    expect(denyRead).toContain(join(root, "Documents"));
    // A link to Documents is closed as a whole too, and a linked folder's target is covered.
    expect(denyRead).toContain(join(root, "Docs"));
    expect(denyRead).toContain(csv(join(root, "Atrium", "linked")));
    expect(denyRead).toContain(csv(join(root, "outside")));
    const keep = join(root, "Atrium", "investing", "run-x");
    expect(denyRead.some((p) => p.startsWith(keep))).toBe(false);
  });

  test("a home that can't be listed still denies the private folders and every export in it", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const gone = join(root, "missing");
    const { denyRead } = privateReads(join(root, "Atrium", "investing", "run-x"), { bash: true, home: gone });
    warn.mockRestore();
    for (const f of ["Downloads", "Desktop", "Documents"]) expect(denyRead).toContain(join(gone, f));
    expect(denyRead).toContain(csv(gone));
  });
});

test("card data: a private run refuses an older or unreadable Claude Code, and nothing is spawned for real work", async () => {
  expect(MIN_PRIVATE_VERSION).toEqual([2, 1, 257]);
  expect(atLeast([2, 1, 318], MIN_PRIVATE_VERSION)).toBe(true);
  expect(atLeast([2, 1, 257], MIN_PRIVATE_VERSION)).toBe(true);
  expect(atLeast([2, 1, 256], MIN_PRIVATE_VERSION)).toBe(false);
  expect(atLeast([2, 0, 999], MIN_PRIVATE_VERSION)).toBe(false);
  for (const v of ["2.1.200", "unknown"]) {
    process.env.FAKE_CLAUDE_VERSION = v;
    const dir = mkdtempSync(join(tmpdir(), "atrium-argv-"));
    process.env.FAKE_CLAUDE_ARGV = join(dir, "argv.json");
    const r = await claudeAdapter(FAKE).run({ ...input(), privateData: true });
    expect(r).toEqual({ status: "error", kind: "failed", message: TOO_OLD });
    expect(existsSync(join(dir, "argv.json"))).toBe(false);
    rmSync(dir, { recursive: true });
  }
  delete process.env.FAKE_CLAUDE_VERSION;
  // An ordinary run doesn't ask.
  process.env.FAKE_CLAUDE_VERSION = "2.1.200";
  expect((await claudeAdapter(FAKE).run(input())).status).toBe("ok");
  delete process.env.FAKE_CLAUDE_VERSION;
});

describe("explicit read denies and symlink cycles", () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "atrium-home-")));
    for (const d of ["Atrium/investing/run-x", "Atrium/other", "Downloads", "Projects"]) mkdirSync(join(root, d), { recursive: true });
    writeFileSync(join(root, "statement.csv"), "x");
    // A link back up at an ancestor, and a two-link cycle.
    symlinkSync(join(root, "Atrium"), join(root, "Atrium", "investing", "loop"));
    symlinkSync(join(root, "b"), join(root, "a"));
    symlinkSync(join(root, "a"), join(root, "b"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("Read denies cover everything beside the way down, and never the run's folder", () => {
    const keep = join(root, "Atrium", "investing", "run-x");
    const rules = privateReadRules(keep, root);
    for (const p of [join(root, "Downloads"), join(root, "Projects"), join(root, "statement.csv"), join(root, "Atrium", "other")]) expect(rules).toContain(`Read(/${p})`);
    expect(rules).toContain("Read(//Users/Shared/**)");
    expect(rules).toContain("Read(//Volumes/**)");
    expect(rules.some((r) => r.startsWith(`Read(/${keep}`))).toBe(false);
    expect(rules).not.toContain(`Read(/${root})`);
    expect(rules).not.toContain(`Read(/${join(root, "Atrium")})`);
  });

  test("a symlink cycle ends, and a link back at an ancestor is closed", () => {
    const keep = join(root, "Atrium", "investing", "run-x");
    const { denyRead } = privateReads(keep, { bash: true, home: root });
    expect(denyRead).toContain(join(root, "Atrium", "investing", "loop"));
    expect(privateReadRules(keep, root)).toContain(`Read(/${join(root, "Atrium", "investing", "loop")})`);
  });
});

test("card data: a private run's sandbox closes iCloud Drive, cloud storage and mail, and denies statements of every kind", () => {
  const home = realpathSync(homedir());
  const plain = privateReads(join(home, "Atrium", "Investing"), { bash: false }).denyRead;
  for (const f of ["Library/Mobile Documents", "Library/CloudStorage"]) expect(plain).toContain(join(home, f));
  const withBash = privateReads(join(home, "Atrium", "Investing"), { bash: true }).denyRead;
  for (const f of ["Library/Mobile Documents", "Library/CloudStorage", "Downloads"]) expect(withBash).toContain(join(home, f));
  for (const g of ["*.[pP][dD][fF]", "*.[xX][lL][sS]", "*.[xX][lL][sS][xX]", "*.[qQ][bB][oO]", "*.[zZ][iI][pP]", "*.[nN][uU][mM][bB][eE][rR][sS]"]) {
    expect(withBash).toContain(join("/Volumes", "**", g));
  }
});
