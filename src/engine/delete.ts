// Deleting a space or a task for good. Every row goes in one transaction, children before parents, along with the
// queue of files to remove; the files go after it commits (see delete-files.ts). Nothing here touches a repo
// Nakul made, his branches, or GitHub.
import type { Database } from "bun:sqlite";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";
import { fileNow, finishPendingDeletes, notesOf, queueDelete } from "./delete-files";
import { bus } from "./events";
import { spaceFolder, tildePath } from "./folders";
import { presentCloneForPath } from "./repos/store";
import { legacyDelete, LEGACY, legacyUnlinkTasks } from "./legacy";
import { getSpace, type Space } from "./spaces";
import { getTask } from "./tasks";

export class DeleteRefused extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

// Every table that points at a space, a task or a run, and what a delete does with it. The test checks this against
// the live schema, so a new table can't be missed.
export const HANDLED = {
  space: ["tasks", "approvals", "activity", "messages", "autonomy_proposals", "autonomy_rules", "repo_clones", "repo_actions", "run_files", "rule_events", "attachments", "usage_log"],
  task: ["tasks", "runs", "approvals", "activity", "messages", "run_files", "attachments", "checks", "usage_log"],
  run: ["run_files", "checks"],
} as const;

const SPACE_GONE = "That space isn't here anymore. It may have been deleted somewhere else.";
const TASK_GONE = "That task isn't here anymore. It may have been deleted somewhere else.";

const marks = (ids: string[]) => ids.map(() => "?").join(",");
const idsOf = (db: Database, sql: string, ...params: string[]): string[] =>
  (db.query(sql).all(...params) as { id: string }[]).map((r) => r.id);

// The tasks a delete takes, plus every review or fix that follows one of them, wherever it is.
function taskClosure(db: Database, start: string[]): string[] {
  const all = new Set(start);
  for (let grew = true; grew; ) {
    grew = false;
    const list = [...all];
    if (!list.length) break;
    const approvals = idsOf(db, `SELECT id FROM approvals WHERE task_id IN (${marks(list)})`, ...list);
    const more = idsOf(
      db,
      `SELECT id FROM tasks WHERE parent_task_id IN (${marks(list)})${approvals.length ? ` OR approval_id IN (${marks(approvals)})` : ""}`,
      ...list,
      ...approvals,
    );
    for (const id of more) if (!all.has(id)) all.add(id), (grew = true);
  }
  return [...all];
}

// What the engine is doing outside the database that a delete must wait for.
export type DeleteGuards = { cloning?: (spaceId: string) => boolean };

const CLONING = "Atrium is still getting a local copy of this repo. Try again in a minute. Nothing was deleted.";

// What stops a delete: a run in progress, or a repo action or clone mid-run.
function refusal(db: Database, tasks: string[], spaceId: string | null, guards: DeleteGuards = {}): string | null {
  const running = tasks.length
    ? (db.query(`SELECT title FROM tasks WHERE status = 'running' AND id IN (${marks(tasks)}) LIMIT 1`).get(...tasks) as { title: string } | null)
    : null;
  if (running) return `"${running.title}" is running. Wait for it to finish (it shows under Live), then try again. Nothing was deleted.`;
  if (spaceId && db.query("SELECT 1 FROM repo_actions WHERE status = 'running' AND space_id = ?").get(spaceId)) {
    return "Atrium is working on this space's repo right now. Try again in a minute. Nothing was deleted.";
  }
  if (spaceId && guards.cloning?.(spaceId)) return CLONING;
  return null;
}

// A task's files sit in a folder other tasks of the space also work in, so its delete waits for all of them.
function spaceBusy(db: Database, spaceId: string): string | null {
  const running = db.query("SELECT title FROM tasks WHERE status = 'running' AND space_id = ? LIMIT 1").get(spaceId) as { title: string } | null;
  return running ? `"${running.title}" is running in this space and may be working on the same files. Wait for it to finish, then try again. Nothing was deleted.` : null;
}

// Rows that point nowhere after a delete would mean a table was missed; the delete rolls back instead. Links that
// were already broken before (old hand-edited databases) don't stop it.
const brokenLinks = (db: Database) => db.query("PRAGMA foreign_key_check").all().length;
const BROKE = "Atrium stopped the delete because it would have left broken links in its records. Nothing was deleted. Check the engine log.";

