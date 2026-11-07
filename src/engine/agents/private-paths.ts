import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

// Keeping a private or investing space's Claude run away from bank exports (Downloads, Desktop, Documents, and any
// CSV, OFX or QFX outside its own folder).
//
// The main guard isn't here: such runs have no Bash (only a private repo keeps its test commands), and Claude's file
// tools are fenced to the working directory with permissions.blockReadsOutsideWorkingDirectories (see claude.ts).
// What's here is the sandbox's denyRead, which only Bash and its children ever meet:
// - With no Bash, the whole home folder, /Users/Shared and /Volumes are denied and only the cwd is re-opened
//   (sandbox.filesystem.allowRead re-opens a narrower plain path inside a denied one).
// - With Bash (a private repo), its tools still need the home folder, so the deny walks down from each root to the
//   cwd and covers every sibling's exports at every level. Paths are real paths, and a symlinked folder is denied as
//   the link and as its target. A folder that can't be listed is denied whole (fail closed).
//
// Pattern syntax (sandbox.filesystem on macOS, and Read permission rules): `*`, `?`, `**` and bracket classes such
// as `[cC]` are wildcards, so `*.[cC][sS][vV]` matches every case of ".csv". A wildcard deny can't be re-opened.
export const EXPORT_GLOBS = ["*.[cC][sS][vV]", "*.[oO][fF][xX]", "*.[qQ][fF][xX]"];
export const PRIVATE_FOLDERS = ["Downloads", "Desktop", "Documents"];
const SHARED_ROOTS = ["/Users/Shared", "/Volumes"];
const OTHER_ROOTS = [...SHARED_ROOTS, "/tmp", "/private/tmp", "/private/var/folders"];

const inside = (path: string, dir: string) => path === dir || path.startsWith(dir + sep);
const exports = (dir: string) => EXPORT_GLOBS.map((g) => join(dir, "**", g));
const filesIn = (dir: string) => EXPORT_GLOBS.map((g) => join(dir, g));
const real = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

// The entry itself, plus its target when it's a symlink.
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

function walk(root: string, keep: string, closeAll: (dir: string) => boolean, out: string[]): void {
  if (!inside(keep, root)) {
    out.push(...(closeAll(root) ? [root] : exports(root)));
    return;
  }
  if (root === keep) return;
  const entries = list(root);
  if (entries === null) {
    console.warn(`Atrium couldn't list ${root}; Claude's sandbox denies every bank export under it.`);
    out.push(...exports(root));
    return;
  }
  out.push(...filesIn(root));
  for (const name of entries) {
    const { paths, dir } = aliases(join(root, name));
    if (!dir) continue;
    const toward = paths.find((p) => inside(keep, p));
    const close = paths.some(closeAll);
    for (const p of paths) {
      if (p === toward) walk(p, keep, closeAll, out);
      else out.push(...(close ? [p] : exports(p)));
    }
  }
}

export type PrivateReads = { denyRead: string[]; allowRead: string[] };

export function privateReads(cwd: string, opts: { bash: boolean; home?: string }): PrivateReads {
  const home = real(opts.home ?? homedir());
  const keep = real(cwd);
  const privateFolders = PRIVATE_FOLDERS.map((f) => join(home, f));
  if (!opts.bash) return { denyRead: [home, ...SHARED_ROOTS], allowRead: [keep] };
  const closeAll = (dir: string) => privateFolders.some((f) => inside(real(dir), f) || inside(dir, f));
  const out: string[] = [];
  if (list(home) === null) {
    console.warn(`Atrium couldn't list ${home}; Claude's sandbox denies every bank export in it.`);
    out.push(...privateFolders, ...exports(home));
  } else walk(home, keep, closeAll, out);
  for (const root of OTHER_ROOTS) walk(real(root), keep, () => false, out);
  for (const f of privateFolders) if (!inside(keep, f) && !out.includes(f)) out.push(f);
  return { denyRead: [...new Set(out)], allowRead: [] };
}

// Read deny rules for Claude's own file tools, beside the working-directory fence: the three private folders,
// unless the run works inside one.
export function privateReadRules(cwd: string, home: string = homedir()): string[] {
  const keep = real(cwd);
  return PRIVATE_FOLDERS.map((f) => join(real(home), f))
    .filter((f) => !inside(keep, f))
    .flatMap((f) => [`Read(/${f})`, `Read(/${f}/**)`]);
}
