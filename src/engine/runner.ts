import type { Database } from "bun:sqlite";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clock, createRegistry, type Registry, type TaskWait } from "./agents/registry";
import type { AgentAdapter, AgentRunResult } from "./agents/types";
import { correctBranchHead, createApproval, getApproval } from "./approvals";
import { factsFor, folderState } from "./autonomy/facts";
import { fingerprintOf } from "./autonomy/kinds";
import { applyRule } from "./autonomy/rules";
import { config } from "./config";
import { bus, logActivity } from "./events";
import {
  branchOffDirty,
  branchSummary,
  commitAll,
  gitSettingsFingerprint,
  headRef,
  moveLateCommit,
  prepareBranch,
  repoReady,
  returnToBranch,
  reviewDiff,
} from "./git";
import { afterFix, afterReview, afterWork, fixFailed, resolvedAgent } from "./handoff";
import { newId } from "./ids";
import { MARKETS_SYSTEM_LINES, type MarketsHooks } from "./markets/agent";
import { agentName, plural, sentence } from "./text";
import { canRun, type PowerSource } from "./power";
import { verdictOf } from "./verdict";
import { type KeptScratch, keepScratch } from "./scratch";
import { getSetting, setSetting } from "./settings";
import { getSpace, type Space } from "./spaces";
import { getTask, listTasks, setTaskStatus, type Task } from "./tasks";
import { enforceTranscriptCap, openTranscript } from "./storage";

const POWER_CHECK_MS = 60_000;
const STOP_TIMEOUT_MS = 10_000;
const MAX_LIMIT_RETRIES = 3;
const TEMP_SWEEP_AGE_MS = 86_400_000;

const REPO_SYSTEM_PROMPT = [
  "You are working for Nakul through Atrium.",
  "Work only on the current git branch. Do not switch, create, or delete branches.",
  "Leave your changes uncommitted; Atrium commits them for you.",
  "Never push or merge.",
  "Never read, print, or edit .env files, keys, or tokens.",
  "Finish with a 2–4 sentence summary of what changed and anything Nakul should check.",
].join("\n");

// Away from a repo there is no git: instructions about branches send agents looking for one.
function generalSystemPrompt(scratch: boolean): string {
  return [
    "You are working for Nakul through Atrium.",
    "Work in the current folder.",
    ...(scratch ? ["This folder is temporary. Atrium keeps a copy of the files you leave in it with this run's results."] : []),
    "Never read, print, or edit .env files, keys, or tokens.",
    "Finish with a 2–4 sentence summary of what you did and anything Nakul should check.",
  ].join("\n");
}

// The diff is in a review's prompt, so the reviewer reads and changes nothing on disk.
const REVIEW_SYSTEM_PROMPT = [
  "You are reviewing another agent's work for Nakul through Atrium.",
  "Everything you need is in the prompt. Don't create or change any files.",
  "Never read, print, or edit .env files, keys, or tokens.",
].join("\n");

