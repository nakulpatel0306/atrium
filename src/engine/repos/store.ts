import type { Database } from "bun:sqlite";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { AlreadyResolved, type Approval, createApproval, getApproval } from "../approvals";
import { config } from "../config";
import { bus } from "../events";
import { newId } from "../ids";
import { BadDraft, type ProjectDraft, projectPath, tildePath } from "./names";
import { TEMPLATE_LABELS } from "./templates";

export type RepoAction = {
  id: string;
  kind: "create" | "remove";
  status: "draft" | "running" | "done" | "failed" | "rejected";
  approvalId: string;
  draft: ProjectDraft | null;
  cloneId: string | null;
  spaceId: string | null;
  remoteUrl: string | null;
  // On a draft, why the previous try failed; on a failed action, why this one did.
  error: string | null;
  createdAt: number;
  updatedAt: number;
};

type ActionRow = {
  id: string;
  kind: RepoAction["kind"];
  status: RepoAction["status"];
  approval_id: string;
  draft: string | null;
  clone_id: string | null;
  space_id: string | null;
  remote_url: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
};

const toAction = (r: ActionRow): RepoAction => ({
  id: r.id,
  kind: r.kind,
  status: r.status,
  approvalId: r.approval_id,
  draft: r.draft ? (JSON.parse(r.draft) as ProjectDraft) : null,
  cloneId: r.clone_id,
  spaceId: r.space_id,
  remoteUrl: r.remote_url,
  error: r.error,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export const getRepoAction = (db: Database, id: string): RepoAction | null => {
  const row = db.query("SELECT * FROM repo_actions WHERE id = ?").get(id) as ActionRow | null;
  return row ? toAction(row) : null;
};

export const actionForApproval = (db: Database, approvalId: string): RepoAction | null => {
  const row = db.query("SELECT * FROM repo_actions WHERE approval_id = ?").get(approvalId) as ActionRow | null;
  return row ? toAction(row) : null;
};

export const pendingRepoActions = (db: Database): RepoAction[] =>
  (
    db
      .query(
        `SELECT r.* FROM repo_actions r JOIN approvals a ON a.id = r.approval_id
         WHERE r.status = 'draft' AND a.status = 'pending' ORDER BY r.created_at, r.rowid`,
      )
      .all() as ActionRow[]
  ).map(toAction);

export function projectDetail(d: ProjectDraft, opts: { lastError?: string; remoteUrl?: string } = {}): string {
  const lines: string[] = [];
  if (opts.lastError) lines.push(`Last try failed: ${opts.lastError}`);
  if (opts.remoteUrl) lines.push(`Reusing the empty repo ${opts.remoteUrl}.`);
  let folder: string;
  let taken: string | null = null;
  try {
    folder = projectPath(d.name);
  } catch (e) {
    if (!(e instanceof BadDraft)) throw e;
    folder = join(config().projectsRoot, d.name);
    taken = e.message;
  }
  lines.push(
    `Name: ${d.name}`,
    `Visibility: ${d.visibility === "public" ? "Public" : "Private"}`,
    `Description: ${d.description}`,
    `Template: ${TEMPLATE_LABELS[d.template]}`,
    `Local folder: ${tildePath(folder)}`,
  );
  if (taken) lines.push(taken);
  lines.push(
    "",
    "On yes, Atrium creates the repo on your GitHub account with gh, sets up the folder from the template, makes a signed first commit as you, pushes it to main, and adds a repo space.",
  );
  return lines.join("\n");
}

const titleFor = (d: ProjectDraft) => `Create GitHub repo "${d.name}"?`;

export function draftProject(
  db: Database,
  draft: ProjectDraft,
  opts: { remoteUrl?: string; lastError?: string } = {},
): { action: RepoAction; approval: Approval } {
  const made = db.transaction(() => {
    const approval = createApproval(db, {
      spaceId: null,
      kind: "question",
      title: titleFor(draft),
      detail: projectDetail(draft, opts),
      alwaysAsk: "create_repo",
    });
    const id = newId("rpa");
    const now = Date.now();
    db.query(
      "INSERT INTO repo_actions (id, kind, status, approval_id, draft, remote_url, error, created_at, updated_at) VALUES (?, 'create', 'draft', ?, ?, ?, ?, ?, ?)",
    ).run(id, approval.id, JSON.stringify(draft), opts.remoteUrl ?? null, opts.lastError ?? null, now, now);
    return { action: getRepoAction(db, id)!, approval };
  })();
  bus.emit({ type: "changed" });
  return made;
}

// Nakul's edits land on the draft and its approval together, and only while he hasn't decided yet.
export function updateDraft(db: Database, actionId: string, draft: ProjectDraft): RepoAction {
  const next = db.transaction(() => {
    const action = getRepoAction(db, actionId);
    if (!action) throw new Error(`No repo action with id ${actionId}`);
    if (action.status !== "draft" || getApproval(db, action.approvalId)?.status !== "pending") throw new AlreadyResolved();
    const detail = projectDetail(draft, { lastError: action.error ?? undefined, remoteUrl: action.remoteUrl ?? undefined });
    db.query("UPDATE repo_actions SET draft = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(draft), Date.now(), actionId);
    db.query("UPDATE approvals SET title = ?, detail = ? WHERE id = ? AND status = 'pending'").run(titleFor(draft), detail, action.approvalId);
    return getRepoAction(db, actionId)!;
  })();
  bus.emit({ type: "changed" });
  return next;
}

const MOVES: Record<RepoAction["status"], RepoAction["status"][]> = {
  draft: ["running", "rejected"],
  running: ["done", "failed"],
  done: [],
  failed: [],
  rejected: [],
};

export function setActionStatus(
  db: Database,
  id: string,
  to: RepoAction["status"],
  patch: Partial<Pick<RepoAction, "spaceId" | "remoteUrl" | "error" | "cloneId">> = {},
): RepoAction {
  const cur = getRepoAction(db, id);
  if (!cur) throw new Error(`No repo action with id ${id}`);
  if (!MOVES[cur.status].includes(to)) throw new Error(`A repo action can't go from ${cur.status} to ${to}.`);
  const next = { ...cur, ...patch };
  const res = db
    .query("UPDATE repo_actions SET status = ?, space_id = ?, remote_url = ?, error = ?, clone_id = ?, updated_at = ? WHERE id = ? AND status = ?")
    .run(to, next.spaceId, next.remoteUrl, next.error, next.cloneId, Date.now(), id, cur.status);
  if (res.changes === 0) throw new Error(`The repo action ${id} changed while updating it.`);
  bus.emit({ type: "changed" });
  return getRepoAction(db, id)!;
}

export type RepoClone = {
  id: string;
  spaceId: string | null;
  path: string;
  github: string;
  origin: "new_project" | "clone";
  status: "present" | "removed";
  gitDev: number;
  gitIno: number;
  lastUsedAt: number;
  declinedAt: number | null;
  createdAt: number;
  removedAt: number | null;
};

type CloneRow = {
  id: string;
  space_id: string | null;
  path: string;
  github: string;
  origin: RepoClone["origin"];
  status: RepoClone["status"];
  git_dev: number;
  git_ino: number;
  last_used_at: number;
  declined_at: number | null;
  created_at: number;
  removed_at: number | null;
};

const toClone = (r: CloneRow): RepoClone => ({
  id: r.id,
  spaceId: r.space_id,
  path: r.path,
  github: r.github,
  origin: r.origin,
  status: r.status,
  gitDev: r.git_dev,
  gitIno: r.git_ino,
  lastUsedAt: r.last_used_at,
  declinedAt: r.declined_at,
  createdAt: r.created_at,
  removedAt: r.removed_at,
});

// The .git folder's device and inode pin this row to the folder Atrium made: a folder swapped in later under the
// same path is never treated as Atrium's to delete.
export function recordClone(
  db: Database,
  input: { spaceId: string | null; path: string; github: string; origin: RepoClone["origin"] },
): RepoClone {
  const st = lstatSync(join(input.path, ".git"));
  if (!st.isDirectory()) throw new Error(`${input.path} isn't a plain git checkout.`);
  const id = newId("cln");
  const now = Date.now();
  // Only called right after Atrium made this folder where none existed, so a row still "present" for the path is
  // from a folder that went away outside Atrium.
  db.query("UPDATE repo_clones SET status = 'removed', removed_at = ? WHERE path = ? AND status = 'present'").run(now, input.path);
  db.query(
    "INSERT INTO repo_clones (id, space_id, path, github, origin, git_dev, git_ino, last_used_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, input.spaceId, input.path, input.github, input.origin, st.dev, st.ino, now, now);
  bus.emit({ type: "changed" });
  return getClone(db, id)!;
}

export const getClone = (db: Database, id: string): RepoClone | null => {
  const row = db.query("SELECT * FROM repo_clones WHERE id = ?").get(id) as CloneRow | null;
  return row ? toClone(row) : null;
};

export const listClones = (db: Database): RepoClone[] =>
  (db.query("SELECT * FROM repo_clones ORDER BY created_at, rowid").all() as CloneRow[]).map(toClone);

export const presentCloneForPath = (db: Database, path: string): RepoClone | null => {
  const row = db.query("SELECT * FROM repo_clones WHERE path = ? AND status = 'present'").get(path) as CloneRow | null;
  return row ? toClone(row) : null;
};

export function touchClone(db: Database, path: string, now: number): void {
  db.query("UPDATE repo_clones SET last_used_at = ? WHERE path = ? AND status = 'present'").run(now, path);
}

export function markRemoved(db: Database, id: string, now: number): void {
  db.query("UPDATE repo_clones SET status = 'removed', removed_at = ? WHERE id = ? AND status = 'present'").run(now, id);
  bus.emit({ type: "changed" });
}

export function markDeclined(db: Database, id: string, now: number): void {
  db.query("UPDATE repo_clones SET declined_at = ? WHERE id = ?").run(now, id);
  bus.emit({ type: "changed" });
}
