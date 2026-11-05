import { closeSync, copyFileSync, mkdirSync, openSync, readdirSync, readSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";

const RUN_CAP_BYTES = 50 * 1024 * 1024;

// A scratch run's folder is deleted when the run ends, so whatever the agent made there is copied out first.
// Symlinks are skipped (they could point anywhere, secrets included), each file is cut at the transcript cap,
// and copying stops once the run's total cap is reached.
export function keepScratch(
  src: string,
  dest: string,
  caps: { file: number; total: number } = { file: config().transcriptFileCapBytes, total: RUN_CAP_BYTES },
): { files: number; truncated: boolean } {
  let left = caps.total;
  let files = 0;
  let truncated = false;

  function walk(from: string, to: string) {
    for (const entry of readdirSync(from, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const source = join(from, entry.name);
      const target = join(to, entry.name);
      if (entry.isDirectory()) walk(source, target);
      if (!entry.isFile()) continue;
      const size = statSync(source).size;
      const take = Math.min(size, caps.file, left);
      if (take < size) truncated = true;
      if (take === 0 && size > 0) continue;
      mkdirSync(to, { recursive: true });
      if (take === size) copyFileSync(source, target);
      else writeFileSync(target, head(source, take));
      left -= take;
      files++;
    }
  }

  walk(src, dest);
  return { files, truncated };
}

function head(path: string, bytes: number): Buffer {
  const buf = Buffer.alloc(bytes);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, bytes, 0);
  } finally {
    closeSync(fd);
  }
  return buf;
}
