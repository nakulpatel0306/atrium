import type { Database } from "bun:sqlite";
import { closeSync, constants, lstatSync, mkdirSync, openSync, realpathSync, rmdirSync, unlinkSync, writeSync } from "node:fs";
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

// An exclusive create that doesn't follow a link, in a folder checked just before. False when the name is
// taken (by a file or a planted link alike), so nothing already there is ever overwritten or written through.
function createIn(dir: string, name: string, bytes: Uint8Array): boolean {
  const target = join(dir, name);
  if (!stillIn(dir, target)) throw new AttachRefused(409, MOVED);
  let fd: number;
  try {
    fd = openSync(target, EXCL, 0o644);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ELOOP") return false;
    throw e;
  }
  try {
    writeAll(fd, bytes);
  } catch (e) {
    closeSync(fd);
    if (stillIn(dir, target)) unlinkSync(target);
    throw e;
  }
  closeSync(fd);
  // A swap between the check and the create would have sent the file elsewhere; the folder isn't trusted after
  // that, so nothing is deleted through it either.
  if (!stillIn(dir, target)) throw new AttachRefused(409, MOVED);
  return true;
}

const withNumber = (name: string, n: number) => {
  if (n === 1) return name;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
};

// "receipt.png", then "receipt (2).png" and so on: an existing file is never replaced.
function writeNew(dir: string, name: string, bytes: Uint8Array): string {
  for (let n = 1; n <= 1000; n++) {
    const candidate = withNumber(name, n);
    if (createIn(dir, candidate, bytes)) return candidate;
  }
  throw new AttachRefused(409, `Atrium couldn't find a free name for ${name} in the Attachments folder. Tidy it up, then try again.`);
}

// Saves the files into the space's Attachments/ and records them, unclaimed until a task names their ids.
export function storeAttachments(db: Database, space: Space, files: Upload[]): Attachment[] {
  if (space.kind === "repo") throw new AttachRefused(409, REPO_REFUSED);
  if (files.length === 0) throw new AttachRefused(400, "Choose at least one file to attach.");
  const sizes = files.map((f) => ({ name: f.name, size: f.bytes.length }));
  const refused = batchRefusal(sizes);
  if (refused) {
    const tooBig = files.length > MAX_FILES || sizes.some((f) => f.size > MAX_FILE_BYTES) || sizes.reduce((n, f) => n + f.size, 0) > MAX_TOTAL_BYTES;
    throw new AttachRefused(tooBig ? 413 : 400, refused);
  }
  const dir = attachDir(ensureSpaceFolder(db, space));
  if (!dir) throw new AttachRefused(409, MOVED);
  const now = Date.now();
  const out: Attachment[] = [];
  for (const f of files) {
    const stored = writeNew(dir, cleanName(f.name), f.bytes);
    const a: Attachment = { id: newId("att"), spaceId: space.id, taskId: null, path: `${ATTACH_DIR}/${stored}`, name: stored, size: f.bytes.length, type: typeOf(stored), createdAt: now };
    db.query("INSERT INTO attachments (id, space_id, task_id, path, name, size, type, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)").run(
      a.id, a.spaceId, a.path, a.name, a.size, a.type, a.createdAt,
    );
    out.push(a);
  }
  return out;
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

export const withAttachments = (detail: string, list: Attachment[]) =>
  list.length ? [detail.trim(), attachedBlock(list.map((a) => a.path))].filter(Boolean).join("\n\n") : detail;

export function taskAttachments(db: Database, taskId: string): Attachment[] {
  return db.query(`SELECT ${COLUMNS} FROM attachments WHERE task_id = ? ORDER BY created_at, rowid`).all(taskId) as Attachment[];
}

export function claimedAttachments(db: Database): Attachment[] {
  return db.query(`SELECT ${COLUMNS} FROM attachments WHERE task_id IS NOT NULL ORDER BY created_at, rowid`).all() as Attachment[];
}

// A Codex or Gemini run works in an empty folder of its own, not the space folder, so the task's files are copied
// in at the same relative paths the task's detail names. Sources are read without passing through a link. What was
// copied, and the real folder it went into, are returned so exactly those copies can be taken out again later.
export type Copies = { dir: string | null; names: string[] };

export function copyAttachments(db: Database, taskId: string, spaceDir: string, dest: string): Copies {
  const list = taskAttachments(db, taskId);
  if (!list.length) return { dir: null, names: [] };
  const dir = attachDir(dest);
  if (!dir) return { dir: null, names: [] };
  const names: string[] = [];
  for (const a of list) {
    let bytes: Uint8Array;
    try {
      const t = resolveTarget(spaceDir, a.path);
      bytes = readOpen(t, (fd, st) => readBytes(fd, st.size));
    } catch {
      // A file Nakul moved or deleted since attaching it just isn't there for the agent; the run still goes ahead.
      continue;
    }
    try {
      if (createIn(dir, a.name, bytes)) names.push(a.name);
    } catch {
      // The folder stopped being a plain one: no more writes into it.
      break;
    }
  }
  return { dir, names };
}

// Only plain files, in the very folder they were copied into, are removed. That folder is named by the real path it
// had then, so if it or any folder above it has since been swapped for a link, its real path no longer matches and
// nothing is touched; a link in a file's place is left alone too. Whatever else is there is the agent's work.
export function removeCopies(copies: Copies): void {
  const { dir, names } = copies;
  if (!dir || !names.length) return;
  for (const name of names) {
    const target = join(dir, name);
    try {
      if (stillIn(dir, target) && lstatSync(target).isFile()) unlinkSync(target);
    } catch {
      // Already gone.
    }
  }
  // The folder too, when nothing else is left in it; rmdir never removes one that isn't empty.
  try {
    if (plainDir(dir)) rmdirSync(dir);
  } catch {
    // The agent left files there; they're kept with its work.
  }
}
