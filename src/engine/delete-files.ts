// The disk side of deleting a space or a task. The database rows go first, in one transaction that also queues
// every file and folder to remove here; each queued item is removed and then dropped, and boot finishes whatever a
// crash left. Every removal is checked against the one folder it may happen in and never follows a link out.
import type { Database } from "bun:sqlite";
import { existsSync, lstatSync, mkdirSync, realpathSync, renameSync, rmdirSync, rmSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { config } from "./config";
import { tildePath } from "./folders";
import { logActivity } from "./events";
import { newId } from "./ids";
import { FileRefused, resolveTarget } from "./outputs/files";
import { checkRemovable, removeVerified } from "./repos/cleanup";
import { getClone, markRemoved } from "./repos/store";
import { bytes } from "./text";

export type PendingKind = "folder" | "transcript" | "file" | "clone";

// `root` is the only folder the item may be removed from: the files home for a space folder, the transcripts folder
// for a transcript, the space folder for a file a task made (`path` relative to it).
export type QueueExtra = {
  cloneId?: string | null;
  // For a file a task made: the size and latest modified time it may have and still be the task's own.
  size?: number | null;
  mtimeMax?: number | null;
  // For a space folder: the identity Atrium recorded when it made the folder; ino 0 means it never made one.
  dev?: number | null;
  ino?: number | null;
};

export function queueDelete(db: Database, kind: PendingKind, path: string, root: string, extra: QueueExtra = {}): void {
  db.query("INSERT INTO pending_deletes (id, kind, path, root, clone_id, size, mtime_max, dev, ino, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    newId("del"),
    kind,
    path,
    root,
    extra.cloneId ?? null,
    extra.size ?? null,
    extra.mtimeMax ?? null,
    extra.dev ?? null,
    extra.ino ?? null,
    Date.now(),
  );
}

// A file a task made, as it is on disk now; null when it's gone or can't be reached without leaving the folder.
export function fileNow(root: string, rel: string): { absPath: string; size: number; mtimeMs: number } | null {
  try {
    const t = resolveTarget(root, rel);
    const st = lstatSync(t.absPath);
    return { absPath: t.absPath, size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

// Space folders go to the Trash, so a delete of Nakul's own files has a way back. Tests and dev engines use a
// trash of their own.
function trashDir(): string {
  if (process.env.ATRIUM_TRASH) return process.env.ATRIUM_TRASH;
  return process.env.ATRIUM_HOME ? join(config().home, "trash") : join(homedir(), ".Trash");
}

// Renamed into the Trash under a name nothing there has; null when that isn't possible (another volume, no
// permission), and the caller removes it instead.
function toTrash(path: string): string | null {
  const dir = trashDir();
  try {
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    let dest = join(dir, `${basename(path)} (deleted ${stamp})`);
    for (let n = 2; existsSync(dest); n++) dest = join(dir, `${basename(path)} (deleted ${stamp}) ${n}`);
    renameSync(path, dest);
    return dest;
  } catch {
    return null;
  }
}

const realOrNull = (p: string): string | null => {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
};

const inside = (child: string, parent: string) => child === parent || child.startsWith(parent + sep);

type FolderResult = { note: string | null; trashed: boolean };
const kept = (note: string): FolderResult => ({ note, trashed: false });
const done: FolderResult = { note: null, trashed: false };

// A space's visible folder holds Nakul's files, so Atrium never removes one for good: it goes to the Trash, and if
// the Trash can't take it (no permission under launchd, another volume) it stays where it is and the note says so.
// It must sit directly in its root, have an ordinary name, be the very folder Atrium made (when Atrium recorded
// that), and not be in use by anything still recorded. The hidden legacy folder is Atrium's own and is removed.
function removeFolder(db: Database, r: Pending): FolderResult {
  const { id, path, root } = r;
  const name = basename(path);
  const shown = tildePath(path);
  const outside = kept(`Atrium left ${shown} alone: it isn't inside ${tildePath(root)}.`);
  if (!name || name.startsWith(".") || resolve(dirname(path)) !== resolve(root)) return outside;
  const parent = realOrNull(dirname(path));
  // A space whose folder was never made (or whose files home is gone) has nothing to remove.
  if (!parent) return done;
  if (parent !== realOrNull(root)) return outside;
  const visible = resolve(root) === resolve(config().filesHome);
  // A files home that is the home folder itself (or above it) holds folders Nakul made; Atrium never removes one.
  const home = realOrNull(process.env.HOME || homedir());
  if (home && inside(home, parent)) return kept(`Atrium left ${shown} alone: its files folder is your home folder, where it can't tell its folders from yours.`);
  // Left by an earlier version's half-finished removal: a visible folder's copy goes to the Trash too, never away.
  const leftover = join(parent, `.atrium-trash-${id}`);
  if (existsSync(leftover)) {
    if (!visible) rmSync(leftover, { recursive: true, force: true });
    else toTrash(leftover);
  }
  const lower = path.toLowerCase();
  const used = (db.query("SELECT folder, repo_path FROM spaces").all() as { folder: string | null; repo_path: string | null }[]).some(
    (s) => s.folder?.toLowerCase() === lower || (s.repo_path !== null && inside(resolve(s.repo_path), resolve(path))),
  );
  const cloned = (db.query("SELECT path FROM repo_clones WHERE status = 'present'").all() as { path: string }[]).some((c) => inside(resolve(c.path), resolve(path)));
  if (used || cloned) return kept(`Atrium kept ${shown}: another space still uses it.`);
  let st: ReturnType<typeof lstatSync> | null = null;
  try {
    st = lstatSync(path);
  } catch {
    // Already gone.
  }
  if (!st) return done;
  if (st.isSymbolicLink()) {
    unlinkSync(path);
    return done;
  }
  if (!st.isDirectory()) return kept(`Atrium left ${shown} alone: it isn't a folder.`);
  if (!visible) {
    const aside = join(parent, `.atrium-trash-${id}`);
    renameSync(path, aside);
    rmSync(aside, { recursive: true, force: true });
    return done;
  }
  if (r.ino === 0) return kept(`Atrium never made ${shown}, so it left it where it is.`);
  if (r.ino !== null && r.dev !== null && (st.dev !== r.dev || st.ino !== r.ino)) return kept(`Atrium kept ${shown}: it isn't the folder Atrium made for this space.`);
  if (toTrash(path)) return { note: null, trashed: true };
  return kept(`Atrium couldn't move ${shown} to the Trash, so it's still there; delete it in Finder if you don't need it.`);
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
function removeMadeFile(path: string, root: string, expect: { size: number | null; mtimeMax: number | null }): string | null {
  let target: string;
  try {
    target = resolveTarget(root, path).absPath;
  } catch (e) {
    if (e instanceof FileRefused && e.status === 404) return null;
    if (e instanceof FileRefused) return `Atrium left ${path} alone: ${e.message}`;
    throw e;
  }
  // Checked again right before removing: a file changed since the delete was asked for (or since a crash) is Nakul's.
  const now = fileNow(root, path);
  if (!now) return null;
  if (expect.size === null || expect.mtimeMax === null || now.size !== expect.size || now.mtimeMs > expect.mtimeMax) {
    return `Kept ${path}: it changed after the task made it.`;
  }
  unlinkSync(target);
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

type Pending = {
  id: string;
  kind: PendingKind;
  path: string;
  root: string;
  clone_id: string | null;
  size: number | null;
  mtime_max: number | null;
  dev: number | null;
  ino: number | null;
};

// What happened to one queued item: a note when something was kept, and whether a folder went to the Trash.
export type DeleteDone = { kind: PendingKind; path: string; note: string | null; trashed: boolean };

// Removes every queued item. One that can't be removed safely is dropped with a line in Activity rather than
// retried forever; one that fails unexpectedly stays queued for the next boot.
export async function finishPendingDeletes(db: Database): Promise<DeleteDone[]> {
  const rows = db.query("SELECT id, kind, path, root, clone_id, size, mtime_max, dev, ino FROM pending_deletes ORDER BY created_at, rowid").all() as Pending[];
  const out: DeleteDone[] = [];
  for (const r of rows) {
    let res: FolderResult;
    try {
      if (r.kind === "folder") res = removeFolder(db, r);
      else if (r.kind === "transcript") res = { note: removeTranscript(r.path, r.root), trashed: false };
      else if (r.kind === "file") res = { note: existsSync(r.root) ? removeMadeFile(r.path, r.root, { size: r.size, mtimeMax: r.mtime_max }) : null, trashed: false };
      else res = { note: r.clone_id ? await removeClone(db, r.clone_id) : null, trashed: false };
    } catch (e) {
      console.error(`Couldn't remove ${r.path}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    db.query("DELETE FROM pending_deletes WHERE id = ?").run(r.id);
    if (res.note) logActivity(db, null, "atrium", res.note);
    out.push({ kind: r.kind, path: r.path, ...res });
  }
  return out;
}

export const notesOf = (done: DeleteDone[]): string[] => done.flatMap((d) => (d.note ? [d.note] : []));
