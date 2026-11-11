import type { Database } from "bun:sqlite";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, realpathSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { ATTACH_DIR, attachedBlock, batchRefusal, cleanName, MAX_FILE_BYTES, MAX_FILES, MAX_TOTAL_BYTES, REPO_REFUSED, typeOf } from "./attachment-rules";
import { ensureSpaceFolder } from "./folders";
import { newId } from "./ids";
import { readBytes, readOpen, resolveTarget } from "./outputs/files";
import type { Space } from "./spaces";

export type Attachment = { id: string; spaceId: string; taskId: string | null; path: string; name: string; size: number; type: string; createdAt: number };
export type Upload = { name: string; bytes: Uint8Array };

export class AttachRefused extends Error {
  constructor(
    readonly status: 400 | 409 | 413,
    message: string,
  ) {
    super(message);
  }
}

const MOVED = "The space's Attachments folder isn't a plain folder anymore, so Atrium stopped. Check the space folder in Finder, then try again.";
const COLUMNS = "id, space_id AS spaceId, task_id AS taskId, path, name, size, type, created_at AS createdAt";
const EXCL = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

// Agents work in the folders these files go into, so any of them could swap Attachments/ (or a folder above it) for
// a link while Atrium writes or deletes. Every write and unlink is preceded by this check: the folder is a real
// directory and its real path is still exactly the one checked first.
function plainDir(dir: string): boolean {
  try {
    const st = lstatSync(dir);
    return st.isDirectory() && !st.isSymbolicLink() && realpathSync(dir) === dir;
  } catch {
    return false;
  }
}

