import type { Database } from "bun:sqlite";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clock, createRegistry, type Registry, type TaskWait } from "./agents/registry";
import type { AgentAdapter, AgentRunResult } from "./agents/types";
import { correctBranchHead, createApproval, getApproval } from "./approvals";
import { factsFor, folderState } from "./autonomy/facts";
import { fingerprintOf } from "./autonomy/kinds";
import { applyRule } from "./autonomy/rules";
import { createDiffNotifier, isFileEdit } from "./diff-watch";
import { bus, logActivity } from "./events";
import { ensureSpaceFolder, spaceFolder, tildePath } from "./folders";
import { type Copy, copyAttachments } from "./attachments";
import { diffSnapshots, type FileChange, type Snapshot, snapshotFolder } from "./outputs/snapshot";
import { madeLine, recordRunFiles } from "./outputs/store";
import {
  branchFiles,
  branchOffDirty,
  branchSummary,
  commitAll,
  gitSettingsFingerprint,
  headRef,
  moveLateCommit,
  prepareBranch,
  remoteUrl,
  repoReady,
  returnToBranch,
  reviewDiff,
} from "./git";
import { afterFix, afterReview, afterWork, fixFailed, resolvedAgent } from "./handoff";
import { newId } from "./ids";
import { MARKETS_SYSTEM_LINES, type MarketsHooks } from "./markets/agent";
import { isMasked, maskNumbers } from "./money/import";
import { remaskTranscript } from "./money/remask";
import { agentName, plural, sentence } from "./text";
import { canRun, type PowerSource } from "./power";
import { verdictOf } from "./verdict";
import { type KeptScratch, keepScratch } from "./scratch";
import { getSetting, setSetting } from "./settings";
import { getSpace, isPrivate, type Space } from "./spaces";
import { appendTaskDetail, getTask, listTasks, setTaskOutcome, setTaskStatus, type Task } from "./tasks";
import { capabilityLines } from "./capabilities";
import { OUTCOME_INSTRUCTION, type ParsedOutcome, parseOutcome } from "./outcome";
import { enforceTranscriptCap, openTranscript } from "./storage";

const POWER_CHECK_MS = 60_000;
const STOP_TIMEOUT_MS = 10_000;
const MAX_LIMIT_RETRIES = 3;
const TEMP_SWEEP_AGE_MS = 86_400_000;

const REPO_SYSTEM_PROMPT = [
  "You are working for the user through Atrium.",
  "Work only on the current git branch. Do not switch, create, or delete branches.",
  "Leave your changes uncommitted; Atrium commits them for you.",
  "Never push or merge.",
  "Never read, print, or edit .env files, keys, or tokens.",
  "Finish with a 2–4 sentence summary of what changed and anything the user should check.",
].join("\n");

// Away from a repo there is no git: instructions about branches send agents looking for one.
function generalSystemPrompt(scratch: boolean): string {
  return [
    "You are working for the user through Atrium.",
    "Work in the current folder.",
    ...(scratch ? ["This folder is temporary. Atrium keeps a copy of the files you leave in it with this run's results."] : []),
    "Never read, print, or edit .env files, keys, or tokens.",
    "Finish with a 2–4 sentence summary of what you did and anything the user should check.",
  ].join("\n");
}

// The diff is in a review's prompt, so the reviewer reads and changes nothing on disk.
const REVIEW_SYSTEM_PROMPT = [
  "You are reviewing another agent's work for the user through Atrium.",
  "Everything you need is in the prompt. Don't create or change any files.",
  "Never read, print, or edit .env files, keys, or tokens.",
].join("\n");

// Titles that ask for something only the engine can do. An agent saying "done" to one of these, with nothing for
// the engine to act on, hasn't done it.
export function engineOnlyClaim(title: string): "repo" | null {
  return /\b(create|make|set up)\s+(a |the )?(new )?(github )?repo(sitory)?\b/i.test(title.trim()) ? "repo" : null;
}

const NO_REPO_MADE = "Only Atrium can create repos, after your yes, and none was created.";

export const REVIEW_TOOLS = ["Read", "Glob", "Grep"];
export const BASE_TOOLS = ["Read", "Edit", "Write", "Glob", "Grep"];
export const REPO_TOOLS = [
  ...BASE_TOOLS,
  "Bash(bun test*)",
  "Bash(bun install --ignore-scripts*)",
  "Bash(bunx tsc*)",
  "Bash(git status*)",
  "Bash(git diff*)",
  "Bash(git log*)",
];

type Settled = Awaited<ReturnType<MarketsHooks["settle"]>>;

type KeepAwake = { start(): void; stop(): void; active(): boolean };

// The repo as found at task start, so it can be put back after the run.
type RepoRun = { path: string; start: string; branch: string; fingerprint: string; remote: string | null };

