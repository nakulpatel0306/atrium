import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

// Where bank and card exports land: a private or investing space's Claude run reads none of it. Downloads, Desktop
// and Documents are closed outright, and CSV, OFX and QFX files everywhere else outside the run's own folder. A
// wildcard deny can't be re-opened for one folder, so the globs are rooted at every place but the one holding the cwd.
export const EXPORT_EXTENSIONS = ["csv", "CSV", "ofx", "OFX", "qfx", "QFX"];
export const PRIVATE_FOLDERS = ["Downloads", "Desktop", "Documents"];
const OTHER_ROOTS = ["/Volumes", "/tmp", "/private/tmp", "/private/var/folders"];

const inside = (path: string, dir: string) => path === dir || path.startsWith(dir + sep);

function homeEntries(home: string): string[] {
  try {
    return readdirSync(home, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !PRIVATE_FOLDERS.includes(e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

// Absolute paths and globs for the sandbox's denyRead; the same list becomes Read deny rules for Claude's own tool.
export function privateDenyPaths(cwd: string, home: string = homedir()): string[] {
  const here = resolve(cwd);
  const folders = PRIVATE_FOLDERS.map((f) => join(home, f)).filter((f) => !inside(here, f));
  const roots = [...homeEntries(home).map((e) => join(home, e)), ...OTHER_ROOTS].filter((r) => !inside(here, r));
  const globs = EXPORT_EXTENSIONS.flatMap((ext) => [join(home, `*.${ext}`), ...roots.map((r) => join(r, "**", `*.${ext}`))]);
  return [...folders, ...globs];
}