// Removes the rows of these tasks, their runs and approvals, in an order the foreign keys accept. Rows elsewhere
// that only mention a task keep their row with the link cleared.
function deleteTaskRows(db: Database, tasks: string[], extraApprovals: string[] = []): { transcripts: string[] } {
  if (!tasks.length && !extraApprovals.length) return { transcripts: [] };
  const t = marks(tasks);
  const runs = tasks.length ? (db.query(`SELECT id, transcript_path FROM runs WHERE task_id IN (${t})`).all(...tasks) as { id: string; transcript_path: string }[]) : [];
  // An approval in another space, or one that belongs to no space (a repo-wide question), outlives the task it came from.
  const own = tasks.length
    ? idsOf(db, `SELECT a.id FROM approvals a JOIN tasks t ON t.id = a.task_id WHERE a.task_id IN (${t}) AND (a.space_id IS NULL OR a.space_id = t.space_id)`, ...tasks)
    : [];
  const approvals = [...new Set([...own, ...extraApprovals])];
  const a = marks(approvals);
  if (approvals.length) {
    legacyDelete(db, LEGACY.byApproval, "approval_id", approvals);
    db.query(`DELETE FROM repo_actions WHERE approval_id IN (${a})`).run(...approvals);
    db.query(`DELETE FROM rule_events WHERE approval_id IN (${a})`).run(...approvals);
  }
  if (tasks.length) {
    legacyUnlinkTasks(db, tasks);
    db.query(`UPDATE approvals SET task_id = NULL WHERE task_id IN (${t})${a ? ` AND id NOT IN (${a})` : ""}`).run(...tasks, ...approvals);
    // Attached files are Nakul's own and stay in the space folder; only the link to the task goes.
    db.query(`UPDATE attachments SET task_id = NULL WHERE task_id IN (${t})`).run(...tasks);
    db.query(`DELETE FROM run_files WHERE task_id IN (${t})`).run(...tasks);
    db.query(`DELETE FROM checks WHERE task_id IN (${t})`).run(...tasks);
    db.query(`DELETE FROM usage_log WHERE task_id IN (${t})`).run(...tasks);
    db.query(`DELETE FROM messages WHERE task_id IN (${t})`).run(...tasks);
    db.query(`DELETE FROM activity WHERE task_id IN (${t})`).run(...tasks);
    // Tasks and approvals point at each other, so the task side lets go first.
    db.query(`UPDATE tasks SET approval_id = NULL, parent_task_id = NULL WHERE id IN (${t})`).run(...tasks);
    db.query(`DELETE FROM runs WHERE task_id IN (${t})`).run(...tasks);
  }
  if (approvals.length) {
    db.query(`UPDATE tasks SET approval_id = NULL WHERE approval_id IN (${a})`).run(...approvals);
    db.query(`DELETE FROM approvals WHERE id IN (${a})`).run(...approvals);
  }
  if (tasks.length) db.query(`DELETE FROM tasks WHERE id IN (${t})`).run(...tasks);
  return { transcripts: runs.map((r) => r.transcript_path) };
}

const queueTranscripts = (db: Database, paths: string[]) => {
  for (const p of paths) queueDelete(db, "transcript", p, config().transcriptsDir);
};

// Files and their size, walked without following links; stops counting at a cap so a huge folder stays quick.
function folderSize(dir: string): { files: number; bytes: number; more: boolean } {
  let files = 0;
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    let names: string[];
    try {
      names = readdirSync(cur);
    } catch {
      continue;
    }
    for (const name of names) {
      if (files >= 50_000) return { files, bytes: total, more: true };
      try {
        const st = lstatSync(join(cur, name));
        if (st.isDirectory()) stack.push(join(cur, name));
        else {
          files++;
          total += st.size;
        }
      } catch {
        // Gone since the listing.
      }
    }
  }
  return { files, bytes: total, more: false };
}

const legacyFolder = (id: string) => join(config().home, "spaces", id);

// Both places a general space can keep files: its visible folder and the hidden one it had before.
const foldersOf = (space: Space): { path: string; root: string }[] => [
  ...(space.folder ? [{ path: space.folder, root: config().filesHome }] : []),
  { path: legacyFolder(space.id), root: join(config().home, "spaces") },
];

export type SpaceDeletePreview = {
  id: string;
  name: string;
  kind: Space["kind"];
  tasks: number;
  runs: number;
  history: number;
  // The visible folder and what's in it now; null for a repo space.
  folder: { path: string; files: number; bytes: number; more: boolean } | null;
  // A repo space's folder: whether Atrium cloned it (removed only if everything is on GitHub) or Nakul did (never touched).
  repo: { path: string; atriumClone: boolean } | null;
  refusal: string | null;
};