export function createRunner(deps: {
  db: Database;
  adapters: Record<string, AgentAdapter>;
  registry?: Registry;
  power: () => Promise<PowerSource>;
  keepAwake: KeepAwake;
  maxConcurrent?: number;
  stopTimeoutMs?: number;
  // Market context in prompts and the atrium-markets block afterwards; absent, markets spaces run like general ones.
  markets?: MarketsHooks;
  // Local copies of attached GitHub repos: cloned on demand, marked used, and checked for cleanup once a day.
  repos?: { requestClone(space: Space): void; cloning(spaceId: string): boolean; touch(path: string): void; daily(now: number): void };
  // Money's once-a-day check (the monthly import reminder and budget heads-ups), from the same minute timer.
  money?: { daily(now: number): void };
  // Test seam for the Changes view's live refresh: the throttle window and the timer for agents that don't report edits.
  diffWatch?: { windowMs?: number; pollMs?: number };
}): {
  start(): void;
  stop(): Promise<void>;
  kick(): void;
  stopTask(taskId: string): Promise<StopOutcome>;
  steerTask(taskId: string, note: string): Promise<SteerOutcome>;
  steerPending(taskId: string): boolean;
  outputSeq(runId: string): number | null;
  registry: Registry;
} {
  const { db, adapters, keepAwake } = deps;
  const registry = deps.registry ?? createRegistry(db, adapters);
  const maxConcurrent = deps.maxConcurrent ?? 1;
  const active = new Map<string, { taskId: string; done: Promise<void>; controller: AbortController }>();
  const activeSpaces = new Set<string>();
  // Tasks Nakul asked to stop, so their aborted run ends blocked with his word rather than back in the queue; and the
  // ones whose run did end that way, so stopTask can say so.
  const stopRequested = new Set<string>();
  const stoppedByStop = new Set<string>();
  // The same for a steer: the note Nakul sent, by task, and the tasks whose run did end that way. A steered task's
  // next run opens its transcript with the note (steerMarkers).
  const steerRequested = new Map<string, string>();
  const steeredBySteer = new Set<string>();
  const steerMarkers = new Map<string, string>();
  // Lines each live run has written to its transcript (and sent), for the transcript route's X-Atrium-Output-Seq.
  const runSeq = new Map<string, number>();
  // Consecutive usage-limit outcomes per task, so a misread limit can't requeue a task forever.
  const limitHits = new Map<string, number>();
  const diffs = createDiffNotifier((taskId) => bus.emit({ type: "diff-changed", taskId }), deps.diffWatch);
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
      logActivity(db, null, "atrium", `Atrium hit a problem starting the next task: ${(e as Error).message.trim().replace(/\.$/, "")}. It will try again on the next change; restart the engine if this repeats.`);
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

  // Queued tasks in active spaces that power and the registry allow, each with the agent it resolved to,
  // plus every task held back and why. A limited agent's tasks stay in `runnable` so the queue counts as work.
  function candidates(source: PowerSource): { runnable: { task: Task; agent: string }[]; waits: TaskWait[] } {
    const runnable: { task: Task; agent: string }[] = [];
    const waits: TaskWait[] = [];
    for (const task of listTasks(db, { status: ["queued"] })) {
      const space = getSpace(db, task.spaceId);
      if (space?.status !== "active") continue;
      // A repo space attached from GitHub gets its local copy first; the task waits rather than blocks meanwhile.
      if (deps.repos && space.kind === "repo" && space.github && task.kind !== "review" && (!space.repoPath || !existsSync(space.repoPath))) {
        deps.repos.requestClone(space);
        waits.push({ taskId: task.id, agent: task.agent, kind: "cloning", reason: `Getting a local copy of ${space.github} from GitHub…` });
        continue;
      }
      const check = canRun(task, source);
      if (!check.ok) {
        waits.push({ taskId: task.id, agent: task.agent, kind: "power", reason: check.reason });
        continue;
      }
      const pick = registry.resolve(task, space);
      if ("wait" in pick) {
        // A reviewer or fixer the space shuts out would wait forever. The review is skipped and Nakul decides
        // alone; the fix is blocked and its approval says so.
        const refused = task.kind !== "work" ? registry.refusal(task.agent, task.kind, space) : null;
        if (refused && task.kind === "review") skipReview(task, refused.reason);
        else if (refused) block(task, refused.reason);
        else waits.push({ taskId: task.id, ...pick.wait });
        continue;
      }
      // Nakul can repoint a queued review (say, to auto) at the agent that did the work, which reviews nothing.
      const parent = task.kind === "review" && task.parentTaskId ? getTask(db, task.parentTaskId) : null;
      if (parent && resolvedAgent(db, parent) === pick.agent) {
        skipReview(task, `${agentName(pick.agent)} did the work, so it can't review it too. Decide on it yourself as usual.`);
        continue;
      }
      const until = registry.limitedUntil(pick.agent);
      if (until > Date.now()) {
        const name = adapters[pick.agent]?.label ?? pick.agent;
        const reason = `${name} hit its usage limit and picks up again at ${clock(until)}. Pick another agent to run it sooner.`;
        waits.push({ taskId: task.id, agent: pick.agent, kind: "limited", reason, until });
      }
      runnable.push({ task, agent: pick.agent });
    }
    return { runnable, waits };
  }

  function busyWait(task: Task, agent: string): TaskWait {
    const reason = activeSpaces.has(task.spaceId)
      ? "Waiting for the task already running in this space to finish."
      : maxConcurrent === 1
        ? "Waiting for the running task to finish: Atrium runs one task at a time."
        : `Waiting for a free slot: Atrium runs ${maxConcurrent} tasks at once.`;
    return { taskId: task.id, agent, kind: "busy", reason };
  }

  async function tick() {
    // A run whose task was taken out from under it (Nakul decided on its parent) has nothing left to do.
    for (const run of active.values()) {
      if (getTask(db, run.taskId)?.status !== "running") run.controller.abort();
    }
    const source = await readPower();
    if (!running) return;
    setSetting(db, "power.source", source);
    await registry.refresh();
    if (!running) return;

    const { runnable, waits } = candidates(source);
    for (const { task, agent } of runnable) {
      if (!running) break;
      // One agent at its limit leaves the others free to run; its tasks already carry the limit as their wait.
      if (registry.limitedUntil(agent) > Date.now()) continue;
      // Two runs in one space would share a working tree.
      if (active.size >= maxConcurrent || activeSpaces.has(task.spaceId)) {
        waits.push(busyWait(task, agent));
        continue;
      }
      const held = await launch(task, agent);
      if (held) waits.push(held);
    }
    // Written once per tick: a second, different write would emit `changed` and wake the runner into a loop.
    setSetting(db, "runner.waiting", JSON.stringify(waits));

    // A limited agent's queue still counts as work: overnight mode should be awake when the limit resets.
    const hasWork = active.size > 0 || candidates(source).runnable.length > 0;
    if (getSetting(db, "overnight") === "true" && source === "ac" && hasWork) keepAwake.start();
    else keepAwake.stop();
    setSetting(db, "power.keepAwake", String(keepAwake.active()));
  }

  function skipReview(task: Task, reason: string) {
    setTaskStatus(db, task.id, "done");
    afterReview(db, task, { status: "error", kind: "failed", message: reason });
    logActivity(db, task.spaceId, "atrium", `Skipped: ${task.title}. ${reason}`, { taskId: task.id });
  }

  // `saved` is the branch Atrium committed the agent's unfinished edits to, if it did.
  function block(task: Task, reason: string, saved: string | null = null) {
    // A steered task that can't start again mustn't carry its note's marker into some later run.
    steerMarkers.delete(task.id);
    const full = saved ? `${sentence(reason)} ${savedNote(task, saved)}` : reason;
    setTaskStatus(db, task.id, "blocked", { blockedReason: full });
    logActivity(db, task.spaceId, "atrium", `Blocked: ${task.title}. ${full}`, { taskId: task.id });
    if (task.kind === "review") afterReview(db, task, { status: "error", kind: "failed", message: reason });
    if (task.kind === "fix") fixFailed(db, task, reason, saved);
  }

  // Puts the repo back on the starting branch; returns a block reason if it can't.
  async function leaveRepo(repo: RepoRun): Promise<string | null> {
    try {
      const res = await returnToBranch(repo.path, repo.start);
      return res === "dirty" ? leftoversReason(repo.branch, repo.path, repo.start) : null;
    } catch (e) {
      return `${(e as Error).message}. Switch ${repo.path} back to ${repo.start} yourself, then requeue.`;
    }
  }

  // After a run: refuse to touch a repo whose git settings the agent changed, since the
  // next checkout could run its hooks or filters.
  async function settleRepo(repo: RepoRun): Promise<string | null> {
    if (!(await settingsUnchanged(repo.path, repo.fingerprint))) return tamperedReason(repo.path);
    return leaveRepo(repo);
  }

  // Returns why the task went back to waiting when it was resolved again just before starting.
  async function launch(task: Task, agent: string): Promise<TaskWait | void> {
    const space = getSpace(db, task.spaceId)!;
    const adapter = adapters[agent];
    if (!adapter) return block(task, `No agent called "${agent}" is set up. Pick another agent and requeue.`);

    let repo: RepoRun | null = null;
    // A review never touches the repo: the diff it needs is already in its prompt.
    if (space.kind === "repo" && task.kind !== "review") {
      if (!space.repoPath) return block(task, "This space has no repo folder set. Add one in the space settings.");
      const path = space.repoPath;
      const own = `atrium/${branchTaskId(task)}`;
      const ready = await repoReady(path);
      if (!ready.ok) {
        // Uncommitted work on this task's own branch is what a killed run leaves behind, not the user's.
        if (ready.dirty && (await headRef(path).catch(() => null))?.branch === own) {
          return block(task, leftoversReason(own, path, lastRepoRun(db, task.id)?.start ?? null));
        }
        return block(task, ready.reason);
      }
      try {
        const head = await headRef(path);
        let start = head.branch ?? head.sha;
        // Still on this task's branch after a crash: carry on from where its last run started.
        const last = start === own ? lastRepoRun(db, task.id) : null;
        if (last) {
          // A fresh fingerprint would bless whatever the crashed agent planted; compare to the pre-run one.
          if (!(await settingsUnchanged(path, last.fingerprint))) return block(task, tamperedReason(path));
          start = last.start;
        }
        // Branching from a leftover agent branch would stack unreviewed work.
        else if (start.startsWith("atrium/")) return block(task, `The repo is on ${start}, an Atrium branch. Switch back to your own branch, then retry.`);
        const fingerprint = last?.fingerprint ?? (await gitSettingsFingerprint(path));
        // Read with the fingerprint, before the agent can touch the repo's config.
        const remote = last ? last.remote : await remoteUrl(path);
        const branch = await prepareBranch(path, branchTaskId(task), { existing: task.kind === "fix" });
        repo = { path, start, fingerprint, branch, remote };
        deps.repos?.touch(path);
      } catch (e) {
        return block(task, (e as Error).message);
      }
    }

    // The task may have left the queue, the engine begun stopping, or the space changed (say, turned private)
    // while git was busy. The agent is resolved again from fresh rows so a privacy change can't slip through.
    const current = getTask(db, task.id);
    const fresh = getSpace(db, task.spaceId);
    const recheck =
      running && current?.status === "queued" && fresh?.status === "active" ? registry.resolve(current, fresh) : null;
    if (!recheck || !("agent" in recheck) || recheck.agent !== agent) {
      if (repo) await leaveRepo(repo);
      return recheck && "wait" in recheck ? { taskId: task.id, ...recheck.wait } : undefined;
    }
    setTaskStatus(db, task.id, "running", repo ? { branch: repo.branch } : {});
    stoppedByStop.delete(task.id);

    // Codex and Gemini reads aren't sandboxed like Claude's: away from a repo each run gets an empty folder of
    // its own instead of the space folder, where earlier runs' files collect.
    // A money question runs in an empty folder too, with no tools: the masked facts in its prompt are all it sees.
    const scratch = !repo && (agent !== "claude" || task.purpose === "money");
    let started: { cwd: string; runId: string; transcript: ReturnType<typeof openTranscript>; copied: Copy[] };
    let cwd: string | null = null;
    try {
      cwd = repo ? repo.path : scratch ? mkdtempSync(join(tmpdir(), "atrium-run-")) : ensureSpaceFolder(db, space);
      // An empty folder doesn't have the files Nakul attached, so they're copied in where the task says they are.
      const copied = scratch && task.purpose !== "money" ? copyAttachments(db, task.id, spaceFolder(space), cwd) : [];
      const runId = newId("run");
      const transcript = openTranscript(runId);
      db.query(
        "INSERT INTO runs (id, task_id, agent, started_at, transcript_path, start_ref, git_fingerprint, remote_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(runId, task.id, agent, Date.now(), transcript.path, repo?.start ?? null, repo?.fingerprint ?? null, repo?.remote ?? null);
      started = { cwd, runId, transcript, copied };
    } catch (e) {
      if (scratch && cwd) rmSync(cwd, { recursive: true, force: true });
      // Blocking takes the task out of the queue, so a broken disk can't retry it every tick.
      const left = repo ? await leaveRepo(repo) : null;
      return block(task, left ?? `Atrium couldn't start the run: ${sentence((e as Error).message)} Check that the Atrium folder isn't full or read-only, then retry.`);
    }
    logActivity(db, space.id, agent, `Started: ${task.title}`, { taskId: task.id });

    activeSpaces.add(space.id);
    const controller = new AbortController();
    const done = execute({ task: current!, space: fresh!, adapter, repo, scratch, signal: controller.signal, ...started })
      .catch(report)
      .finally(() => {
        active.delete(started.runId);
        activeSpaces.delete(space.id);
        kick();
      });
    active.set(started.runId, { taskId: task.id, done, controller });
  }

  async function execute(r: {
    task: Task;
    space: Space;
    adapter: AgentAdapter;
    repo: RepoRun | null;
    scratch: boolean;
    signal: AbortSignal;
    cwd: string;
    runId: string;
    transcript: ReturnType<typeof openTranscript>;
    copied: Copy[];
  }) {
    const { task, space, adapter, repo, runId, transcript } = r;
    // A Claude run away from a repo works in the space folder itself, where its files stay; this is how a rule
    // tells a text answer from one that left files behind.
    const folderBefore = !repo && !r.scratch && task.kind === "work" ? folderState(r.cwd) : null;
    // What the folder held before, so the review can say which files this run made. Runs/ holds kept scratch
    // files, which their own runs record.
    let snapBefore: Snapshot | null = null;
    if (!repo && !r.scratch) {
      try {
        snapBefore = snapshotFolder(r.cwd, { skipTop: ["runs"] });
      } catch {
        // Reported once the run ends, when recording finds the folder unreadable too.
      }
    }
    const markets = space.kind === "markets" && task.kind === "work" ? deps.markets : undefined;
    const unwatch = repo ? diffs.watch(task.id, adapter.id !== "claude") : null;
    const line = (raw: string) => {
      // A money run's transcript and live view are masked like everything else it touches.
      const chunk = task.purpose === "money" ? maskNumbers(raw) : raw;
      try {
        transcript.append(`${chunk}\n`);
      } catch {
        // A disk error here would reject the run while the agent keeps working; the live view still gets it.
      }
      const seq = (runSeq.get(runId) ?? 0) + 1;
      runSeq.set(runId, seq);
      bus.emit({ type: "run-output", runId, taskId: task.id, chunk, seq });
      if (repo && isFileEdit(chunk)) diffs.edited(task.id);
    };
    const steered = steerMarkers.get(task.id);
    if (steered !== undefined) {
      steerMarkers.delete(task.id);
      line(`— You steered: ${steered} —`);
    }
    let result: AgentRunResult;
    try {
      const context = markets ? `\n\n${await markets.context(task, space, adapter.id)}` : "";
      const base = repo ? [REPO_SYSTEM_PROMPT] : [generalSystemPrompt(r.scratch), ...(markets ? MARKETS_SYSTEM_LINES : [])];
      // The outcome line comes last, so it's the final thing the agent reads before it starts.
      const honest = [...capabilityLines(), OUTCOME_INSTRUCTION];
      const prompt = buildPrompt(task, space) + context;
      // Money facts go to Claude only, and only masked: a card or account number left in the prompt stops the run.
      if (task.purpose === "money" && (adapter.id !== "claude" || !isMasked(prompt))) throw new MoneyGuard();
      result = await adapter.run({
        prompt,
        cwd: r.cwd,
        systemPrompt: task.kind === "review" ? REVIEW_SYSTEM_PROMPT : [...base, ...honest].join("\n"),
        // Reviews and investing write-ups (digest, thesis draft, thesis check) only read: their output is the summary.
        allowedTools: task.purpose === "money" ? [] : task.kind === "review" || task.purpose ? REVIEW_TOOLS : repo ? REPO_TOOLS : BASE_TOOLS,
        privateData: isPrivate(space),
        mode: task.kind === "review" || task.purpose ? "review" : "work",
        signal: r.signal,
        onChunk: line,
      });
    } catch (e) {
      result =
        e instanceof MoneyGuard
          ? { status: "error", kind: "failed", message: MoneyGuard.text }
          : { status: "error", kind: "failed", message: `${adapter.label} couldn't start: ${sentence((e as Error).message)} Check that it's installed and signed in, then retry.` };
    }
    unwatch?.();
    // Whether the run was cut short. An abort that lands after the agent answered (a stop during the commit step)
    // mustn't relabel what the agent actually said, a failure or a usage limit included.
    const cutShort = r.signal.aborted;
    // A steer keeps the edits on the task's own branch, where the next run carries on from them.
    const steering = cutShort && result.status !== "ok" && steerRequested.has(task.id) && !stopRequested.has(task.id);

    // Claude's answer to a money question is masked before anything saves it: the task, the review, the write-up.
    if (task.purpose === "money") result = result.status === "ok" ? { ...result, summary: maskNumbers(result.summary) } : { ...result, message: maskNumbers(result.message) };
    // Its transcript is masked again as one text once the run ends: a number written across several chunks was only
    // masked piece by piece on the way in.
    if (task.purpose === "money") remaskTranscript(transcript.path);

    // Usage and limits are the account's, whatever became of the task, so they're recorded before anything
    // below can block or discard it.
    if (result.usage) registry.recordUsage(adapter.id, result.usage);
    if (result.status === "error" && result.kind === "rate_limited") {
      registry.setLimited(adapter.id, result.retryAfter ?? Date.now() + 30 * 60_000);
    }

    let leftRepo: string | null = null;
    let commitError: string | null = null;
    let lateBranch: string | null = null;
    // Where the agent's unfinished edits were committed when the run ended without finishing.
    let saved: string | null = null;
    // Where a scratch run's files were copied before its folder went away.
    let kept: Kept | null = null;
    try {
      const stopped = result.status !== "ok";
      // A fix still running after Nakul decided must not add to the branch he decided on, and one that didn't
      // finish must not leave half its work there either: its edits go on a branch of its own.
      const late = task.kind === "fix" && !fixStillWanted(task);
      // Before settleRepo switches branches, so the repo always goes back clean. Skipped when git settings
      // changed: staging can run filter drivers from config the agent planted, and settleRepo reports the tampering.
      if (repo && (await settingsUnchanged(repo.path, repo.fingerprint))) {
        const message = steering ? `WIP (steered): ${task.title}` : stopped ? `WIP (stopped): ${task.title}` : task.title;
        let on = repo.branch;
        try {
          if (task.kind === "fix" && (late || (stopped && !steering))) {
            const side = await branchOffDirty(repo.path, task.id);
            if (side) on = side;
            if (side && (await commitAll(repo.path, message, repo.fingerprint)).committed) {
              if (late) lateBranch = side;
              else saved = side;
            }
          } else {
            const pre = task.kind === "fix" ? (await headRef(repo.path)).sha : null;
            const res = await commitAll(repo.path, message, repo.fingerprint);
            if (stopped && res.committed) saved = repo.branch;
            // Nakul can decide between the check above and the commit landing; that commit is moved off too.
            if (pre && res.committed && !fixStillWanted(task)) {
              const post = (await headRef(repo.path)).sha;
              lateBranch = await moveLateCommit(repo.path, task.id, repo.branch, pre, post);
              if (task.approvalId) correctBranchHead(db, task.approvalId, post, pre);
            }
          }
        } catch (e) {
          commitError = `${sentence((e as Error).message)} The changes are still uncommitted on ${on} in ${repo.path}. Commit or stash them on that branch, switch back to ${repo.start}, then retry.`;
        }
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
    } finally {
      if (repo) leftRepo = await settleRepo(repo);
      if (r.scratch) {
        // The attachments are already in the space folder; keeping their copies would list them as the run's work.
        kept = await keepScratchFiles(space, runId, r.cwd, r.copied);
        rmSync(r.cwd, { recursive: true, force: true });
      }
    }

    // Before any status change, so every ended run (finished, blocked or stopped) says what it left.
    const made = await recordMade({ task, space, runId, repo, cwd: r.cwd, scratch: r.scratch, kept, before: snapBefore, tampered: leftRepo !== null });

    // What the agent says it did, with its OUTCOME line taken out of the text people read. A review's verdict is
    // its own last line, so reviews are left alone.
    let outcome: ParsedOutcome = { outcome: "unknown", reason: null, body: "" };
    if (result.status === "ok" && task.kind !== "review") {
      outcome = honestOutcome(task, result.summary);
      result = { ...result, summary: outcome.body };
    }

    if (result.status === "ok" || result.kind !== "rate_limited") limitHits.delete(task.id);
    let settled: Settled | null = null;
    try {
      if (getTask(db, task.id)?.status !== "running") {
        // Someone moved the task while it ran; its outcome no longer applies.
        const problem = commitError ?? leftRepo;
        const message =
          lateBranch && !problem
            ? `Kept the late fix on ${lateBranch}; the branch you decided on is unchanged.`
            : `Discarded the result for ${task.title}: the task was moved while it ran.${problem ? ` ${problem}` : ""}${saved ? ` Its unfinished edits are on ${saved}.` : ""}`;
        logActivity(db, space.id, "atrium", message, { taskId: task.id });
      } else if (commitError ?? leftRepo) {
        // The commit failure is why the tree is dirty, so it explains more than the dirty-tree message.
        block(task, (commitError ?? leftRepo)!);
      } else if (result.status !== "ok" && cutShort && stopRequested.has(task.id)) {
        stoppedByYou(task, saved);
      } else if (steering) {
        steeredByYou(task, steerRequested.get(task.id)!);
      } else if (result.status !== "ok" && cutShort) {
        setTaskStatus(db, task.id, "queued");
        logActivity(db, space.id, "atrium", `The engine stopped, so ${task.title} is back in the queue.${saved ? ` Its unfinished edits are saved on ${saved}.` : ""}`, { taskId: task.id });
      } else if (result.status === "ok" && task.kind === "review") {
        setTaskStatus(db, task.id, "done");
        afterReview(db, task, result);
        logActivity(db, space.id, adapter.id, `Finished: ${task.title}`, { taskId: task.id });
        if (task.approvalId) await considerRule(task.approvalId, { reviewed: verdictOf(result.summary) === "approve" });
      } else if (result.status === "ok" && task.kind === "fix") {
        // The parent's approval covers the branch, so the fix reports there instead of asking on its own. The
        // count starts where the work did, even if Nakul has since moved the repo to another branch.
        const base = (task.parentTaskId && lastRepoRun(db, task.parentTaskId)?.start) || null;
        const report = repo ? await repoReport(base ? { ...repo, start: base } : repo) : null;
        setTaskStatus(db, task.id, "done");
        afterFix(db, task, outcome, report?.lines[0] ?? "");
        logActivity(db, space.id, adapter.id, `Finished: ${task.title}`, { taskId: task.id });
      } else if (result.status === "ok" && (settled = markets ? await settleMarkets(markets, task, space, adapter.id, result.summary) : null)?.done) {
        // A paper strategy run settled its own orders; there is nothing for Nakul to review.
        if (settled.lines.length) appendTaskDetail(db, task.id, `\n\nThis run:\n${settled.lines.join("\n")}`);
        setTaskOutcome(db, task.id, outcome.outcome, outcome.reason);
        setTaskStatus(db, task.id, "done");
        logActivity(db, space.id, adapter.id, settled.activity ?? `Finished: ${task.title}`, { taskId: task.id });
      } else if (result.status === "ok") {
        const lines = [...(result.summary.trim() ? [result.summary.trim()] : []), ...(settled?.lines ?? [])];
        // Repo runs already count their files in the branch summary.
        const madeText = !repo && made ? madeLine(made.changes, made.display) : null;
        if (madeText) lines.splice(1, 0, madeText);
        const report = repo ? await repoReport(repo) : null;
        if (report) lines.push(...report.lines);
        if (kept) lines.push(keptLine(kept));
        const filesKept = repo ? 0 : kept ? Math.max(kept.files + kept.skipped, 1) : r.scratch ? 0 : filesLeftIn(r.cwd, folderBefore);
        const facts = await factsFor(db, getTask(db, task.id)!, space, filesKept);
        // Before the approval exists, so nothing deciding on it can miss what the agent said.
        setTaskOutcome(db, task.id, outcome.outcome, outcome.reason);
        setTaskStatus(db, task.id, "review");
        const approval = createApproval(db, {
          spaceId: space.id,
          taskId: task.id,
          kind: "review",
          title: task.title,
          detail: lines.join("\n\n"),
          // A result that isn't done has no kind, so no rule can ever approve it.
          fingerprint: outcome.outcome === "done" && facts ? fingerprintOf(facts) : null,
        });
        logActivity(db, space.id, adapter.id, readyLine(task, outcome), { taskId: task.id });
        if (repo && report?.commits) await handOff(task, repo, approval.id);
        await considerRule(approval.id, { filesKept });
      } else if (result.kind === "rate_limited") {
        const hits = (limitHits.get(task.id) ?? 0) + 1;
        if (hits >= MAX_LIMIT_RETRIES) {
          limitHits.delete(task.id);
          block(task, `${agentName(adapter.id)} kept reporting a usage limit for this task; retry when you're ready.`, saved);
        } else {
          limitHits.set(task.id, hits);
          // The task did nothing wrong; it goes back in line and runs when the limit resets.
          setTaskStatus(db, task.id, "queued");
          const kept = saved ? ` ${savedNote(task, saved)}` : "";
          logActivity(db, space.id, "atrium", `Paused: ${result.message}. ${task.title} will run again after that.${kept}`, { taskId: task.id });
        }
      } else {
        block(task, result.message, saved);
      }
    } finally {
      stopRequested.delete(task.id);
      steerRequested.delete(task.id);
      runSeq.delete(runId);
      enforceTranscriptCap();
    }
  }

  // Blocked rather than failed or queued: nothing went wrong, and Retry is how he runs it again.
  function stoppedByYou(task: Task, saved: string | null) {
    const reason = `You stopped this task. ${saved ? savedNote(task, saved) : "Retry to run it again."}`;
    setTaskStatus(db, task.id, "blocked", { blockedReason: reason });
    stoppedByStop.add(task.id);
    logActivity(db, task.spaceId, "you", `Stopped by you: ${task.title}.${saved ? ` ${savedNote(task, saved)}` : ""}`, { taskId: task.id });
    if (task.kind === "review") afterReview(db, task, { status: "error", kind: "failed", message: "You stopped the review." });
    if (task.kind === "fix") fixFailed(db, task, "You stopped the fix.", saved);
  }

  // Back in the queue with the note added to what he asked, so the next run's prompt carries it. The task keeps
  // its branch, and the next run checks it out again.
  function steeredByYou(task: Task, note: string) {
    appendTaskDetail(db, task.id, `\n\n${steerBlock(note)}`);
    setTaskStatus(db, task.id, "queued");
    steeredBySteer.add(task.id);
    const flat = note.replace(/\s+/g, " ");
    steerMarkers.set(task.id, flat);
    logActivity(db, task.spaceId, "you", `You steered: ${flat.length > 80 ? `${flat.slice(0, 79)}…` : flat}`, { taskId: task.id });
  }

  // Stop and continue: the run ends the way a stop ends it (edits committed to the branch, repo put back), then
  // the task goes straight back in the queue. The same for every agent, since none takes input mid-run.
  // A note already on its way: the run is winding down for it, or it's queued to start again with it.
  const steerPending = (taskId: string) => steerRequested.has(taskId) || steerMarkers.has(taskId);

  async function steerTask(taskId: string, note: string): Promise<SteerOutcome> {
    if (steerPending(taskId)) return "pending";
    const run = [...active.values()].find((r) => r.taskId === taskId);
    if (!run) return "not-running";
    steeredBySteer.delete(taskId);
    steerRequested.set(taskId, note);
    run.controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([
      run.done.then(() => true),
      new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), deps.stopTimeoutMs ?? STOP_TIMEOUT_MS))),
    ]);
    clearTimeout(timer);
    if (!settled) return "timeout";
    if (steeredBySteer.has(taskId)) return "steered";
    // Saving its edits or putting the repo back failed, so it can't start again; the task says why.
    if (getTask(db, taskId)?.status === "blocked" && !stoppedByStop.has(taskId)) return "blocked";
    // Otherwise it finished, or was stopped, before the note could take effect.
    return "not-running";
  }

  // Aborting kills the agent's process group (see runAgentProcess, which escalates to SIGKILL); execute then saves
  // its edits, puts the repo back and marks the task. Says what actually happened: stopped; finished (the agent had
  // already answered, so its result stands); or timeout (still winding down; it's marked stopped when it ends).
  async function stopTask(taskId: string): Promise<StopOutcome> {
    const run = [...active.values()].find((r) => r.taskId === taskId);
    if (!run) return "not-running";
    stoppedByStop.delete(taskId);
    stopRequested.add(taskId);
    run.controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([
      run.done.then(() => true),
      new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), deps.stopTimeoutMs ?? STOP_TIMEOUT_MS))),
    ]);
    clearTimeout(timer);
    if (!settled) return "timeout";
    // `has`, not `delete`: a second stop of the same run waits on the same promise and must hear the same answer.
    return stoppedByStop.has(taskId) ? "stopped" : "finished";
  }

  // The agent's own word, except that "done" can't stand for a title only the engine could have carried out.
  function honestOutcome(task: Task, summary: string): ParsedOutcome {
    const parsed = parseOutcome(summary);
    const parent = task.kind === "fix" && task.parentTaskId ? getTask(db, task.parentTaskId) : null;
    // A repo task's title is about code, never a repo Atrium would create.
    const claim = getSpace(db, task.spaceId)?.kind === "repo" ? null : engineOnlyClaim((parent ?? task).title);
    // Atrium knows for certain that nothing was created, so this is "couldn't", not "can't tell".
    if (parsed.outcome === "done" && claim) return { ...parsed, outcome: "couldnt", reason: NO_REPO_MADE };
    return parsed;
  }

  // Records the files a run created, changed or deleted. A failure is logged and never changes the task's outcome.
  async function recordMade(r: {
    task: Task;
    space: Space;
    runId: string;
    repo: RepoRun | null;
    cwd: string;
    scratch: boolean;
    kept: Kept | null;
    before: Snapshot | null;
    tampered: boolean;
  }): Promise<{ changes: FileChange[]; display?: (path: string) => string } | null> {
    const run = { runId: r.runId, taskId: r.task.id, spaceId: r.space.id };
    try {
      if (r.repo) {
        // The repo's git settings changed under the run; nothing more is read from it until Nakul looks.
        if (r.tampered) return null;
        // The same start repoReport counts from: a fix counts from where its parent's work began.
        const base = (r.task.kind === "fix" && r.task.parentTaskId && lastRepoRun(db, r.task.parentTaskId)?.start) || r.repo.start;
        const files = await branchFiles(r.repo.path, base, r.repo.branch);
        const changes = files.map((f) => ({ ...f, size: null }));
        if (changes.length) recordRunFiles(db, { ...run, root: "branch", ref: r.repo.branch }, changes);
        return { changes };
      }
      if (r.scratch) {
        if (!r.kept || r.kept.failed || r.kept.files === 0) return null;
        const prefix = `runs/${r.runId}/`;
        const changes = [...snapshotFolder(r.kept.dir).files].map(([path, e]): FileChange => ({ path: prefix + path, change: "created", size: e.size }));
        if (changes.length) recordRunFiles(db, { ...run, root: "space" }, changes);
        return { changes, display: (p) => p.slice(prefix.length) };
      }
      if (!r.before) throw new Error("the folder couldn't be read before the run");
      const changes = diffSnapshots(r.before, snapshotFolder(r.cwd, { skipTop: ["runs"] }));
      if (changes.length) recordRunFiles(db, { ...run, root: "space" }, changes);
      return { changes };
    } catch (e) {
      const why = (e as Error).message.trim().replace(/\.$/, "");
      logActivity(db, r.space.id, "atrium", `Couldn't list the files this run made: ${why}. The work itself is saved; open the space's Files tab to see the folder.`, { taskId: r.task.id });
      return null;
    }
  }

  // A failure here still leaves the agent's answer for review, with a line saying what didn't happen.
  async function settleMarkets(markets: MarketsHooks, task: Task, space: Space, agent: string, summary: string): Promise<Settled> {
    try {
      return await markets.settle(task, space, agent, summary);
    } catch (e) {
      return { done: false, lines: [`Atrium couldn't act on the markets block: ${(e as Error).message}`] };
    }
  }

  // Called once the adapter has returned, by which point runAgentProcess has killed the agent's process group.
  // A copy that fails must not lose the run's outcome; the approval says the files couldn't be kept.
  async function keepScratchFiles(space: Space, runId: string, cwd: string, skip: Copy[]): Promise<Kept | null> {
    const dir = join(ensureSpaceFolder(db, space), "runs", runId);
    try {
      const res = await keepScratch(cwd, dir, { skip });
      return res.files > 0 || res.skipped > 0 ? { ...res, dir } : null;
    } catch (e) {
      logActivity(db, space.id, "atrium", `Couldn't keep the files from a run's temporary folder: ${(e as Error).message}`);
      return { files: 0, truncated: false, skipped: 0, dir, failed: (e as Error).message };
    }
  }

  function fixStillWanted(task: Task): boolean {
    if (getTask(db, task.id)?.status !== "running" || !task.approvalId) return false;
    return getApproval(db, task.approvalId)?.status === "pending";
  }

  // One of Nakul's rules may decide in his place. In a space with a reviewer that happens only once the review
  // has said approve without a fix round; anything that goes wrong here leaves the item waiting for him.
  async function considerRule(approvalId: string, opts: { filesKept?: number; reviewed?: boolean } = {}) {
    const a = getApproval(db, approvalId);
    if (a?.status !== "pending" || !a.fingerprint || !a.taskId || !a.spaceId) return;
    try {
      const task = getTask(db, a.taskId);
      const space = getSpace(db, a.spaceId);
      if (!task || !space) return;
      const kids = db.query("SELECT kind FROM tasks WHERE parent_task_id = ?").all(task.id) as { kind: Task["kind"] }[];
      if (kids.some((k) => k.kind === "fix")) return;
      const reviewed = (space.kind === "repo" && space.reviewBy) || kids.some((k) => k.kind === "review");
      if (reviewed && !opts.reviewed) return;
      applyRule(db, approvalId, await factsFor(db, task, space, opts.filesKept ?? 0));
    } catch (e) {
      logActivity(db, a.spaceId, "atrium", `Couldn't check your rules for ${a.title}: ${(e as Error).message}. It's waiting for you as usual.`, { taskId: a.taskId });
    }
  }

  // A review is extra: if it can't be set up, the work still waits for Nakul as usual.
  async function handOff(task: Task, repo: RepoRun, approvalId: string) {
    const space = getSpace(db, task.spaceId);
    if (!space?.reviewBy) return;
    try {
      afterWork(db, getTask(db, task.id)!, space, approvalId, await reviewDiff(repo.path, repo.start, repo.branch));
    } catch (e) {
      logActivity(db, space.id, "atrium", `Couldn't send ${task.title} for review: ${(e as Error).message}. Check it yourself as usual.`, { taskId: task.id });
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      unsubscribe = bus.on((e) => {
        if (e.type === "changed") kick();
      });
      const moneyDaily = () => {
        try {
          deps.money?.daily(Date.now());
        } catch (e) {
          console.error(`Money's daily check failed: ${(e as Error).message}`);
        }
      };
      interval = setInterval(() => {
        deps.repos?.daily(Date.now());
        moneyDaily();
        kick();
      }, POWER_CHECK_MS);
      moneyDaily();
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
    stopTask,
    steerTask,
    steerPending,
    outputSeq: (runId) => runSeq.get(runId) ?? null,
    registry,
  };
}

