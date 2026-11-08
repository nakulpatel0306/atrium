import type { Database } from "bun:sqlite";
import { Database as Sqlite } from "bun:sqlite";
import { accessSync, constants, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { config, setChosenProjectsRoot } from "./config";
import { getSetting, setSetting } from "./settings";

// Everything personal about the person using Atrium lives in the settings table, never in source.
export const NAME_KEY = "user.name";
export const PROJECTS_KEY = "projects.root";
// Atrium counts in Canadian dollars everywhere. It is shown in Settings so that is plain, but it can't be changed yet.
export const HOME_CURRENCY = "CAD";

let macName: string | null | undefined;
// The Mac account's full name. ATRIUM_MAC_NAME replaces it (empty for none) so tests and demos never read the real one.
export function macFullName(): string | null {
  const env = process.env.ATRIUM_MAC_NAME;
  if (env !== undefined) return env.trim() || null;
  if (macName === undefined) {
    const r = Bun.spawnSync(["id", "-F"], { stdout: "pipe", stderr: "pipe" });
    macName = r.exitCode === 0 ? r.stdout.toString().trim() || null : null;
  }
  return macName;
}

// Account names a Mac gets by default; none of them is how anyone wants to be greeted.
const GENERIC_NAMES = new Set(["admin", "administrator", "root", "user", "guest", "mac"]);
const firstWord = (full: string | null | undefined): string | null => full?.trim().split(/\s+/)[0] || null;
const realFirstName = (full: string | null | undefined): string | null => {
  const w = firstWord(full);
  return w && !GENERIC_NAMES.has(w.toLowerCase()) ? w : null;
};

export const suggestedName = (): string | null => realFirstName(macFullName());
// The name set in Settings, else the Mac account's first name, else none.
export const userName = (db: Database): string | null => firstWord(getSetting(db, NAME_KEY)) ?? suggestedName();
export const storedName = (db: Database): string | null => getSetting(db, NAME_KEY) || null;

export function cleanUserName(raw: string): string {
  const name = raw.replace(/[\p{Cc}\p{Cf}]/gu, "").trim();
  if (name.length > 40) throw new Error("Keep your name under 40 characters.");
  return name;
}

export const setUserName = (db: Database, raw: string): void => setSetting(db, NAME_KEY, cleanUserName(raw));

// Where the setting is read back into config(); called when a database opens and when the setting changes.
export function applyProjectsRoot(db: Database): void {
  setChosenProjectsRoot(getSetting(db, PROJECTS_KEY) || null);
}

export function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;
}

// Checks a folder without creating it: inside the home folder, and either a folder Atrium can write to or one it can create.
export function checkProjectsRoot(raw: string): string {
  const typed = expandHome(raw.trim());
  if (!raw.trim() || !isAbsolute(typed)) throw new Error("Give a folder path, like ~/Projects.");
  const path = resolve(typed);
  const home = process.env.ATRIUM_USER_HOME ?? homedir();
  if (path === home || !path.startsWith(home + sep)) throw new Error("Pick a folder inside your home folder, like ~/Projects.");
  let probe = path;
  while (!existsSync(probe)) probe = dirname(probe);
  if (!statSync(probe).isDirectory()) throw new Error("That path is a file, not a folder.");
  try {
    accessSync(probe, constants.W_OK);
  } catch {
    throw new Error("Atrium can't write to that folder. Pick one you own, like ~/Projects.");
  }
  return path;
}

export function setProjectsRoot(db: Database, raw: string): string {
  const path = checkProjectsRoot(raw);
  setSetting(db, PROJECTS_KEY, path);
  applyProjectsRoot(db);
  return path;
}

// For commands that run without opening the database (atrium doctor): the saved folder, read-only, if there is one.
export function applyProjectsRootFromFile(dbPath: string): void {
  if (!existsSync(dbPath)) return;
  let db: Sqlite | null = null;
  try {
    db = new Sqlite(dbPath, { readonly: true });
    applyProjectsRoot(db);
  } catch {
    // A database that can't be read leaves the default in place.
  } finally {
    db?.close();
  }
}

const hasCheckout = (folder: string): boolean => {
  try {
    return readdirSync(folder, { withFileTypes: true }).some((e) => e.isDirectory() && existsSync(join(folder, e.name, ".git")));
  } catch {
    return false;
  }
};

// Creates the projects folder the first time something needs it, and says so.
export function ensureProjectsRoot(): string {
  const root = config().projectsRoot;
  if (!existsSync(root)) {
    mkdirSync(root, { recursive: true });
    console.log(`Created your projects folder at ${root}. New projects and clones go here; change it in Settings.`);
  }
  return root;
}

// One-time, additive: an install whose spaces already live under the old default folder, or whose old folder
// already holds git checkouts, keeps using it, by writing that folder into the setting. Installs that already chose a folder, or set the environment variable,
// are left alone.
export function migrateProjectsRoot(db: Database, legacy: string): boolean {
  if (getSetting(db, PROJECTS_KEY) || process.env.ATRIUM_PROJECTS_ROOT || !existsSync(legacy)) return false;
  const rows = db.query("SELECT repo_path FROM spaces WHERE repo_path IS NOT NULL").all() as { repo_path: string }[];
  const inside = rows.some((r) => r.repo_path === legacy || r.repo_path.startsWith(legacy + sep));
  if (!inside && !hasCheckout(legacy)) return false;
  setSetting(db, PROJECTS_KEY, legacy);
  return true;
}
