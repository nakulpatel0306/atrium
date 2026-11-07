import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

// Where bank and card exports land: a private or investing space's Claude run reads none of it. Downloads, Desktop
// and Documents are closed outright, and CSV, OFX and QFX files everywhere else outside the run's own folder.
//
// Pattern syntax (Claude Code's sandbox.filesystem.denyRead on macOS, and Read permission rules): `*`, `?`, `**` and
// bracket classes like `[cC]` are wildcards, so `*.[cC][sS][vV]` matches every case of ".csv". A wildcard deny
// can't be re-opened for one folder, so instead of one glob per root the deny walks down from each root to the
// cwd and covers every sibling at every level: only the cwd's own subtree stays open. Symlinked folders are denied
// as the link and as its target. If a folder can't be listed the whole of it is denied (fail closed).
export const EXPORT_GLOBS = ["*.[cC][sS][vV]", "*.[oO][fF][xX]", "*.[qQ][fF][xX]"];
export const PRIVATE_FOLDERS = ["Downloads", "Desktop", "Documents"];
const OTHER_ROOTS = ["/Users/Shared", "/Volumes", "/tmp", "/private/tmp", "/private/var/folders"];

const inside = (path: string, dir: string) => path === dir || path.startsWith(dir + sep);
const exports = (dir: string) => EXPORT_GLOBS.map((g) => join(dir, "**", g));
const filesIn = (dir: string) => EXPORT_GLOBS.map((g) => join(dir, g));

// The entry itself, plus its target when it's a symlink to a folder.
function aliases(path: string): { paths: string[]; dir: boolean } {
  try {
    const link = lstatSync(path).isSymbolicLink();
    const dir = statSync(path).isDirectory();
    return { paths: link ? [path, realpathSync(path)] : [path], dir };
  } catch {
    return { paths: [path], dir: false };
  }
}

function list(dir: string): string[] | null {
  try {
    return readdirSync(dir);
  } catch {
    return null;
  }
}

// Every export under root, except inside `keep` (the cwd); folders under `privateRoot` are closed outright.
function walk(root: string, keep: string, closeAll: (dir: string) => boolean, out: string[]): void {
  if (!inside(keep, root)) {
    out.push(...(closeAll(root) ? [root] : exports(root)));
    return;
  }
  if (root === keep) return;
  const entries = list(root);
  if (entries === null) {
    // Fail closed: the cwd's ancestors can't be listed, so their exports are denied, cwd and all.
    console.warn(`Atrium couldn't list ${root}; Claude's sandbox denies every bank export under it.`);
    out.push(...exports(root));
    return;
  }
  out.push(...filesIn(root));
  const next = join(root, relative(root, keep).split(sep)[0]!);
  for (const name of entries) {
    const path = join(root, name);
    const { paths, dir } = aliases(path);
    if (!dir) continue;
    if (path === next) walk(path, keep, closeAll, out);
    else for (const p of paths) out.push(...(closeAll(p) ? [p] : exports(p)));
  }
}

// Absolute paths and globs for the sandbox's denyRead; the same list becomes Read deny rules for Claude's own tool.
export function privateDenyPaths(cwd: string, home: string = homedir()): string[] {
  const keep = resolve(cwd);
  const privateFolders = PRIVATE_FOLDERS.map((f) => join(home, f));
  // Inside Downloads, Desktop or Documents, every sibling is closed, not just its exports.
  const closeAll = (dir: string) => privateFolders.some((f) => inside(dir, f));
  const out: string[] = [];
  if (list(home) === null) {
    console.warn(`Atrium couldn't list ${home}; Claude's sandbox denies every bank export in it.`);
    out.push(...privateFolders, ...exports(home));
  } else walk(home, keep, closeAll, out);
  for (const root of OTHER_ROOTS) walk(root, keep, () => false, out);
  // Never empty, and never missing the three folders unless the run works inside one of them.
  for (const f of privateFolders) if (!inside(keep, f) && !out.includes(f)) out.push(f);
  return [...new Set(out)];
}
