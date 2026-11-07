// Failures nothing else caught. A late background rejection (a clone or lookup that outlived its space) is logged
// and the engine keeps running. A synchronous throw can leave the runner's in-memory state half updated, and a
// damaged or full database means every later write is suspect, so those exit with code 1: launchd's KeepAlive
// starts a fresh engine, boot recovery requeues the runs, and the next boot tells Nakul it happened.
import type { Database } from "bun:sqlite";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { logActivity } from "./events";
import { redact } from "./markets/redact";

const describe = (e: unknown) => redact(e instanceof Error ? (e.stack ?? e.message) : String(e), []);

// SQLite's corrupt, I/O and disk-full errors (and their extended codes), by code or by their standard words.
export function isFatalDbError(e: unknown): boolean {
  const code = String((e as { code?: unknown } | null)?.code ?? "");
  if (/^SQLITE_(CORRUPT|IOERR|FULL|NOTADB)/.test(code)) return true;
  const message = e instanceof Error ? e.message : String(e);
  return /database disk image is malformed|disk I\/O error|database or disk is full|file is not a database/i.test(message);
}

export const RESTARTED = "Atrium restarted after an error. Check engine.log if something looks off.";

type Deps = { marker: string; log?: (line: string) => void; exit?: (code: number) => void; proc?: NodeJS.Process };

export function installCrashGuard({ marker, log = (l) => console.error(l), exit = (c) => process.exit(c), proc = process }: Deps): void {
  const fatal = (what: string, e: unknown) => {
    log(`Atrium stopped after ${what}; launchd starts it again: ${describe(e)}`);
    try {
      writeFileSync(marker, String(Date.now()));
    } catch {
      // The restart still happens; only the Activity line is lost.
    }
    exit(1);
  };
  proc.on("uncaughtException", (e) => fatal("an error nothing else handled", e));
  proc.on("unhandledRejection", (e) => {
    if (isFatalDbError(e)) return fatal("a database error", e);
    log(`Atrium caught a failure nothing else handled and kept running: ${describe(e)}`);
  });
}

// On boot: one line in Activity if the last engine stopped through the guard.
export function noteRestart(db: Database, marker: string): boolean {
  if (!existsSync(marker)) return false;
  unlinkSync(marker);
  logActivity(db, null, "atrium", RESTARTED);
  return true;
}
