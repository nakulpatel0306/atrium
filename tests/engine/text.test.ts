import { expect, test } from "bun:test";
import { shortCommand } from "../../src/engine/agents/short";
import { agentName, plainStop, plural } from "../../src/engine/text";
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
  expect(plainStop("Codex exited with code 3")).toBe("Codex stopped with an error and didn't say why (exit code 3). Retry the task; if it stops again, run `codex` once in a terminal to see the error.");
  expect(plainStop("Gemini exited with code 1.")).toContain("run `agy` once");
  // An Activity line quotes it after the task's title.
  expect(plainStop("Stopped: Move the toolbar. Claude Code exited with code 1")).toBe(`Stopped: Move the toolbar. ${plainStop("Claude Code exited with code 1")}`);
  expect(plainStop("The repo has uncommitted changes. Commit or stash them, then retry.")).toBe("The repo has uncommitted changes. Commit or stash them, then retry.");
});
