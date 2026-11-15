import { afterEach, beforeEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentAdapter, AgentRunInput, AgentRunResult } from "../../src/engine/agents/types";
import { openDb } from "../../src/engine/db";
import { createRunner } from "../../src/engine/runner";
import { createSpace, type ReviewChoice, updateSpace } from "../../src/engine/spaces";
import { getTask } from "../../src/engine/tasks";
import { tempHome, tempRepo } from "../helpers";

// A runner over a temp home and fake agents, for tests of the loop's later stages (shapes, sessions, tiers).
export const FAKE_CHECK = `bun ${join(import.meta.dir, "..", "fixtures", "fake-check.ts")}`;

export const ok = (summary: string, tokens = 1, extra: Partial<Extract<AgentRunResult, { status: "ok" }>> = {}): AgentRunResult => ({
  status: "ok",
  summary,
  inputTokens: tokens,
  outputTokens: tokens,
  ...extra,
});

export function fake(id: string, impl: (input: AgentRunInput, n: number) => Promise<AgentRunResult> | AgentRunResult) {
  const calls: AgentRunInput[] = [];
  const adapter: AgentAdapter = {
    id,
    label: id === "claude" ? "Claude Code" : id[0]!.toUpperCase() + id.slice(1),
    async run(input) {
      calls.push(input);
      return impl(input, calls.length);
    },
  };
  return { adapter, calls };
}

export function git(path: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", "-c", "user.name=Atrium Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: path });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
}

export async function waitFor(cond: () => boolean, ms = 8000) {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error("timed out waiting for condition");
    await Bun.sleep(5);
  }
}

export function loopHarness() {
  const h = {
    db: null as unknown as Database,
    runner: null as ReturnType<typeof createRunner> | null,
    cleanups: [] as Array<() => void>,
    // A repo whose fake check passes on the base commit.
    repo(): string {
      const r = tempRepo();
      h.cleanups.push(r.cleanup);
      writeFileSync(join(r.path, "status.txt"), "pass\n");
      git(r.path, "add", "-A");
      git(r.path, "commit", "-qm", "passing base");
      return r.path;
    },
    space(path: string, opts: { reviewBy?: ReviewChoice; checks?: string | null; private?: boolean } = {}) {
      const s = createSpace(h.db, { name: "App", kind: "repo", goal: "", repoPath: path, private: opts.private ?? false });
      return updateSpace(h.db, s.id, { reviewBy: opts.reviewBy ?? "off", checks: opts.checks === undefined ? FAKE_CHECK : opts.checks });
    },
    start(adapters: Record<string, AgentAdapter>) {
      h.runner = createRunner({ db: h.db, adapters, power: async () => "ac", keepAwake: { start() {}, stop() {}, active: () => false } });
      h.runner.start();
      return h.runner;
    },
    status: (id: string) => getTask(h.db, id)!.status,
    task: (id: string) => getTask(h.db, id)!,
  };
  let home: ReturnType<typeof tempHome>;
  beforeEach(() => {
    home = tempHome();
    h.db = openDb();
    h.runner = null;
  });
  afterEach(async () => {
    await h.runner?.stop();
    h.db.close();
    home.cleanup();
    while (h.cleanups.length) h.cleanups.pop()!();
  });
  return h;
}

// A writer that leaves `status.txt` (read by the fake check) as each turn's entry says, and always changes something.
export function writer(statuses: string[], opts: { summary?: string; review?: string } = {}) {
  return fake("claude", (input, n) => {
    if (input.mode === "review") return ok(opts.review ?? "Looks fine.\nVERDICT: approve");
    writeFileSync(join(input.cwd, "status.txt"), `${statuses[Math.min(n, statuses.length) - 1]}\n`);
    writeFileSync(join(input.cwd, "work.txt"), `turn ${n}\n`);
    return ok(opts.summary ?? "Changed it.\nOUTCOME: done");
  });
}
