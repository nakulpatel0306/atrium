import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";

const TRUNCATION_MARKER = "[atrium] transcript truncated at 5 MB";

export function openTranscript(runId: string): { path: string; append(chunk: string): void; close(): void } {
  const { transcriptsDir, transcriptFileCapBytes } = config();
  mkdirSync(transcriptsDir, { recursive: true });
  const path = join(transcriptsDir, `${runId}.log`);
  let size = existsSync(path) ? statSync(path).size : 0;
  let truncated = false;
  return {
    path,
    append(chunk) {
      if (truncated) return;
      const bytes = Buffer.byteLength(chunk);
      if (size + bytes > transcriptFileCapBytes) {
        // Leading newline keeps the marker on its own line when the last chunk had none.
        appendFileSync(path, `\n${TRUNCATION_MARKER}\n`);
        truncated = true;
        return;
      }
      appendFileSync(path, chunk);
      size += bytes;
    },
    close() {
      truncated = true;
    },
  };
}

function transcriptFiles(): { path: string; size: number; mtimeMs: number }[] {
  const dir = config().transcriptsDir;
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map((name) => {
    const path = join(dir, name);
    const st = statSync(path);
    return { path, size: st.size, mtimeMs: st.mtimeMs };
  });
}

export function enforceTranscriptCap(capBytes: number = config().transcriptCapBytes): { deleted: string[] } {
  const files = transcriptFiles().sort((a, b) => a.mtimeMs - b.mtimeMs);
  let total = files.reduce((n, f) => n + f.size, 0);
  const deleted: string[] = [];
  for (const f of files) {
    if (total <= capBytes) break;
    unlinkSync(f.path);
    total -= f.size;
    deleted.push(f.path);
  }
  return { deleted };
}

export function atriumDiskUsage(): { totalBytes: number; transcriptsBytes: number; dbBytes: number } {
  const transcriptsBytes = transcriptFiles().reduce((n, f) => n + f.size, 0);
  const { dbPath } = config();
  // WAL and shm sidecars count toward what Atrium occupies on disk.
  const dbBytes = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].reduce((n, p) => n + (existsSync(p) ? statSync(p).size : 0), 0);
  return { totalBytes: transcriptsBytes + dbBytes, transcriptsBytes, dbBytes };
}
