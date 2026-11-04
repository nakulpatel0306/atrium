import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentAdapter, AgentRunResult } from "./agents/types";
import { createApproval } from "./approvals";
import { config } from "./config";
import { bus, logActivity } from "./events";
import { branchSummary, headRef, prepareBranch, pushBranch, repoReady } from "./git";
import { newId } from "./ids";
import { canRun, type PowerSource } from "./power";
import { getSetting, setSetting } from "./settings";
import { getSpace, type Space } from "./spaces";
import { listTasks, setTaskStatus, type Task } from "./tasks";
import { enforceTranscriptCap, openTranscript } from "./storage";

const POWER_CHECK_MS = 60_000;

const SYSTEM_PROMPT = [
  "You are working for Nakul through Atrium.",
  "Work only on the current git branch. Do not switch, create, or delete branches.",
  "Commit your work with clear, descriptive messages.",
  "Never push or merge.",
  "Never read, print, or edit .env files, keys, or tokens.",
  "Finish with a 2–4 sentence summary of what changed and anything Nakul should check.",
].join("\n");

const BASE_TOOLS = ["Read", "Edit", "Write", "Glob", "Grep"];
const REPO_TOOLS = [
  ...BASE_TOOLS,
  "Bash(bun test*)",
  "Bash(bun run *)",
  "Bash(bun install*)",
  "Bash(bunx tsc*)",
  "Bash(git add *)",
  "Bash(git commit *)",
  "Bash(git status*)",
  "Bash(git diff*)",
  "Bash(git log*)",
];

type KeepAwake = { start(): void; stop(): void; active(): boolean };

export function createRunner(deps: {
  db: Database;
  adapters: Record<string, AgentAdapter>;
  power: () => Promise<PowerSource>;
  keepAwake: KeepAwake;
  maxConcurrent?: number;
}): { start(): void; stop(): Promise<void>; kick(): void } {
  const { db, adapters, keepAwake } = deps;
  const maxConcurrent = deps.maxConcurrent ?? 1;
  const active = new Map<string, Promise<void>>();
  const activeSpaces = new Set<string>();
  let running = false;
  let scheduled = false;
  let busy = false;
  let again = false;
  let draining: Promise<void> = Promise.resolve();
  let interval: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;

  // At most one tick is pending and ticks never overlap. A kick during a tick
  // asks for exactly one more pass, so a burst of events costs at most two ticks.
  function kick() {
    if (!running) return;
    if (busy) {
      again = true;
      return;
    }
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      draining = drain();
    }, 0);
  }

  async function drain() {
    busy = true;
    try {
      do {
        again = false;
        await tick().catch(report);
      } while (again && running);
    } finally {
      busy = false;
    }
  }

  // An escaped error would be an unhandled rejection and take the whole engine down.
  function report(e: unknown) {
    logActivity(db, null, "atrium", `Runner error: ${(e as Error).message}`);
  }

  async function readPower(): Promise<PowerSource> {
    try {
      return await deps.power();
    } catch {
      // Unknown power state must not stall the queue on desktops or odd pmset output.
      return "ac";
    }
  }

  function pausedUntil(): number {
    return Number(getSetting(db, "runner.pausedUntil") ?? 0);
  }

  // Oldest queued task in an active space that power allows, plus the first one power holds back.
  function candidates(source: PowerSource): { runnable: Task[]; waiting: { taskId: string; reason: string } | null } {
    const runnable: Task[] = [];
    let waiting: { taskId: string; reason: string } | null = null;
    for (const task of listTasks(db, { status: ["queued"] })) {
      if (getSpace(db, task.spaceId)?.status !== "active") continue;
      const check = canRun(task, source);
      if (!check.ok) {
        waiting ??= { taskId: task.id, reason: check.reason };
        continue;
      }
      runnable.push(task);
    }
    return { runnable, waiting };
  }

  async function tick() {
    const source = await readPower();
    if (!running) return;
    setSetting(db, "power.source", source);

    const { runnable, waiting } = candidates(source);
    setSetting(db, "runner.waiting", waiting ? JSON.stringify(waiting) : "");

    if (pausedUntil() <= Date.now()) {
      for (const task of runnable) {
        if (!running || active.size >= maxConcurrent || pausedUntil() > Date.now()) break;
        // Two runs in one space would share a working tree.
        if (activeSpaces.has(task.spaceId)) continue;
        await launch(task);
      }
    }

    // A paused queue still counts as work: overnight mode should be awake when the limit resets.
    const hasWork = active.size > 0 || candidates(source).runnable.length > 0;
    if (getSetting(db, "overnight") === "true" && source === "ac" && hasWork) keepAwake.start();
    else keepAwake.stop();
    setSetting(db, "power.keepAwake", String(keepAwake.active()));
  }

  function block(task: Task, reason: string) {
    setTaskStatus(db, task.id, "blocked", { blockedReason: reason });
    logActivity(db, task.spaceId, "atrium", `Blocked: ${task.title}. ${reason}`);
  }

  async function launch(task: Task) {
    const space = getSpace(db, task.spaceId)!;
    const adapter = adapters[task.agent];
    if (!adapter) return block(task, `No agent called "${task.agent}" is set up. Pick another agent and requeue.`);

    let cwd: string;
    let base: string | null = null;
    let branch: string | undefined;
    if (space.kind === "repo") {
      if (!space.repoPath) return block(task, "This space has no repo folder set. Add one in the space settings.");
      const ready = await repoReady(space.repoPath);
      if (!ready.ok) return block(task, ready.reason);
      try {
        const head = await headRef(space.repoPath);
        branch = await prepareBranch(space.repoPath, task.id);
        // On a retry the repo is already on the task's branch, so only this run's commits are measurable.
        base = head.branch && head.branch !== branch ? head.branch : head.sha;
      } catch (e) {
        return block(task, (e as Error).message);
      }
      cwd = space.repoPath;
    } else {
      cwd = join(config().home, "spaces", space.id);
      mkdirSync(cwd, { recursive: true });
    }

    const runId = newId("run");
    const transcript = openTranscript(runId);
    db.query("INSERT INTO runs (id, task_id, agent, started_at, transcript_path) VALUES (?, ?, ?, ?, ?)").run(
      runId,
      task.id,
      adapter.id,
      Date.now(),
      transcript.path,
    );
    setTaskStatus(db, task.id, "running", branch ? { branch } : {});
    logActivity(db, space.id, task.agent, `Started: ${task.title}`);

    activeSpaces.add(space.id);
    const done = execute({ task, space, adapter, cwd, runId, transcript, base, branch })
      .catch(report)
      .finally(() => {
        active.delete(runId);
        activeSpaces.delete(space.id);
        kick();
      });
    active.set(runId, done);
  }

  async function execute(r: {
    task: Task;
    space: Space;
    adapter: AgentAdapter;
    cwd: string;
    runId: string;
    transcript: ReturnType<typeof openTranscript>;
    base: string | null;
    branch: string | undefined;
  }) {
    const { task, space, adapter, runId, transcript } = r;
    let result: AgentRunResult;
    try {
      result = await adapter.run({
        prompt: buildPrompt(task, space),
        cwd: r.cwd,
        systemPrompt: SYSTEM_PROMPT,
        allowedTools: space.kind === "repo" ? REPO_TOOLS : BASE_TOOLS,
        onChunk(chunk) {
          transcript.append(`${chunk}\n`);
          bus.emit({ type: "run-output", runId, taskId: task.id, chunk });
        },
      });
    } catch (e) {
      result = { status: "error", kind: "failed", message: `${adapter.label} could not start: ${(e as Error).message}` };
    }

    transcript.close();
    const tokens = result.status === "ok" ? [result.inputTokens, result.outputTokens] : [0, 0];
    db.query("UPDATE runs SET ended_at = ?, exit_code = ?, input_tokens = ?, output_tokens = ? WHERE id = ?").run(
      Date.now(),
      result.status === "ok" ? 0 : 1,
      tokens[0]!,
      tokens[1]!,
      runId,
    );
    enforceTranscriptCap();

    if (result.status === "ok") {
      const lines = [result.summary.trim()];
      if (space.kind === "repo" && r.branch && r.base) lines.push(...(await repoReport(space.repoPath!, r.branch, r.base)));
      setTaskStatus(db, task.id, "review");
      createApproval(db, { spaceId: space.id, taskId: task.id, kind: "review", title: task.title, detail: lines.join("\n\n") });
      logActivity(db, space.id, task.agent, `Ready for review: ${task.title}`);
    } else if (result.kind === "rate_limited") {
      // The task did nothing wrong; it goes back in line and runs when the limit resets.
      setSetting(db, "runner.pausedUntil", String(result.retryAfter ?? Date.now() + 30 * 60_000));
      setTaskStatus(db, task.id, "queued");
      logActivity(db, space.id, "atrium", `Paused: ${result.message}. ${task.title} will run again after that.`);
    } else {
      block(task, result.message);
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      unsubscribe = bus.on((e) => {
        if (e.type === "changed") kick();
      });
      interval = setInterval(kick, POWER_CHECK_MS);
      kick();
    },
    async stop() {
      running = false;
      unsubscribe?.();
      unsubscribe = null;
      if (interval) clearInterval(interval);
      interval = null;
      await draining;
      await Promise.all(active.values());
      keepAwake.stop();
      setSetting(db, "power.keepAwake", "false");
    },
    kick,
  };
}

