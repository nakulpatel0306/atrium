import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isEnvPath } from "../envpath";

export type Entry = { size: number; mtimeMs: number; hash: string | null };
export type Snapshot = { files: Map<string, Entry>; truncated: boolean };
export type FileChange = { path: string; change: "created" | "changed" | "deleted"; size: number | null };

export const SNAPSHOT_LIMITS = { hashBytes: 1_048_576, maxFiles: 2_000, maxDepth: 8 };

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
        files.set(childRel, { size: st.size, mtimeMs: st.mtimeMs, hash: st.size <= limits.hashBytes ? hashOf(childAbs) : null });
      }
    }
  };
  walk(dir, "", 0);
  return { files, truncated };
}

function hashOf(path: string): string | null {
  try {
    return Bun.hash(readFileSync(path)).toString(16);
  } catch {
    return null;
  }
}

export function diffSnapshots(before: Snapshot, after: Snapshot): FileChange[] {
  const out: FileChange[] = [];
  for (const [path, a] of after.files) {
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
