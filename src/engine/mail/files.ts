import { lstatSync, mkdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { config } from "../config";
import { type OpenHow, openFile } from "../outputs/open";

// An attachment's name is chosen by whoever sent it: no folders, no hidden files, no control characters.
export function safeFileName(name: string): string {
  const clean = basename(name.replace(/\\/g, "/"))
    .replace(/[\u0000-\u001f\u007f/:]/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 120);
  return clean || "attachment";
}

// Attachments are saved inside Atrium's own data folder, which agents can't reach, one folder per message.
export function attachmentDir(messageId: string): string {
  const dir = join(config().home, "mail-attachments", messageId.replace(/[^\w-]/g, ""));
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Opened the same way as any file a task made: a named app per type, never anything that could run code.
export async function openSaved(path: string, how: OpenHow): Promise<{ app: string }> {
  const st = lstatSync(path);
  return openFile({ absPath: path, dev: st.dev, ino: st.ino, isDir: st.isDirectory() }, how);
}

export function dropAttachments(): void {
  rmSync(join(config().home, "mail-attachments"), { recursive: true, force: true });
}
