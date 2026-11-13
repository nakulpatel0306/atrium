import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeAdapter } from "../../src/engine/agents/claude";
import { TIER_DEFAULTS } from "../../src/engine/tiers";
import { draftBrief } from "../../src/engine/brief-draft";
import { tempHome, tempRepo } from "../helpers";

const FAKE = join(import.meta.dir, "..", "fixtures", "fake-claude.ts");
let home: ReturnType<typeof tempHome>;
beforeEach(() => {
  home = tempHome();
});
afterEach(() => {
  for (const k of ["FAKE_CLAUDE_TEXT", "FAKE_CLAUDE_ARGV", "FAKE_CLAUDE_MODE"]) delete process.env[k];
  home.cleanup();
});

test("the pre-pass runs a small read-only Claude in the repo and returns the brief and its questions", async () => {
  const repo = tempRepo();
  const argvFile = join(home.home, "argv.json");
  process.env.FAKE_CLAUDE_ARGV = argvFile;
  process.env.FAKE_CLAUDE_TEXT = [
    "Here it is:",
    "```json",
    JSON.stringify({
      goal: "Show an error on a bad password",
      acceptance: ["A wrong password shows 'Try again'"],
      verify: "auto",
      lookFirst: ["src/login.ts"],
      size: "small",
      questions: [{ question: "Inline or as a toast?", options: ["Inline", "Toast"] }],
    }),
    "```",
  ].join("\n");
  // The cheap tier's model, as the runner and the brief route pass it.
  const res = await draftBrief(claudeAdapter(FAKE), { ask: "login error message", repoPath: repo.path, privateData: false, model: TIER_DEFAULTS.cheap });
  expect(res.error).toBeNull();
  expect(res.brief.goal).toBe("Show an error on a bad password");
  expect(res.brief.size).toBe("small");
  expect(res.questions).toEqual([{ question: "Inline or as a toast?", options: ["Inline", "Toast"] }]);
  const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
  expect(argv[argv.indexOf("--model") + 1]).toBe("haiku");
  expect(argv[argv.indexOf("--max-turns") + 1]).toBe("6");
  const tools = argv.slice(argv.indexOf("--allowedTools") + 1, argv.indexOf("--disallowedTools"));
  expect(tools).toEqual(["Read", "Glob", "Grep"]);
  repo.cleanup();
});

test("a check command the pre-pass picks is only a suggestion: the brief keeps auto", async () => {
  process.env.FAKE_CLAUDE_TEXT = JSON.stringify({ goal: "Fix login", verify: "true" });
  const res = await draftBrief(claudeAdapter(FAKE), { ask: "fix login", repoPath: null, privateData: false });
  expect(res.brief.verify).toBe("auto");
  expect(res.suggestedVerify).toBe("true");
});

test("a general space's pre-pass gets no tools", async () => {
  const argvFile = join(home.home, "argv.json");
  process.env.FAKE_CLAUDE_ARGV = argvFile;
  process.env.FAKE_CLAUDE_TEXT = JSON.stringify({ goal: "Draft release notes", acceptance: ["Covers every merged change"] });
  const res = await draftBrief(claudeAdapter(FAKE), { ask: "release notes", repoPath: null, privateData: false });
  expect(res.brief.acceptance).toEqual(["Covers every merged change"]);
  const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
  expect(argv[argv.indexOf("--tools") + 1]).toBe("");
});

test("an answer Atrium can't read, or a failed run, still leaves a brief holding the ask", async () => {
  process.env.FAKE_CLAUDE_TEXT = "I think you want a button.";
  const unreadable = await draftBrief(claudeAdapter(FAKE), { ask: "add a button", repoPath: null, privateData: false });
  expect(unreadable.brief.goal).toBe("add a button");
  expect(unreadable.error).toContain("couldn't read");
  process.env.FAKE_CLAUDE_MODE = "crash";
  const failed = await draftBrief(claudeAdapter(FAKE), { ask: "add a button", repoPath: null, privateData: false });
  expect(failed.brief.goal).toBe("add a button");
  expect(failed.error).toBeTruthy();
});
