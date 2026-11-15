import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

// A file an agent may have written, read without a gap between checking and reading: opened once without following a
// link (and without blocking on a FIFO), checked through that same descriptor, and read only up to the cap from it.
// A file that grew past the cap after the check still reads as too large.
export type CappedRead = { ok: true; bytes: Buffer } | { ok: false; why: "missing" | "not-file" | "too-large" | "unreadable" };

export function readCapped(path: string, cap: number): CappedRead {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // A link is refused by O_NOFOLLOW with ELOOP.
    return { ok: false, why: code === "ENOENT" || code === "ENOTDIR" ? "missing" : code === "ELOOP" ? "not-file" : "unreadable" };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { ok: false, why: "not-file" };
    if (st.size > cap) return { ok: false, why: "too-large" };
    const buf = Buffer.alloc(cap + 1);
    let n = 0;
    while (n < buf.length) {
      const got = readSync(fd, buf, n, buf.length - n, n);
      if (got === 0) break;
      n += got;
    }
    return n > cap ? { ok: false, why: "too-large" } : { ok: true, bytes: buf.subarray(0, n) };
  } catch {
    return { ok: false, why: "unreadable" };
  } finally {
    closeSync(fd);
  }
}
