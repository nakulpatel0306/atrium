import { createHash } from "node:crypto";
import { constants, existsSync, promises as fsp, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type DiffFile, type DiffResult, MAX_FILE_LINES, parseDiff, totalsOf } from "./diff-parse";
import { isEnvPath } from "./envpath";

const PROTECTED = new Set(["main", "master"]);

// The agent can write inside the repo, so config it plants must never run with the engine's privileges.
const SAFE = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.sshCommand=ssh"];

export async function git(
  path: string,
  args: string[],
  timeoutMs?: number,
  opts: { env?: Record<string, string>; stdin?: Uint8Array | string } = {},
): Promise<{ code: number; out: string; err: string; timedOut: boolean }> {
  const proc = Bun.spawn(["git", ...SAFE, ...args], {
    cwd: path,
    stdin: opts.stdin === undefined ? "ignore" : typeof opts.stdin === "string" ? Buffer.from(opts.stdin) : opts.stdin,
    stdout: "pipe",
    stderr: "pipe",
    // The engine has no terminal; a credential prompt would hang the run instead of failing it.
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...opts.env },
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
  if (!existsSync(path) || !statSync(path).isDirectory()) return { ok: false, reason: `The folder ${path} doesn't exist. Check the repo folder in the space settings.` };
  const inside = await git(path, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0) return { ok: false, reason: `${path} isn't a git repo. Pick the repo's own folder in the space settings.` };
  const status = await git(path, ["status", "--porcelain"]);
  if (status.code !== 0) return { ok: false, reason: `${path} isn't a git repo. Pick the repo's own folder in the space settings.` };
  if (status.out.trim() !== "") return { ok: false, reason: `You have uncommitted changes in ${path}`, dirty: true };
  return { ok: true };
}

// The branch name, or null when HEAD is detached; sha is always the current commit.
export async function headRef(path: string): Promise<{ branch: string | null; sha: string }> {
  const name = await git(path, ["branch", "--show-current"]);
  const sha = await git(path, ["rev-parse", "HEAD"]);
  if (sha.code !== 0) throw new Error(`Couldn't read HEAD: ${sha.err.trim()}`);
  return { branch: name.out.trim() || null, sha: sha.out.trim() };
}

export async function prepareBranch(path: string, taskId: string): Promise<string> {
  if (isProtected(taskId)) throw new Error("Refusing to work on main");
  const branch = `atrium/${taskId}`;
  const valid = await git(path, ["check-ref-format", "--branch", branch]);
  if (valid.code !== 0) throw new Error(`Invalid branch name: ${branch}`);
  // checkout carries non-conflicting uncommitted changes along, which would put the user's WIP on the agent branch.
  const status = await git(path, ["status", "--porcelain"]);
  if (status.code !== 0) throw new Error(`Couldn't read git status: ${status.err.trim()}`);
  if (status.out.trim() !== "") throw new Error(`You have uncommitted changes in ${path}`);
  // A retry after a send-back reuses the existing branch. Plain checkout (never --force)
  // fails rather than overwrite local changes.
  const exists = await git(path, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  const res = await git(path, exists.code === 0 ? ["checkout", branch] : ["checkout", "-b", branch]);
  if (res.code !== 0) throw new Error(`Couldn't switch to ${branch}: ${res.err.trim()}`);
  return branch;
}

// Test seams: the fingerprint reader, and a hook that runs after every check and just before staging, where a
// lingering agent process could still change things.
type CommitSeams = { fingerprint?: (path: string) => Promise<string>; beforeStage?: () => void | Promise<void> };

// Applied to every git call that touches the worktree: no attributes from the user's global file, and no
// descending into submodules, whose own config and info/attributes the outer checks and fingerprint never see.
export const STAGE_FLAGS = ["-c", "core.attributesFile=/dev/null", "-c", "diff.ignoreSubmodules=all"];

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

export async function signingPins(path: string): Promise<string[]> {
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
  if (empty.code !== 0) throw new Error(`Couldn't read git objects: ${empty.err.trim()}`);
  // Reading attributes from the empty tree means no .gitattributes can select a filter driver, however late
  // the agent writes one. Config checks alone can't close that window.
  const flags = [...STAGE_FLAGS, `--attr-source=${empty.out.trim()}`];
  await refuseGitlinks(path);
  const status = await git(path, [...flags, "status", "--porcelain", "-z", "--untracked-files=all", "--ignore-submodules=all"]);
  if (status.code !== 0) throw new Error(`Couldn't read git status: ${status.err.trim()}`);
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
  if (add.code !== 0) throw new Error(`Couldn't stage changes: ${add.err.trim()}`);
  const commit = await git(path, [...flags, ...(await signingPins(path)), "commit", "-m", message]);
  if (commit.code !== 0) throw new Error(`Couldn't commit: ${(commit.err || commit.out).trim()}`);
  return { committed: true, files: paths.length };
}

// git runs inside a gitlink's repo during status and add, where that repo's own filters and attributes apply.
async function refuseGitlinks(path: string): Promise<void> {
  const index = await git(path, ["ls-files", "-s", "-z"]);
  if (index.code !== 0) throw new Error(`Couldn't list files: ${index.err.trim()}`);
  let tree = "";
  // An empty repo has no HEAD to list.
  if ((await git(path, ["rev-parse", "--verify", "--quiet", "HEAD"])).code === 0) {
    const res = await git(path, ["ls-tree", "-r", "-z", "HEAD"]);
    if (res.code !== 0) throw new Error(`Couldn't list files: ${res.err.trim()}`);
    tree = res.out;
  }
  if (/(^|\0)160000 /.test(index.out) || /(^|\0)160000 /.test(tree)) throw new Error(SUBMODULES_REFUSAL);
}

// Staging ignores attributes (see commitAll), so a repo that relies on filters such as LFS would get raw
// contents committed. Refusing is safer than guessing which filters are trustworthy.
const FILTERS_REFUSAL = "Refusing to commit: this repo uses git filters (e.g. LFS). Commit these changes yourself.";

async function refuseFilterAttributes(path: string, changed: string[]): Promise<void> {
  const tracked = await git(path, ["ls-files", "-z", "--", ".gitattributes", "*.gitattributes"]);
  if (tracked.code !== 0) throw new Error(`Couldn't list files: ${tracked.err.trim()}`);
  const files = new Set([...tracked.out.split("\0"), ...changed].filter((f) => f && f.split("/").pop() === ".gitattributes"));
  // --attr-source does not cover info/attributes, so it is the one place a filter selection can still arrive from.
  const info = await git(path, ["rev-parse", "--path-format=absolute", "--git-path", "info/attributes"]);
  if (info.code !== 0) throw new Error(`Couldn't read git dir: ${info.err.trim()}`);
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
  if (res.code > 1) throw new Error(`Couldn't read git config: ${res.err.trim()}`);
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
  if (dirs.code !== 0 || !gitDirPath || !commonDir || !top) throw new Error(`${path} isn't a git repo. Pick the repo's own folder in the space settings.`);
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
  // Extra git options, such as gh's credential helper.
  flags: string[] = [],
): Promise<{ pushed: boolean; reason?: string }> {
  if (isProtected(branch)) return { pushed: false, reason: "Refusing to push main" };
  if (!url) return { pushed: false, reason: "No remote configured" };
  const res = await git(path, [...flags, "push", url, `refs/heads/${branch}:refs/heads/${branch}`], timeoutMs);
  if (res.timedOut) return { pushed: false, reason: "The push timed out." };
  if (res.code !== 0) return { pushed: false, reason: res.err.trim() };
  return { pushed: true };
}

// Pushes one approved commit from a throwaway bare repo that borrows the repo's objects, so nothing in the repo's own
// config (insteadOf rewrites, include files, askpass, proxies, protocol settings the agent could have written) is
// read during the push. Only https and ssh transports are allowed, and no askpass program runs.
export async function pushApprovedSha(
  path: string,
  sha: string,
  branch: string,
  url: string,
  opts: { flags?: string[]; timeoutMs?: number } = {},
): Promise<{ pushed: boolean; reason?: string }> {
  if (isProtected(branch)) return { pushed: false, reason: "Refusing to push main" };
  const objects = await git(path, ["rev-parse", "--path-format=absolute", "--git-path", "objects"]);
  if (objects.code !== 0) return { pushed: false, reason: `Couldn't read git dir: ${objects.err.trim()}` };
  const dir = mkdtempSync(join(tmpdir(), "atrium-push-"));
  try {
    const bare = join(dir, "push.git");
    const init = await git(dir, ["init", "-q", "--bare", bare]);
    if (init.code !== 0) return { pushed: false, reason: `Couldn't prepare the push: ${init.err.trim()}` };
    writeFileSync(join(bare, "objects", "info", "alternates"), `${objects.out.trim()}\n`);
    const isolated = ["--git-dir", bare];
    const ref = await git(dir, [...isolated, "update-ref", `refs/heads/${branch}`, sha]);
    if (ref.code !== 0) return { pushed: false, reason: `Couldn't prepare the push: ${ref.err.trim()}` };
    const transport = ["-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "protocol.ssh.allow=always", "-c", "core.askPass="];
    const res = await git(dir, [...isolated, ...transport, ...(opts.flags ?? []), "push", url, `${sha}:refs/heads/${branch}`], opts.timeoutMs ?? 60_000);
    if (res.timedOut) return { pushed: false, reason: "The push timed out." };
    if (res.code !== 0) return { pushed: false, reason: res.err.trim() };
    return { pushed: true };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Plain checkout (never --force); a dirty tree is reported rather than carried along.
export async function returnToBranch(path: string, ref: string): Promise<"ok" | "dirty"> {
  const status = await git(path, ["status", "--porcelain"]);
  if (status.code !== 0) throw new Error(`Couldn't read git status: ${status.err.trim()}`);
  if (status.out.trim() !== "") return "dirty";
  const res = await git(path, ["checkout", ref]);
  if (res.code !== 0) throw new Error(`Couldn't switch back to ${ref}: ${res.err.trim()}`);
  return "ok";
}

export async function branchSummary(
  path: string,
  branch: string,
  base: string,
): Promise<{ commits: number; filesChanged: number; insertions: number; deletions: number }> {
  const count = await git(path, ["rev-list", "--count", `${base}..${branch}`]);
  const stat = await git(path, ["diff", "--shortstat", `${base}...${branch}`]);
  if (count.code !== 0) throw new Error(`Couldn't count commits: ${count.err.trim()}`);
  if (stat.code !== 0) throw new Error(`Couldn't diff ${base}...${branch}: ${stat.err.trim()}`);
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
  if (res.code !== 0) throw new Error(`Couldn't diff ${base}...${branch}: ${res.err.trim()}`);
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

// Modes are git's octal file modes ("100644" plain, "100755" executable, "120000" symlink, "160000" gitlink);
// "000000" is the missing side of an add or delete.
export type ChangedFile = {
  path: string;
  status: "A" | "M" | "D" | "T";
  added: number | null;
  deleted: number | null;
  oldMode: string;
  newMode: string;
};

// Every file the branch changed, for deciding what kind of result it is. Unlike reviewDiff, .env paths stay in:
// the always-ask check has to see them. Renames show as a delete plus an add, so moving a file counts as deleting one.
export async function changedFiles(path: string, base: string, branch: string): Promise<ChangedFile[]> {
  // Submodules always show, whatever the repo's config says, so a gitlink is seen and refused.
  const flags = [
    "-c", "core.quotePath=false", "-c", "diff.ignoreSubmodules=none",
    "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-color", "--ignore-submodules=none",
  ];
  const names = await git(path, [...flags, "--raw", "-z", `${base}...${branch}`, "--"]);
  if (names.code !== 0) throw new Error(`Couldn't diff ${base}...${branch}: ${names.err.trim()}`);
  const nums = await git(path, [...flags, "--numstat", "-z", `${base}...${branch}`, "--"]);
  if (nums.code !== 0) throw new Error(`Couldn't diff ${base}...${branch}: ${nums.err.trim()}`);
  const counts = new Map<string, { added: number | null; deleted: number | null }>();
  for (const record of nums.out.split("\0").filter(Boolean)) {
    const [added, deleted, ...rest] = record.split("\t");
    // git prints "-" for both counts of a binary file.
    counts.set(rest.join("\t"), { added: added === "-" ? null : Number(added), deleted: deleted === "-" ? null : Number(deleted) });
  }
  // Each record is ":<old mode> <new mode> <old sha> <new sha> <status>" followed by the path.
  const fields = names.out.split("\0");
  const files: ChangedFile[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [oldMode, newMode, , , status] = fields[i]!.slice(1).split(" ");
    const file = fields[i + 1]!;
    files.push({
      path: file,
      status: status as ChangedFile["status"],
      ...(counts.get(file) ?? { added: null, deleted: null }),
      oldMode: oldMode!,
      newMode: newMode!,
    });
  }
  return files;
}

export type BranchFile = { path: string; change: "created" | "changed" | "deleted"; insertions: number | null; deletions: number | null };

// What a task branch changed, for showing Nakul what it made. .env paths are left out: Atrium never shows them.
export async function branchFiles(path: string, base: string, branch: string): Promise<BranchFile[]> {
  const flags = ["-c", "core.quotePath=false", "diff", "--no-renames", "--no-ext-diff", "--no-textconv", "-z"];
  const range = `${base}...${branch}`;
  const names = await git(path, [...flags, "--name-status", range, "--"]);
  if (names.code !== 0) throw new Error(`Couldn't list the files on ${branch}: ${firstLine(names.err)}`);
  const nums = await git(path, [...flags, "--numstat", range, "--"]);
  if (nums.code !== 0) throw new Error(`Couldn't list the files on ${branch}: ${firstLine(nums.err)}`);
  const counts = new Map<string, [number | null, number | null]>();
  for (const record of nums.out.split("\0").filter(Boolean)) {
    const [added, deleted, ...rest] = record.split("\t");
    counts.set(rest.join("\t"), [added === "-" ? null : Number(added), deleted === "-" ? null : Number(deleted)]);
  }
  const CHANGE: Record<string, BranchFile["change"]> = { A: "created", M: "changed", T: "changed", D: "deleted" };
  const fields = names.out.split("\0");
  const files: BranchFile[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const change = CHANGE[fields[i]!];
    const file = fields[i + 1]!;
    if (!change || isEnvPath(file)) continue;
    const [insertions, deletions] = counts.get(file) ?? [null, null];
    files.push({ path: file, change, insertions, deletions });
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// One file from a branch without checking it out. Its bytes are read only when it fits the cap.
export async function showBlob(path: string, ref: string, file: string, capBytes: number): Promise<{ size: number; bytes: Uint8Array | null }> {
  if (isEnvPath(file)) throw new Error("Atrium never shows .env files.");
  const spec = `${ref}:${file}`;
  const size = await git(path, ["cat-file", "-s", spec]);
  if (size.code !== 0) throw new Error(`Couldn't read ${file} on ${ref}: ${firstLine(size.err)}`);
  const n = Number(size.out.trim());
  if (n > capBytes) return { size: n, bytes: null };
  const proc = Bun.spawn(["git", ...SAFE, "cat-file", "blob", spec], { cwd: path, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const bytes = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
  if ((await proc.exited) !== 0) throw new Error(`Couldn't read ${file} on ${ref}.`);
  return { size: n, bytes };
}

const firstLine = (text: string) => text.trim().split("\n")[0] ?? "";

// For output that can be huge (a diff of a 3 MB line): stops reading at `cap` bytes and says so.
async function gitCapped(path: string, args: string[], cap: number, env: Record<string, string> = {}): Promise<{ out: string; truncated: boolean }> {
  const proc = Bun.spawn(["git", ...SAFE, ...args], { cwd: path, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env } });
  const err = new Response(proc.stderr).text();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  const reader = proc.stdout.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
    if (total > cap) {
      truncated = true;
      proc.kill();
      break;
    }
  }
  const code = await proc.exited;
  if (!truncated && code !== 0) throw new Error(`git ${args[0]} failed: ${(await err).trim()}`);
  return { out: Buffer.concat(chunks).subarray(0, cap).toString(), truncated };
}

// The commit a branch points at, or null when the branch is gone.
export async function branchSha(path: string, branch: string): Promise<string | null> {
  const res = await git(path, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  return res.code === 0 ? res.out.trim() : null;
}

const PATCH_READ_CAP = 256 * 1024;

// Files in the working tree that git doesn't track: untracked and ignored ones, never the dependency folders
// (agents can't write them, and listing an installed node_modules would take long).
export async function outsideGit(path: string): Promise<string[]> {
  const exclude = ["node_modules", ".venv"].flatMap((d) => [`:(exclude,glob)${d}/**`, `:(exclude,glob)**/${d}/**`]);
  const res = await git(path, ["-c", "core.quotePath=false", "status", "--porcelain=v1", "-z", "--ignored=traditional", "--untracked-files=all", "--", ".", ...exclude]);
  if (res.code !== 0) throw new Error(`Couldn't read git status: ${firstLine(res.err)}`);
  return res.out
    .split("\0")
    .filter((rec) => rec.startsWith("?? ") || rec.startsWith("!! "))
    .map((rec) => rec.slice(3));
}

// The text a change adds, and how many bytes it adds and removes, read from a zero-context diff. A diff too big to
// read in full reports more bytes than the cap, which is all a caller deciding "small enough?" needs.
export async function changedText(path: string, base: string, sha: string): Promise<{ added: string[]; bytes: number }> {
  const res = await gitCapped(
    path,
    [
      "-c", "core.quotePath=false", "-c", "diff.ignoreSubmodules=none",
      "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-color", "-U0", `${base}...${sha}`, "--",
    ],
    PATCH_READ_CAP,
  );
  const added: string[] = [];
  let bytes = 0;
  let inHunk = false;
  for (const line of res.out.split("\n")) {
    if (line.startsWith("diff --git ")) inHunk = false;
    else if (line.startsWith("@@")) inHunk = true;
    else if (inHunk && (line.startsWith("+") || line.startsWith("-"))) {
      bytes += Buffer.byteLength(line) - 1;
      if (line.startsWith("+")) added.push(line.slice(1));
    }
  }
  return { added, bytes: res.truncated ? Math.max(bytes, PATCH_READ_CAP + 1) : bytes };
}

// Every entry in a commit's tree with its git mode ("100644" plain, "120000" symlink, "160000" gitlink…).
export async function treeEntries(path: string, sha: string): Promise<{ path: string; mode: string }[]> {
  const res = await git(path, ["-c", "core.quotePath=false", "ls-tree", "-r", "-z", sha]);
  if (res.code !== 0) throw new Error(`Couldn't list files at ${sha}: ${res.err.trim()}`);
  return res.out
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const tab = record.indexOf("\t");
      return { path: record.slice(tab + 1), mode: record.slice(0, record.indexOf(" ")) };
    });
}

// One file's contents at a commit, cut at `cap` bytes; `truncated` says it was cut.
export async function fileAt(path: string, sha: string, file: string, cap = 64 * 1024): Promise<{ text: string; truncated: boolean }> {
  const res = await gitCapped(path, ["cat-file", "blob", `${sha}:${file}`], cap);
  return { text: res.out, truncated: res.truncated };
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

// A detached checkout of `sha` in a folder of its own, where Atrium's checks run, so nothing they or the engine's
// install do reaches the user's checkout. Attributes come from the empty tree, so no checkout filter runs.
export async function addCheckTree(path: string, sha: string, dir: string): Promise<void> {
  const empty = await git(path, ["hash-object", "-t", "tree", "/dev/null"]);
  if (empty.code !== 0) throw new Error(`Couldn't read git objects: ${empty.err.trim()}`);
  const res = await git(path, [...STAGE_FLAGS, `--attr-source=${empty.out.trim()}`, "worktree", "add", "--detach", "--quiet", dir, sha]);
  if (res.code !== 0) throw new Error(`Couldn't check out ${sha.slice(0, 8)} for the checks: ${res.err.trim()}`);
}

// Removes the folder and git's record of it, whatever the checks left there.
export async function removeCheckTree(path: string, dir: string): Promise<void> {
  const res = await git(path, ["worktree", "remove", "--force", dir]);
  if (res.code !== 0) rmSync(dir, { recursive: true, force: true });
  await git(path, ["worktree", "prune"]);
}

const CHANGES_CAP = 200 * 1024;
const ENV_EXCLUDES = ["--", ".", ":(exclude,glob,icase)**/.env*", ":(exclude,glob,icase)**/*.env"];
// Only ever between two trees: git reads no working tree, so no clean filter, whatever the repo's config or
// attributes say, has anything to run on. No external diff programs or textconv filters either, and attributes come
// from the empty tree.
async function diffFlags(path: string): Promise<string[]> {
  const empty = await git(path, ["hash-object", "-t", "tree", "/dev/null"]);
  if (empty.code !== 0) throw new Error(`Couldn't read git objects: ${empty.err.trim()}`);
  return [
    "-c", "core.quotePath=false", ...STAGE_FLAGS, `--attr-source=${empty.out.trim()}`,
    // Fixed prefixes: a user's diff.mnemonicPrefix or diff.noPrefix would change what the parser reads.
    "diff", "--no-ext-diff", "--no-textconv", "--no-color", "-M", "--src-prefix=a/", "--dst-prefix=b/",
  ];
}

// .env files are left out by pathspec, and again by header, as in reviewDiff (that covers both sides of a rename).
function parseCapped(res: { out: string; truncated: boolean }): DiffResult {
  const kept = res.out.split(/^(?=diff --git )/m).filter((s) => s.startsWith("diff --git ") && !touchesEnv(s.split("\n").slice(0, 4).join(" ")));
  const files = parseDiff(kept.join(""));
  if (res.truncated && files.length) files[files.length - 1]!.truncated = true;
  return { files, totals: totalsOf(files), truncated: res.truncated };
}

// A finished task's changes, from its branch's commits against where the work started.
export async function branchDiff(path: string, base: string, branch: string): Promise<DiffResult> {
  return parseCapped(await gitCapped(path, [...(await diffFlags(path)), `${base}...${branch}`, ...ENV_EXCLUDES], CHANGES_CAP));
}

// What a running agent has changed so far, against `start`: every file git knows (committed on the branch, or
// staged) as it is on disk now, plus new files it hasn't added (they're shown as additions). Every file is read by
// Atrium itself, never through a symlink, and git only ever compares trees.
// `hashBudget` is a test seam for the most bytes read in one look.
export async function workingDiff(path: string, start: string, opts: { hashBudget?: number } = {}): Promise<DiffResult> {
  const flags = await diffFlags(path);
  const snap = await withWorktreeTree(path, opts.hashBudget ?? HASH_TOTAL, (tree, env) => gitCapped(path, [...flags, start, tree, ...ENV_EXCLUDES], CHANGES_CAP, env));
  const changes = parseCapped(snap.value);
  const files = [...changes.files];
  // A file Atrium couldn't read, or that's too large and a different size, is listed as changed with a note.
  for (const u of snap.unknown) {
    if (isEnvPath(u.path)) continue;
    files.push({ path: u.path, status: u.added ? "added" : "modified", additions: 0, deletions: 0, binary: false, truncated: true, hunks: [], note: u.note });
  }
  const list = await git(path, ["-c", "core.quotePath=false", ...STAGE_FLAGS, "ls-files", "-z", "--others", "--exclude-standard"]);
  if (list.code !== 0) throw new Error(`Couldn't list new files: ${list.err.trim()}`);
  let budget = CHANGES_CAP - files.reduce((n, f) => n + f.hunks.reduce((m, h) => m + h.lines.reduce((k, l) => k + l.text.length + 1, 0), 0), 0);
  let truncated = changes.truncated;
  // A nested repo shows as "dir/"; its contents are its own repo's business. A file taken out of the index but still
  // on the branch is already in the snapshot.
  const top = await fsp.realpath(path);
  for (const rel of list.out.split("\0").filter((p) => p && !p.endsWith("/") && !isEnvPath(p) && !snap.paths.has(p)).sort()) {
    const found = await untrackedFile(path, rel, Math.max(budget, 0), top);
    if (!found) continue;
    const { file, cut } = found;
    if (cut) truncated = true;
    budget -= file.hunks[0]?.lines.reduce((k, l) => k + l.text.length + 1, 0) ?? 0;
    files.push(file);
  }
  const unchecked = snap.unchecked.filter((u) => !isEnvPath(u.path));
  return { files, totals: totalsOf(files), truncated, ...(unchecked.length ? { unchecked } : {}) };
}

// A file bigger than this is never read, and no more than HASH_TOTAL is read in all for one look at the changes. A
// file left unread is never taken as unchanged: see withWorktreeTree.
const HASH_CAP = 10 * 1024 * 1024;
const HASH_TOTAL = 50 * 1024 * 1024;

type Opened = { kind: "fd"; fh: FileHandle } | { kind: "link"; target: string } | { kind: "gone" } | { kind: "unreadable" };

// One path in the repo, opened without following a symlink or blocking on a FIFO, and only while its folder still
// resolves inside the repo (`top`, the repo's own real path). Async throughout, so a big repo never stalls the engine.
async function openRepoFile(top: string, root: string, rel: string): Promise<Opened> {
  const abs = join(root, rel);
  try {
    const dir = await fsp.realpath(dirname(abs));
    if (dir !== top && !dir.startsWith(`${top}/`)) return { kind: "gone" };
  } catch {
    return { kind: "gone" };
  }
  try {
    return { kind: "fd", fh: await fsp.open(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "gone" };
    if (code !== "ELOOP") return { kind: "unreadable" };
    try {
      return { kind: "link", target: await fsp.readlink(abs) };
    } catch {
      return { kind: "gone" };
    }
  }
}

async function readFh(fh: FileHandle, length: number): Promise<Buffer> {
  const out = Buffer.alloc(length);
  let pos = 0;
  while (pos < length) {
    const { bytesRead } = await fh.read(out, pos, length - pos, pos);
    if (bytesRead === 0) break;
    pos += bytesRead;
  }
  return out.subarray(0, pos);
}

type Hashed =
  | { kind: "file"; id: string; mode: string; bytes: Buffer }
  | { kind: "large"; size: number }
  | { kind: "budget" }
  | { kind: "gone" }
  | { kind: "unreadable" };

const blobId = (format: "sha1" | "sha256", bytes: Buffer) => createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

// A file's blob id as git would store it with no filters, worked out from the bytes on disk every time, whatever the
// index's flags or the file's times say. One over the cap, or past what's left of `budget`, isn't read.
async function hashRepoFile(top: string, root: string, rel: string, format: "sha1" | "sha256", budget: { left: number }): Promise<Hashed> {
  const opened = await openRepoFile(top, root, rel);
  if (opened.kind === "link") {
    const bytes = Buffer.from(opened.target);
    return { kind: "file", id: blobId(format, bytes), mode: "120000", bytes };
  }
  if (opened.kind !== "fd") return opened;
  const { fh } = opened;
  try {
    const st = await fh.stat();
    // A folder or FIFO where a file was is, as far as the file goes, gone.
    if (!st.isFile()) return { kind: "gone" };
    if (st.size > HASH_CAP) return { kind: "large", size: st.size };
    if (st.size > budget.left) return { kind: "budget" };
    budget.left -= st.size;
    const bytes = await readFh(fh, st.size);
    // It changed size while being read; whatever it is now, it isn't what was hashed.
    if (bytes.length !== st.size) return { kind: "unreadable" };
    return { kind: "file", id: blobId(format, bytes), mode: (st.mode & 0o111) !== 0 ? "100755" : "100644", bytes };
  } catch {
    return { kind: "unreadable" };
  } finally {
    await fh.close();
  }
}

type Snapshot<T> = {
  value: T;
  paths: Set<string>;
  unknown: { path: string; note: string; added: boolean }[];
  unchecked: { path: string; note: string }[];
};

const TOO_LARGE = "Too large to show. Open the file in your editor to see what changed.";
const UNREADABLE = "Atrium couldn't read this file, so it may have changed.";
const TOO_LARGE_TO_CHECK = "Too large to check";
const PAST_BUDGET = "Not checked: too much to scan";

// The working tree as a git tree, built without git ever reading it: Atrium reads each file git knows (on HEAD or
// staged) itself, hashes it as is, and writes only the changed ones as blobs, into a temporary object folder (the
// repo's own objects are an alternate, so nothing is added to the repo) and a temporary index. `use` gets the tree
// and the environment that can see it.
async function withWorktreeTree<T>(path: string, hashBudget: number, use: (tree: string, env: Record<string, string>) => Promise<T>): Promise<Snapshot<T>> {
  const format = (await git(path, ["rev-parse", "--show-object-format"])).out.trim() === "sha256" ? "sha256" : "sha1";
  const objects = await git(path, ["rev-parse", "--path-format=absolute", "--git-path", "objects"]);
  if (objects.code !== 0) throw new Error(`Couldn't read git dir: ${objects.err.trim()}`);
  const head = await git(path, ["-c", "core.quotePath=false", "ls-tree", "-r", "-l", "-z", "--full-tree", "HEAD"]);
  if (head.code !== 0) throw new Error(`Couldn't list files at HEAD: ${head.err.trim()}`);
  const staged = await git(path, ["-c", "core.quotePath=false", "ls-files", "-s", "-z"]);
  if (staged.code !== 0) throw new Error(`Couldn't list staged files: ${staged.err.trim()}`);
  // Path → HEAD's entry (null when only the index has it). Gitlinks are other repos' business.
  const known = new Map<string, { mode: string; id: string; size: number } | null>();
  for (const record of head.out.split("\0").filter(Boolean)) {
    const tab = record.indexOf("\t");
    const [mode, type, id, size] = record.slice(0, tab).split(/ +/) as [string, string, string, string];
    if (type === "blob") known.set(record.slice(tab + 1), { mode, id, size: Number(size) });
  }
  for (const record of staged.out.split("\0").filter(Boolean)) {
    const tab = record.indexOf("\t");
    const rel = record.slice(tab + 1);
    if (!record.startsWith("160000 ") && !known.has(rel)) known.set(rel, null);
  }

  const updates: { mode: string; id: string | null; path: string; bytes: Buffer | null }[] = [];
  const unknown: Snapshot<T>["unknown"] = [];
  const unchecked: Snapshot<T>["unchecked"] = [];
  const budget = { left: hashBudget };
  const top = await fsp.realpath(path);
  for (const [rel, entry] of known) {
    const f = await hashRepoFile(top, path, rel, format, budget);
    if (f.kind === "unreadable") {
      unknown.push({ path: rel, note: UNREADABLE, added: entry === null });
      continue;
    }
    // Past the budget, a file can't be vouched for, so it's listed as changed.
    if (f.kind === "budget") {
      unknown.push({ path: rel, note: PAST_BUDGET, added: entry === null });
      continue;
    }
    // Over the cap: a different size from HEAD's is certainly a change; the same size can't be told apart, so it's
    // listed on its own as not checked.
    if (f.kind === "large") {
      if (entry && entry.size === f.size) unchecked.push({ path: rel, note: TOO_LARGE_TO_CHECK });
      else unknown.push({ path: rel, note: TOO_LARGE, added: entry === null });
      continue;
    }
    if (f.kind === "gone") {
      if (entry) updates.push({ mode: entry.mode, id: null, path: rel, bytes: null });
      continue;
    }
    if (entry && entry.id === f.id && entry.mode === f.mode) continue;
    updates.push({ mode: f.mode, id: f.id, path: rel, bytes: f.bytes });
  }
  const paths = new Set(known.keys());
  if (updates.length === 0) return { value: await use("HEAD^{tree}", {}), paths, unknown, unchecked };

  const dir = mkdtempSync(join(tmpdir(), "atrium-diff-"));
  try {
    mkdirSync(join(dir, "objects"));
    const env = { GIT_OBJECT_DIRECTORY: join(dir, "objects"), GIT_ALTERNATE_OBJECT_DIRECTORIES: objects.out.trim(), GIT_INDEX_FILE: join(dir, "index") };
    const zeros = "0".repeat(format === "sha256" ? 64 : 40);
    // The bytes Atrium read go into files of its own, and one git call stores them all. --no-filters keeps them
    // exactly as read; git only ever opens these copies, never the repo's files.
    const written = updates.filter((u) => u.id !== null);
    await fsp.mkdir(join(dir, "blobs"));
    const copies = await Promise.all(written.map(async (u, i) => (await fsp.writeFile(join(dir, "blobs", String(i)), u.bytes!), join(dir, "blobs", String(i)))));
    const ids = written.length
      ? await git(path, ["hash-object", "-w", "--no-filters", "--stdin-paths"], undefined, { env, stdin: copies.map((c) => `${c}\n`).join("") })
      : null;
    if (ids && ids.code !== 0) throw new Error(`Couldn't read the changed files: ${ids.err.trim()}`);
    const stored = ids?.out.trim().split("\n") ?? [];
    if (stored.length !== written.length) throw new Error("Couldn't read the changed files: git stored a different number of them.");
    const lines = [
      ...updates.filter((u) => u.id === null).map((u) => `0 ${zeros}\t${u.path}`),
      ...written.map((u, i) => `${u.mode} ${stored[i]}\t${u.path}`),
    ];
    const read = await git(path, ["read-tree", "HEAD"], undefined, { env });
    if (read.code !== 0) throw new Error(`Couldn't read HEAD: ${read.err.trim()}`);
    const info = await git(path, ["update-index", "-z", "--index-info"], undefined, { env, stdin: lines.map((l) => `${l}\0`).join("") });
    if (info.code !== 0) throw new Error(`Couldn't list the changed files: ${info.err.trim()}`);
    const tree = await git(path, ["write-tree"], undefined, { env });
    if (tree.code !== 0) throw new Error(`Couldn't read the changed files: ${tree.err.trim()}`);
    return { value: await use(tree.out.trim(), env), paths, unknown, unchecked };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// `cut` says the file was shortened to fit what's left of the 200 KB, rather than at its own 2,000 lines. `top` is
// the repo's real path, when the caller already has it.
export async function untrackedFile(root: string, rel: string, budget: number, top?: string): Promise<{ file: DiffFile; cut: boolean } | null> {
  const file: DiffFile = { path: rel, status: "added", additions: 0, deletions: 0, binary: false, truncated: false, hunks: [] };
  const opened = await openRepoFile(top ?? (await fsp.realpath(root)), root, rel);
  if (opened.kind === "gone") return null;
  if (opened.kind === "unreadable") return { file: { ...file, truncated: true, note: UNREADABLE }, cut: false };
  // git shows a symlink as one line holding its target, which is what it would commit; nothing behind it is read.
  if (opened.kind === "link") {
    file.additions = 1;
    file.hunks = [{ header: "@@ -0,0 +1 @@", lines: [{ kind: "add", text: opened.target, newNo: 1 }] }];
    return { file, cut: false };
  }
  let bytes: Buffer;
  let size: number;
  try {
    const st = await opened.fh.stat();
    if (!st.isFile()) return null;
    size = st.size;
    bytes = await readFh(opened.fh, Math.min(size, budget));
  } finally {
    await opened.fh.close();
  }
  if (bytes.subarray(0, 8000).includes(0)) {
    file.binary = true;
    return { file, cut: false };
  }
  const cut = bytes.length < size;
  if (cut) file.truncated = true;
  const lines = bytes.toString().split("\n");
  if (lines.at(-1) === "") lines.pop();
  file.additions = lines.length;
  if (lines.length > MAX_FILE_LINES) file.truncated = true;
  const shown = lines.slice(0, MAX_FILE_LINES);
  if (shown.length) {
    file.hunks = [{ header: `@@ -0,0 +1,${lines.length} @@`, lines: shown.map((t, i) => ({ kind: "add" as const, text: t, newNo: i + 1 })) }];
  }
  return { file, cut };
}
