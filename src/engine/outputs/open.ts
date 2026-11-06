import { lstatSync } from "node:fs";
import { basename } from "node:path";
import { config } from "../config";
import { FileRefused } from "./files";

export type OpenHow = "open" | "reveal" | "calendar";

// File types macOS opens in a viewer or editor. Anything that can launch code (apps, scripts, .command, HTML)
// is left out: those are only ever revealed in Finder.
export const OPENABLE = new Set(["md", "markdown", "txt", "csv", "tsv", "json", "yaml", "yml", "ics", "pdf", "png", "jpg", "jpeg", "gif", "webp", "heic", "rtf", "docx", "xlsx", "pptx"]);

const RUNS_CODE = "Atrium won't open this kind of file directly, since it could run code. Use Reveal in Finder to look at it.";

const extOf = (p: string) => {
  const name = basename(p);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

export function openArgs(absPath: string, how: OpenHow, mode: number): string[] {
  if (how === "reveal") return ["-R", absPath];
  if (how === "calendar") {
    if (extOf(absPath) !== "ics") throw new FileRefused(403, "Only .ics files can be added to Calendar.");
    return ["-a", "Calendar", absPath];
  }
  if (!OPENABLE.has(extOf(absPath)) || mode & 0o111) throw new FileRefused(403, RUNS_CODE);
  return [absPath];
}

export async function openFile(absPath: string, how: OpenHow): Promise<void> {
  const st = lstatSync(absPath);
  if (st.isSymbolicLink()) throw new FileRefused(403, "This file points outside the space folder, so Atrium won't open it.");
  // Directories (an .app bundle among them) are only ever revealed.
  if (how !== "reveal" && !st.isFile()) throw new FileRefused(403, RUNS_CODE);
  const args = openArgs(absPath, how, st.mode);
  const proc = Bun.spawn([config().openBin, ...args], { stdin: "ignore", stdout: "ignore", stderr: "pipe", timeout: 10_000, env: { ...process.env } });
  const code = await proc.exited;
  if (code !== 0 || proc.signalCode !== null) {
    throw new Error(`macOS couldn't open ${basename(absPath)}. Use Reveal in Finder and open it from there.`);
  }
}
