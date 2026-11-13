import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEPENDENCY_DIRS } from "../agents/seatbelt";
import { addCheckTree, branchFiles, removeCheckTree, treeEntries } from "../git";
import { checkAttention } from "./attention";
import { type Check, installFor, LOCKFILES, touchesInstallConfig } from "./detect";
import { type CheckResult, excerptOf, judge, runChecks } from "./run";

export type GateOutcome = {
  verdict: "passed" | "failed" | "none";
  // Null when the checks didn't run at all (a change to how dependencies install).
  results: CheckResult[] | null;
  attention: string[];
  unverified: string | null;
  // Checks that failed on the base commit too and still fail, with the end of their output then and now.
  alreadyFailing: { name: string; before: string; now: string }[];
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
      if (Bun.spawnSync(["/bin/cp", "-c", "-R", "-P", `${theirs}/.`, fresh]).exitCode !== 0) throw new CopyFailed(d);
      renameSync(fresh, dest);
    }
    return await runChecks(tree, opts.install ? [opts.install, ...checks] : checks, { signal: opts.signal, onLine: opts.onLine });
  } finally {
    await removeCheckTree(repo, tree);
    rmSync(dir, { recursive: true, force: true });
  }
}

// A partial copy would install into something half-made, so a failed one stops the run before anything else.
class CopyFailed extends Error {
  constructor(dir: string) {
    super(`Atrium couldn't copy ${dir} for the install`);
  }
}

const lstatOrNull = (p: string) => {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
};

// The base commit's own results, kept for the most recent few bases, so a check that was already failing before
// the task is told apart from one the change broke. The key holds the dependencies as well as the commit: after a
// reinstall the base runs again. Only a run that finished is kept; a Stop mid-run leaves nothing cached.
const BASE_CACHE = 32;
const baseRuns = new Map<string, CheckResult[]>();

// The user's dependencies as they stand: each lockfile's content, and each dependency folder's identity and time.
function depsFingerprint(repo: string): string {
  const locks = LOCKFILES.flatMap((l) => {
    const p = join(repo, l);
    return existsSync(p) ? [`${l}:${createHash("sha256").update(readFileSync(p)).digest("hex")}`] : [];
  });
  const dirs = DEPENDENCY_DIRS.flatMap((d) => {
    const st = lstatOrNull(join(repo, d));
    return st ? [`${d}:${st.ino}:${st.mtimeMs}`] : [];
  });
  return [...locks, ...dirs].join("|");
}

export async function baseResults(repo: string, base: string, checks: Check[], signal?: AbortSignal): Promise<CheckResult[] | null> {
  const key = `${repo}\0${base}\0${depsFingerprint(repo)}\0${JSON.stringify(checks)}`;
  const hit = baseRuns.get(key);
  if (hit) {
    // Most recently used last, so the oldest is the one let go.
    baseRuns.delete(key);
    baseRuns.set(key, hit);
    return hit;
  }
  const results = await runInTree(repo, base, checks, { install: null, signal });
  if (signal?.aborted) return null;
  baseRuns.set(key, results);
  if (baseRuns.size > BASE_CACHE) baseRuns.delete(baseRuns.keys().next().value!);
  return results;
}

// The checks that fail on the base commit, with the end of their output then, for telling the writer before its
// first turn.
export async function failingAtBase(repo: string, base: string, checks: Check[], signal?: AbortSignal): Promise<GateOutcome["alreadyFailing"]> {
  const before = await baseResults(repo, base, checks, signal);
  return (before ?? []).filter((r) => r.status === "failed").map((r) => ({ name: r.name, before: excerptOf(r), now: "" }));
}

// The gate on one turn: what the change does to the checks themselves, then the checks on the branch head in a
// check tree. `outside` are config files the work left outside git (attention.ts changedOutside). A check failing at
// the head is compared with the base commit only by whether it failed there too.
export async function runGate(input: {
  repo: string;
  base: string;
  head: string;
  checks: Check[];
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
      alreadyFailing: [],
    };
  }
  const roots = (await treeEntries(repo, head)).map((e) => e.path).filter((p) => !p.includes("/"));
  const install = installFor(committed, LOCKFILES.filter((l) => roots.includes(l)));
  let results: CheckResult[];
  try {
    results = await runInTree(repo, head, checks, { install, signal: input.signal, onLine: input.onLine });
  } catch (e) {
    if (!(e instanceof CopyFailed)) throw e;
    return { verdict: "none", results: null, attention, unverified: `Unverified: ${e.message}, so it didn't install or run the checks.`, alreadyFailing: [] };
  }
  const failing = results.filter((r) => r.status === "failed" && !r.install);
  const alreadyFailing: GateOutcome["alreadyFailing"] = [];
  const before = failing.length && !input.signal?.aborted ? await baseResults(repo, base, checks, input.signal) : null;
  for (const r of failing) {
    const b = before?.find((x) => x.name === r.name);
    if (b?.status === "failed") alreadyFailing.push({ name: r.name, before: excerptOf(b), now: excerptOf(r) });
  }
  const judged = judge(results, new Set(alreadyFailing.map((f) => f.name)));
  return { verdict: judged.verdict, results, attention: [...attention, ...judged.attention], unverified: judged.unverified, alreadyFailing };
}