// Any change to the space folder, or a folder that can't be read, counts as files left behind.
function filesLeftIn(dir: string, before: string | null): number {
  return before !== null && folderState(dir) === before ? 0 : 1;
}

function readyLine(task: Task, o: ParsedOutcome): string {
  // The reason reads as its own sentence after the title.
  const why = o.reason ? ` ${o.reason[0]!.toUpperCase()}${o.reason.slice(1)}` : "";
  if (o.outcome === "couldnt") return `Couldn't do: ${task.title}.${why}`;
  if (o.outcome === "partial") return `Partly done: ${task.title}.${why}`;
  return `Ready for review: ${task.title}`;
}

export type StopOutcome = "stopped" | "finished" | "timeout" | "not-running";
export type SteerOutcome = "steered" | "not-running" | "timeout" | "pending" | "blocked";

export const STEER_NOTE_MAX = 2000;

export const steerBlock = (note: string) =>
  `Note from you while this was running: ${note}\nThe changes made so far are already on this branch. Continue from them; don't start over.`;

class MoneyGuard extends Error {
  static text = "Atrium stopped this before sending anything: the money facts weren't fully masked or the agent wasn't Claude. Try again, and check the engine log if it keeps happening.";
}

function buildPrompt(task: Task, space: Space): string {
  const parts = [`Task: ${task.title}`];
  if (task.detail.trim()) parts.push(task.detail.trim());
  if (space.goal.trim()) parts.push(`Space goal: ${space.goal.trim()}`);
  return parts.join("\n\n");
}

