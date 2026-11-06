// A background job that fails late (a clone or lookup finishing after its space was deleted) must never take the
// engine down with it, and every run in other spaces with it. Anything that slips past its own catch is logged here,
// with secrets in query strings hidden, and the engine keeps running.
import { redact } from "./markets/redact";

const describe = (e: unknown) => redact(e instanceof Error ? (e.stack ?? e.message) : String(e), []);

export function installCrashGuard(proc: NodeJS.Process = process, log: (line: string) => void = (l) => console.error(l)): void {
  proc.on("unhandledRejection", (e) => log(`Atrium caught a failure nothing else handled and kept running: ${describe(e)}`));
  proc.on("uncaughtException", (e) => log(`Atrium caught an error nothing else handled and kept running: ${describe(e)}`));
}
