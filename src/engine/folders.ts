import type { Database } from "bun:sqlite";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { config } from "./config";
import type { Space } from "./spaces";

// General and markets spaces keep their files in ~/Atrium/<space-slug>/, where Nakul can find them in Finder.
// The folder is chosen once, when the space is made: renaming the space doesn't move it.

const slug = (name: string) =>
  name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "") || "space";

// A name no other space has taken and nothing on disk already uses (APFS ignores case, so neither do we).
export function pickFolder(db: Database, name: string): string {
  const root = config().filesHome;
  const taken = new Set(
    (db.query("SELECT folder FROM spaces WHERE folder IS NOT NULL").all() as { folder: string }[]).map((r) => r.folder.toLowerCase()),
  );
  const onDisk = new Set((existsSync(root) ? readdirSync(root) : []).map((n) => n.toLowerCase()));
  const base = slug(name);
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if (!onDisk.has(candidate) && !taken.has(join(root, candidate).toLowerCase())) return join(root, candidate);
  }
}

// "~/Atrium/weekly-planning" rather than the full path, for messages Nakul reads.
export const tildePath = (p: string): string => {
  const home = homedir();
  return p === home ? "~" : p.startsWith(home + sep) ? `~${p.slice(home.length)}` : p;
};

// Spaces made before the move keep their old hidden folder until boot moves it.
const legacyFolder = (id: string) => join(config().home, "spaces", id);

// A recorded folder that doesn't exist yet while the old one still does means the move hasn't happened: the files
// are still in the old folder, so that's where runs and listings look until a boot moves them.
export function spaceFolder(space: Pick<Space, "id" | "folder">): string {
  const legacy = legacyFolder(space.id);
  if (!space.folder) return legacy;
  return !existsSync(space.folder) && existsSync(legacy) ? legacy : space.folder;
}

// Records the folder's identity, so a later delete only ever touches the very folder Atrium made.
export function pinFolder(db: Database, spaceId: string, dir: string): void {
  const st = lstatSync(dir);
  db.query("UPDATE spaces SET folder_dev = ?, folder_ino = ? WHERE id = ?").run(st.dev, st.ino, spaceId);
}

// Where a run works, made if it isn't there yet. A visible folder Atrium makes here is pinned; one that was already
// there under that name (made by someone else) isn't, and a delete then leaves it alone.
export function ensureSpaceFolder(db: Database, space: Pick<Space, "id" | "folder">): string {
  const dir = spaceFolder(space);
  if (dir !== space.folder) {
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  mkdirSync(dirname(dir), { recursive: true });
  try {
    mkdirSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    return dir;
  }
  pinFolder(db, space.id, dir);
  return dir;
}

const isEmptyDir = (dir: string) => {
  try {
    return readdirSync(dir).length === 0;
  } catch {
    return false;
  }
};

// Boot-time move of general and markets spaces into their visible folders, safe to stop at any point and run
// again. The folder is recorded first, so a crash can never lead to a second pick (and a "-2" folder). Then any
// old folder still on disk is moved into a recorded folder that is missing or empty; one that already has files is
// left alone rather than merged into.
export function migrateSpaceFolders(db: Database): { spaceId: string; from: string; to: string }[] {
  const unnamed = db.query("SELECT id, name FROM spaces WHERE kind != 'repo' AND folder IS NULL ORDER BY created_at, rowid").all() as {
    id: string;
    name: string;
  }[];
  for (const row of unnamed) db.query("UPDATE spaces SET folder = ? WHERE id = ?").run(pickFolder(db, row.name), row.id);
  const rows = db.query("SELECT id, folder FROM spaces WHERE kind != 'repo' AND folder IS NOT NULL ORDER BY created_at, rowid").all() as {
    id: string;
    folder: string;
  }[];
  const moved: { spaceId: string; from: string; to: string }[] = [];
  for (const row of rows) {
    const from = legacyFolder(row.id);
    const to = row.folder;
    try {
      if (finishPartial(from, to)) moved.push({ spaceId: row.id, from, to });
      else if (existsSync(from) && (!existsSync(to) || isEmptyDir(to))) {
        move(from, to);
        moved.push({ spaceId: row.id, from, to });
      } else continue;
      // Atrium made this folder by moving its files there.
      pinFolder(db, row.id, to);
    } catch {
      // The files stay where they are (spaceFolder still finds them) and the next boot tries again.
    }
  }
  return moved;
}

// A cross-volume copy goes to `<to>.partial`; once complete it's renamed to `<to>.copied` (the marker that it is
// whole), then the old folder is deleted, then `.copied` is renamed into place. Left over from an interrupted boot:
// `.copied` is finished (the rest of the old folder is deleted); an unmarked `.partial` may be half done, so it's
// thrown away and the move starts over.
function finishPartial(from: string, to: string): boolean {
  const partial = `${to}.partial`;
  const copied = `${to}.copied`;
  if (existsSync(partial)) rmSync(partial, { recursive: true, force: true });
  if (!existsSync(copied)) return false;
  if (existsSync(to) && !isEmptyDir(to)) return false;
  rmSync(from, { recursive: true, force: true });
  rmSync(to, { recursive: true, force: true });
  renameSync(copied, to);
  return true;
}

// A rename when both sides are on one volume; otherwise the crash-safe copy described above.
function move(from: string, to: string) {
  mkdirSync(dirname(to), { recursive: true });
  // An empty folder made ahead of the move (a run's mkdir) would block the rename.
  if (existsSync(to)) rmSync(to, { recursive: true, force: true });
  try {
    renameSync(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    const partial = `${to}.partial`;
    cpSync(from, partial, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
    renameSync(partial, `${to}.copied`);
    rmSync(from, { recursive: true, force: true });
    renameSync(`${to}.copied`, to);
  }
}
