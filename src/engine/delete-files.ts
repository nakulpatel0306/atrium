// The disk side of deleting a space or a task. The database rows go first, in one transaction that also queues
// every file and folder to remove here; each queued item is removed and then dropped, and boot finishes whatever a
// crash left. Every removal is checked against the one folder it may happen in and never follows a link out.
import type { Database } from "bun:sqlite";
import { existsSync, lstatSync, realpathSync, renameSync, rmdirSync, rmSync, unlinkSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { logActivity } from "./events";
import { newId } from "./ids";
import { FileRefused, resolveTarget } from "./outputs/files";
import { checkRemovable, removeVerified } from "./repos/cleanup";
import { getClone, markRemoved } from "./repos/store";
import { bytes } from "./text";

export type PendingKind = "folder" | "transcript" | "file" | "clone";

// `root` is the only folder the item may be removed from: the files home for a space folder, the transcripts folder
// for a transcript, the space folder for a file a task made (`path` relative to it).
export function queueDelete(db: Database, kind: PendingKind, path: string, root: string, cloneId: string | null = null): void {
  db.query("INSERT INTO pending_deletes (id, kind, path, root, clone_id, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    newId("del"),
    kind,
    path,
    root,
    cloneId,
    Date.now(),
  );
}

const realOrNull = (p: string): string | null => {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
};

const inside = (child: string, parent: string) => child === parent || child.startsWith(parent + sep);

// A space folder goes only if it sits directly in its root (after resolving links in the root's own path), has an
// ordinary name, and nothing still recorded lives in or at it. It's renamed aside first, so it leaves Finder at
// once and a half-finished removal is never mistaken for the space's files; rmSync then removes links inside
// without following them.
function removeFolder(db: Database, id: string, path: string, root: string): string | null {
  const name = basename(path);
  const outside = `Atrium left ${path} alone: it isn't inside ${root}.`;
  if (!name || name.startsWith(".") || resolve(dirname(path)) !== resolve(root)) return outside;
  const parent = realOrNull(dirname(path));
  // A space whose folder was never made (or whose files home is gone) has nothing to remove.
  if (!parent) return null;
  if (parent !== realOrNull(root)) return outside;
  const lower = path.toLowerCase();
  const used = (db.query("SELECT folder, repo_path FROM spaces").all() as { folder: string | null; repo_path: string | null }[]).some(
    (s) => s.folder?.toLowerCase() === lower || (s.repo_path !== null && inside(resolve(s.repo_path), resolve(path))),
  );
  const cloned = (db.query("SELECT path FROM repo_clones WHERE status = 'present'").all() as { path: string }[]).some((c) => inside(resolve(c.path), resolve(path)));
  if (used || cloned) return `Atrium kept ${path}: another space still uses it.`;
  const trash = join(parent, `.atrium-trash-${id}`);
  let st: ReturnType<typeof lstatSync> | null = null;
  try {
    st = lstatSync(path);
  } catch {
    // Already gone, or already moved aside by an earlier try.
  }
  if (st?.isSymbolicLink()) unlinkSync(path);
  else if (st?.isDirectory()) renameSync(path, trash);
  else if (st) return `Atrium left ${path} alone: it isn't a folder.`;
  rmSync(trash, { recursive: true, force: true });
  return null;
}

function removeTranscript(path: string, root: string): string | null {
  const parent = realOrNull(dirname(path));
  if (!parent || parent !== realOrNull(root) || !path.endsWith(".log")) return `Atrium left ${path} alone: it isn't in the transcripts folder.`;
  try {
    const st = lstatSync(path);
    if (st.isFile() || st.isSymbolicLink()) unlinkSync(path);
  } catch {
    // Already gone; the transcript cap may have removed it.
  }
  return null;
}

// A file a task made, named relative to its space folder. resolveTarget refuses anything outside the folder, hidden,
// or reached through a link. Kept scratch files sit in runs/<runId>/, which goes too once it's empty.
function removeMadeFile(path: string, root: string): string | null {
  try {
    unlinkSync(resolveTarget(root, path).absPath);
  } catch (e) {
    if (e instanceof FileRefused && e.status === 404) return null;
    if (e instanceof FileRefused) return `Atrium left ${path} alone: ${e.message}`;
    throw e;
  }
  const parts = path.split("/");
  if (parts[0] === "runs" && parts.length > 2) {
    for (let n = parts.length - 1; n >= 2; n--) {
      try {
        rmdirSync(join(root, ...parts.slice(0, n)));
      } catch {
        break;
      }
    }
  }
  return null;
}

// An Atrium clone goes only through the same checks as Settings › Storage: nothing uncommitted, untracked or
// unpushed, and no space still using it. Nakul's own checkouts never get here.
async function removeClone(db: Database, cloneId: string): Promise<string | null> {
  const clone = getClone(db, cloneId);
  if (clone?.status !== "present") return null;
  if (db.query("SELECT 1 FROM spaces WHERE repo_path = ?").get(clone.path)) return null;
  const check = await checkRemovable(db, clone.id);
  if (!check.ok) return `Kept the local copy of ${clone.github}: ${check.reasons.join(" ")} Delete the folder yourself if you don't need it.`;
  if (!removeVerified(clone.path, clone.id, { dev: clone.gitDev, ino: clone.gitIno })) return `Kept the local copy of ${clone.github}: Atrium didn't create this folder, so it never removes it.`;
  markRemoved(db, clone.id, Date.now());
  logActivity(db, null, "atrium", `Removed the local copy of ${clone.github} (${bytes(check.bytes)})`);
  return null;
}

type Pending = { id: string; kind: PendingKind; path: string; root: string; clone_id: string | null };

// Removes every queued item. One that can't be removed safely is dropped with a line in Activity rather than
// retried forever; one that fails unexpectedly stays queued for the next boot.
export async function finishPendingDeletes(db: Database): Promise<string[]> {
  const rows = db.query("SELECT id, kind, path, root, clone_id FROM pending_deletes ORDER BY created_at, rowid").all() as Pending[];
  const kept: string[] = [];
  for (const r of rows) {
    let note: string | null;
    try {
      if (r.kind === "folder") note = removeFolder(db, r.id, r.path, r.root);
      else if (r.kind === "transcript") note = removeTranscript(r.path, r.root);
      else if (r.kind === "file") note = existsSync(r.root) ? removeMadeFile(r.path, r.root) : null;
      else note = r.clone_id ? await removeClone(db, r.clone_id) : null;
    } catch (e) {
      console.error(`Couldn't remove ${r.path}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    db.query("DELETE FROM pending_deletes WHERE id = ?").run(r.id);
    if (note) {
      kept.push(note);
      logActivity(db, null, "atrium", note);
    }
  }
  return kept;
}
