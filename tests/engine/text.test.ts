import { expect, test } from "bun:test";
import { shortCommand } from "../../src/engine/agents/short";
import { agentName, plainStop, plural, shortStop } from "../../src/engine/text";
import { verdictOf } from "../../src/engine/verdict";

test("verdictOf reads the last line, with or without formatting", () => {
  expect(verdictOf("Fine.\nVERDICT: approve")).toBe("approve");
  expect(verdictOf("Broken.\n**`VERDICT: changes`**")).toBe("changes");
  expect(verdictOf("verdict: Changes.")).toBe("changes");
  expect(verdictOf("VERDICT: approve\nbut one more thing")).toBeNull();
  expect(verdictOf("Seems okay.")).toBeNull();
});

test("agent names and plurals", () => {
  expect([agentName("claude"), agentName("codex"), agentName("gemini"), agentName("auto"), agentName("atrium"), agentName("x")]).toEqual([
    "Claude", "Codex", "Gemini", "Auto", "Atrium", "x",
  ]);
  expect([plural(1, "file"), plural(2, "file"), plural(0, "commit")]).toEqual(["1 file", "2 files", "0 commits"]);
});

test("shortCommand collapses whitespace and caps at 80 characters", () => {
  expect(shortCommand("bun   test\n--watch")).toBe("bun test --watch");
  expect(shortCommand("x".repeat(100))).toBe(`${"x".repeat(77)}...`);
  expect(shortCommand(undefined)).toBe("");
});

test("a bare exit code from an older stop becomes what happened and what to try; anything else is left as it is", () => {
  expect(plainStop("Codex exited with code 3")).toBe("Codex exited without a message (exit code 3). Retry the task; if it stops again, `codex login status` in a terminal shows whether Codex is still signed in.");
  // Atrium knows no status command for Gemini that reports a failure, so it only says to retry.
  expect(plainStop("Gemini exited with code 1.")).toBe("Gemini exited without a message (exit code 1). Retry the task.");
  // An Activity line quotes it after the task's title.
  expect(plainStop("Stopped: Move the toolbar. Claude Code exited with code 1")).toBe(`Stopped: Move the toolbar. ${plainStop("Claude Code exited with code 1")}`);
  expect(plainStop("The repo has uncommitted changes. Commit or stash them, then retry.")).toBe("The repo has uncommitted changes. Commit or stash them, then retry.");
});

test("a one-line surface gets only the cause, old wording or new; the remedy stays on the task", () => {
  const cause = "Claude Code exited without a message (exit code 1)";
  expect(shortStop("Claude Code exited with code 1")).toBe(cause);
  expect(shortStop(plainStop("Claude Code exited with code 1"))).toBe(cause);
  expect(shortStop(`Stopped: Move the toolbar. ${plainStop("Codex exited with code 2")}`)).toBe("Stopped: Move the toolbar. Codex exited without a message (exit code 2)");
  expect(shortStop("No postings found")).toBe("No postings found");
});