// `root`'s Attachments/ by its real path, made if missing; null when it isn't a plain folder.
function attachDir(root: string): string | null {
  const dir = join(realpathSync(root), ATTACH_DIR);
  try {
    mkdirSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  return plainDir(dir) ? dir : null;
}

const stillIn = (dir: string, target: string) => plainDir(dir) && realpathSync(dirname(target)) === dir;

function writeAll(fd: number, bytes: Uint8Array) {
  for (let off = 0; off < bytes.length; ) off += writeSync(fd, bytes, off, bytes.length - off);
}

type Made = { name: string; dev: number; ino: number };

// An exclusive create that doesn't follow a link, in a folder checked just before. Null when the name is taken (by
// a file or a planted link alike), so nothing already there is ever overwritten or written through. A write that
// fails part way leaves its partial file where it is: nothing is ever deleted on the strength of a path alone.
function createIn(dir: string, name: string, bytes: Uint8Array): Made | null {
  const target = join(dir, name);
  if (!stillIn(dir, target)) throw new AttachRefused(409, MOVED);
  let fd: number;
  try {
    fd = openSync(target, EXCL, 0o644);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ELOOP") return null;
    throw e;
  }
  let made: Made;
  try {
    const st = fstatSync(fd);
    made = { name, dev: st.dev, ino: st.ino };
    writeAll(fd, bytes);
  } finally {
    closeSync(fd);
  }
  // A swap between the check and the create would have sent the file elsewhere; the folder isn't trusted after
  // that, so nothing is deleted through it either.
  if (!stillIn(dir, target)) throw new AttachRefused(409, MOVED);
  return made;
}

// Takes back the files a failed batch made: only through the checked folder, and only a file that is still the very
// one created (same device and inode), so a name an agent reused or a swapped folder is left alone.
function undoMade(dir: string, made: Made[]) {
  for (const m of made) {
    const target = join(dir, m.name);
    try {
      const st = lstatSync(target);
      if (stillIn(dir, target) && st.isFile() && st.dev === m.dev && st.ino === m.ino) unlinkSync(target);
    } catch {
      // Already gone, or the folder isn't the checked one anymore: either way, nothing more to take back.
    }
  }
}

const withNumber = (name: string, n: number) => {
  if (n === 1) return name;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
};

// "receipt.png", then "receipt (2).png" and so on: an existing file is never replaced.
function writeNew(dir: string, name: string, bytes: Uint8Array): Made {
  for (let n = 1; n <= 1000; n++) {
    const made = createIn(dir, withNumber(name, n), bytes);
    if (made) return made;
  }
  throw new AttachRefused(409, `Atrium couldn't find a free name for ${name} in the Attachments folder. Tidy it up, then try again.`);
}

// Why a batch can't be attached, with a status: too much is 413, anything else 400.
export function checkUploads(files: Upload[]): void {
  if (files.length === 0) throw new AttachRefused(400, "Choose at least one file to attach.");
  const sizes = files.map((f) => ({ name: f.name, size: f.bytes.length }));
  const refused = batchRefusal(sizes);
  if (!refused) return;
  const tooBig = files.length > MAX_FILES || sizes.some((f) => f.size > MAX_FILE_BYTES) || sizes.reduce((n, f) => n + f.size, 0) > MAX_TOTAL_BYTES;
  throw new AttachRefused(tooBig ? 413 : 400, refused);
}

// Saves the files into the space's Attachments/ and records them, unclaimed until a task names their ids. All the
// files are written first and the rows go in together; if anything fails, the files this call made are taken back,
// so a failed batch leaves nothing behind.
export function storeAttachments(db: Database, space: Space, files: Upload[]): Attachment[] {
  if (space.kind === "repo") throw new AttachRefused(409, REPO_REFUSED);
  checkUploads(files);
  const dir = attachDir(ensureSpaceFolder(db, space));
  if (!dir) throw new AttachRefused(409, MOVED);
  const now = Date.now();
  const made: Made[] = [];
  try {
    for (const f of files) made.push(writeNew(dir, cleanName(f.name), f.bytes));
    const out = made.map((m, i): Attachment => ({
      id: newId("att"), spaceId: space.id, taskId: null, path: `${ATTACH_DIR}/${m.name}`, name: m.name, size: files[i]!.bytes.length, type: typeOf(m.name), createdAt: now,
    }));
    db.transaction(() => {
      for (const a of out) {
        db.query("INSERT INTO attachments (id, space_id, task_id, path, name, size, type, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)").run(
          a.id, a.spaceId, a.path, a.name, a.size, a.type, a.createdAt,
        );
      }
    })();
    return out;
  } catch (e) {
    undoMade(dir, made);
    throw e;
  }
}

// The attachments a new task will claim: every id must be this space's and not yet claimed by another task.
export function checkAttachments(db: Database, space: Space, ids: unknown): Attachment[] {
  if (ids === undefined) return [];
  if (!Array.isArray(ids) || ids.some((x) => typeof x !== "string")) throw new AttachRefused(400, "attachments must be a list of ids.");
  if (ids.length === 0) return [];
  if (space.kind === "repo") throw new AttachRefused(400, REPO_REFUSED);
  if (ids.length > MAX_FILES) throw new AttachRefused(413, `A task can carry at most ${MAX_FILES} files.`);
  const unique = [...new Set(ids as string[])];
  const rows = db
    .query(`SELECT ${COLUMNS} FROM attachments WHERE id IN (${unique.map(() => "?").join(",")}) AND space_id = ? AND task_id IS NULL`)
    .all(...unique, space.id) as Attachment[];
  if (rows.length !== unique.length) throw new AttachRefused(400, "One of the attached files isn't in this space anymore. Attach it again, then send.");
  return unique.map((id) => rows.find((r) => r.id === id)!);
}

export function claimAttachments(db: Database, taskId: string, list: Attachment[]): void {
  for (const a of list) db.query("UPDATE attachments SET task_id = ? WHERE id = ? AND task_id IS NULL").run(taskId, a.id);
}

// Gives files to a task that already exists (a new space's first starter task): its detail gains the list.
export function attachToTask(db: Database, taskId: string, list: Attachment[]): void {
  const row = db.query("SELECT detail FROM tasks WHERE id = ?").get(taskId) as { detail: string };
  db.query("UPDATE tasks SET detail = ?, updated_at = ? WHERE id = ?").run(withAttachments(row.detail, list), Date.now(), taskId);
  claimAttachments(db, taskId, list);
}

export const withAttachments = (detail: string, list: Attachment[]) =>
  list.length ? [detail.trim(), attachedBlock(list.map((a) => a.path))].filter(Boolean).join("\n\n") : detail;

export function taskAttachments(db: Database, taskId: string): Attachment[] {
  return db.query(`SELECT ${COLUMNS} FROM attachments WHERE task_id = ? ORDER BY created_at, rowid`).all(taskId) as Attachment[];
}

export function claimedAttachments(db: Database): Attachment[] {
  return db.query(`SELECT ${COLUMNS} FROM attachments WHERE task_id IS NOT NULL ORDER BY created_at, rowid`).all() as Attachment[];
}

// A Codex or Gemini run works in an empty folder of its own, not the space folder, so the task's files are copied
// in at the same relative paths the task's detail names. Sources are read without passing through a link, and a
// file that's grown past the limit or has another hard link (it could be a secret's other name) is left out. What was
// copied is returned by path, size and content hash, so the copies left unchanged aren't kept as the run's work;
// the scratch folder itself is removed whole when the run ends, so nothing here deletes anything.
export type Copy = { path: string; size: number; hash: string };

export const hashOf = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

export function copyAttachments(db: Database, taskId: string, spaceDir: string, dest: string): Copy[] {
  const list = taskAttachments(db, taskId);
  if (!list.length) return [];
  const dir = attachDir(dest);
  if (!dir) return [];
  const copied: Copy[] = [];
  for (const a of list) {
    let bytes: Uint8Array;
    try {
      const t = resolveTarget(spaceDir, a.path);
      bytes = readOpen(t, (fd, st) => {
        if (st.size > MAX_FILE_BYTES || st.nlink > 1) throw new Error("not copied");
        return readBytes(fd, st.size);
      });
    } catch {
      // Moved, deleted, grown or hard-linked since it was attached: the agent goes without it.
      continue;
    }
    try {
      if (createIn(dir, a.name, bytes)) copied.push({ path: a.path, size: bytes.length, hash: hashOf(bytes) });
    } catch {
      // The folder stopped being a plain one: no more writes into it.
      break;
    }
  }
  return copied;
}
