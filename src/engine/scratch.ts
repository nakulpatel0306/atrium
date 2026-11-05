import { closeSync, constants, ftruncateSync, lstatSync, mkdirSync, openSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "./config";
import { SANDBOX_EXEC, codexStateDir, seatbeltFailure, wrapInSeatbelt } from "./agents/seatbelt";

const RUN_CAP_BYTES = 50 * 1024 * 1024;
const COPY_TIMEOUT_MS = 60_000;
const NO_SANDBOX = "the sandbox for copying them didn't start";

export type KeptScratch = { files: number; truncated: boolean; skipped: number };

// A scratch run's folder is deleted when the run ends, so whatever the agent made there is copied out first.
// The tree is the agent's, so the copy runs under the same Seatbelt read-denies the agent ran with (secrets,
// .env names, Atrium's own folder, both CLIs' state) and may write only the destination: however the agent
// arranged links or swaps paths, the copy can't read more than the agent could, or write anywhere else.
// `cp -RP` copies symlinks as links, never their targets, and the engine then removes them.
// Throws (and keeps nothing) when the sandbox can't start, so a copy never runs unconfined.
export async function keepScratch(
  src: string,
  dest: string,
  opts: { caps?: { file: number; total: number }; sandboxExec?: string } = {},
): Promise<KeptScratch> {
  const caps = opts.caps ?? { file: config().transcriptFileCapBytes, total: RUN_CAP_BYTES };
  mkdirSync(dest, { recursive: true });
  try {
    const argv = wrapInSeatbelt(["/bin/cp", "-RP", `${src}/`, dest], {
      cwd: src,
      writable: [dest],
      extraDenyRead: [codexStateDir(), join(homedir(), ".gemini")],
      allowReadDirs: [dest],
      sandboxExec: opts.sandboxExec ?? SANDBOX_EXEC,
    });
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(argv, { stdout: "ignore", stderr: "pipe", timeout: COPY_TIMEOUT_MS });
    } catch {
      throw new Error(NO_SANDBOX);
    }
    const stderr = await new Response(proc.stderr as ReadableStream).text();
    const exitCode = await proc.exited;
    if (seatbeltFailure({ stderr, exitCode, aborted: false })) throw new Error(NO_SANDBOX);
    // Each file the sandbox refused (a .env name, a hard link into a denied folder) is one line from cp.
    const refused = exitCode === 0 ? 0 : stderr.split("\n").filter((l) => l.startsWith("cp: ")).length;
    const kept = trim(dest, caps);
    kept.skipped += refused;
    // A copy cut off by the timeout kept only part of the files.
    if (proc.signalCode !== null) kept.truncated = true;
    if (kept.files === 0) rmSync(dest, { recursive: true, force: true });
    return kept;
  } catch (e) {
    rmSync(dest, { recursive: true, force: true });
    throw e;
  }
}

// Applies the caps to the copy, which only the finished sandboxed cp ever wrote, and drops links and special
// files. O_NOFOLLOW stays on the truncating open as a last guard.
function trim(dest: string, caps: { file: number; total: number }): KeptScratch {
  let left = caps.total;
  const kept: KeptScratch = { files: 0, truncated: false, skipped: 0 };
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const st = lstatSync(path);
      if (st.isDirectory()) {
        walk(path);
        continue;
      }
      if (!st.isFile()) {
        unlinkSync(path);
        kept.skipped++;
        continue;
      }
      const take = Math.min(st.size, caps.file, left);
      if (take < st.size) kept.truncated = true;
      if (take === 0 && st.size > 0) {
        unlinkSync(path);
        continue;
      }
      if (take < st.size) {
        const fd = openSync(path, constants.O_WRONLY | constants.O_NOFOLLOW);
        try {
          ftruncateSync(fd, take);
        } finally {
          closeSync(fd);
        }
      }
      left -= take;
      kept.files++;
    }
  };
  walk(dest);
  return kept;
}