// A summary failure is reported in the review, not fatal: the work is done and worth reviewing.
async function repoReport(repo: RepoRun): Promise<{ lines: string[]; commits: number }> {
  let summaryLine: string;
  let commits = 0;
  try {
    // Against the starting branch, so a retry reports all the work on the task branch.
    const s = await branchSummary(repo.path, repo.branch, repo.start);
    commits = s.commits;
    summaryLine =
      s.commits === 0
        ? "No file changes"
        : `${plural(s.commits, "commit")}, ${plural(s.filesChanged, "file")} (+${s.insertions} −${s.deletions}) on ${repo.branch}`;
  } catch (e) {
    summaryLine = `Couldn't summarise the changes on ${repo.branch}: ${(e as Error).message}`;
  }
  // Atrium never pushes as Nakul; sharing the branch is his call.
  return { lines: [summaryLine, `Branch ${repo.branch} is on your machine. Push it when you're ready.`], commits };
}

// A fix adds to the branch its parent's work is on.
const branchTaskId = (task: Task) => (task.kind === "fix" && task.parentTaskId) || task.id;

type Kept = KeptScratch & { dir: string; failed?: string };

function keptLine(kept: Kept): string {
  if (kept.failed) return `Atrium couldn't keep the files it left: ${kept.failed}. They were removed with the temporary folder.`;
  const parts = [kept.files > 0 ? `Files it left are kept in ${tildePath(kept.dir)}.` : "None of the files it left were kept."];
  if (kept.truncated) parts.push("Some were cut short or left out to stay under 5 MB each and 50 MB in all.");
  if (kept.skipped > 0) {
    const one = kept.skipped === 1;
    parts.push(`Left out ${plural(kept.skipped, "item")} that ${one ? "was a link" : "were links"} or changed while being copied.`);
  }
  return parts.join(" ");
}

