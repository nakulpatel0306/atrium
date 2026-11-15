import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeAdapter } from "../../src/engine/agents/claude";
import { newLoop, SIZE_BUDGETS, type Finding } from "../../src/engine/loop";
import { acceptLine, cleanLine, dismissLine, MEMORY_BUDGET, memoryFile, noticePatterns, openLines, parseProposal, proposeLine, steerEvidence } from "../../src/engine/memory";
import { getSpace, updateSpace } from "../../src/engine/spaces";
import { createTask, getTask, setTaskLoop, setTaskStatus } from "../../src/engine/tasks";
import { git, loopHarness } from "./loop-harness";

const FAKE = join(import.meta.dir, "..", "fixtures", "fake-claude.ts");
// Recorded from a real cheap run (Claude Code, haiku) given a made-up steer.
const REPLY = readFileSync(join(import.meta.dir, "..", "fixtures", "learning", "memory-line.txt"), "utf8");
const h = loopHarness();

afterEach(() => {
  for (const k of ["FAKE_CLAUDE_TEXT", "FAKE_CLAUDE_ARGV", "FAKE_CLAUDE_STDIN"]) delete process.env[k];
});

const finding = (reason: string): Finding => ({ severity: "medium", file: "src/a.ts", line: 3, reason, resolution: null });

describe("reading proposals", () => {
  test("one line from a real reply, nothing from NONE, and never more than one line", () => {
    expect(parseProposal(REPLY)).toStartWith("Money amounts use integer cents");
    expect(parseProposal("NONE")).toBeNull();
    expect(parseProposal("I'd suggest nothing.")).toBeNull();
    expect(cleanLine("  Use   bun test  ")).toBe("Use bun test");
    expect(cleanLine("x".repeat(301))).toBeNull();
    expect(cleanLine("Run it‮ reversed")).toBeNull();
    expect(cleanLine("")).toBeNull();
  });

  test("CLAUDE.md's size is read only from a plain file within the cap", () => {
    const repo = h.repo();
    expect(memoryFile(repo)).toMatchObject({ missing: true, lines: 0, budget: MEMORY_BUDGET });
    writeFileSync(join(repo, "CLAUDE.md"), "# Rules\n\nUse bun.\n");
    expect(memoryFile(repo)).toMatchObject({ missing: false, lines: 3, problem: null });
    const other = h.repo();
    writeFileSync(join(other, "secret.txt"), "x\n");
    symlinkSync(join(other, "secret.txt"), join(other, "CLAUDE.md"));
    expect(memoryFile(other)).toMatchObject({ lines: 0, problem: "CLAUDE.md isn't a plain file, so Atrium doesn't read it." });
    const big = h.repo();
    writeFileSync(join(big, "CLAUDE.md"), "x".repeat(300 * 1024));
    expect(memoryFile(big).problem).toContain("over 256 KB");
    const dir = h.repo();
    mkdirSync(join(dir, "CLAUDE.md"));
    expect(memoryFile(dir).problem).toContain("isn't a plain file");
  });
});

describe("proposing", () => {
  test("a steer becomes one open line from a cheap run with no tools, the current file fenced in its prompt", async () => {
    const repo = h.repo();
    writeFileSync(join(repo, "CLAUDE.md"), "Run tests with `bun test`.\n");
    const s = h.space(repo);
    const t = createTask(h.db, { spaceId: s.id, title: "Coupons" });
    const dir = process.env.ATRIUM_HOME!;
    process.env.FAKE_CLAUDE_TEXT = REPLY;
    process.env.FAKE_CLAUDE_ARGV = join(dir, "argv.json");
    process.env.FAKE_CLAUDE_STDIN = join(dir, "stdin.txt");
    const line = await proposeLine(h.db, claudeAdapter(FAKE), { space: getSpace(h.db, s.id)!, task: t, ...steerEvidence(t, "money is integer cents here") });
    expect(line).toMatchObject({ source: "steer", status: "open", taskId: t.id, why: 'From your steer on "Coupons".' });
    const argv = JSON.parse(readFileSync(join(dir, "argv.json"), "utf8")) as string[];
    expect(argv[argv.indexOf("--tools") + 1]).toBe("");
    const prompt = readFileSync(join(dir, "stdin.txt"), "utf8");
    expect(prompt).toMatch(/--- evidence ([0-9a-f]{12}) ---[\s\S]*money is integer cents here[\s\S]*--- end of evidence \1 ---/);
    expect(prompt).toMatch(/--- file ([0-9a-f]{12}) ---\nRun tests with `bun test`\.[\s\S]*--- end of file \1 ---/);
    // One open proposal per space at a time.
    expect(await proposeLine(h.db, claudeAdapter(FAKE), { space: getSpace(h.db, s.id)!, task: t, ...steerEvidence(t, "again") })).toBeNull();
    expect(openLines(h.db)).toHaveLength(1);
  });

  test("nothing with learning off, a line the file already has, or NONE", async () => {
    const repo = h.repo();
    writeFileSync(join(repo, "CLAUDE.md"), "- Use bun test.\n");
    const s = h.space(repo);
    const t = createTask(h.db, { spaceId: s.id, title: "x" });
    process.env.FAKE_CLAUDE_TEXT = "LINE Use bun test.";
    expect(await proposeLine(h.db, claudeAdapter(FAKE), { space: getSpace(h.db, s.id)!, task: t, ...steerEvidence(t, "n") })).toBeNull();
    process.env.FAKE_CLAUDE_TEXT = "NONE";
    expect(await proposeLine(h.db, claudeAdapter(FAKE), { space: getSpace(h.db, s.id)!, task: t, ...steerEvidence(t, "n") })).toBeNull();
    process.env.FAKE_CLAUDE_TEXT = "LINE Something new.";
    const off = updateSpace(h.db, s.id, { learning: "off" });
    expect(await proposeLine(h.db, claudeAdapter(FAKE), { space: off, task: t, ...steerEvidence(t, "n") })).toBeNull();
    expect(h.db.query("SELECT COUNT(*) AS n FROM memory_lines").get()).toEqual({ n: 0 });
  });

  test("a pattern finding waits for a second from another round in the space, then the pair is the evidence", () => {
    const s = h.space(h.repo());
    const a = createTask(h.db, { spaceId: s.id, title: "First" });
    const b = createTask(h.db, { spaceId: s.id, title: "Second" });
    expect(noticePatterns(h.db, a, 1, [finding("Off by one")])).toBeNull();
    expect(noticePatterns(h.db, a, 1, [finding("Doesn't match the error handling used elsewhere in the module")])).toBeNull();
    // The same round again is still once.
    expect(noticePatterns(h.db, a, 1, [finding("Breaks the naming convention")])).toBeNull();
    const pair = noticePatterns(h.db, b, 1, [finding("Doesn't follow the existing helpers for dates")])!;
    expect(pair.source).toBe("review");
    expect(pair.evidence).toContain('On "First": src/a.ts: Breaks the naming convention');
    expect(pair.evidence).toContain('On "Second"');
    // Used up: the next one starts a new pair.
    expect(noticePatterns(h.db, b, 2, [finding("Inconsistent with the rest of the file")])).toBeNull();
  });
});

