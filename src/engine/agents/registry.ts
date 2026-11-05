import type { Database } from "bun:sqlite";
import { basename } from "node:path";
import { getSetting, setSetting } from "../settings";
import type { Space } from "../spaces";
import type { Task } from "../tasks";
import type { AgentAdapter, AgentStatus, AgentUsage } from "./types";

const REFRESH_MS = 10 * 60_000;
const PROBE_TIMEOUT_MS = 10_000;
const ENV_CACHE_MS = 60_000;
const DEFAULT_RESERVE = 0.5;
// Preference order for `auto`: the free agents, before spending Claude.
const FREE_AGENTS = ["codex", "gemini"];

export type Resolution = { agent: string } | { wait: string };
export type AgentView = AgentStatus & { limitedUntil: number | null };

export type Registry = {
  adapters: Record<string, AgentAdapter>;
  refresh(): Promise<void>;
  statuses(): Record<string, AgentView>;
  limitedUntil(id: string): number;
  setLimited(id: string, until: number): void;
  recordUsage(id: string, usage: AgentUsage): void;
  inReserve(): { until: number } | null;
  resolve(task: Task, space: Space): Resolution;
};

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

const isEnvFile = (file: string) => /^\.env/.test(basename(file)) || /\.env$/.test(basename(file));

// Only paths are listed, never contents. Tracked and untracked-unignored files come from one call and
// ignored ones from another, because git prints only the ignored files when --ignored is combined with --cached.
// Anything git can't list through (unreadable repo, nested repo, submodule) counts as having .env files,
// since unknown must not let a free agent in.
function repoHasEnvFiles(path: string): boolean {
  const git = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", "-C", cwd, ...args]);
  // The agent can read the whole repo, not just the folder the space points at.
  const top = git(path, "rev-parse", "--show-toplevel");
  if (top.exitCode !== 0) return true;
  const root = top.stdout.toString().trim();

  const staged = git(root, "ls-files", "-s", "-z");
  if (staged.exitCode !== 0) return true;
  const entries = staged.stdout.toString().split("\0").filter(Boolean);
  if (entries.some((e) => e.startsWith("160000 "))) return true;
  if (entries.some((e) => isEnvFile(e.slice(e.indexOf("\t") + 1)))) return true;

  for (const args of [["--others"], ["--others", "--ignored"]]) {
    const r = git(root, "ls-files", "-z", ...args, "--exclude-standard");
    if (r.exitCode !== 0) return true;
    // ls-files doesn't descend into an untracked nested repo and lists it as "dir/".
    if (r.stdout.toString().split("\0").filter(Boolean).some((f) => f.endsWith("/") || isEnvFile(f))) return true;
  }
  return false;
}

