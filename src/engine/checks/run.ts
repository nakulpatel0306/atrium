import type { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { newId } from "../ids";
import { runAgentProcess } from "../agents/process";
import { SANDBOX_EXEC, seatbeltFailure, withPrivateTmp } from "../agents/seatbelt";
import type { Check } from "./detect";
import { OUTPUT_CUT } from "../loop";
import { checkProfile, installProfile, wrapCheck } from "./sandbox";

export type CheckStatus = "passed" | "failed" | "timeout" | "missing" | "skipped";
export type CheckResult = Check & { status: CheckStatus; exitCode: number | null; output: string; durationMs: number };

export const CHECK_TIMEOUT_MS = 10 * 60_000;
const OUTPUT_CAP = 16 * 1024;
// What the writer is sent back: the end of the output, where test runners put the failures and the totals.
const FEEDBACK_LINES = 60;
const FEEDBACK_CHARS = 4000;

// The project's own commands, in the checks' own sandbox (see sandbox.ts): writes only in the check tree and a
// private temp folder, no credentials, no internet, no Atrium API. The environment is built from scratch so nothing
// from the engine's (tokens, keys) reaches a test.
export async function runChecks(
  cwd: string,
  checks: Check[],
  opts: { signal?: AbortSignal; timeoutMs?: number; onLine?: (line: string) => void; sandboxExec?: string } = {},
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  // The engine's install first, then fast checks, then the full test run. Every check runs whatever the others
  // said: a typecheck that was already failing must not hide what the tests would find.
  const ordered = [...checks.filter((c) => c.kind === "fast"), ...checks.filter((c) => c.kind === "full")];
  for (const check of ordered) {
    if (opts.signal?.aborted) break;
    // Nothing runs on dependencies that didn't install.
    if (results.some((r) => r.install && r.status !== "passed")) {
      results.push({ ...check, status: "skipped", exitCode: null, output: "", durationMs: 0 });
      continue;
    }
    opts.onLine?.(`— Checking: ${check.command} —`);
    const result = await runOne(cwd, check, opts);
    opts.onLine?.(`— ${check.name}: ${STATUS_WORD[result.status]} —`);
    results.push(result);
  }
  return results;
}

const STATUS_WORD: Record<CheckStatus, string> = { passed: "passed", failed: "failed", timeout: "timed out", missing: "couldn't run", skipped: "skipped" };

async function runOne(cwd: string, check: Check, opts: { signal?: AbortSignal; timeoutMs?: number; sandboxExec?: string }): Promise<CheckResult> {
  const started = Date.now();
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? CHECK_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  let output = "";
  const add = (line: string) => {
    output += `${line}\n`;
    if (output.length > OUTPUT_CAP * 2) output = output.slice(-OUTPUT_CAP);
  };
  // Whether the tool is there at all is asked before anything from the repo runs: an exit code is the repo's to
  // choose (a test can exit 127), so it never decides that a check couldn't run.
  const tool = firstWord(check.command);
  const env = (tmp: string, files: string) => (check.install ? installEnv(tmp) : checkEnv(cwd, tmp, files, check.node ?? false));
  if (tool && !hasTool(tool, env("/tmp", "/tmp").PATH ?? "")) {
    return { ...check, status: "missing", exitCode: null, output: `${tool} isn't installed on this Mac, or isn't on the PATH checks get.`, durationMs: 0 };
  }
  const proc = await withPrivateTmp((tmp) => {
    const files = join(tmp, "check-files");
    mkdirSync(files);
    for (const [name, body] of Object.entries(check.files ?? {})) {
      mkdirSync(dirname(join(files, name)), { recursive: true });
      writeFileSync(join(files, name), body);
    }
    const profile = check.install ? installProfile(cwd, tmp) : checkProfile(cwd, [cwd, tmp]);
    return runAgentProcess(wrapCheck(["/bin/sh", "-c", `exec 2>&1\n${check.command}`], profile, opts.sandboxExec ?? SANDBOX_EXEC), {
      cwd,
      stdin: "",
      env: env(tmp, files),
      signal,
      abortGraceMs: 2000,
      onLine: add,
    });
  });
  const durationMs = Date.now() - started;
  const tail = output.length > OUTPUT_CAP ? `${OUTPUT_CUT}\n${output.slice(-OUTPUT_CAP)}` : output;
  if (proc.notInstalled || seatbeltFailure(proc)) {
    return { ...check, status: "missing", exitCode: null, output: "Atrium couldn't start the sandbox for this check.", durationMs };
  }
  if (timeout.aborted) return { ...check, status: "timeout", exitCode: null, output: tail, durationMs };
  return { ...check, status: proc.exitCode === 0 ? "passed" : "failed", exitCode: proc.exitCode, output: tail, durationMs };
}

function checkEnv(cwd: string, tmp: string, files: string, node: boolean): Record<string, string> {
  const keep = (k: string) => (process.env[k] ? { [k]: process.env[k]! } : {});
  return {
    // A package script runs with the project's own tools first, as `npm run` would run it; only the engine writes
    // node_modules (agents' sandboxes can't). Every other check gets the system PATH and nothing from the tree.
    PATH: [node ? join(cwd, "node_modules", ".bin") : null, process.env.PATH].filter(Boolean).join(":"),
    ATRIUM_CHECK_FILES: files,
    ...keep("HOME"),
    ...keep("USER"),
    ...keep("LOGNAME"),
    ...keep("LANG"),
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    // Tool caches that would otherwise be written outside the repo, where checks can't write.
    XDG_CACHE_HOME: join(tmp, "cache"),
    GOCACHE: join(tmp, "go-build"),
    CI: "1",
    TERM: "dumb",
    NO_COLOR: "1",
  };
}

// The install's environment: the same scrubbed basics, with every package manager's cache in the run's temp folder,
// the only place outside the dependency folders it may write.
function installEnv(tmp: string): Record<string, string> {
  const keep = (k: string) => (process.env[k] ? { [k]: process.env[k]! } : {});
  return {
    ...keep("PATH"),
    ...keep("HOME"),
    ...keep("LANG"),
    TMPDIR: tmp,
    BUN_INSTALL_CACHE_DIR: join(tmp, "bun-cache"),
    npm_config_cache: join(tmp, "npm-cache"),
    npm_config_store_dir: join(tmp, "pnpm-store"),
    YARN_CACHE_FOLDER: join(tmp, "yarn-cache"),
    CI: "1",
    NO_COLOR: "1",
  };
}

// The command's program, past any VAR=value assignments in front of it.
function firstWord(command: string): string | null {
  const words = command.trim().split(/\s+/);
  const word = words.find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
  return word ? word.replace(/^["']|["']$/g, "") : null;
}

// `command -v` only looks the name up; nothing it finds is run.
function hasTool(tool: string, path: string): boolean {
  return Bun.spawnSync(["/bin/sh", "-c", 'command -v -- "$1" >/dev/null', "sh", tool], { env: { PATH: path } }).exitCode === 0;
}

const REGISTRY_LOGIN = /\b(E?401|E?403|ENEEDAUTH|unauthori[sz]ed|authentication (required|failed)|requires? (a )?login)\b/i;

export type Judgement = {
  verdict: "passed" | "failed" | "none";
  // Why the result is unverified when checks exist but didn't all run; null otherwise.
  unverified: string | null;
  // Checks that couldn't run, which no rule may approve past.
  attention: string[];
};

const UNRUN: Partial<Record<CheckStatus, string>> = { missing: "its tool isn't installed here", timeout: "it timed out", skipped: "the install it needed didn't happen" };

// What a turn's results prove. A check that couldn't run (a missing tool, a timeout, one skipped because the
// install didn't happen) proves nothing, so the result is never "passed" with it; the install itself is never
// counted as a passing check. `alreadyFailing` are checks that failed on the base commit too: one that still fails
// proves nothing about this change either, so it can't fail the task and can't pass it.
export function judge(results: CheckResult[], alreadyFailing: Set<string> = new Set()): Judgement {
  const install = results.find((r) => r.install);
  const loginNeeded = install?.status === "failed" && REGISTRY_LOGIN.test(install.output);
  const failed = results.filter((r) => r.status === "failed" && !alreadyFailing.has(r.name) && !(r.install && loginNeeded));
  if (failed.length) return { verdict: "failed", unverified: null, attention: [] };
  if (loginNeeded) {
    const why = "Unverified: Atrium couldn't install the dependencies because the registry needs your login, which checks never get.";
    return { verdict: "none", unverified: why, attention: [] };
  }
  const unrun = results.filter((r) => !r.install && UNRUN[r.status]);
  const stale = results.filter((r) => r.status === "failed" && alreadyFailing.has(r.name));
  if (unrun.length || stale.length) {
    const why = [
      ...(unrun.length ? [`${unrun.map((r) => r.name).join(", ")} couldn't run`] : []),
      ...(stale.length ? [`${stale.map((r) => r.name).join(", ")} ${stale.length === 1 ? "was" : "were"} already failing before this task`] : []),
    ];
    const attention = [
      ...unrun.map((r) => `${r.name} couldn't run (${UNRUN[r.status]}), so it proves nothing.`),
      ...stale.map((r) => `${r.name} was already failing before this task and still fails, so it proves nothing about this change.`),
    ];
    return { verdict: "none", unverified: `Unverified: ${why.join("; ")}.`, attention };
  }
  return { verdict: results.some((r) => !r.install && r.status === "passed") ? "passed" : "none", unverified: null, attention: [] };
}

// The end of a check's output, for telling the writer and the reviewer what was already failing.
export const excerptOf = (r: CheckResult, lines = 15) => r.output.trimEnd().split("\n").slice(-lines).join("\n").slice(-1500);

// The short report the writer gets after a failing turn.
export function failureReport(results: CheckResult[]): string {
  const failed = results.filter((r) => r.status === "failed");
  const parts = failed.map((r) => {
    let tail = r.output.trimEnd().split("\n").slice(-FEEDBACK_LINES).join("\n");
    if (tail.length > FEEDBACK_CHARS) tail = tail.slice(-FEEDBACK_CHARS);
    const what = `failed (exit ${r.exitCode})`;
    return `\`${r.command}\` ${what}. The end of its output:\n\`\`\`\n${tail}\n\`\`\``;
  });
  return parts.join("\n\n");
}

export function saveChecks(db: Database, taskId: string, runId: string | null, results: CheckResult[]): void {
  const now = Date.now();
  const insert = db.query(
    "INSERT INTO checks (id, task_id, run_id, name, command, status, exit_code, output, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  db.transaction(() => {
    for (const r of results) insert.run(newId("chk"), taskId, runId, r.name, r.command, r.status, r.exitCode, r.output, r.durationMs, now);
  })();
}

export type CheckRow = { id: string; runId: string | null; name: string; command: string; status: CheckStatus; exitCode: number | null; output: string; durationMs: number; createdAt: number };

// The checks from the task's latest checked turn, which are the ones its badge speaks for.
export function latestChecks(db: Database, taskId: string): CheckRow[] {
  return db
    .query(
      `SELECT id, run_id AS runId, name, command, status, exit_code AS exitCode, output, duration_ms AS durationMs, created_at AS createdAt
       FROM checks WHERE task_id = ? AND created_at = (SELECT MAX(created_at) FROM checks WHERE task_id = ?) ORDER BY rowid`,
    )
    .all(taskId, taskId) as CheckRow[];
}
