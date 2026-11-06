import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { basename, join, sep } from "node:path";
import { showBlob } from "../git";
import { bytes as sizeText } from "../text";
import { isHiddenPath } from "./snapshot";

export type FileKind = "markdown" | "text" | "image" | "calendar" | "other";

export class FileRefused extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 413,
    message: string,
  ) {
    super(message);
  }
}

export const PREVIEW_CAP = 262_144;
export const RAW_CAP = 10_485_760;

const TEXT_EXT = new Set("txt csv tsv json yaml yml toml ts tsx js jsx py rb go rs swift sh css html xml log".split(" "));
// SVG can carry script, so it is never shown inline.
const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

const BAD_PATH = "That isn't a file Atrium can show.";
const GONE = "That file isn't in the folder anymore. It may have been moved or deleted.";
const OUTSIDE = "This file points outside the space folder, so Atrium won't open it.";
const NOT_FILE = "That's a folder or special file. Use Reveal in Finder to see it.";
const BINARY = "This file isn't text, so there's no preview. Open it instead.";
const NOT_UTF8 = "Parts of this file aren't valid text, so they show as �.";

const extOf = (path: string) => {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

export function kindOf(path: string, head?: Uint8Array): FileKind {
  const ext = extOf(path);
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "ics") return "calendar";
  if (ext in IMAGE_TYPES) return "image";
  if (TEXT_EXT.has(ext)) return "text";
  return head && looksLikeText(head) ? "text" : "other";
}

function looksLikeText(head: Uint8Array): boolean {
  if (head.includes(0)) return false;
  try {
    // stream: a multi-byte character cut at the end of the head isn't an error.
    new TextDecoder("utf-8", { fatal: true }).decode(head, { stream: true });
    return true;
  } catch {
    return false;
  }
}

// Requests name files relative to the folder. Anything absolute, climbing out, hidden or a .env name is refused
// before the disk is touched.
function checkRel(rel: string) {
  if (!rel || rel.startsWith("/") || rel.includes("\0") || rel.includes("\\")) throw new FileRefused(400, BAD_PATH);
  if (rel.split("/").some((seg) => seg === "" || seg === "..") || isHiddenPath(rel)) throw new FileRefused(400, BAD_PATH);
}

// The real path of a regular file inside `root`, reached without passing through a link. "." is the folder itself.
export function resolveInside(root: string, rel: string): string {
  let real: string;
  try {
    real = realpathSync(root);
  } catch {
    throw new FileRefused(404, GONE);
  }
  if (rel === ".") return real;
  checkRel(rel);
  const segs = rel.split("/");
  let at = real;
  for (let i = 0; i < segs.length; i++) {
    at = join(at, segs[i]!);
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(at);
    } catch {
      throw new FileRefused(404, GONE);
    }
    if (st.isSymbolicLink()) throw new FileRefused(403, OUTSIDE);
    if (i < segs.length - 1 ? !st.isDirectory() : !st.isFile()) throw new FileRefused(i < segs.length - 1 ? 404 : 400, i < segs.length - 1 ? GONE : NOT_FILE);
  }
  // A last check in case a folder was swapped for a link mid-walk.
  if (!realpathSync(at).startsWith(real + sep)) throw new FileRefused(403, OUTSIDE);
  return at;
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

export function previewOf(path: string, absPath: string, size: number, bytes: Uint8Array | null): FilePreview {
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

// Opened without following links, then checked to be the regular file the path resolved to.
function readOpen<T>(abs: string, read: (fd: number, size: number) => T): T {
  let fd: number;
  try {
    fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    throw (e as NodeJS.ErrnoException).code === "ELOOP" ? new FileRefused(403, OUTSIDE) : new FileRefused(404, GONE);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new FileRefused(400, NOT_FILE);
    return read(fd, st.size);
  } finally {
    closeSync(fd);
  }
}

function readBytes(fd: number, length: number): Uint8Array {
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
  const abs = resolveInside(root, rel);
  return readOpen(abs, (fd, size) => {
    const kind = kindOf(rel);
    // A huge file that isn't text by name isn't read at all; text is read up to the preview cap.
    const skip = kind === "image" || (size > RAW_CAP && kind === "other");
    return previewOf(rel, abs, size, skip ? null : readBytes(fd, Math.min(size, PREVIEW_CAP + 4)));
  });
}

export function readRaw(root: string, rel: string): { bytes: Uint8Array; type: string } {
  const abs = resolveInside(root, rel);
  const type = IMAGE_TYPES[extOf(rel)];
  if (!type) throw new FileRefused(400, "Only images can be shown inline.");
  return readOpen(abs, (fd, size) => {
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
