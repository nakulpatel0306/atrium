import type { Database } from "bun:sqlite";
import { lstatSync, mkdirSync, readdirSync, realpathSync, rmdirSync, rmSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { config } from "../config";
import { extOf, OPENABLE } from "../outputs/kinds";
import { type OpenHow, openFile } from "../outputs/open";
import { MailProblem } from "./types";

// An attachment's name is chosen by whoever sent it: no folders, no hidden files, and none of the invisible format,
// bidi or control characters that can make "invoice‮fdp.app" read as "invoiceppa.pdf".
export function safeFileName(name: string): string {
  const clean = basename(name.normalize("NFC").replace(/\\/g, "/"))
    .replace(/\p{Cf}/gu, "")
    .replace(/[\u0000-\u001f\u007f-\u009f/:]/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 120);
  return clean || "attachment";
}

// Only types Atrium already opens with a named app get an Open button; anything else (apps, scripts, archives,
// unknown types) is Show in Finder only.
export const canOpen = (name: string): boolean => OPENABLE.has(extOf(safeFileName(name)));

export const attachmentsRoot = (): string => join(config().home, "mail-attachments");
const part = (id: string) => id.replace(/[^\w-]/g, "");

// One folder per account and message, inside Atrium's own data folder, which agents can't reach.
export function attachmentDir(accountId: string, messageId: string): string {
  const dir = join(attachmentsRoot(), part(accountId), part(messageId));
  mkdirSync(dir, { recursive: true });
  return dir;
}

// A path is ours to open or remove only if, with links resolved, it sits inside `dir`.
export function inside(dir: string, path: string): boolean {
  try {
    const root = realpathSync(dir);
    return realpathSync(path).startsWith(root + sep);
  } catch {
    return false;
  }
}

// Saved attachments get the same quarantine mark a browser or Mail.app gives a download, so Gatekeeper checks
// anything inside one before it runs. A file that can't be marked isn't offered at all.
export async function quarantine(path: string, now = Date.now()): Promise<void> {
  const value = `0081;${Math.floor(now / 1000).toString(16)};Atrium;`;
  const proc = Bun.spawn(["/usr/bin/xattr", "-w", "com.apple.quarantine", value, path], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  if ((await proc.exited) !== 0) {
    rmSync(path, { force: true });
    throw new MailProblem("other", "Atrium couldn't mark this attachment as downloaded, so it removed it rather than let it skip macOS's safety check. Try again.");
  }
}

// Every saved file is recorded with its message, so removing an account or ageing out mail removes exactly those.
export function recordSaved(db: Database, path: string, accountId: string, messageId: string, now = Date.now()): void {
  db.query("INSERT INTO mail_saved_files (path, account_id, message_id, saved_at) VALUES (?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET saved_at = excluded.saved_at").run(path, accountId, messageId, now);
}

// Removes the recorded files matching `where`, each only after checking it still resolves inside mail-attachments,
// then any message and account folders left empty.
export function removeSaved(db: Database, where: { accountId: string } | { messageIds: string[] }): void {
  const rows =
    "accountId" in where
      ? (db.query("SELECT path FROM mail_saved_files WHERE account_id = ?").all(where.accountId) as { path: string }[])
      : where.messageIds.flatMap((id) => db.query("SELECT path FROM mail_saved_files WHERE message_id = ?").all(id) as { path: string }[]);
  const root = attachmentsRoot();
  for (const { path } of rows) {
    if (inside(root, path)) rmSync(path, { force: true });
    db.query("DELETE FROM mail_saved_files WHERE path = ?").run(path);
    for (const dir of [dirname(path), dirname(dirname(path))]) {
      try {
        if (inside(root, dir) && readdirSync(dir).length === 0) rmdirSync(dir);
      } catch {
        // Already gone, or not empty: left as it is.
      }
    }
  }
}

// Opened the same way as any file a task made: a named app per type, never anything that could run code.
export async function openSaved(path: string, how: OpenHow): Promise<{ app: string }> {
  if (!inside(attachmentsRoot(), path)) throw new MailProblem("other", "That attachment isn't where Atrium saved it. Open the thread and try again.");
  const st = lstatSync(path);
  return openFile({ absPath: path, dev: st.dev, ino: st.ino, isDir: st.isDirectory() }, how);
}