export function createRegistry(db: Database, adapters: Record<string, AgentAdapter>): Registry {
  const probed = new Map<string, AgentStatus>();
  const envCache = new Map<string, { at: number; found: boolean }>();
  let refreshedAt = 0;

  // Plan 1 paused every agent with one key; only Claude existed then.
  const legacy = getSetting(db, "runner.pausedUntil");
  if (legacy !== null) {
    if (Number(legacy) > Number(getSetting(db, "agent.claude.limitedUntil") ?? 0)) setSetting(db, "agent.claude.limitedUntil", legacy);
    db.query("DELETE FROM settings WHERE key = 'runner.pausedUntil'").run();
  }

  const limitedUntil = (id: string) => Number(getSetting(db, `agent.${id}.limitedUntil`) ?? 0);
  // An adapter with no probe is taken at its word until a run says otherwise.
  const status = (id: string): AgentStatus => probed.get(id) ?? { installed: true, loggedIn: null, detail: "" };
  const label = (id: string) => adapters[id]?.label ?? id;

  function fiveHour(): { utilization: number; resetsAt: number } | null {
    const raw = getSetting(db, "usage.claude.fiveHour");
    return raw ? JSON.parse(raw) : null;
  }

  function inReserve(): { until: number } | null {
    const w = fiveHour();
    const reserve = Number(getSetting(db, "usage.claude.reserve") ?? DEFAULT_RESERVE);
    return w && w.utilization >= reserve && w.resetsAt > Date.now() ? { until: w.resetsAt } : null;
  }

  function envFiles(path: string): boolean {
    const hit = envCache.get(path);
    if (hit && Date.now() - hit.at < ENV_CACHE_MS) return hit.found;
    const found = repoHasEnvFiles(path);
    envCache.set(path, { at: Date.now(), found });
    return found;
  }

  // Why this agent can't be started at all, or null.
  function unavailable(id: string): string | null {
    const s = status(id);
    if (!s.installed) return `${label(id)} isn't installed. Install it, or pick another agent for this task.`;
    if (s.loggedIn === false) return `${label(id)} is signed out. ${s.detail}`;
    return null;
  }

  // Codex and Gemini reads aren't sandboxed like Claude's, so they stay away from secrets and private spaces.
  function freeAgentBlock(id: string, task: Task, space: Space): string | null {
    if (space.private) return `${label(id)} can't work here: this space is private, so only Claude works in it.`;
    if (space.kind === "repo" && space.repoPath && envFiles(space.repoPath)) {
      return `${label(id)} can't work here: this repo has .env files ${label(id)} could read. Use Claude for this task.`;
    }
    // Its search tool can't be turned off and it can't run tests headless, so repo edits are out.
    if (id === "gemini" && space.kind === "repo" && task.kind !== "review") {
      return "Gemini only reviews code; pick Claude or Codex for repo work.";
    }
    return null;
  }

  function claude(task: Task): Resolution {
    const reason = unavailable("claude");
    if (reason) return { wait: reason };
    const reserve = inReserve();
    if (reserve && !task.ignoreReserve) {
      return { wait: `Saving the rest of your Claude window for you (resets ${clock(reserve.until)}). Use “Run now” to override.` };
    }
    return { agent: "claude" };
  }

  function resolve(task: Task, space: Space): Resolution {
    if (task.agent === "claude") return claude(task);
    if (task.agent !== "auto") {
      const reason = freeAgentBlock(task.agent, task, space) ?? unavailable(task.agent);
      return reason ? { wait: reason } : { agent: task.agent };
    }
    const free = () =>
      FREE_AGENTS.find((id) => adapters[id] && !unavailable(id) && limitedUntil(id) <= Date.now() && !freeAgentBlock(id, task, space));
    const repoWork = space.kind === "repo" && task.kind !== "review";
    // Free agents only get work Claude's reserve or a review frees up; otherwise Claude does it.
    const wantsFree = !space.private && (task.kind === "review" || (!repoWork && inReserve() !== null));
    const pick = wantsFree ? free() : undefined;
    return pick ? { agent: pick } : claude(task);
  }

  return {
    adapters,
    // Runs from the runner's 60s check, so the 10 minute spacing is kept here instead of in a timer.
    async refresh() {
      if (Date.now() - refreshedAt < REFRESH_MS) return;
      refreshedAt = Date.now();
      await Promise.all(
        Object.values(adapters).map(async (a) => {
          if (!a.probe) return;
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const timeout = new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("the check timed out")), PROBE_TIMEOUT_MS);
            });
            probed.set(a.id, await Promise.race([a.probe(), timeout]));
          } catch (e) {
            // A failed check says nothing about sign-in; a real run will surface the actual problem.
            probed.set(a.id, { installed: true, loggedIn: null, detail: `Couldn't check ${a.label}: ${(e as Error).message}` });
          } finally {
            clearTimeout(timer);
          }
        }),
      );
    },
    statuses() {
      return Object.fromEntries(
        Object.keys(adapters).map((id) => {
          const until = limitedUntil(id);
          return [id, { ...status(id), limitedUntil: until > Date.now() ? until : null }];
        }),
      );
    },
    limitedUntil,
    setLimited: (id, until) => setSetting(db, `agent.${id}.limitedUntil`, String(until)),
    recordUsage(id, usage) {
      if (usage.fiveHour) setSetting(db, `usage.${id}.fiveHour`, JSON.stringify(usage.fiveHour));
    },
    inReserve,
    resolve,
  };
}