// A work task's retry resumes on its own branch; a fix's retry starts again from the branch under review.
const savedNote = (task: Task, saved: string) =>
  task.kind === "fix"
    ? `Its unfinished edits are on ${saved}.`
    : `Atrium saved the agent's unfinished edits as a WIP commit on ${saved}; retry to carry on from there.`;

const leftoversReason = (branch: string, path: string, start: string | null) =>
  `The agent left uncommitted changes on ${branch} in ${path}. Commit or stash them on that branch, switch back to ${start ?? "your own branch"}, then retry.`;

const tamperedReason = (path: string) =>
  `The agent changed git settings in ${path} (config, hooks, or attributes). Atrium stopped before switching branches. Check them, then retry.`;

// The last repo run of a task: where it started, the git settings it started with and its remote (null for older rows).
export function lastRepoRun(db: Database, taskId: string): { start: string; fingerprint: string | null; remote: string | null } | null {
  const row = db
    .query(
      "SELECT start_ref, git_fingerprint, remote_url FROM runs WHERE task_id = ? AND start_ref IS NOT NULL ORDER BY started_at DESC, rowid DESC LIMIT 1",
    )
    .get(taskId) as { start_ref: string; git_fingerprint: string | null; remote_url: string | null } | null;
  return row ? { start: row.start_ref, fingerprint: row.git_fingerprint, remote: row.remote_url } : null;
}

