import type { Database } from "bun:sqlite";
import { lstatSync, rmSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { type Approval, createApproval, getApproval, isOwnYes } from "../approvals";
import { bus, logActivity } from "../events";
import { git, STAGE_FLAGS } from "../git";
import { isEnvPath } from "../envpath";
import { newId } from "../ids";
import { getSpace, listSpaces, setSpaceRepo, type Space } from "../spaces";
import { listTasks } from "../tasks";
import { bytes, plural } from "../text";
import { fetchOrigin } from "./gitops";
import { tildePath } from "./names";
import { getClone, getRepoAction, listClones, markRemoved, type RepoAction, setActionStatus } from "./store";

export const CLONE_IDLE_MS = 14 * 86_400_000;
export const DECLINE_QUIET_MS = 30 * 86_400_000;
// Ignored folders a build or install recreates; anything else ignored might be the only copy of something.
export const BUILD_OUTPUT = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  ".cache",
  ".next",
  ".turbo",
  ".vite",
  ".parcel-cache",
  ".svelte-kit",
  "coverage",
  "target",
  "__pycache__",
  ".pytest_cache",
]);
const IGNORED_JUNK = ".DS_Store";
const WALK_LIMIT = 50_000;
const NOT_OURS = "Atrium didn't create this folder, so it never removes it.";

const first3 = (paths: string[]) => paths.slice(0, 3).join(", ");

// Sizes the folder without following symlinks, so a link can't make it count (or reach) anything outside.
export async function dirBytes(path: string): Promise<number> {
  let total = 0;
  const stack = [path];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else {
        try {
          total += (await lstat(p)).size;
        } catch {
          // Gone since the listing.
        }
      }
    }
  }
  return total;
}

// Looks for .env files inside an ignored build folder; null when there are too many entries to be sure.
async function envInside(root: string, rel: string): Promise<{ env: string | null } | null> {
  let seen = 0;
  const stack = [rel];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(join(root, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (++seen > WALK_LIMIT) return null;
      const p = `${dir.replace(/\/$/, "")}/${e.name}`;
      if (isEnvPath(p)) return { env: p };
      if (e.isDirectory()) stack.push(p);
    }
  }
  return { env: null };
}

// Any space can point at a folder Atrium cloned for another one, so every space using it counts.
const spacesUsing = (db: Database, path: string): Space[] =>
  listSpaces(db, { includeArchived: true }).filter((s) => s.repoPath === path);

// Every reason the folder can't go, all collected, from a fresh look at disk and GitHub.
export async function checkRemovable(db: Database, cloneId: string): Promise<{ ok: true; bytes: number } | { ok: false; reasons: string[] }> {
  const clone = getClone(db, cloneId);
  if (clone?.status !== "present") return { ok: false, reasons: [NOT_OURS] };
  try {
    const st = lstatSync(join(clone.path, ".git"));
    if (!st.isDirectory() || st.dev !== clone.gitDev || st.ino !== clone.gitIno) return { ok: false, reasons: [NOT_OURS] };
  } catch {
    return { ok: false, reasons: [NOT_OURS] };
  }
  const path = clone.path;
  const reasons: string[] = [];
  for (const space of spacesUsing(db, path)) {
    if (listTasks(db, { spaceId: space.id, status: ["queued", "running"] }).length > 0) reasons.push(`A task is queued or running in ${space.name}.`);
  }
  const empty = (await git(path, ["hash-object", "-t", "tree", "/dev/null"])).out.trim();
  const status = await git(path, [
    ...STAGE_FLAGS,
    `--attr-source=${empty}`,
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--ignored=matching",
    "--ignore-submodules=none",
  ]);
  if (status.code !== 0) return { ok: false, reasons: [...reasons, `Couldn't read git status: ${status.err.trim()}`] };
  const entries = status.out.split("\0").filter(Boolean);
  let changed = false;
  const untracked: string[] = [];
  const ignored: string[] = [];
  const envs: string[] = [];
  const buildDirs: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const code = entries[i]!.slice(0, 2);
    const p = entries[i]!.slice(3);
    if (/^[RC]/.test(code)) i++;
    if (code !== "??" && code !== "!!") {
      changed = true;
      continue;
    }
    if (isEnvPath(p)) {
      envs.push(p);
      continue;
    }
    if (code === "??") {
      untracked.push(p);
      continue;
    }
    const top = p.split("/")[0]!;
    const name = p.replace(/\/$/, "").split("/").pop()!;
    if (BUILD_OUTPUT.has(top)) {
      // node_modules is full of packages' own .env fixtures and is always reinstalled, so it isn't walked.
      if (top !== "node_modules") buildDirs.push(p);
    } else if (name !== IGNORED_JUNK) ignored.push(p);
  }
  for (const dir of buildDirs) {
    const found = await envInside(path, dir);
    if (!found) reasons.push(`Too many files to check in ${dir}.`);
    else if (found.env) envs.push(found.env);
  }
  if (changed) reasons.push("There are uncommitted changes.");
  if (untracked.length > 0) reasons.push(`There are files git doesn't track: ${first3(untracked)}.`);
  if (ignored.length > 0) reasons.push(`There are ignored files that aren't build output: ${first3(ignored)}.`);
  for (const env of envs) reasons.push(`There's a .env file: ${env}.`);
  if ((await git(path, ["stash", "list"])).out.trim()) reasons.push("There are stashed changes.");
  const trees = (await git(path, ["worktree", "list", "--porcelain"])).out.split("\n").filter((l) => l.startsWith("worktree "));
  if (trees.length > 1) reasons.push("There are extra worktrees.");
  const fetched = await fetchOrigin(path);
  if (!fetched.ok) reasons.push("Couldn't reach GitHub to confirm everything is pushed.");
  else {
    // One walk over every local branch, every tag and HEAD: naming refs one by one lets an ambiguous name (a local
    // branch called "origin/main") resolve to the wrong ref and hide its commits.
    const res = await git(path, ["rev-list", "--count", "--branches", "--tags", "HEAD", "--not", "--remotes=origin"]);
    const n = res.code === 0 && /^\d+$/.test(res.out.trim()) ? Number(res.out.trim()) : null;
    if (n === null) reasons.push("Couldn't confirm every commit is on GitHub.");
    else if (n > 0) reasons.push(`${plural(n, "commit")} on local branches, tags or the checked-out commit ${n === 1 ? "isn't" : "aren't"} on GitHub.`);
  }
  if (reasons.length > 0) return { ok: false, reasons };
  return { ok: true, bytes: await dirBytes(path) };
}

