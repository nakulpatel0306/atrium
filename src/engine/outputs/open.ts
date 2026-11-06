import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { config } from "../config";
import { CHANGED, FileRefused, readBytes, readOpen, type Target } from "./files";
import { extOf, OPENABLE } from "./kinds";

export { OPENABLE } from "./kinds";

export type OpenHow = "open" | "reveal" | "calendar";


const RUNS_CODE = "Atrium won't open this kind of file directly, since it could run code. Use Reveal in Finder to look at it.";
const OPEN_CAP = 100 * 1024 * 1024;
const COPY_TTL_MS = 24 * 60 * 60_000;

const TEXT = new Set(["md", "markdown", "txt", "csv", "tsv", "json", "yaml", "yml", "rtf"]);
const VIEW = new Set(["pdf", "png", "jpg", "jpeg", "gif", "webp", "heic"]);
// Office files go to whichever suite is installed; TextEdit reads .docx too.
const OFFICE: Record<string, string[]> = {
  docx: ["Microsoft Word", "Pages", "TextEdit"],
  xlsx: ["Microsoft Excel", "Numbers"],
  pptx: ["Microsoft PowerPoint", "Keynote"],
};

const installed = (app: string) =>
  app === "TextEdit" || ["/Applications", "/System/Applications"].some((d) => existsSync(join(d, `${app}.app`)));

// A named app per type, never the file's default handler: a default can be anything, including something that
// runs what it opens.
export function appFor(absPath: string, how: OpenHow): string {
  const ext = extOf(absPath);
  if (how === "calendar") {
    if (ext !== "ics") throw new FileRefused(403, "Only .ics files can be added to Calendar.");
    return "Calendar";
  }
  if (!OPENABLE.has(ext)) throw new FileRefused(403, RUNS_CODE);
  if (ext === "ics") return "Calendar";
  if (TEXT.has(ext)) return "TextEdit";
  if (VIEW.has(ext)) return "Preview";
  const app = OFFICE[ext]!.find(installed);
  if (!app) throw new FileRefused(403, `No app on this Mac opens .${ext} files. Use Reveal in Finder to look at it.`);
  return app;
}

// Open and Add to Calendar launch a copy in Atrium's own data folder, which agents can't reach: whatever an agent
// does to the space folder afterwards, the app gets exactly the bytes Atrium checked. Reveal only selects the file
// in Finder, which can't run it, so it uses the real path once that still names the checked file.
export async function openFile(t: Target, how: OpenHow): Promise<{ app: string; copy: boolean }> {
  let argv: string[];
  let result: { app: string; copy: boolean };
  if (how === "reveal") {
    const st = lstatSync(t.absPath, { throwIfNoEntry: false });
    if (!st || st.isSymbolicLink() || st.dev !== t.dev || st.ino !== t.ino) throw new FileRefused(409, CHANGED);
    argv = ["-R", t.absPath];
    result = { app: "Finder", copy: false };
  } else {
    if (t.isDir) throw new FileRefused(403, how === "calendar" ? "Only .ics files can be added to Calendar." : RUNS_CODE);
    const app = appFor(t.absPath, how);
    const bytes = readOpen(t, (fd, st) => {
      if (st.mode & 0o111) throw new FileRefused(403, RUNS_CODE);
      if (st.size > OPEN_CAP) throw new FileRefused(413, "This file is too big to open from Atrium. Use Reveal in Finder to open it.");
      return readBytes(fd, st.size);
    });
    argv = ["-a", app, privateCopy(basename(t.absPath), bytes)];
    result = { app, copy: true };
  }
  const proc = Bun.spawn([config().openBin, ...argv], { stdin: "ignore", stdout: "ignore", stderr: "pipe", timeout: 10_000, env: { ...process.env } });
  const code = await proc.exited;
  if (code !== 0 || proc.signalCode !== null) {
    throw new Error(`macOS couldn't open ${basename(t.absPath)}. Use Reveal in Finder and open it from there.`);
  }
  return result;
}

function privateCopy(name: string, bytes: Uint8Array): string {
  const root = join(config().home, "open-copies");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  // Old copies go when the next one is made; nothing runs on a timer.
  for (const entry of readdirSync(root)) {
    const p = join(root, entry);
    if (Date.now() - statSync(p).mtimeMs > COPY_TTL_MS) rmSync(p, { recursive: true, force: true });
  }
  const dir = mkdtempSync(join(root, "c-"));
  const path = join(dir, name);
  writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
  return path;
}