const REVIEW_TOOLS = ["Read", "Glob", "Grep"];
const BASE_TOOLS = ["Read", "Edit", "Write", "Glob", "Grep"];
const REPO_TOOLS = [
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
type RepoRun = { path: string; start: string; branch: string; fingerprint: string };

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
}): { start(): void; stop(): Promise<void>; kick(): void; registry: Registry } {
  const { db, adapters, keepAwake } = deps;
  const registry = deps.registry ?? createRegistry(db, adapters);
  const maxConcurrent = deps.maxConcurrent ?? 1;
  const active = new Map<string, { taskId: string; done: Promise<void>; controller: AbortController }>();
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

  // Queued tasks in active spaces that power and the registry allow, each with the agent it resolved to,
  // plus every task held back and why. A limited agent's tasks stay in `runnable` so the queue counts as work.
  function candidates(source: PowerSource): { runnable: { task: Task; agent: string }[]; waits: TaskWait[] } {
    const runnable: { task: Task; agent: string }[] = [];
    const waits: TaskWait[] = [];
    for (const task of listTasks(db, { status: ["queued"] })) {
      const space = getSpace(db, task.spaceId);
      if (space?.status !== "active") continue;
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
    logActivity(db, task.spaceId, "atrium", `Skipped: ${task.title}. ${reason}`);
  }

  // `saved` is the branch Atrium committed the agent's unfinished edits to, if it did.
  function block(task: Task, reason: string, saved: string | null = null) {
    const full = saved ? `${sentence(reason)} ${savedNote(task, saved)}` : reason;
    setTaskStatus(db, task.id, "blocked", { blockedReason: full });
    logActivity(db, task.spaceId, "atrium", `Blocked: ${task.title}. ${full}`);
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
        else if (start.startsWith("atrium/")) return block(task, `Repo is on ${start}; switch back to your branch first.`);
        const fingerprint = last?.fingerprint ?? (await gitSettingsFingerprint(path));
        const branch = await prepareBranch(path, branchTaskId(task), { existing: task.kind === "fix" });
        repo = { path, start, fingerprint, branch };
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

    // Codex and Gemini reads aren't sandboxed like Claude's: away from a repo each run gets an empty folder of
    // its own instead of the space folder, where earlier runs' files collect.
    const scratch = !repo && agent !== "claude";
    let started: { cwd: string; runId: string; transcript: ReturnType<typeof openTranscript> };
    let cwd: string | null = null;
    try {
      cwd = repo ? repo.path : scratch ? mkdtempSync(join(tmpdir(), "atrium-run-")) : join(config().home, "spaces", space.id);
      if (!repo && !scratch) mkdirSync(cwd, { recursive: true });
      const runId = newId("run");
      const transcript = openTranscript(runId);
      db.query(
        "INSERT INTO runs (id, task_id, agent, started_at, transcript_path, start_ref, git_fingerprint) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(runId, task.id, agent, Date.now(), transcript.path, repo?.start ?? null, repo?.fingerprint ?? null);
      started = { cwd, runId, transcript };
    } catch (e) {
      if (scratch && cwd) rmSync(cwd, { recursive: true, force: true });
      // Blocking takes the task out of the queue, so a broken disk can't retry it every tick.
      const left = repo ? await leaveRepo(repo) : null;
      return block(task, left ?? `Atrium couldn't start the run: ${(e as Error).message}`);
    }
    logActivity(db, space.id, agent, `Started: ${task.title}`);

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
  }) {
    const { task, space, adapter, repo, runId, transcript } = r;
    // A Claude run away from a repo works in the space folder itself, where its files stay; this is how a rule
    // tells a text answer from one that left files behind.
    const folderBefore = !repo && !r.scratch && task.kind === "work" ? folderState(r.cwd) : null;
    const markets = space.kind === "markets" && task.kind === "work" ? deps.markets : undefined;
    let result: AgentRunResult;
    try {
      const context = markets ? `\n\n${await markets.context(task, space, adapter.id)}` : "";
      const general = generalSystemPrompt(r.scratch);
      result = await adapter.run({
        prompt: buildPrompt(task, space) + context,
        cwd: r.cwd,
        systemPrompt:
          task.kind === "review" ? REVIEW_SYSTEM_PROMPT : repo ? REPO_SYSTEM_PROMPT : markets ? [general, ...MARKETS_SYSTEM_LINES].join("\n") : general,
        allowedTools: task.kind === "review" ? REVIEW_TOOLS : repo ? REPO_TOOLS : BASE_TOOLS,
        mode: task.kind === "review" ? "review" : "work",
        signal: r.signal,
        onChunk(chunk) {
          try {
            transcript.append(`${chunk}\n`);
          } catch {
            // A disk error here would reject the run while the agent keeps working; the live view still gets it.
          }
          bus.emit({ type: "run-output", runId, taskId: task.id, chunk });
        },
      });
    } catch (e) {
      result = { status: "error", kind: "failed", message: `${adapter.label} could not start: ${(e as Error).message}` };
    }

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
        const message = stopped ? `WIP (stopped): ${task.title}` : task.title;
        let on = repo.branch;
        try {
          if (task.kind === "fix" && (late || stopped)) {
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
        kept = await keepScratchFiles(space, runId, r.cwd);
        rmSync(r.cwd, { recursive: true, force: true });
      }
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
        logActivity(db, space.id, "atrium", message);
      } else if (commitError ?? leftRepo) {
        // The commit failure is why the tree is dirty, so it explains more than the dirty-tree message.
        block(task, (commitError ?? leftRepo)!);
      } else if (result.status !== "ok" && r.signal.aborted) {
        setTaskStatus(db, task.id, "queued");
        logActivity(db, space.id, "atrium", `Engine stopped; requeued ${task.title}${saved ? `. Its unfinished edits are saved on ${saved}.` : ""}`);
      } else if (result.status === "ok" && task.kind === "review") {
        setTaskStatus(db, task.id, "done");
        afterReview(db, task, result);
        logActivity(db, space.id, adapter.id, `Finished: ${task.title}`);
        if (task.approvalId) await considerRule(task.approvalId, { reviewed: verdictOf(result.summary) === "approve" });
      } else if (result.status === "ok" && task.kind === "fix") {
        // The parent's approval covers the branch, so the fix reports there instead of asking on its own. The
        // count starts where the work did, even if Nakul has since moved the repo to another branch.
        const base = (task.parentTaskId && lastRepoRun(db, task.parentTaskId)?.start) || null;
        const report = repo ? await repoReport(base ? { ...repo, start: base } : repo) : null;
        setTaskStatus(db, task.id, "done");
        afterFix(db, task, result.summary, report?.lines[0] ?? "");
        logActivity(db, space.id, adapter.id, `Finished: ${task.title}`);
      } else if (result.status === "ok" && (settled = markets ? await settleMarkets(markets, task, space, adapter.id, result.summary) : null)?.done) {
        // A paper strategy run settled its own orders; there is nothing for Nakul to review.
        setTaskStatus(db, task.id, "done");
        logActivity(db, space.id, adapter.id, settled.activity ?? `Finished: ${task.title}`);
      } else if (result.status === "ok") {
        const lines = [result.summary.trim(), ...(settled?.lines ?? [])];
        const report = repo ? await repoReport(repo) : null;
        if (report) lines.push(...report.lines);
        if (kept) lines.push(keptLine(kept));
        const filesKept = repo ? 0 : kept ? Math.max(kept.files + kept.skipped, 1) : r.scratch ? 0 : filesLeftIn(r.cwd, folderBefore);
        const facts = await factsFor(db, getTask(db, task.id)!, space, filesKept);
        setTaskStatus(db, task.id, "review");
        const approval = createApproval(db, {
          spaceId: space.id,
          taskId: task.id,
          kind: "review",
          title: task.title,
          detail: lines.join("\n\n"),
          fingerprint: facts ? fingerprintOf(facts) : null,
        });
        logActivity(db, space.id, adapter.id, `Ready for review: ${task.title}`);
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
          logActivity(db, space.id, "atrium", `Paused: ${result.message}. ${task.title} will run again after that.${kept}`);
        }
      } else {
        block(task, result.message, saved);
      }
    } finally {
      enforceTranscriptCap();
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
  async function keepScratchFiles(space: Space, runId: string, cwd: string): Promise<Kept | null> {
    const dir = join(config().home, "spaces", space.id, "runs", runId);
    try {
      const res = await keepScratch(cwd, dir);
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
    if (a?.status !== "pending" || !a.fingerprint || !a.taskId) return;
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
      logActivity(db, a.spaceId, "atrium", `Couldn't check your rules for ${a.title}: ${(e as Error).message}. It's waiting for you as usual.`);
    }
  }

  // A review is extra: if it can't be set up, the work still waits for Nakul as usual.
  async function handOff(task: Task, repo: RepoRun, approvalId: string) {
    const space = getSpace(db, task.spaceId);
    if (!space?.reviewBy) return;
    try {
      afterWork(db, getTask(db, task.id)!, space, approvalId, await reviewDiff(repo.path, repo.start, repo.branch));
    } catch (e) {
      logActivity(db, space.id, "atrium", `Couldn't send ${task.title} for review: ${(e as Error).message}. Check it yourself as usual.`);
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
    registry,
  };
}

// Any change to the space folder, or a folder that can't be read, counts as files left behind.
function filesLeftIn(dir: string, before: string | null): number {
  return before !== null && folderState(dir) === before ? 0 : 1;
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
  return { lines: [summaryLine, `Branch ${repo.branch} is on your machine — push it when you're ready.`], commits };
}

// A fix adds to the branch its parent's work is on.
const branchTaskId = (task: Task) => (task.kind === "fix" && task.parentTaskId) || task.id;

type Kept = KeptScratch & { dir: string; failed?: string };

function keptLine(kept: Kept): string {
  if (kept.failed) return `Atrium couldn't keep the files it left: ${kept.failed}. They were removed with the temporary folder.`;
  const parts = [kept.files > 0 ? `Files it left are kept in ${kept.dir}.` : "None of the files it left were kept."];
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
  `The agent changed git settings in ${path} (config, hooks, or attributes). Atrium stopped before switching branches — check them before retrying.`;

// The last repo run of a task: where it started and the git settings it started with (null for older rows).
function lastRepoRun(db: Database, taskId: string): { start: string; fingerprint: string | null } | null {
  const row = db
    .query(
      "SELECT start_ref, git_fingerprint FROM runs WHERE task_id = ? AND start_ref IS NOT NULL ORDER BY started_at DESC, rowid DESC LIMIT 1",
    )
    .get(taskId) as { start_ref: string; git_fingerprint: string | null } | null;
  return row ? { start: row.start_ref, fingerprint: row.git_fingerprint } : null;
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
        logActivity(db, task.spaceId, "atrium", `Blocked: ${task.title}. ${reason}`);
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
    logActivity(db, task.spaceId, "atrium", `Engine restarted; requeued ${task.title}`);
  }
  db.query("UPDATE runs SET ended_at = ?, exit_code = -1 WHERE ended_at IS NULL").run(Date.now());
  return stuck.length;
}
