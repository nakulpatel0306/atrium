import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentAdapter, AgentRunResult } from "./agents/types";
import { createApproval } from "./approvals";
import { config } from "./config";
import { bus, logActivity } from "./events";
import { branchSummary, gitSettingsFingerprint, headRef, prepareBranch, pushBranch, remoteUrl, repoReady, returnToBranch } from "./git";
import { newId } from "./ids";
import { canRun, type PowerSource } from "./power";
import { getSetting, setSetting } from "./settings";
import { getSpace, type Space } from "./spaces";
import { getTask, listTasks, setTaskStatus, type Task } from "./tasks";
import { enforceTranscriptCap, openTranscript } from "./storage";

const POWER_CHECK_MS = 60_000;
const STOP_TIMEOUT_MS = 10_000;
const MAX_LIMIT_RETRIES = 3;

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
  "Bash(bun install --ignore-scripts*)",
  "Bash(bunx tsc*)",
  "Bash(git add *)",
  "Bash(git commit *)",
  "Bash(git status*)",
  "Bash(git diff*)",
  "Bash(git log*)",
];

type KeepAwake = { start(): void; stop(): void; active(): boolean };

// The repo as found at task start, so it can be put back after the run.
type RepoRun = { path: string; start: string; branch: string; url: string | null; fingerprint: string };

