import { format } from "node:util";
import { closeSync, openSync, readSync, statSync, writeFileSync } from "node:fs";

// Rewrites in place (same inode) because launchd already holds the file open for appending.
export function trimLog(path: string, maxBytes: number): void {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return;
  }
  if (size <= maxBytes) return;
  const buf = Buffer.alloc(maxBytes);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, maxBytes, size - maxBytes);
  } finally {
    closeSync(fd);
  }
  writeFileSync(path, buf);
}

// launchd writes stdout and stderr to engine.log as they are, so each line gets its time here.
export function stampConsole(now: () => Date = () => new Date()): void {
  for (const name of ["log", "error"] as const) {
    const write = console[name].bind(console);
    console[name] = (...args: unknown[]) => write(`${now().toISOString()} ${format(...args)}`);
  }
}
