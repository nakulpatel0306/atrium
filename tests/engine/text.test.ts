import { expect, test } from "bun:test";
import { shortCommand } from "../../src/engine/agents/short";
import { agentName, plural } from "../../src/engine/text";
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