export function createRunner(deps: {
  db: Database;
  adapters: Record<string, AgentAdapter>;
  power: () => Promise<PowerSource>;
  keepAwake: KeepAwake;
  maxConcurrent?: number;
  stopTimeoutMs?: number;
}): { start(): void; stop(): Promise<void>; kick(): void } {
  const { db, adapters, keepAwake } = deps;
  const maxConcurrent = deps.maxConcurrent ?? 1;
  const active = new Map<string, { done: Promise<void>; controller: AbortController }>();
  const activeSpaces = new Set<string>();
  // Consecutive usage-limit outcomes per task, so a misread limit can't requeue a task forever.
  const limitHits = new Map<string, number>();
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
        try {
          await tick();
        } catch (e) {
          report(e);
          // A failure that repeats every tick would otherwise re-arm itself through
          // report's own `changed` event and spin. The next event or power check retries.
          again = false;
        }
      } while (again && running);
    } finally {
      busy = false;
    }
  }

  // An escaped error would be an unhandled rejection and take the whole engine down.
  function report(e: unknown) {
    try {
      logActivity(db, null, "atrium", `Runner error: ${(e as Error).message}`);
    } catch {
      // Nowhere left to record it; staying alive matters more.
    }
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

  // Puts the repo back on the starting branch; returns a block reason if it can't.
  async function leaveRepo(repo: RepoRun): Promise<string | null> {
    try {
      const res = await returnToBranch(repo.path, repo.start);
      return res === "dirty" ? `The agent left uncommitted changes on ${repo.branch} in ${repo.path}` : null;
    } catch (e) {
      return `${(e as Error).message}. Switch ${repo.path} back to ${repo.start} yourself, then requeue.`;
    }
  }

  // After a run: refuse to touch a repo whose git settings the agent changed, since the
  // next push or checkout could run its hooks or follow its rewritten URLs.
  async function settleRepo(repo: RepoRun): Promise<string | null> {
    let same: boolean;
    try {
      same = (await gitSettingsFingerprint(repo.path)) === repo.fingerprint;
    } catch {
      same = false;
    }
    if (!same) {
      return `The agent changed git settings in ${repo.path} (config, hooks, or attributes). Atrium stopped before pushing — check them before retrying.`;
    }
    return leaveRepo(repo);
  }

  async function launch(task: Task) {
    const space = getSpace(db, task.spaceId)!;
    const adapter = adapters[task.agent];
    if (!adapter) return block(task, `No agent called "${task.agent}" is set up. Pick another agent and requeue.`);

    let repo: RepoRun | null = null;
    if (space.kind === "repo") {
      if (!space.repoPath) return block(task, "This space has no repo folder set. Add one in the space settings.");
      const path = space.repoPath;
      const own = `atrium/${task.id}`;
      const ready = await repoReady(path);
      if (!ready.ok) {
        // Uncommitted work on this task's own branch is what a killed run leaves behind, not the user's.
        if (ready.dirty && (await headRef(path).catch(() => null))?.branch === own) {
          return block(task, `The agent left uncommitted changes on ${own} in ${path}`);
        }
        return block(task, ready.reason);
      }
      try {
        const head = await headRef(path);
        let start = head.branch ?? head.sha;
        // Still on this task's branch after a crash: carry on from where its last run started.
        const resumeFrom = start === own ? lastStartRef(db, task.id) : null;
        if (resumeFrom) start = resumeFrom;
        // Branching from a leftover agent branch would stack unreviewed work.
        else if (start.startsWith("atrium/")) return block(task, `Repo is on ${start}; switch back to your branch first.`);
        const url = await remoteUrl(path);
        const fingerprint = await gitSettingsFingerprint(path);
        repo = { path, start, url, fingerprint, branch: await prepareBranch(path, task.id) };
      } catch (e) {
        return block(task, (e as Error).message);
      }
    }

    // The task may have left the queue, or the engine begun stopping, while git was busy.
    if (!running || getTask(db, task.id)?.status !== "queued") {
      if (repo) await leaveRepo(repo);
      return;
    }
    setTaskStatus(db, task.id, "running", repo ? { branch: repo.branch } : {});

    let started: { cwd: string; runId: string; transcript: ReturnType<typeof openTranscript> };
    try {
      const cwd = repo ? repo.path : join(config().home, "spaces", space.id);
      if (!repo) mkdirSync(cwd, { recursive: true });
      const runId = newId("run");
      const transcript = openTranscript(runId);
      db.query("INSERT INTO runs (id, task_id, agent, started_at, transcript_path, start_ref) VALUES (?, ?, ?, ?, ?, ?)").run(
        runId,
        task.id,
        adapter.id,
        Date.now(),
        transcript.path,
        repo?.start ?? null,
      );
      started = { cwd, runId, transcript };
    } catch (e) {
      // Blocking takes the task out of the queue, so a broken disk can't retry it every tick.
      const left = repo ? await leaveRepo(repo) : null;
      return block(task, left ?? `Atrium couldn't start the run: ${(e as Error).message}`);
    }
    logActivity(db, space.id, task.agent, `Started: ${task.title}`);

    activeSpaces.add(space.id);
    const controller = new AbortController();
    const done = execute({ task, space, adapter, repo, signal: controller.signal, ...started })
      .catch(report)
      .finally(() => {
        active.delete(started.runId);
        activeSpaces.delete(space.id);
        kick();
      });
    active.set(started.runId, { done, controller });
  }

  async function execute(r: {
    task: Task;
    space: Space;
    adapter: AgentAdapter;
    repo: RepoRun | null;
    signal: AbortSignal;
    cwd: string;
    runId: string;
    transcript: ReturnType<typeof openTranscript>;
  }) {
    const { task, space, adapter, repo, runId, transcript } = r;
    let result: AgentRunResult;
    try {
      result = await adapter.run({
        prompt: buildPrompt(task, space),
        cwd: r.cwd,
        systemPrompt: SYSTEM_PROMPT,
        allowedTools: repo ? REPO_TOOLS : BASE_TOOLS,
        signal: r.signal,
        onChunk(chunk) {
          transcript.append(`${chunk}\n`);
          bus.emit({ type: "run-output", runId, taskId: task.id, chunk });
        },
      });
    } catch (e) {
      result = { status: "error", kind: "failed", message: `${adapter.label} could not start: ${(e as Error).message}` };
    }

    let leftRepo: string | null = null;
    try {
      transcript.close();
      const tokens = result.status === "ok" ? [result.inputTokens, result.outputTokens] : [0, 0];
      db.query("UPDATE runs SET ended_at = ?, exit_code = ?, input_tokens = ?, output_tokens = ? WHERE id = ?").run(
        Date.now(),
        result.status === "ok" ? 0 : 1,
        tokens[0]!,
        tokens[1]!,
        runId,
      );
    } finally {
      if (repo) leftRepo = await settleRepo(repo);
    }

    if (result.status === "ok" || result.kind !== "rate_limited") limitHits.delete(task.id);
    try {
      if (getTask(db, task.id)?.status !== "running") {
        // Someone moved the task while it ran; its outcome no longer applies.
        logActivity(db, space.id, "atrium", `Discarded the result for ${task.title}: the task was moved while it ran.`);
      } else if (leftRepo) {
        block(task, leftRepo);
      } else if (result.status !== "ok" && r.signal.aborted) {
        setTaskStatus(db, task.id, "queued");
        logActivity(db, space.id, "atrium", `Engine stopped; requeued ${task.title}`);
      } else if (result.status === "ok") {
        const lines = [result.summary.trim()];
        if (repo) lines.push(...(await repoReport(repo)));
        setTaskStatus(db, task.id, "review");
        createApproval(db, { spaceId: space.id, taskId: task.id, kind: "review", title: task.title, detail: lines.join("\n\n") });
        logActivity(db, space.id, task.agent, `Ready for review: ${task.title}`);
      } else if (result.kind === "rate_limited") {
        setSetting(db, "runner.pausedUntil", String(result.retryAfter ?? Date.now() + 30 * 60_000));
        const hits = (limitHits.get(task.id) ?? 0) + 1;
        if (hits >= MAX_LIMIT_RETRIES) {
          limitHits.delete(task.id);
          block(task, "Claude kept reporting a usage limit for this task; retry when you're ready.");
        } else {
          limitHits.set(task.id, hits);
          // The task did nothing wrong; it goes back in line and runs when the limit resets.
          setTaskStatus(db, task.id, "queued");
          logActivity(db, space.id, "atrium", `Paused: ${result.message}. ${task.title} will run again after that.`);
        }
      } else {
        block(task, result.message);
      }
    } finally {
      enforceTranscriptCap();
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
      // Each aborted run requeues its task and puts its repo back as it settles.
      for (const run of active.values()) run.controller.abort();
      let timer: ReturnType<typeof setTimeout> | undefined;
      // A run that won't settle stays `running`; recoverOnBoot requeues it on the next start.
      await Promise.race([
        Promise.all([...active.values()].map((run) => run.done)),
        new Promise((resolve) => (timer = setTimeout(resolve, deps.stopTimeoutMs ?? STOP_TIMEOUT_MS))),
      ]);
      clearTimeout(timer);
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
async function repoReport(repo: RepoRun): Promise<string[]> {
  let pushLine: string;
  try {
    const push = await pushBranch(repo.path, repo.branch, repo.url);
    pushLine = push.pushed ? `Pushed ${repo.branch}.` : `Not pushed: ${push.reason}`;
  } catch (e) {
    pushLine = `Couldn't push ${repo.branch}: ${(e as Error).message}`;
  }
  let summaryLine: string;
  try {
    // Against the starting branch, so a retry reports all the work on the task branch.
    const s = await branchSummary(repo.path, repo.branch, repo.start);
    summaryLine = `${plural(s.commits, "commit")}, ${plural(s.filesChanged, "file")} (+${s.insertions} −${s.deletions}) on ${repo.branch}`;
  } catch (e) {
    summaryLine = `Couldn't summarise the changes on ${repo.branch}: ${(e as Error).message}`;
  }
  return [summaryLine, pushLine];
}

function lastStartRef(db: Database, taskId: string): string | null {
  const row = db
    .query("SELECT start_ref FROM runs WHERE task_id = ? AND start_ref IS NOT NULL ORDER BY started_at DESC, rowid DESC LIMIT 1")
    .get(taskId) as { start_ref: string } | null;
  return row?.start_ref ?? null;
}

export async function recoverOnBoot(db: Database): Promise<number> {
  const stuck = listTasks(db, { status: ["running"] });
  for (const task of stuck) {
    setTaskStatus(db, task.id, "queued");
    logActivity(db, task.spaceId, "atrium", `Engine restarted; requeued ${task.title}`);
    const path = getSpace(db, task.spaceId)?.repoPath;
    const start = lastStartRef(db, task.id);
    if (!path || !start) continue;
    // A crash mid-run leaves the repo on the task branch. A clean one goes back now; a dirty one
    // stays put and launch blocks it with the agent's leftovers.
    try {
      if ((await headRef(path)).branch === `atrium/${task.id}`) await returnToBranch(path, start);
    } catch {
      // Left as found: launch reports a repo it can't read or switch.
    }
  }
  db.query("UPDATE runs SET ended_at = ?, exit_code = -1 WHERE ended_at IS NULL").run(Date.now());
  return stuck.length;
}