// A missing baseline counts as changed: without it there's no telling what the agent did.
async function settingsUnchanged(path: string, expected: string | null): Promise<boolean> {
  if (!expected) return false;
  try {
    return (await gitSettingsFingerprint(path)) === expected;
  } catch {
    return false;
  }
}

// Scratch and per-run temp folders a crashed engine never removed. A day is far longer than any run lasts.
function sweepTempDirs() {
  const dir = tmpdir();
  for (const name of readdirSync(dir)) {
    if (!/^atrium-(run|agent)-/.test(name)) continue;
    const path = join(dir, name);
    try {
      const st = lstatSync(path);
      if (st.isDirectory() && Date.now() - st.mtimeMs > TEMP_SWEEP_AGE_MS) rmSync(path, { recursive: true, force: true });
    } catch {
      // Gone already, or not ours to remove; the next boot tries again.
    }
  }
}

export async function recoverOnBoot(db: Database): Promise<number> {
  sweepTempDirs();
  const stuck = listTasks(db, { status: ["running"] });
  for (const task of stuck) {
    const path = getSpace(db, task.spaceId)?.repoPath;
    const last = lastRepoRun(db, task.id);
    if (path && last && (await headRef(path).catch(() => null))?.branch === `atrium/${branchTaskId(task)}`) {
      // A checkout could run hooks or filters the crashed agent planted, so only a repo with untouched settings is switched.
      if (!(await settingsUnchanged(path, last.fingerprint))) {
        const reason = tamperedReason(path);
        setTaskStatus(db, task.id, "blocked", { blockedReason: reason });
        logActivity(db, task.spaceId, "atrium", `Blocked: ${task.title}. ${reason}`, { taskId: task.id });
        continue;
      }
      // A crash mid-run leaves the repo on the task branch. A clean one goes back now; a dirty one
      // stays put and launch blocks it with the agent's leftovers.
      try {
        await returnToBranch(path, last.start);
      } catch {
        // Left as found: launch reports a repo it can't switch.
      }
    }
    setTaskStatus(db, task.id, "queued");
    logActivity(db, task.spaceId, "atrium", `The engine restarted, so ${task.title} is back in the queue.`, { taskId: task.id });
  }
  db.query("UPDATE runs SET ended_at = ?, exit_code = -1 WHERE ended_at IS NULL").run(Date.now());
  return stuck.length;
}