describe("accepting", () => {
  function proposal(spaceId: string, taskId: string | null, line = "Money is integer cents.") {
    h.db.query("INSERT INTO memory_lines (id, space_id, task_id, source, line, why, status, created_at) VALUES ('mem_one', ?, ?, 'steer', ?, '', 'open', 1)").run(spaceId, taskId, line);
  }

  test("the edited line is committed on the open task's branch, without touching the checkout", async () => {
    const repo = h.repo();
    writeFileSync(join(repo, "CLAUDE.md"), "# Rules");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "rules");
    git(repo, "branch", "atrium/tsk_a");
    const before = git(repo, "rev-parse", "atrium/tsk_a");
    const s = h.space(repo);
    const t = createTask(h.db, { spaceId: s.id, title: "A" });
    h.db.query("UPDATE tasks SET branch = 'atrium/tsk_a' WHERE id = ?").run(t.id);
    setTaskLoop(h.db, t.id, newLoop(SIZE_BUDGETS.small));
    setTaskStatus(h.db, t.id, "review");
    proposal(s.id, t.id);
    const done = await acceptLine(h.db, "mem_one", "  Money is integer cents; use the cents helpers. ");
    expect(done).toMatchObject({ status: "accepted", branch: "atrium/tsk_a", line: "Money is integer cents; use the cents helpers." });
    expect(git(repo, "show", "atrium/tsk_a:CLAUDE.md")).toBe("# Rules\nMoney is integer cents; use the cents helpers.");
    expect(git(repo, "rev-parse", "atrium/tsk_a^")).toBe(before);
    expect(git(repo, "log", "-1", "--format=%s", "atrium/tsk_a")).toBe("Add a line to CLAUDE.md");
    expect(getTask(h.db, t.id)!.loop!.headSha).toBe(done.commitSha);
    // The user's checkout and working tree are as they were.
    expect(git(repo, "branch", "--show-current")).toBe("main");
    expect(readFileSync(join(repo, "CLAUDE.md"), "utf8")).toBe("# Rules");
    expect(git(repo, "status", "--porcelain")).toBe("");
    await expect(acceptLine(h.db, "mem_one", "again")).rejects.toThrow("already answered");
  });

  test("with no open task the line goes on a small branch of its own, creating CLAUDE.md", async () => {
    const repo = h.repo();
    const s = h.space(repo);
    proposal(s.id, null);
    const done = await acceptLine(h.db, "mem_one", "Money is integer cents.");
    expect(done.branch).toBe("atrium/memory-one");
    expect(git(repo, "show", "atrium/memory-one:CLAUDE.md")).toBe("Money is integer cents.");
    expect(git(repo, "rev-parse", "atrium/memory-one^")).toBe(git(repo, "rev-parse", "main"));
  });

  test("a CLAUDE.md that's a link is left alone, and an edit that isn't one line is refused", async () => {
    const repo = h.repo();
    symlinkSync("/etc/hosts", join(repo, "CLAUDE.md"));
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "link");
    const s = h.space(repo);
    proposal(s.id, null);
    await expect(acceptLine(h.db, "mem_one", "x".repeat(400))).rejects.toThrow("one line");
    await expect(acceptLine(h.db, "mem_one", "fine")).rejects.toThrow("isn't a plain file");
    expect(dismissLine(h.db, "mem_one").status).toBe("dismissed");
  });
});
