import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeAdapter } from "../../src/engine/agents/claude";
import type { DiffHunk } from "../../src/engine/diff-parse";
import { explainHunk, HUNK_TOOLS, hunkHash } from "../../src/engine/explain-hunk";
import { getSpace } from "../../src/engine/spaces";
import { createTask, setTaskBrief } from "../../src/engine/tasks";
import { normalizeBrief } from "../../src/engine/brief";
import { loopHarness } from "./loop-harness";

const FAKE = join(import.meta.dir, "..", "fixtures", "fake-claude.ts");
// Recorded from a real cheap run (Claude Code, haiku) on a made-up cart repo.
const NOTE = readFileSync(join(import.meta.dir, "..", "fixtures", "learning", "hunk-note.txt"), "utf8").trim();
const h = loopHarness();

const hunk: DiffHunk = {
  header: "@@ -1,6 +1,10 @@",
  lines: [
    { kind: "ctx", text: "export type Item = { price: number; qty: number };", oldNo: 1, newNo: 1 },
    { kind: "add", text: "export type Coupon = { percent: number };", newNo: 2 },
    { kind: "del", text: "  let sum = 0;", oldNo: 3 },
  ],
};

afterEach(() => {
  for (const k of ["FAKE_CLAUDE_TEXT", "FAKE_CLAUDE_ARGV", "FAKE_CLAUDE_STDIN"]) delete process.env[k];
});

test("the cheap tier explains one fenced hunk with read-only tools, and the answer is kept by the hunk's hash", async () => {
  const s = h.space(h.repo());
  const t = setTaskBrief(h.db, createTask(h.db, { spaceId: s.id, title: "Coupons" }).id, normalizeBrief({ goal: "Let total() take a coupon", acceptance: ["10% off 20 is 18"] }));
  const dir = process.env.ATRIUM_HOME!;
  process.env.FAKE_CLAUDE_TEXT = NOTE;
  process.env.FAKE_CLAUDE_ARGV = join(dir, "argv.json");
  process.env.FAKE_CLAUDE_STDIN = join(dir, "stdin.txt");
  const first = await explainHunk(h.db, claudeAdapter(FAKE), t, getSpace(h.db, s.id)!, "src/cart.ts", hunk);
  expect(first).toEqual({ note: NOTE, cached: false });
  const argv = JSON.parse(readFileSync(join(dir, "argv.json"), "utf8")) as string[];
  expect(argv[argv.indexOf("--tools") + 1]).toBe(HUNK_TOOLS.join(","));
  expect(HUNK_TOOLS).toEqual(["Read", "Glob", "Grep"]);
  expect(argv[argv.indexOf("--model") + 1]).toBe("haiku");
  const prompt = readFileSync(join(dir, "stdin.txt"), "utf8");
  expect(prompt).toContain("Task the change was for: Let total() take a coupon");
  expect(prompt).toMatch(/--- hunk ([0-9a-f]{12}) ---\n@@ -1,6 \+1,10 @@\n export type Item[\s\S]*\+export type Coupon[\s\S]*-  let sum = 0;\n--- end of hunk \1 ---/);
  expect(prompt).toContain("Don't narrate it line by line");

  // Asked again: from the cache, with no second run.
  process.env.FAKE_CLAUDE_TEXT = "a different answer";
  expect(await explainHunk(h.db, claudeAdapter(FAKE), t, getSpace(h.db, s.id)!, "src/cart.ts", hunk)).toEqual({ note: NOTE, cached: true });
  expect(h.db.query("SELECT purpose FROM usage_log").all()).toEqual([{ purpose: "hunk" }]);
});

test("a hunk that changed, or the same hunk in another file, hashes differently", () => {
  const other = { ...hunk, lines: [...hunk.lines, { kind: "add" as const, text: "x", newNo: 3 }] };
  expect(hunkHash("a.ts", hunk)).not.toBe(hunkHash("a.ts", other));
  expect(hunkHash("a.ts", hunk)).not.toBe(hunkHash("b.ts", hunk));
});

test("a failed run says so in plain words and caches nothing", async () => {
  const s = h.space(h.repo());
  const t = createTask(h.db, { spaceId: s.id, title: "Coupons" });
  const failing = { id: "claude", label: "Claude Code", run: async () => ({ status: "error" as const, kind: "failed" as const, message: "boom" }) };
  await expect(explainHunk(h.db, failing, t, getSpace(h.db, s.id)!, "src/cart.ts", hunk)).rejects.toThrow("Claude couldn't explain this hunk this time");
  expect(h.db.query("SELECT COUNT(*) AS n FROM hunk_notes").get()).toEqual({ n: 0 });
});
