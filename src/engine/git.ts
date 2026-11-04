import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const PROTECTED = new Set(["main", "master"]);

// The agent can write inside the repo, so config it plants must never run with the engine's privileges.
const SAFE = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.sshCommand=ssh"];

async function git(path: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["git", ...SAFE, ...args], { cwd: path, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

function isProtected(branch: string): boolean {
  return PROTECTED.has(branch.replace(/^refs\/heads\//, ""));
}

export async function repoReady(path: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!existsSync(path) || !statSync(path).isDirectory()) return { ok: false, reason: `Folder not found: ${path}` };
  const inside = await git(path, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0) return { ok: false, reason: `Not a git repo: ${path}` };
  const status = await git(path, ["status", "--porcelain"]);
  if (status.code !== 0) return { ok: false, reason: `Not a git repo: ${path}` };
  if (status.out.trim() !== "") return { ok: false, reason: `You have uncommitted changes in ${path}` };
  return { ok: true };
}

// The branch name, or null when HEAD is detached; sha is always the current commit.
export async function headRef(path: string): Promise<{ branch: string | null; sha: string }> {
  const name = await git(path, ["branch", "--show-current"]);
  const sha = await git(path, ["rev-parse", "HEAD"]);
  if (sha.code !== 0) throw new Error(`Could not read HEAD: ${sha.err.trim()}`);
  return { branch: name.out.trim() || null, sha: sha.out.trim() };
}

export async function prepareBranch(path: string, taskId: string): Promise<string> {
  if (isProtected(taskId)) throw new Error("Refusing to work on main");
  const branch = `atrium/${taskId}`;
  const valid = await git(path, ["check-ref-format", "--branch", branch]);
  if (valid.code !== 0) throw new Error(`Invalid branch name: ${branch}`);
  // checkout carries non-conflicting uncommitted changes along, which would put the user's WIP on the agent branch.
  const status = await git(path, ["status", "--porcelain"]);
  if (status.code !== 0) throw new Error(`Could not read git status: ${status.err.trim()}`);
  if (status.out.trim() !== "") throw new Error(`You have uncommitted changes in ${path}`);
  // A retry after a send-back reuses the existing branch. Plain checkout (never --force)
  // fails rather than overwrite local changes.
  const exists = await git(path, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  const res = await git(path, exists.code === 0 ? ["checkout", branch] : ["checkout", "-b", branch]);
  if (res.code !== 0) throw new Error(`Could not switch to ${branch}: ${res.err.trim()}`);
  return branch;
}

const MISSING = "\0missing\0";

function readOrMissing(file: string): string {
  return existsSync(file) && statSync(file).isFile() ? readFileSync(file, "latin1") : MISSING;
}

// Hash of everything in the repo that can make a later git command run code or rewrite where it pushes.
export async function gitSettingsFingerprint(path: string): Promise<string> {
  const dir = await git(path, ["rev-parse", "--git-dir"]);
  const top = await git(path, ["rev-parse", "--show-toplevel"]);
  if (dir.code !== 0 || top.code !== 0) throw new Error(`Not a git repo: ${path}`);
  const gitDir = resolve(path, dir.out.trim());
  const hooksDir = join(gitDir, "hooks");
  const hooks = existsSync(hooksDir)
    ? (readdirSync(hooksDir, { recursive: true }) as string[]).filter((f) => statSync(join(hooksDir, f)).isFile()).sort()
    : [];
  const hash = createHash("sha256");
  const add = (label: string, content: string) => hash.update(`${label}\0${content.length}\0${content}\0`);
  add("config", readOrMissing(join(gitDir, "config")));
  for (const f of hooks) add(`hook:${f}`, readOrMissing(join(hooksDir, f)));
  add("info/attributes", readOrMissing(join(gitDir, "info", "attributes")));
  add(".gitattributes", readOrMissing(join(top.out.trim(), ".gitattributes")));
  return hash.digest("hex");
}

// Read before the agent runs: a remote URL the agent rewrites afterwards must not be where Atrium pushes.
export async function remoteUrl(path: string): Promise<string | null> {
  const remotes = (await git(path, ["remote"])).out.split("\n").map((r) => r.trim()).filter(Boolean);
  if (remotes.length === 0) return null;
  const remote = remotes.includes("origin") ? "origin" : remotes[0]!;
  const res = await git(path, ["remote", "get-url", remote]);
  return res.code === 0 ? res.out.trim() : null;
}

export async function pushBranch(path: string, branch: string, url: string | null): Promise<{ pushed: boolean; reason?: string }> {
  if (isProtected(branch)) return { pushed: false, reason: "Refusing to push main" };
  if (!url) return { pushed: false, reason: "No remote configured" };
  const res = await git(path, ["push", url, `refs/heads/${branch}:refs/heads/${branch}`]);
  if (res.code !== 0) return { pushed: false, reason: res.err.trim() };
  return { pushed: true };
}

// Plain checkout (never --force); a dirty tree is reported rather than carried along.
export async function returnToBranch(path: string, ref: string): Promise<"ok" | "dirty"> {
  const status = await git(path, ["status", "--porcelain"]);
  if (status.code !== 0) throw new Error(`Could not read git status: ${status.err.trim()}`);
  if (status.out.trim() !== "") return "dirty";
  const res = await git(path, ["checkout", ref]);
  if (res.code !== 0) throw new Error(`Could not switch back to ${ref}: ${res.err.trim()}`);
  return "ok";
}

export async function branchSummary(
  path: string,
  branch: string,
  base: string,
): Promise<{ commits: number; filesChanged: number; insertions: number; deletions: number }> {
  const count = await git(path, ["rev-list", "--count", `${base}..${branch}`]);
  const stat = await git(path, ["diff", "--shortstat", `${base}...${branch}`]);
  if (count.code !== 0) throw new Error(`Could not count commits: ${count.err.trim()}`);
  if (stat.code !== 0) throw new Error(`Could not diff ${base}...${branch}: ${stat.err.trim()}`);
  const num = (re: RegExp) => Number(stat.out.match(re)?.[1] ?? 0);
  return {
    commits: Number(count.out.trim()),
    filesChanged: num(/(\d+) files? changed/),
    insertions: num(/(\d+) insertions?\(\+\)/),
    deletions: num(/(\d+) deletions?\(-\)/),
  };
}