export function spaceDeletePreview(db: Database, id: string, guards: DeleteGuards = {}): SpaceDeletePreview {
  const space = getSpace(db, id);
  if (!space) throw new DeleteRefused(404, SPACE_GONE);
  const count = (sql: string, ...p: string[]) => (db.query(sql).get(...p) as { n: number }).n;
  const tasks = taskClosure(db, idsOf(db, "SELECT id FROM tasks WHERE space_id = ?", id));
  const sized = foldersOf(space)
    .filter((f) => existsSync(f.path))
    .map((f) => folderSize(f.path))
    .reduce((a, b) => ({ files: a.files + b.files, bytes: a.bytes + b.bytes, more: a.more || b.more }), { files: 0, bytes: 0, more: false });
  return {
    id,
    name: space.name,
    kind: space.kind,
    tasks: tasks.length,
    runs: count("SELECT COUNT(*) AS n FROM runs r JOIN tasks t ON t.id = r.task_id WHERE t.space_id = ?", id),
    history: count("SELECT COUNT(*) AS n FROM activity WHERE space_id = ?", id),
    folder: space.kind === "repo" ? null : { path: tildePath(space.folder ?? legacyFolder(id)), ...sized },
    repo: space.repoPath ? { path: tildePath(space.repoPath), atriumClone: presentCloneForPath(db, space.repoPath) !== null } : null,
    refusal: refusal(db, tasks, id, guards),
  };
}

// The name must match exactly (ignoring spaces around it), so a stale page or a mistyped id can't delete another space.
export async function deleteSpace(db: Database, id: string, typedName: string, guards: DeleteGuards = {}): Promise<{ name: string; message: string; kept: string[] }> {
  const space = db.transaction(() => {
    const space = getSpace(db, id);
    if (!space) throw new DeleteRefused(404, SPACE_GONE);
    if (!typedName.trim() || typedName.trim() !== space.name.trim()) throw new DeleteRefused(400, `Type the space's name exactly as shown, "${space.name}", to delete it.`);
    const tasks = taskClosure(db, idsOf(db, "SELECT id FROM tasks WHERE space_id = ?", id));
    const refused = refusal(db, tasks, id, guards);
    if (refused) throw new DeleteRefused(409, refused);
    const pin = db.query("SELECT folder_dev AS dev, folder_ino AS ino FROM spaces WHERE id = ?").get(id) as { dev: number | null; ino: number | null };
    const linksBefore = brokenLinks(db);
    // A new project's approval belongs to no space, so it's found through its repo action.
    const repoApprovals = idsOf(db, "SELECT approval_id AS id FROM repo_actions WHERE space_id = ?", id);
    db.query("DELETE FROM repo_actions WHERE space_id = ?").run(id);
    const spaceApprovals = idsOf(db, "SELECT id FROM approvals WHERE space_id = ?", id);
    const { transcripts } = deleteTaskRows(db, tasks, [...spaceApprovals, ...repoApprovals]);
    const rules = idsOf(db, "SELECT id FROM autonomy_rules WHERE space_id = ?", id);
    if (rules.length) db.query(`UPDATE approvals SET rule_id = NULL WHERE rule_id IN (${marks(rules)})`).run(...rules);
    db.query("DELETE FROM rule_events WHERE space_id = ?").run(id);
    db.query("DELETE FROM autonomy_rules WHERE space_id = ?").run(id);
    db.query("DELETE FROM autonomy_proposals WHERE space_id = ?").run(id);
    db.query("DELETE FROM run_files WHERE space_id = ?").run(id);
    db.query("DELETE FROM usage_log WHERE space_id = ?").run(id);
    db.query("DELETE FROM attachments WHERE space_id = ?").run(id);
    db.query("DELETE FROM messages WHERE space_id = ?").run(id);
    db.query("DELETE FROM activity WHERE space_id = ?").run(id);
    legacyDelete(db, LEGACY.bySpace, "space_id", [id]);
    // Atrium's record of a clone outlives the space, so Storage and boot recovery still know the folder is its own.
    const clone = space.repoPath ? presentCloneForPath(db, space.repoPath) : null;
    db.query("UPDATE repo_clones SET space_id = NULL WHERE space_id = ?").run(id);
    db.query("DELETE FROM spaces WHERE id = ?").run(id);
    if (brokenLinks(db) > linksBefore) {
      console.error(`Deleting space ${id} would have left broken links: ${JSON.stringify(db.query("PRAGMA foreign_key_check").all())}`);
      throw new DeleteRefused(409, BROKE);
    }
    queueTranscripts(db, transcripts);
    if (space.kind !== "repo") {
      for (const f of foldersOf(space)) queueDelete(db, "folder", f.path, f.root, f.path === space.folder ? pin : {});
    }
    if (clone) queueDelete(db, "clone", clone.path, config().projectsRoot, { cloneId: clone.id });
    return space;
  })();
  bus.emit({ type: "changed" });
  const done = await finishPendingDeletes(db);
  // The result says plainly where the visible folder went, or that it's still there.
  const folder = space.folder ? done.find((d) => d.kind === "folder" && d.path === space.folder) : undefined;
  const where = folder?.trashed ? ` Its folder ${tildePath(space.folder!)} went to the Trash.` : folder?.note ? ` ${folder.note}` : "";
  return { name: space.name, message: `Deleted "${space.name}".${where}`, kept: notesOf(done.filter((d) => d !== folder)) };
}

