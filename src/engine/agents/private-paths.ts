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
// Bank exports and statements: CSV, OFX, QFX, QBO, PDF, Excel, Numbers and ZIP, in any case.
export const EXPORT_GLOBS = [
  "*.[cC][sS][vV]", "*.[oO][fF][xX]", "*.[qQ][fF][xX]", "*.[qQ][bB][oO]", "*.[pP][dD][fF]",
  "*.[xX][lL][sS]", "*.[xX][lL][sS][xX]", "*.[nN][uU][mM][bB][eE][rR][sS]", "*.[zZ][iI][pP]",
];
// Cloud and mail copies of the same files (iCloud Drive mirrors Desktop and Documents here), closed whole.
export const CLOUD_FOLDERS = ["Library/Mobile Documents", "Library/CloudStorage", "Library/Mail", "Library/Containers/com.apple.mail"];
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

const MAX_DEPTH = 16;

type Visit = {
  // A folder on the way down to the cwd.
  ancestor(dir: string): void;
  // Anything beside the way down: a file or folder, as every path it goes by (a link and its target). `closed` is a
  // link that points back up at an ancestor.
  sibling(paths: string[], dir: boolean, closed: boolean): void;
  // A folder on the way down that couldn't be listed, or one too deep.
  unlisted(dir: string): void;
};

// From root down to keep (both real paths, keep strictly inside root), visiting what lies beside the path. Only a
// folder strictly deeper than the current one is entered, each real path once, at most 16 levels: a symlink cycle
// ends instead of looping.
function walkTo(root: string, keep: string, visit: Visit, depth = 0, seen = new Set<string>()): void {
  if (depth > MAX_DEPTH || seen.has(root)) return visit.unlisted(root);
  seen.add(root);
  visit.ancestor(root);
  const entries = list(root);
  if (entries === null) return visit.unlisted(root);
  for (const name of entries) {
    const { paths, dir } = aliases(join(root, name));
    const target = paths.at(-1)!;
    const deeper = target.startsWith(root + sep);
    if (dir && deeper && inside(keep, target)) {
      if (target !== keep) walkTo(target, keep, visit, depth + 1, seen);
      // The link's own name (if any) is beside the path too.
      if (paths.length > 1) visit.sibling(paths.slice(0, -1), dir, false);
    } else if (dir && inside(keep, target)) {
      // A link back up at an ancestor: the link is closed, but its target holds the cwd and stays as it is.
      visit.sibling(paths.slice(0, -1), dir, true);
    } else visit.sibling(paths, dir, false);
  }
}

// Every export under root except inside keep; folders under a private folder are closed outright.
function denyExports(root: string, keep: string, closeAll: (dir: string) => boolean, out: string[]): void {
  if (!inside(keep, root)) {
    out.push(...(closeAll(root) ? [root] : exports(root)));
    return;
  }
  if (root === keep) return;
  walkTo(root, keep, {
    ancestor: (dir) => out.push(...filesIn(dir)),
    sibling: (paths, dir, closed) => {
      if (!dir) return;
      const close = closed || paths.some(closeAll);
      for (const p of paths) out.push(...(close ? [p] : exports(p)));
    },
    unlisted: (dir) => {
      console.warn(`Atrium couldn't list ${dir}; Claude's sandbox denies every bank export under it.`);
      out.push(...exports(dir));
    },
  });
}

export type PrivateReads = { denyRead: string[]; allowRead: string[] };

export function privateReads(cwd: string, opts: { bash: boolean; home?: string }): PrivateReads {
  const home = real(opts.home ?? homedir());
  const keep = real(cwd);
  const privateFolders = PRIVATE_FOLDERS.map((f) => join(home, f));
  const cloud = CLOUD_FOLDERS.map((f) => join(home, f)).filter((f) => !inside(keep, f));
  if (!opts.bash) return { denyRead: [home, ...cloud, ...SHARED_ROOTS], allowRead: [keep] };
  const closed = [...privateFolders, ...cloud];
  const closeAll = (dir: string) => closed.some((f) => inside(real(dir), f) || inside(dir, f));
  const out: string[] = [];
  if (list(home) === null) {
    console.warn(`Atrium couldn't list ${home}; Claude's sandbox denies every bank export in it.`);
    out.push(...privateFolders, ...exports(home));
  } else denyExports(home, keep, closeAll, out);
  for (const root of OTHER_ROOTS) denyExports(real(root), keep, () => false, out);
  for (const f of [...privateFolders, ...cloud]) if (!inside(keep, f) && !out.includes(f)) out.push(f);
  return { denyRead: [...new Set(out)], allowRead: [] };
}

// Read deny rules (they cover Read, Glob and Grep) beside the working-directory fence, so a CLI that ignored the fence
// would still be kept out: the whole of /Users/Shared and /Volumes, and everything in the home folder beside the
// way down to the cwd. A deny can't be re-opened, so none of them ever covers the cwd.
export function privateReadRules(cwd: string, home: string = homedir()): string[] {
  const keep = real(cwd);
  const rule = (p: string) => [`Read(/${p})`, `Read(/${p}/**)`];
  const out: string[] = [];
  const deny = (root: string) => {
    if (!inside(keep, root)) return out.push(...rule(root));
    if (root === keep) return;
    walkTo(root, keep, {
      ancestor: () => {},
      sibling: (paths) => paths.forEach((p) => out.push(...rule(p))),
      // Can't list it without covering the cwd, so the fence alone guards it.
      unlisted: (dir) => console.warn(`Atrium couldn't list ${dir} to deny Claude's reads beside its folder.`),
    });
  };
  for (const root of [real(home), ...SHARED_ROOTS]) deny(root);
  return [...new Set(out)];
}
