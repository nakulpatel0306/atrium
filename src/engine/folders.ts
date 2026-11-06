import type { Database } from "bun:sqlite";
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
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

export function spaceFolder(space: Pick<Space, "id" | "folder">): string {
  return space.folder ?? legacyFolder(space.id);
}

// Boot-time move of every general and markets space without a recorded folder. A space whose move fails keeps
// its old folder (spaceFolder still finds it) and is tried again on the next boot.
export function migrateSpaceFolders(db: Database): { spaceId: string; from: string; to: string }[] {
  const rows = db.query("SELECT id, name FROM spaces WHERE kind != 'repo' AND folder IS NULL ORDER BY created_at, rowid").all() as {
    id: string;
    name: string;
  }[];
  const moved: { spaceId: string; from: string; to: string }[] = [];
  for (const row of rows) {
    const to = pickFolder(db, row.name);
    const from = legacyFolder(row.id);
    if (existsSync(from)) {
      try {
        move(from, to);
      } catch {
        continue;
      }
      moved.push({ spaceId: row.id, from, to });
    }
    db.query("UPDATE spaces SET folder = ? WHERE id = ?").run(to, row.id);
  }
  return moved;
}

// A rename when both sides are on one volume; otherwise a copy that keeps links as links, then the old copy goes.
function move(from: string, to: string) {
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    cpSync(from, to, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
    rmSync(from, { recursive: true, force: true });
  }
}
