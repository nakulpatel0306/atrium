import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEPENDENCY_DIRS } from "../agents/seatbelt";
import { addCheckTree, branchFiles, removeCheckTree, treeEntries } from "../git";
import { checkAttention } from "./attention";
import { type Check, installFor, LOCKFILES, touchesInstallConfig } from "./detect";
import { type CheckResult, judge, runChecks, signatureOf } from "./run";

export type GateOutcome = {
  verdict: "passed" | "failed" | "none";
  // Null when the checks didn't run at all (a change to how dependencies install).
  results: CheckResult[] | null;
  attention: string[];
  unverified: string | null;
  // Checks that failed the same way on the base commit, which don't count against this task.
  preexisting: string[];
};

// Runs `checks` on `sha` in a checkout of its own that's deleted afterwards. The dependency folders are the
// user's, linked in read-only (no check may write them); with `install`, they're instead private copies (APFS
// clones where they can be) that the engine installs the change's lockfile into. Either way nothing the
// checks or the install do outlives the run or reaches the user's checkout.
async function runInTree(repo: string, sha: string, checks: Check[], opts: { install: Check | null; signal?: AbortSignal; onLine?: (l: string) => void }): Promise<CheckResult[]> {
  const dir = mkdtempSync(join(tmpdir(), "atrium-checks-"));
  const tree = join(dir, "tree");
  try {
    await addCheckTree(repo, sha, tree);
    const root = realpathSync(tree);
    for (const d of DEPENDENCY_DIRS) {
      const dest = join(tree, d);
      // Whatever the commit put at this name (a link pointing out of the tree, say) goes first; rm removes a link
      // itself, never what it points at, and the folder it sits in is checked to be the tree's own.
      if (lstatOrNull(dest)) {
        if (realpathSync(dirname(dest)) !== root) throw new Error(`The check tree's ${d} isn't inside it.`);
        rmSync(dest, { recursive: true, force: true });
      }
      const theirs = join(repo, d);
      if (!existsSync(theirs)) continue;
      if (!opts.install) {
        symlinkSync(theirs, dest);
        continue;
      }
      // An install may write every dependency folder in the tree, so each is then a real copy, made in a fresh
      // folder of the run's own (links copied as links, never followed) and renamed into place.
      const fresh = join(dir, `copy-${d}`);
      mkdirSync(fresh);
      Bun.spawnSync(["/bin/cp", "-c", "-R", "-P", `${theirs}/.`, fresh]);
      renameSync(fresh, dest);
    }
    return await runChecks(tree, opts.install ? [opts.install, ...checks] : checks, { signal: opts.signal, onLine: opts.onLine });
  } finally {
    await removeCheckTree(repo, tree);
    rmSync(dir, { recursive: true, force: true });
  }
}

const lstatOrNull = (p: string) => {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
};

// The base commit's own results, once per repo, commit and set of checks, so a check that was already failing
// before the task isn't put down to it.
const baseRuns = new Map<string, Promise<CheckResult[]>>();

function baseResults(repo: string, base: string, checks: Check[]): Promise<CheckResult[]> {
  const key = `${repo}\0${base}\0${JSON.stringify(checks)}`;
  let run = baseRuns.get(key);
  if (!run) {
    run = runInTree(repo, base, checks, { install: null });
    baseRuns.set(key, run);
    run.catch(() => baseRuns.delete(key));
  }
  return run;
}

const FIX_WORDS = /\b(fix|fixes|failing|fails|broken|breaks|pass|passing|green|red)\b/i;
const KIND_WORDS: Record<string, RegExp> = { Typecheck: /\b(type|types|typecheck|tsc|mypy)\b/i, Lint: /\b(lint|linter|eslint|ruff|clippy)\b/i };

// Whether the task is about getting this check to pass, in which case its failing at base is the point.
function targets(goal: string, check: Check): boolean {
  if (!FIX_WORDS.test(goal)) return false;
  const kind = KIND_WORDS[check.name] ?? /\b(test|tests|spec|suite)\b/i;
  return kind.test(goal) || goal.includes(check.command);
}

// The gate on one turn: what the change does to the checks themselves, then the checks on the branch head in a
// check tree. `outside` are config files the work left outside git (attention.ts changedOutside); `goal` is what
// the task is for, so a check it's meant to fix still counts when it fails.
export async function runGate(input: {
  repo: string;
  base: string;
  head: string;
  checks: Check[];
  goal: string;
  outside: string[];
  signal?: AbortSignal;
  onLine?: (l: string) => void;
}): Promise<GateOutcome> {
  const { repo, base, head, checks } = input;
  const committed = (await branchFiles(repo, base, head)).map((f) => f.path);
  const attention = [...new Set(checks.flatMap((c) => c.notes ?? [])), ...(await checkAttention(repo, base, head, committed, input.outside, checks))];
  // Installing would run the change's own install instructions, so a change to them leaves the result to the user.
  const installConfig = touchesInstallConfig(committed);
  if (installConfig.length) {
    return {
      verdict: "none",
      results: null,
      attention: [`This change edits how dependencies install: ${installConfig.join(", ")}.`, ...attention],
      unverified: "Unverified: this change edits how dependencies install, so Atrium didn't install or run the checks.",
      preexisting: [],
    };
  }
  const roots = (await treeEntries(repo, head)).map((e) => e.path).filter((p) => !p.includes("/"));
  const install = installFor(committed, LOCKFILES.filter((l) => roots.includes(l)));
  const results = await runInTree(repo, head, checks, { install, signal: input.signal, onLine: input.onLine });
  const failing = results.filter((r) => r.status === "failed" && !r.install);
  const preexisting: string[] = [];
  if (failing.length && !input.signal?.aborted) {
    const before = await baseResults(repo, base, checks);
    for (const r of failing) {
      const b = before.find((x) => x.name === r.name);
      if (b?.status === "failed" && signatureOf(b) === signatureOf(r) && !targets(input.goal, r)) preexisting.push(r.name);
    }
  }
  const judged = judge(results, new Set(preexisting));
  return { verdict: judged.verdict, results, attention: [...attention, ...judged.attention], unverified: judged.unverified, preexisting };
}
