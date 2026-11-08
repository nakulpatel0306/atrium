import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
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

const firstWord = (full: string | null | undefined): string | null => full?.trim().split(/\s+/)[0] || null;

export const suggestedName = (): string | null => firstWord(macFullName());
// The name set in Settings, else the Mac account's first name, else none.
export const userName = (db: Database): string | null => firstWord(getSetting(db, NAME_KEY)) ?? suggestedName();
export const storedName = (db: Database): string | null => getSetting(db, NAME_KEY) || null;

export function setUserName(db: Database, raw: string): void {
  const name = raw.replace(/[\p{Cc}\p{Cf}]/gu, "").trim();
  if (name.length > 40) throw new Error("Keep your name under 40 characters.");
  setSetting(db, NAME_KEY, name);
}

// Where the setting is read back into config(); called when a database opens and when the setting changes.
export function applyProjectsRoot(db: Database): void {
  setChosenProjectsRoot(getSetting(db, PROJECTS_KEY) || null);
}

export function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;
}

export function setProjectsRoot(db: Database, raw: string): string {
  const path = resolve(expandHome(raw.trim()));
  if (!raw.trim() || !isAbsolute(expandHome(raw.trim()))) throw new Error("Give a folder path, like ~/Projects.");
  if (path === sep) throw new Error("Pick a folder inside your home folder, not the whole disk.");
  if (existsSync(path) && !statSync(path).isDirectory()) throw new Error("That path is a file, not a folder.");
  setSetting(db, PROJECTS_KEY, path);
  applyProjectsRoot(db);
  return path;
}

// Creates the projects folder the first time something needs it, and says so.
export function ensureProjectsRoot(): string {
  const root = config().projectsRoot;
  if (!existsSync(root)) {
    mkdirSync(root, { recursive: true });
    console.log(`Created your projects folder at ${root}. New projects and clones go here; change it in Settings.`);
  }
  return root;
}

// One-time, additive: an install whose spaces already live under the old default folder keeps using it, by
// writing that folder into the setting. Installs that already chose a folder, or set the environment variable,
// are left alone.
export function migrateProjectsRoot(db: Database, legacy: string): boolean {
  if (getSetting(db, PROJECTS_KEY) || process.env.ATRIUM_PROJECTS_ROOT || !existsSync(legacy)) return false;
  const rows = db.query("SELECT repo_path FROM spaces WHERE repo_path IS NOT NULL").all() as { repo_path: string }[];
  const inside = rows.some((r) => r.repo_path === legacy || r.repo_path.startsWith(legacy + sep));
  if (!inside) return false;
  setSetting(db, PROJECTS_KEY, legacy);
  return true;
}
