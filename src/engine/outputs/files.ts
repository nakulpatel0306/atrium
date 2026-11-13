import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from "node:fs";
import { join, sep } from "node:path";
import { showBlob } from "../git";
import { bytes as sizeText } from "../text";
import { extOf, type FileKind, IMAGE_TYPES, kindOf, looksLikeText } from "./kinds";
import { isHiddenPath } from "./snapshot";

export { type FileKind, kindOf } from "./kinds";

export class FileRefused extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 413,
    message: string,
  ) {
    super(message);
  }
}

export const PREVIEW_CAP = 262_144;
export const RAW_CAP = 10_485_760;


const BAD_PATH = "That isn't a file Atrium can show.";
const GONE = "That file isn't in the folder anymore. It may have been moved or deleted.";
const OUTSIDE = "This file points outside the space folder, so Atrium won't open it.";
export const NOT_FILE = "That's a folder or special file. Use Reveal in Finder to see it.";
const BINARY = "This file isn't text, so there's no preview. Open it instead.";
const NOT_UTF8 = "Parts of this file aren't valid text, so they show as �.";

// Requests name files relative to the folder. Anything absolute, climbing out, hidden or a .env name is refused
// before the disk is touched.
function checkRel(rel: string) {
  if (!rel || rel.startsWith("/") || rel.includes("\0") || rel.includes("\\")) throw new FileRefused(400, BAD_PATH);
  if (rel.split("/").some((seg) => seg === "" || seg === "..") || isHiddenPath(rel)) throw new FileRefused(400, BAD_PATH);
}

export const CHANGED = "That file changed while Atrium was checking it. Try again.";

// A checked file: its real path and the identity it had when checked, so a later open can tell whether the path
// still names the same file (an agent's leftover process could swap it for a link in between).
export type Target = { absPath: string; dev: number; ino: number; isDir: boolean };

export function resolveInside(root: string, rel: string): string {
  return resolveTarget(root, rel).absPath;
}

// The real path of a regular file inside `root`, reached without passing through a link. "." is the folder itself.
export function resolveTarget(root: string, rel: string): Target {
  let real: string;
  try {
    real = realpathSync(root);
  } catch {
    throw new FileRefused(404, GONE);
  }
  if (rel === ".") {
    const st = lstatSync(real);
    return { absPath: real, dev: st.dev, ino: st.ino, isDir: true };
  }
  checkRel(rel);
  const segs = rel.split("/");
  let at = real;
  let last: ReturnType<typeof lstatSync> | null = null;
  for (let i = 0; i < segs.length; i++) {
    at = join(at, segs[i]!);
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(at);
    } catch {
      throw new FileRefused(404, GONE);
    }
    if (st.isSymbolicLink()) throw new FileRefused(403, OUTSIDE);
    last = st;
    if (i < segs.length - 1 ? !st.isDirectory() : !st.isFile()) throw new FileRefused(i < segs.length - 1 ? 404 : 400, i < segs.length - 1 ? GONE : NOT_FILE);
  }
  // A last check in case a folder was swapped for a link mid-walk.
  if (!realpathSync(at).startsWith(real + sep)) throw new FileRefused(403, OUTSIDE);
  return { absPath: at, dev: last!.dev, ino: last!.ino, isDir: false };
}

export type FilePreview = {
  path: string;
  absPath: string;
  size: number;
  kind: FileKind;
  text: string | null;
  truncated: boolean;
  note: string | null;
};

function previewOf(path: string, absPath: string, size: number, bytes: Uint8Array | null): FilePreview {
  const kind = kindOf(path, bytes?.subarray(0, 4096));
  const base = { path, absPath, size, kind, text: null, truncated: false, note: null };
  if (kind === "image") return base;
  if (!bytes) return { ...base, note: size > RAW_CAP ? `Too big to preview (${sizeText(size)}). Open it instead.` : BINARY };
  if (bytes.includes(0) || (kind === "other" && !looksLikeText(bytes.subarray(0, 4096)))) return { ...base, note: BINARY };
  let cut = bytes.length;
  const truncated = size > PREVIEW_CAP || bytes.length > PREVIEW_CAP;
  if (bytes.length > PREVIEW_CAP) {
    cut = PREVIEW_CAP;
    // Back up to the start of a character, so the cut never splits one.
    while (cut > 0 && (bytes[cut]! & 0xc0) === 0x80) cut--;
  }
  const slice = bytes.subarray(0, cut);
  try {
    return { ...base, text: new TextDecoder("utf-8", { fatal: true }).decode(slice), truncated };
  } catch {
    return { ...base, text: new TextDecoder("utf-8").decode(slice), truncated, note: NOT_UTF8 };
  }
}

// Opened without following links, then checked to be the very regular file the path resolved to.
export function readOpen<T>(t: Target, read: (fd: number, st: Stats) => T): T {
  let fd: number;
  try {
    fd = openSync(t.absPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    throw (e as NodeJS.ErrnoException).code === "ELOOP" ? new FileRefused(409, CHANGED) : new FileRefused(404, GONE);
  }
  try {
    const st = fstatSync(fd);
    if (st.dev !== t.dev || st.ino !== t.ino) throw new FileRefused(409, CHANGED);
    if (!st.isFile()) throw new FileRefused(400, NOT_FILE);
    return read(fd, st);
  } finally {
    closeSync(fd);
  }
}

export function readBytes(fd: number, length: number): Uint8Array {
  const buf = new Uint8Array(length);
  let off = 0;
  while (off < length) {
    const n = readSync(fd, buf, off, length - off, off);
    if (n === 0) break;
    off += n;
  }
  return buf.subarray(0, off);
}

export function readPreview(root: string, rel: string): FilePreview {
  const t = resolveTarget(root, rel);
  return readOpen(t, (fd, { size }) => {
    const kind = kindOf(rel);
    // A huge file that isn't text by name isn't read at all; text is read up to the preview cap.
    const skip = kind === "image" || (size > RAW_CAP && kind === "other");
    return previewOf(rel, t.absPath, size, skip ? null : readBytes(fd, Math.min(size, PREVIEW_CAP + 4)));
  });
}

export function readRaw(root: string, rel: string): { bytes: Uint8Array; type: string } {
  const t = resolveTarget(root, rel);
  const type = IMAGE_TYPES[extOf(rel)];
  if (!type) throw new FileRefused(400, "Only images can be shown inline.");
  return readOpen(t, (fd, { size }) => {
    if (size > RAW_CAP) throw new FileRefused(413, "This image is too big to show here. Open it instead.");
    return { bytes: readBytes(fd, size), type };
  });
}

async function blob(repo: string, ref: string, rel: string, cap: number) {
  checkRel(rel);
  try {
    return await showBlob(repo, ref, rel, cap);
  } catch {
    throw new FileRefused(404, GONE);
  }
}

export async function branchPreview(repo: string, ref: string, rel: string): Promise<FilePreview> {
  const kind = kindOf(rel);
  const b = await blob(repo, ref, rel, kind === "image" ? 0 : RAW_CAP);
  return previewOf(rel, join(repo, rel), b.size, b.bytes);
}

export async function branchRaw(repo: string, ref: string, rel: string): Promise<{ bytes: Uint8Array; type: string }> {
  const type = IMAGE_TYPES[extOf(rel)];
  checkRel(rel);
  if (!type) throw new FileRefused(400, "Only images can be shown inline.");
  const b = await blob(repo, ref, rel, RAW_CAP);
  if (!b.bytes) throw new FileRefused(413, "This image is too big to show here. Open it instead.");
  return { bytes: b.bytes, type };
}