function buildPrompt(task: Task, space: Space): string {
  const parts = [`Task: ${task.title}`];
  if (task.detail.trim()) parts.push(task.detail.trim());
  if (space.goal.trim()) parts.push(`Space goal: ${space.goal.trim()}`);
  return parts.join("\n\n");
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// Push and summary failures are reported in the review, not fatal: the work is done and worth reviewing.
async function repoReport(path: string, branch: string, base: string): Promise<string[]> {
  let pushLine: string;
  try {
    const push = await pushBranch(path, branch);
    pushLine = push.pushed ? `Pushed ${branch}.` : `Not pushed: ${push.reason}`;
  } catch (e) {
    pushLine = `Couldn't push ${branch}: ${(e as Error).message}`;
  }
  let summaryLine: string;
  try {
    const s = await branchSummary(path, branch, base);
    summaryLine = `${plural(s.commits, "commit")}, ${plural(s.filesChanged, "file")} (+${s.insertions} −${s.deletions}) on ${branch}`;
  } catch (e) {
    summaryLine = `Couldn't summarise the changes on ${branch}: ${(e as Error).message}`;
  }
  return [summaryLine, pushLine];
}

export function recoverOnBoot(db: Database): number {
  const stuck = listTasks(db, { status: ["running"] });
  for (const task of stuck) {
    setTaskStatus(db, task.id, "queued");
    logActivity(db, task.spaceId, "atrium", `Engine restarted; requeued ${task.title}`);
  }
  db.query("UPDATE runs SET ended_at = ?, exit_code = -1 WHERE ended_at IS NULL").run(Date.now());
  return stuck.length;
}