export type TaskDeletePreview = {
  id: string;
  title: string;
  // Reviews and fixes that go with it.
  followers: number;
  runs: number;
  // Files its runs created in the space folder, unchanged since, that no other task also recorded; these go.
  files: string[];
  // Files it made that were changed afterwards (by Nakul or another task); these stay.
  edited: string[];
  // A repo task's branch, which stays.
  branch: string | null;
  refusal: string | null;
};

type MadeFile = { path: string; size: number; mtimeMax: number };

// A file still counts as the task's own only while it's the size the run left it and hasn't been touched since
// the run was recorded (a second of slack for the filesystem's clock).
const SLACK_MS = 2000;

// Files the tasks created in the space folder that nothing else recorded touching, split by whether they're still
// exactly as the run left them.
function madeFiles(db: Database, tasks: string[], root: string | null): { remove: MadeFile[]; edited: string[] } {
  if (!tasks.length || !root) return { remove: [], edited: [] };
  const t = marks(tasks);
  const rows = db
    .query(
      `SELECT f.path, f.size, f.change, f.created_at FROM run_files f WHERE f.task_id IN (${t}) AND f.root = 'space'
       AND f.path IN (SELECT path FROM run_files c WHERE c.task_id IN (${t}) AND c.root = 'space' AND c.change = 'created')
       AND NOT EXISTS (SELECT 1 FROM run_files o WHERE o.space_id = f.space_id AND o.root = 'space' AND o.path = f.path AND o.task_id NOT IN (${t}))
       ORDER BY f.created_at, f.rowid`,
    )
    .all(...tasks, ...tasks, ...tasks) as { path: string; size: number | null; change: string; created_at: number }[];
  // The newest record of each path says what it should look like now.
  const latest = new Map(rows.map((r) => [r.path, r]));
  const remove: MadeFile[] = [];
  const edited: string[] = [];
  for (const r of latest.values()) {
    if (r.change === "deleted") continue;
    const now = fileNow(root, r.path);
    if (!now) continue;
    if (r.size !== null && now.size === r.size && now.mtimeMs <= r.created_at + SLACK_MS) remove.push({ path: r.path, size: r.size, mtimeMax: r.created_at + SLACK_MS });
    else edited.push(r.path);
  }
  return { remove, edited };
}

export function taskDeletePreview(db: Database, id: string): TaskDeletePreview {
  const task = getTask(db, id);
  if (!task) throw new DeleteRefused(404, TASK_GONE);
  const tasks = taskClosure(db, [id]);
  const files = madeFiles(db, tasks, taskRoot(db, task));
  return {
    id,
    title: task.title,
    followers: tasks.length - 1,
    runs: (db.query(`SELECT COUNT(*) AS n FROM runs WHERE task_id IN (${marks(tasks)})`).get(...tasks) as { n: number }).n,
    files: files.remove.map((f) => f.path),
    edited: files.edited,
    branch: task.branch,
    refusal: refusal(db, tasks, null) ?? spaceBusy(db, task.spaceId),
  };
}

// A repo task's files are on its branch, which stays; only a space folder's files are removed.
function taskRoot(db: Database, task: { spaceId: string }): string | null {
  const space = getSpace(db, task.spaceId);
  return space && space.kind !== "repo" ? spaceFolder(space) : null;
}

export async function deleteTask(db: Database, id: string): Promise<{ title: string; kept: string[] }> {
  const { title, edited } = db.transaction(() => {
    const task = getTask(db, id);
    if (!task) throw new DeleteRefused(404, TASK_GONE);
    const tasks = taskClosure(db, [id]);
    const refused = refusal(db, tasks, null) ?? spaceBusy(db, task.spaceId);
    if (refused) throw new DeleteRefused(409, refused);
    const root = taskRoot(db, task);
    const files = madeFiles(db, tasks, root);
    const linksBefore = brokenLinks(db);
    const { transcripts } = deleteTaskRows(db, tasks);
    if (brokenLinks(db) > linksBefore) throw new DeleteRefused(409, BROKE);
    queueTranscripts(db, transcripts);
    for (const f of files.remove) queueDelete(db, "file", f.path, root!, { size: f.size, mtimeMax: f.mtimeMax });
    return { title: task.title, edited: files.edited };
  })();
  bus.emit({ type: "changed" });
  const kept = notesOf(await finishPendingDeletes(db));
  return { title, kept: [...(edited.length ? [keptEdited(edited)] : []), ...kept] };
}

const keptEdited = (paths: string[]) =>
  paths.length === 1 ? `Kept ${paths[0]}: it changed after the task made it.` : `Kept ${paths.length} files that changed after the task made them: ${paths.slice(0, 3).join(", ")}${paths.length > 3 ? ", …" : ""}.`;
