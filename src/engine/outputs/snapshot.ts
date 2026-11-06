import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, type Stats } from "node:fs";
import { join } from "node:path";
import { isEnvPath } from "../envpath";

export type Entry = { size: number; mtimeMs: number; hash: string | null };
// `last` is the last path the walk reached, so a capped snapshot says how far it got.
// `fileCapHit` says the walk stopped at maxFiles, and `last` is the last path it reached, so a diff knows how far
// it got. A depth cap also sets `truncated`, but the walk carried on past it.
export type Snapshot = { files: Map<string, Entry>; truncated: boolean; fileCapHit: boolean; last: string | null };
export type FileChange = { path: string; change: "created" | "changed" | "deleted"; size: number | null };

// hashTotalBytes caps the reading one snapshot does (a folder of 2,000 one-megabyte files would otherwise be read
// in full, twice per run); files past it are compared by size and mtime.
export const SNAPSHOT_LIMITS = { hashBytes: 1_048_576, hashTotalBytes: 64 * 1024 * 1024, maxFiles: 2_000, maxDepth: 8 };

// Dot-entries are tool state (.claude/, .git, .DS_Store), never something an agent made for Nakul, and Atrium
// never reads a .env file to show it.
export const isHiddenPath = (rel: string): boolean => rel.split("/").some((seg) => seg.startsWith(".")) || isEnvPath(rel);

// What a folder holds, walked without following links: a link can point anywhere, so it is never listed.
export function snapshotFolder(
  dir: string,
  opts: { limits?: Partial<typeof SNAPSHOT_LIMITS>; skipTop?: string[] } = {},
): Snapshot {
  const limits = { ...SNAPSHOT_LIMITS, ...opts.limits };
  const skip = new Set(opts.skipTop ?? []);
  const files = new Map<string, Entry>();
  let truncated = false;
  // Too deep only skips that branch; too many files ends the walk.
  let full = false;
  let hashed = 0;
  let last: string | null = null;

  const walk = (abs: string, rel: string, depth: number) => {
    let names: string[];
    try {
      names = readdirSync(abs).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (full) return;
      const childRel = rel ? `${rel}/${name}` : name;
      if (isHiddenPath(childRel) || (!rel && skip.has(name))) continue;
      const childAbs = join(abs, name);
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(childAbs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (depth >= limits.maxDepth) truncated = true;
        else walk(childAbs, childRel, depth + 1);
      } else if (st.isFile()) {
        if (files.size >= limits.maxFiles) {
          truncated = full = true;
          return;
        }
        const hashIt = st.size <= limits.hashBytes && hashed + st.size <= limits.hashTotalBytes;
        if (hashIt) hashed += st.size;
        files.set(childRel, { size: st.size, mtimeMs: st.mtimeMs, hash: hashIt ? hashOf(childAbs, st, limits.hashBytes) : null });
        last = childRel;
      }
    }
  };
  walk(dir, "", 0);
  return { files, truncated, fileCapHit: full, last };
}

function hashOf(path: string, seen: Stats, cap: number): string | null {
  const bytes = readRegular(path, seen, cap);
  return bytes ? Bun.hash(bytes).toString(16) : null;
}

// The engine isn't sandboxed and the folder is an agent's, so the path may be swapped for a link (or another
// file) between the walk's lstat and this read. The open never follows a link, and the opened file must be the
// very one the walk saw. Reads at most `cap` bytes; null when it isn't that regular file or is bigger.
export function readRegular(path: string, seen: Pick<Stats, "dev" | "ino">, cap: number): Uint8Array | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.dev !== seen.dev || st.ino !== seen.ino || st.size > cap) return null;
    const buf = new Uint8Array(st.size);
    let off = 0;
    while (off < buf.length) {
      const n = readSync(fd, buf, off, buf.length - off, off);
      if (n === 0) break;
      off += n;
    }
    return buf.subarray(0, off);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

// The walk's order: names sorted within each folder, a folder's contents before the names after it.
function walkOrder(x: string, y: string): number {
  const a = x.split("/");
  const b = y.split("/");
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  return a.length - b.length;
}

export function diffSnapshots(before: Snapshot, after: Snapshot): FileChange[] {
  const out: FileChange[] = [];
  // A capped before-walk never saw what lies past its last path, so nothing there can be called new.
  const seen = (path: string) => !before.fileCapHit || (before.last !== null && walkOrder(path, before.last) <= 0);
  for (const [path, a] of after.files) {
    if (!seen(path)) continue;
    const b = before.files.get(path);
    if (!b) out.push({ path, change: "created", size: a.size });
    else if (changed(b, a)) out.push({ path, change: "changed", size: a.size });
  }
  // A capped walk didn't see the whole folder, so a missing path may simply be one it never reached.
  if (!after.truncated) for (const path of before.files.keys()) if (!after.files.has(path)) out.push({ path, change: "deleted", size: null });
  return out.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
}

function changed(b: Entry, a: Entry): boolean {
  if (b.size !== a.size) return true;
  if (b.hash !== null && a.hash !== null) return b.hash !== a.hash;
  return b.mtimeMs !== a.mtimeMs;
}
