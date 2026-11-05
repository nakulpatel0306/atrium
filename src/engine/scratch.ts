import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, type Stats, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";

const RUN_CAP_BYTES = 50 * 1024 * 1024;

export type KeptScratch = { files: number; truncated: boolean; skipped: number };

// A scratch run's folder is deleted when the run ends, so whatever the agent made there is copied out first.
// The copy runs with Nakul's full privileges after the agent's process group is gone, but on a tree the agent
// built, so nothing in it is trusted: symlinks, hard links and anything swapped between the walk and the open
// are skipped, each file is cut at the transcript cap, and copying stops once the run's total cap is reached.
export function keepScratch(
  src: string,
  dest: string,
  caps: { file: number; total: number } = { file: config().transcriptFileCapBytes, total: RUN_CAP_BYTES },
): KeptScratch {
  const root = realpathSync(src);
  let left = caps.total;
  const kept: KeptScratch = { files: 0, truncated: false, skipped: 0 };

  function walk(dir: string, to: string) {
    for (const name of readdirSync(dir).sort()) {
      const source = join(dir, name);
      const target = join(to, name);
      let st: Stats;
      try {
        st = lstatSync(source);
      } catch {
        kept.skipped++;
        continue;
      }
      if (st.isDirectory()) {
        // A real directory whose resolved path is exactly where the walk expects it: nothing on the way is a link.
        if (realpathSync(source) === source) walk(source, target);
        else kept.skipped++;
      } else if (!st.isFile() || !copyFile(source, target, st)) {
        kept.skipped++;
      }
    }
  }

  // False when the file fails a check; a file left out only for the caps counts as truncated instead.
  function copyFile(source: string, target: string, seen: Stats): boolean {
    let fd: number;
    try {
      fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      return false;
    }
    try {
      const st = fstatSync(fd);
      // A second link could be a secret the agent linked in; a changed inode means the path was swapped.
      if (!st.isFile() || st.nlink !== 1 || st.dev !== seen.dev || st.ino !== seen.ino) return false;
      const take = Math.min(st.size, caps.file, left);
      if (take < st.size) kept.truncated = true;
      if (take === 0 && st.size > 0) return true;
      const buf = Buffer.alloc(take);
      const read = take > 0 ? readSync(fd, buf, 0, take, 0) : 0;
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, buf.subarray(0, read), { flag: "wx" });
      left -= read;
      kept.files++;
      return true;
    } finally {
      closeSync(fd);
    }
  }

  walk(root, dest);
  return kept;
}
