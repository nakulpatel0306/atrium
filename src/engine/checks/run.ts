import type { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { newId } from "../ids";
import { runAgentProcess } from "../agents/process";
import { SANDBOX_EXEC, seatbeltFailure, withPrivateTmp } from "../agents/seatbelt";
import type { Check } from "./detect";
import { checkProfile, installProfile, wrapCheck } from "./sandbox";

export type CheckStatus = "passed" | "failed" | "timeout" | "missing" | "skipped";
export type CheckResult = Check & { status: CheckStatus; exitCode: number | null; output: string; durationMs: number };

export const CHECK_TIMEOUT_MS = 10 * 60_000;
const OUTPUT_CAP = 16 * 1024;
// What the writer is sent back: the end of the output, where test runners put the failures and the totals.
const FEEDBACK_LINES = 60;
const FEEDBACK_CHARS = 4000;

// The project's own commands, in the checks' own sandbox (see sandbox.ts): writes only in the repo and a private
// temp folder, no credentials, no internet, no Atrium API. The environment is built from scratch so nothing from
// the engine's (tokens, keys) reaches a test.
export async function runChecks(
  cwd: string,
  checks: Check[],
  opts: { signal?: AbortSignal; timeoutMs?: number; onLine?: (line: string) => void; sandboxExec?: string } = {},
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  // The engine's install first, then fast checks, then the full test run.
  const ordered = [...checks.filter((c) => c.kind === "fast"), ...checks.filter((c) => c.kind === "full")];
  for (const check of ordered) {
    if (opts.signal?.aborted) break;
    // Nothing runs on dependencies that didn't install, and a full test run is wasted on code that doesn't typecheck.
    const broken = (r: CheckResult) => r.status === "failed" || r.status === "timeout";
    if (results.some((r) => r.install && broken(r)) || (check.kind === "full" && results.some(broken))) {
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
  const proc = await withPrivateTmp((tmp) => {
    const files = join(tmp, "check-files");
    mkdirSync(files);
    for (const [name, body] of Object.entries(check.files ?? {})) {
      mkdirSync(dirname(join(files, name)), { recursive: true });
      writeFileSync(join(files, name), body);
    }
    const profile = (check.install ? installProfile : checkProfile)(cwd, [cwd, tmp]);
    return runAgentProcess(wrapCheck(["/bin/sh", "-c", `exec 2>&1\n${check.command}`], profile, opts.sandboxExec ?? SANDBOX_EXEC), {
      cwd,
      stdin: "",
      env: checkEnv(cwd, tmp, files, check.node ?? false),
      signal,
      abortGraceMs: 2000,
      onLine: add,
    });
  });
  const durationMs = Date.now() - started;
  const tail = output.length > OUTPUT_CAP ? `[earlier output cut]\n${output.slice(-OUTPUT_CAP)}` : output;
  if (proc.notInstalled || seatbeltFailure(proc)) {
    return { ...check, status: "missing", exitCode: null, output: "Atrium couldn't start the sandbox for this check.", durationMs };
  }
  if (timeout.aborted) return { ...check, status: "timeout", exitCode: null, output: tail, durationMs };
  // 127 is the shell's "command not found": the tool isn't installed here, which says nothing about the code.
  if (proc.exitCode === 127) return { ...check, status: "missing", exitCode: 127, output: tail, durationMs };
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

export type ChecksOutcome = "passed" | "failed" | "none";

// Missing and skipped checks prove nothing either way; with no check that ran, the result is unverified.
export function outcomeOf(results: CheckResult[]): ChecksOutcome {
  if (results.some((r) => r.status === "failed" || r.status === "timeout")) return "failed";
  return results.some((r) => r.status === "passed") ? "passed" : "none";
}

// The short report the writer gets after a failing turn.
export function failureReport(results: CheckResult[]): string {
  const failed = results.filter((r) => r.status === "failed" || r.status === "timeout");
  const parts = failed.map((r) => {
    let tail = r.output.trimEnd().split("\n").slice(-FEEDBACK_LINES).join("\n");
    if (tail.length > FEEDBACK_CHARS) tail = tail.slice(-FEEDBACK_CHARS);
    const what = r.status === "timeout" ? "timed out" : `failed (exit ${r.exitCode})`;
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
