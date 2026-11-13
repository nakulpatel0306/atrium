import { describe, expect, test } from "bun:test";
import { briefSections, gapHints, NO_CHECK_HINT, normalizeBrief, normalizeQuestions } from "../../src/engine/brief";
import { applyTriage, failureSignature, newLoop, overBudget, parseFindings, resumed, SIZE_BUDGETS, shownStage, toolWatch } from "../../src/engine/loop";

describe("brief", () => {
  test("normalizing keeps the known fields, caps them and falls back to the ask", () => {
    const b = normalizeBrief({ acceptance: ["Button is blue", 4, ""], verify: "AUTO", size: "huge", extra: 1, lookFirst: Array(20).fill("a.ts") }, "Make it blue");
    expect(b.goal).toBe("Make it blue");
    expect(b.acceptance).toEqual(["Button is blue"]);
    expect(b.verify).toBe("auto");
    expect(b.size).toBe("medium");
    expect(b.lookFirst).toHaveLength(8);
    expect("extra" in b).toBe(false);
  });

  test("at most two questions, each with at most three answers", () => {
    const qs = normalizeQuestions([
      { question: "Which page?", options: ["Home", "Settings", "Both", "Neither"] },
      { question: "Keep the old one?" },
      { question: "Third?" },
    ]);
    expect(qs).toEqual([
      { question: "Which page?", options: ["Home", "Settings", "Both"] },
      { question: "Keep the old one?", options: [] },
    ]);
  });

  test("gap hints name what's missing", () => {
    const empty = normalizeBrief({ goal: "Fix login" });
    expect(gapHints(empty, { repo: true, checksFound: false })).toContain(NO_CHECK_HINT);
    expect(gapHints({ ...empty, verify: "bun test" }, { repo: true, checksFound: false })).not.toContain(NO_CHECK_HINT);
    expect(gapHints({ ...empty, acceptance: ["Login works"] }, { repo: true, checksFound: true })).toEqual([]);
    expect(gapHints(empty, { repo: false, checksFound: false })).toEqual(["Say what done looks like, so the result can be judged."]);
  });

  test("the writer sees the brief as sections, with the commands that check it", () => {
    const b = normalizeBrief({ goal: "Fix login", acceptance: ["Bad passwords show an error"], nonGoals: ["Signup"], answers: [{ question: "Which form?", answer: "The main one" }] });
    const text = briefSections(b, ["bun test"]).join("\n\n");
    expect(text).toContain("## Goal\nFix login");
    expect(text).toContain("## Acceptance criteria\n- Bad passwords show an error");
    expect(text).toContain("`bun test`");
    expect(text).toContain("## Not in scope\n- Signup");
    expect(text).toContain("- Which form? The main one");
    expect(briefSections(b, null).join("\n")).toContain("## Done when");
  });
});

describe("loop rules", () => {
  test("budgets count since the user last stepped in", () => {
    const loop = { ...newLoop(SIZE_BUDGETS.small), usage: { tokens: 250_000, ms: 0, unreported: false } };
    expect(overBudget(loop)).toContain("250k tokens");
    expect(overBudget(resumed(loop))).toBeNull();
    expect(overBudget({ ...loop, usage: { tokens: 0, ms: 21 * 60_000, unreported: false } })).toContain("20 minutes");
  });

  test("the same failure reads the same even when timings and temp paths differ", () => {
    const a = failureSignature([{ name: "Tests", output: "1 fail [12.3ms]\n/private/var/folders/x/T/a.ts:3 expected 2" }]);
    const b = failureSignature([{ name: "Tests", output: "1 fail [80ms]\n/private/var/folders/y/T/a.ts:3 expected 2" }]);
    const c = failureSignature([{ name: "Tests", output: "2 fail [80ms]\nexpected 2" }]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  test("tool watch catches a call repeated in a row and an edit made again and again", () => {
    const watch = toolWatch();
    expect(watch("Bash", { command: "bun test" })).toBeNull();
    expect(watch("Bash", { command: "bun test" })).toBeNull();
    expect(watch("Bash", { command: "bun test" })).toBe("It ran the same command (bun test) 3 times in a row.");
    const edits = toolWatch();
    const edit = { file_path: "src/a.ts", old_string: "a", new_string: "b" };
    edits("Edit", edit);
    edits("Read", { file_path: "src/a.ts" });
    edits("Edit", edit);
    edits("Bash", { command: "bun test" });
    expect(edits("Edit", edit)).toBe("It made the same edit (src/a.ts) 3 times.");
    const fine = toolWatch();
    expect([1, 2, 3].map((n) => fine("Edit", { file_path: "a.ts", old_string: `${n}`, new_string: "x" }))).toEqual([null, null, null]);
  });

  test("findings and their triage are read from the agents' lines", () => {
    const findings = parseFindings("Two problems.\nFINDING high src/a.ts:12 — misses empty input\n- `FINDING low - naming is off`\nVERDICT: changes");
    expect(findings).toEqual([
      { severity: "high", file: "src/a.ts", line: 12, reason: "misses empty input", resolution: null },
      { severity: "low", file: null, line: null, reason: "naming is off", resolution: null },
    ]);
    const { findings: answered, body } = applyTriage(findings, "Fixed the empty case.\nTRIAGE 1 fixed - added a guard\nTRIAGE 2 declined: matches the module");
    expect(answered.map((f) => f.resolution)).toEqual([
      { action: "fixed", note: "added a guard" },
      { action: "declined", note: "matches the module" },
    ]);
    expect(body).toBe("Fixed the empty case.");
  });

  test("the stage strip reads status and loop together", () => {
    const loop = newLoop(SIZE_BUDGETS.medium);
    expect(shownStage("queued", null, true)).toBe("brief");
    expect(shownStage("running", { ...loop, stage: "checks" }, true)).toBe("checks");
    expect(shownStage("blocked", { ...loop, paused: { kind: "loop", diagnosis: "x" } }, false)).toBe("paused");
    expect(shownStage("review", loop, false)).toBe("ready");
  });
});