const pendingRemoval = (db: Database, cloneId: string): Approval | null => {
  const row = db
    .query(
      `SELECT a.id FROM repo_actions r JOIN approvals a ON a.id = r.approval_id
       WHERE r.kind = 'remove' AND r.clone_id = ? AND r.status = 'draft' AND a.status = 'pending'`,
    )
    .get(cloneId) as { id: string } | null;
  return row ? getApproval(db, row.id) : null;
};

export const pendingRemovalId = (db: Database, cloneId: string): string | null => pendingRemoval(db, cloneId)?.id ?? null;

export async function askToRemove(db: Database, cloneId: string): Promise<{ approval: Approval } | { reasons: string[] }> {
  const open = pendingRemoval(db, cloneId);
  if (open) return { approval: open };
  const check = await checkRemovable(db, cloneId);
  if (!check.ok) return { reasons: check.reasons };
  const clone = getClone(db, cloneId)!;
  const approval = db.transaction(() => {
    const a = createApproval(db, {
      spaceId: null,
      kind: "question",
      title: `Remove the local copy of ${clone.github}?`,
      detail: `${tildePath(clone.path)} · ${bytes(check.bytes)}. Everything is committed and on GitHub, so nothing is lost: GitHub keeps the repo, and Atrium clones it again if a task needs it.`,
      alwaysAsk: "remove_clone",
    });
    const now = Date.now();
    db.query(
      "INSERT INTO repo_actions (id, kind, status, approval_id, clone_id, space_id, created_at, updated_at) VALUES (?, 'remove', 'draft', ?, ?, ?, ?, ?)",
    ).run(newId("rpa"), a.id, cloneId, clone.spaceId, now, now);
    return a;
  })();
  bus.emit({ type: "changed" });
  return { approval };
}

// Refusals stay silent here: the storage view shows why a folder is kept.
export async function scanIdleClones(db: Database, now: number): Promise<number> {
  let made = 0;
  for (const clone of listClones(db)) {
    if (clone.status !== "present" || pendingRemoval(db, clone.id)) continue;
    const space = clone.spaceId ? getSpace(db, clone.spaceId) : null;
    if (now - Math.max(clone.lastUsedAt, space?.updatedAt ?? 0) < CLONE_IDLE_MS) continue;
    if (clone.declinedAt !== null && now - clone.declinedAt < DECLINE_QUIET_MS) continue;
    if ("approval" in (await askToRemove(db, clone.id))) made++;
  }
  return made;
}

// Runs only on Nakul's own yes, and checks everything again right before deleting.
export async function removeClone(db: Database, actionId: string): Promise<RepoAction> {
  const action = getRepoAction(db, actionId);
  if (!action || action.kind !== "remove" || !action.cloneId) throw new Error(`No clone removal with id ${actionId}`);
  if (action.status !== "draft") return action;
  const approval = getApproval(db, action.approvalId);
  setActionStatus(db, actionId, "running");
  if (!approval || !isOwnYes(approval) || approval.alwaysAsk !== "remove_clone") {
    return setActionStatus(db, actionId, "failed", { error: "Only your own yes can remove a local copy." });
  }
  const clone = getClone(db, action.cloneId)!;
  const check = await checkRemovable(db, clone.id);
  if (!check.ok) {
    const error = check.reasons.join(" ");
    logActivity(db, clone.spaceId, "atrium", `Kept the local copy of ${clone.github}: ${error}`);
    return setActionStatus(db, actionId, "failed", { error });
  }
  rmSync(clone.path, { recursive: true, force: true });
  return db.transaction(() => {
    markRemoved(db, clone.id, Date.now());
    for (const space of spacesUsing(db, clone.path)) setSpaceRepo(db, space.id, { repoPath: null });
    logActivity(db, clone.spaceId, "atrium", `Removed the local copy of ${clone.github} (${bytes(check.bytes)})`);
    return setActionStatus(db, actionId, "done");
  })();
}
