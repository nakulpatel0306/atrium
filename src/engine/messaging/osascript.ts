import { config } from "../config";

// The only place Atrium runs osascript: always an argv array (never a shell), always fixed script lines from
// scripts.ts. User, agent and contact data go after "--": without it osascript keeps reading options, so an
// argument like "-e" would be parsed as more script. After "--" every item reaches `on run argv` literally.
export type OsaResult = { code: number; out: string; err: string; timedOut: boolean };

export async function runOsa(lines: readonly string[], args: string[], opts: { timeoutMs?: number } = {}): Promise<OsaResult> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([config().osascriptBin, ...lines.flatMap((l) => ["-e", l]), "--", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env } });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { code: 127, out: "", err: "", timedOut: false };
    throw e;
  }
  let timedOut = false;
  // A macOS permission dialog nobody answers would otherwise hold the send open forever.
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, opts.timeoutMs ?? 30_000);
  const out = new Response(proc.stdout as ReadableStream).text();
  const err = new Response(proc.stderr as ReadableStream).text();
  const code = await proc.exited;
  clearTimeout(timer);
  if (timedOut) return { code, out: "", err: "", timedOut: true };
  return { code, out: await out, err: await err, timedOut: false };
}
