import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isEnvPath } from "./envpath";

const PROTECTED = new Set(["main", "master"]);

// The agent can write inside the repo, so config it plants must never run with the engine's privileges.
const SAFE = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.sshCommand=ssh"];

async function git(
  path: string,
  args: string[],
  timeoutMs?: number,
): Promise<{ code: number; out: string; err: string; timedOut: boolean }> {
  const proc = Bun.spawn(["git", ...SAFE, ...args], {
    cwd: path,
    stdout: "pipe",
    stderr: "pipe",
    // The engine has no terminal; a credential prompt would hang the run instead of failing it.
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    timeout: timeoutMs,
  });
  const out = new Response(proc.stdout).text();
  const err = new Response(proc.stderr).text();
  const code = await proc.exited;
  // git's transport helper outlives a killed git and keeps the pipes open, so don't wait on them.
  if (timeoutMs !== undefined && proc.signalCode !== null) return { code, out: "", err: "", timedOut: true };
  return { code, out: await out, err: await err, timedOut: false };
}

function isProtected(branch: string): boolean {
  return PROTECTED.has(branch.replace(/^refs\/heads\//, ""));
}

export async function repoReady(path: string): Promise<{ ok: true } | { ok: false; reason: string; dirty?: true }> {
  if (!existsSync(path) || !statSync(path).isDirectory()) return { ok: false, reason: `Folder not found: ${path}` };
  const inside = await git(path, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0) return { ok: false, reason: `Not a git repo: ${path}` };
  const status = await git(path, ["status", "--porcelain"]);
  if (status.code !== 0) return { ok: false, reason: `Not a git repo: ${path}` };
  if (status.out.trim() !== "") return { ok: false, reason: `You have uncommitted changes in ${path}`, dirty: true };
  return { ok: true };
}

// The branch name, or null when HEAD is detached; sha is always the current commit.
export async function headRef(path: string): Promise<{ branch: string | null; sha: string }> {
  const name = await git(path, ["branch", "--show-current"]);
  const sha = await git(path, ["rev-parse", "HEAD"]);
  if (sha.code !== 0) throw new Error(`Could not read HEAD: ${sha.err.trim()}`);
  return { branch: name.out.trim() || null, sha: sha.out.trim() };
}

// A fix task passes its parent's id with `existing`: it adds to the branch under review, and a branch that's
// gone means there is nothing left to fix, so it is never recreated.
export async function prepareBranch(path: string, taskId: string, opts: { existing?: boolean } = {}): Promise<string> {
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
  if (opts.existing && exists.code !== 0) throw new Error(`${branch} no longer exists, so there's no work left to fix.`);
  const res = await git(path, exists.code === 0 ? ["checkout", branch] : ["checkout", "-b", branch]);
  if (res.code !== 0) throw new Error(`Could not switch to ${branch}: ${res.err.trim()}`);
  return branch;
}

// Test seams: the fingerprint reader, and a hook that runs after every check and just before staging, where a
// lingering agent process could still change things.
type CommitSeams = { fingerprint?: (path: string) => Promise<string>; beforeStage?: () => void | Promise<void> };

// Applied to every git call that touches the worktree: no attributes from the user's global file, and no
// descending into submodules, whose own config and info/attributes the outer checks and fingerprint never see.
const STAGE_FLAGS = ["-c", "core.attributesFile=/dev/null", "-c", "diff.ignoreSubmodules=all"];

const SUBMODULES_REFUSAL = "Refusing to commit: this repo has submodules or nested repos. Commit these changes yourself.";

// Programs a signed commit can exec. A repo-local value would run with the engine's privileges, so they are
// pinned to the user's global/system value, or git's own default.
const SIGNING_PROGRAMS: Array<[string, string]> = [
  ["gpg.program", "gpg"],
  ["gpg.openpgp.program", "gpg"],
  ["gpg.ssh.program", "ssh-keygen"],
  ["gpg.x509.program", "gpgsm"],
  ["gpg.ssh.defaultKeyCommand", ""],
];

async function signingPins(path: string): Promise<string[]> {
  const pins: string[] = [];
  for (const [key, fallback] of SIGNING_PROGRAMS) {
    const global = await git(path, ["config", "--global", "--get", key]);
    const system = global.code === 0 ? global : await git(path, ["config", "--system", "--get", key]);
    pins.push("-c", `${key}=${system.code === 0 ? system.out.replace(/\n$/, "") : fallback}`);
  }
  return pins;
}

// The baseline is the fingerprint taken before the agent ran, so a change made at any point since is caught.
// Commits whatever the agent left in the tree. Signing is left to commit.gpgsign in the user's git config:
// forcing -S would fail in repos and machines where signing isn't set up.
export async function commitAll(
  path: string,
  message: string,
  baseline: string,
  seams: CommitSeams = {},
): Promise<{ committed: boolean; files: number }> {
  const fingerprint = seams.fingerprint ?? gitSettingsFingerprint;
  const changed = () => new Error("Refusing to commit: git settings changed while committing.");
  if ((await fingerprint(path)) !== baseline) throw changed();
  await refuseFilterConfig(path);
  // Hashed rather than hardcoded so sha256 repos get their own empty tree.
  const empty = await git(path, ["hash-object", "-t", "tree", "/dev/null"]);
  if (empty.code !== 0) throw new Error(`Could not read git objects: ${empty.err.trim()}`);
  // Reading attributes from the empty tree means no .gitattributes can select a filter driver, however late
  // the agent writes one. Config checks alone can't close that window.
  const flags = [...STAGE_FLAGS, `--attr-source=${empty.out.trim()}`];
  await refuseGitlinks(path);
  const status = await git(path, [...flags, "status", "--porcelain", "-z", "--untracked-files=all", "--ignore-submodules=all"]);
  if (status.code !== 0) throw new Error(`Could not read git status: ${status.err.trim()}`);
  const entries = status.out.split("\0").filter(Boolean);
  const paths: string[] = [];
  // Rename and copy sources too: committing `.env → x.txt` would publish the secret under a new name.
  const sources: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    paths.push(entries[i]!.slice(3));
    // A rename or copy is followed by its source path as a separate entry.
    if (/^[RC]/.test(entries[i]!)) sources.push(entries[++i]!);
  }
  // Checked before staging so a refusal leaves the index untouched.
  const env = [...paths, ...sources].find(isEnvPath);
  if (env) throw new Error(`Refusing to commit a .env file: ${env}`);
  if (paths.length === 0) return { committed: false, files: 0 };
  // add would record an untracked repo as a gitlink and run git inside it.
  for (const p of paths) {
    if (p.endsWith("/") && existsSync(join(path, p, ".git"))) throw new Error(SUBMODULES_REFUSAL);
  }
  await refuseFilterAttributes(path, paths);
  await seams.beforeStage?.();
  const add = await git(path, [...flags, "add", "-A"]);
  // reset refreshes the index, which can re-run clean filters on files git can't prove unchanged, so it needs the flags too.
  if ((await fingerprint(path)) !== baseline) {
    await git(path, [...flags, "reset", "-q"]);
    throw changed();
  }
  if (add.code !== 0) throw new Error(`Could not stage changes: ${add.err.trim()}`);
  const commit = await git(path, [...flags, ...(await signingPins(path)), "commit", "-m", message]);
  if (commit.code !== 0) throw new Error(`Could not commit: ${(commit.err || commit.out).trim()}`);
  return { committed: true, files: paths.length };
}

// git runs inside a gitlink's repo during status and add, where that repo's own filters and attributes apply.
async function refuseGitlinks(path: string): Promise<void> {
  const index = await git(path, ["ls-files", "-s", "-z"]);
  if (index.code !== 0) throw new Error(`Could not list files: ${index.err.trim()}`);
  let tree = "";
  // An empty repo has no HEAD to list.
  if ((await git(path, ["rev-parse", "--verify", "--quiet", "HEAD"])).code === 0) {
    const res = await git(path, ["ls-tree", "-r", "-z", "HEAD"]);
    if (res.code !== 0) throw new Error(`Could not list files: ${res.err.trim()}`);
    tree = res.out;
  }
  if (/(^|\0)160000 /.test(index.out) || /(^|\0)160000 /.test(tree)) throw new Error(SUBMODULES_REFUSAL);
}

// Staging ignores attributes (see commitAll), so a repo that relies on filters such as LFS would get raw
// contents committed. Refusing is safer than guessing which filters are trustworthy.
const FILTERS_REFUSAL = "Refusing to commit: this repo uses git filters (e.g. LFS). Commit these changes yourself.";

async function refuseFilterAttributes(path: string, changed: string[]): Promise<void> {
  const tracked = await git(path, ["ls-files", "-z", "--", ".gitattributes", "*.gitattributes"]);
  if (tracked.code !== 0) throw new Error(`Could not list files: ${tracked.err.trim()}`);
  const files = new Set([...tracked.out.split("\0"), ...changed].filter((f) => f && f.split("/").pop() === ".gitattributes"));
  // --attr-source does not cover info/attributes, so it is the one place a filter selection can still arrive from.
  const info = await git(path, ["rev-parse", "--path-format=absolute", "--git-path", "info/attributes"]);
  if (info.code !== 0) throw new Error(`Could not read git dir: ${info.err.trim()}`);
  const full = [...[...files].map((f) => join(path, f)), info.out.trim()];
  for (const file of full) {
    if (existsSync(file) && statSync(file).isFile() && /(^|\s)filter\s*=/m.test(readFileSync(file, "utf8"))) {
      throw new Error(FILTERS_REFUSAL);
    }
  }
}

// A configured clean/smudge/process driver is a strong sign the repo expects filters, and one the agent
// planted would run during staging.
async function refuseFilterConfig(path: string): Promise<void> {
  // NUL-separated so a value containing newlines can't pass for several config entries.
  const res = await git(path, ["config", "--null", "--get-regexp", "^filter\\."]);
  // Exit 1 just means no filter is configured.
  if (res.code > 1) throw new Error(`Could not read git config: ${res.err.trim()}`);
  for (const record of res.out.split("\0").filter(Boolean)) {
    const key = record.split("\n")[0]!;
    const dot = key.lastIndexOf(".");
    const parsed = key.startsWith("filter.") && dot >= "filter.".length;
    const variable = parsed ? key.slice(dot + 1) : "";
    if (parsed && !["clean", "smudge", "process"].includes(variable)) continue;
    const name = parsed ? key.slice("filter.".length, dot) : key;
    throw new Error(
      `Refusing to commit: this repo's git config defines a "${name}" filter that would run a program during commit. Commit these changes yourself if you trust it.`,
    );
  }
}

const MISSING = "\0missing\0";

function readOrMissing(file: string): string {
  return existsSync(file) && statSync(file).isFile() ? readFileSync(file, "latin1") : MISSING;
}

// Hash of everything in the repo that can make a later git command run code or rewrite where it pushes.
export async function gitSettingsFingerprint(path: string): Promise<string> {
  // Absolute: from a subfolder, --git-common-dir is otherwise relative to the repo root, not cwd.
  const dirs = await git(path, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir", "--show-toplevel"]);
  const [gitDirPath, commonDir, top] = dirs.out.trim().split("\n");
  if (dirs.code !== 0 || !gitDirPath || !commonDir || !top) throw new Error(`Not a git repo: ${path}`);
  // Effective config catches include files, which the raw config file only points at.
  const local = await git(path, ["config", "--list", "--show-origin", "--includes", "--local"]);
  // Fails unless extensions.worktreeConfig is on; then there is no worktree config to hash.
  const worktree = await git(path, ["config", "--list", "--show-origin", "--includes", "--worktree"]);

  const hash = createHash("sha256");
  const add = (label: string, content: string) => hash.update(`${label}\0${content.length}\0${content}\0`);
  add("config --local", local.code === 0 ? local.out : MISSING);
  add("config --worktree", worktree.code === 0 ? worktree.out : MISSING);
  // A linked worktree has its own git dir, but hooks and config live in the shared common dir.
  for (const gitDir of new Set([gitDirPath, commonDir])) {
    const hooksDir = join(gitDir, "hooks");
    const hooks = existsSync(hooksDir)
      ? (readdirSync(hooksDir, { recursive: true }) as string[]).filter((f) => statSync(join(hooksDir, f)).isFile()).sort()
      : [];
    add(`${gitDir}:config`, readOrMissing(join(gitDir, "config")));
    for (const f of hooks) add(`${gitDir}:hook:${f}`, readOrMissing(join(hooksDir, f)));
    add(`${gitDir}:info/attributes`, readOrMissing(join(gitDir, "info", "attributes")));
  }
  add(".gitattributes", readOrMissing(join(top, ".gitattributes")));
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

export async function pushBranch(
  path: string,
  branch: string,
  url: string | null,
  timeoutMs = 60_000,
): Promise<{ pushed: boolean; reason?: string }> {
  if (isProtected(branch)) return { pushed: false, reason: "Refusing to push main" };
  if (!url) return { pushed: false, reason: "No remote configured" };
  const res = await git(path, ["push", url, `refs/heads/${branch}:refs/heads/${branch}`], timeoutMs);
  if (res.timedOut) return { pushed: false, reason: "The push timed out." };
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

const REVIEW_DIFF_CAP = 60 * 1024;

// Every path in the header, so a file inside a `.env.d/` folder is caught as well as `.env.local` and `prod.env`.
const touchesEnv = (header: string) => header.split(/[\s"]+/).some(isEnvPath);

// The branch's changes for a reviewer who never sees the repo. .env paths are left out twice over: by
// pathspec, and by dropping any file section whose header still names one (e.g. a `.env.d/` folder).
export type ReviewDiff = { diff: string; files: number; truncated: boolean };

export async function reviewDiff(path: string, base: string, branch: string): Promise<ReviewDiff> {
  const res = await git(path, [
    "-c", "core.quotePath=false",
    // No external diff programs or textconv filters: repo config must not run code while the engine reads a diff.
    "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-color",
    // Against the merge base, so commits made on the start branch meanwhile don't show up reversed.
    `${base}...${branch}`,
    "--", ".", ":(exclude,glob,icase)**/.env*", ":(exclude,glob,icase)**/*.env",
  ]);
  if (res.code !== 0) throw new Error(`Could not diff ${base}...${branch}: ${res.err.trim()}`);
  const sections = res.out.split(/^(?=diff --git )/m).filter((s) => s.startsWith("diff --git ") && !touchesEnv(s.split("\n")[0]!));
  const full = Buffer.from(sections.join(""));
  if (full.length <= REVIEW_DIFF_CAP) return { diff: full.toString(), files: sections.length, truncated: false };
  // Cut right at the cap, even inside a line: cutting back to a line end can throw away nearly all of a
  // change made of a few huge lines. Backing off UTF-8 continuation bytes (10xxxxxx) keeps characters whole.
  let end = REVIEW_DIFF_CAP;
  while (end > 0 && (full[end]! & 0xc0) === 0x80) end--;
  const cut = full.subarray(0, end).toString();
  const sep = cut.endsWith("\n") ? "" : "\n";
  return {
    diff: `${cut}${sep}[The rest of the diff was cut at 60 KB to keep the review short.]`,
    files: sections.length,
    truncated: true,
  };
}

// Synchronous so it can be read inside the approval transaction; null when the branch or repo is gone.
export function branchHeadSync(path: string, branch: string): string | null {
  try {
    const r = Bun.spawnSync(["git", ...SAFE, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: path });
    return r.exitCode === 0 ? r.stdout.toString().trim() : null;
  } catch {
    return null;
  }
}

// Moves a late fix's uncommitted work onto its own new branch at the current commit, so the branch Nakul
// decided on gets nothing after his decision. Null when there is nothing to move. Creating a branch at
// HEAD rewrites no files, so nothing in the tree is checked out over. A fix stopped more than once gets a
// numbered branch each time, since its earlier edits already sit on `atrium/<id>`.
export async function branchOffDirty(path: string, taskId: string): Promise<string | null> {
  const status = await git(path, ["status", "--porcelain"]);
  if (status.code !== 0) throw new Error(`Could not read git status: ${status.err.trim()}`);
  if (status.out.trim() === "") return null;
  let branch = `atrium/${taskId}`;
  for (let n = 2; (await git(path, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0; n++) {
    branch = `atrium/${taskId}-${n}`;
  }
  const valid = await git(path, ["check-ref-format", "--branch", branch]);
  if (valid.code !== 0) throw new Error(`Invalid branch name: ${branch}`);
  const res = await git(path, ["checkout", "-b", branch]);
  if (res.code !== 0) throw new Error(`Could not create ${branch}: ${res.err.trim()}`);
  return branch;
}

// A fix commit that landed just after Nakul decided: the fix keeps it on a branch of its own, and the decided
// branch goes back to `pre` only if it still points at `post` (update-ref compare-and-swap), so nothing anyone
// else put there is lost. Switching to the new branch first changes no files and frees the decided branch's ref.
export async function moveLateCommit(path: string, taskId: string, decided: string, pre: string, post: string): Promise<string> {
  const branch = `atrium/${taskId}`;
  const valid = await git(path, ["check-ref-format", "--branch", branch]);
  if (valid.code !== 0) throw new Error(`Invalid branch name: ${branch}`);
  const res = await git(path, ["checkout", "-b", branch, post]);
  if (res.code !== 0) throw new Error(`Could not create ${branch}: ${res.err.trim()}`);
  const back = await git(path, ["update-ref", `refs/heads/${decided}`, pre, post]);
  if (back.code !== 0) throw new Error(`Could not move ${decided} back to the commit you decided on: ${back.err.trim()}`);
  return branch;
}
