const KILL_GRACE_MS = 300;
// How long an aborted agent gets to exit on SIGTERM before its whole group is killed outright.
export const ABORT_GRACE_MS = 3000;

export type AgentProcessResult = { notInstalled: true } | { notInstalled?: false; stderr: string; exitCode: number; aborted: boolean };

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

// Agents run shell commands whose background children would otherwise outlive the run.
async function killGroup(pgid: number): Promise<void> {
  if (!groupAlive(pgid)) return;
  try {
    process.kill(-pgid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + KILL_GRACE_MS;
  while (groupAlive(pgid) && Date.now() < deadline) await Bun.sleep(20);
  if (!groupAlive(pgid)) return;
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    // ESRCH: the group exited during the grace period.
  }
}

// Spawns an agent CLI in its own process group, feeds it stdin, and hands each stdout line to onLine.
// The group is killed once the main process exits, so stray children can't outlive the run (or hold stdout open).
export async function runAgentProcess(
  argv: string[],
  opts: { cwd: string; stdin: string; env?: Record<string, string | undefined>; signal?: AbortSignal; abortGraceMs?: number; onLine(line: string): void },
): Promise<AgentProcessResult> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(argv, {
      cwd: opts.cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe", env: opts.env ?? process.env, signal: opts.signal, detached: true,
    });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { notInstalled: true };
    throw e;
  }

  // The prompt goes over stdin so a leading "-" can never be parsed as a flag.
  const stdin = proc.stdin as import("bun").FileSink;
  stdin.write(opts.stdin);
  stdin.end();

  const readStdout = async () => {
    const decoder = new TextDecoder();
    let buf = "";
    for await (const part of proc.stdout as ReadableStream<Uint8Array>) {
      buf += decoder.decode(part, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        opts.onLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    }
    if (buf.trim()) opts.onLine(buf);
  };

  // Bun sends SIGTERM to the main process on abort; one that ignores it (or a child holding the group open) would
  // keep the run alive, so the group is killed after a grace period.
  let escalate: ReturnType<typeof setTimeout> | undefined;
  const onAbort = () => {
    escalate = setTimeout(() => {
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        // ESRCH: everything already exited.
      }
    }, opts.abortGraceMs ?? ABORT_GRACE_MS);
  };
  if (opts.signal?.aborted) onAbort();
  else opts.signal?.addEventListener("abort", onAbort, { once: true });

  const reading = Promise.all([readStdout(), new Response(proc.stderr as ReadableStream).text()]);
  const exitCode = await proc.exited;
  clearTimeout(escalate);
  opts.signal?.removeEventListener("abort", onAbort);
  await killGroup(proc.pid);
  const [, stderr] = await reading;
  return { stderr, exitCode, aborted: Boolean(opts.signal?.aborted) };
}
