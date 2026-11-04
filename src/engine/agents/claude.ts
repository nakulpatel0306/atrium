import { config } from "../config";
import type { AgentAdapter, AgentRunInput, AgentRunResult } from "./types";

const DENY = [
  "Read(**/.env*)",
  "Edit(**/.env*)",
  "Write(**/.env*)",
  "Bash(cat *.env*)",
  // Planted hooks or config in .git could run code outside the agent's tool limits.
  "Edit(**/.git/**)",
  "Write(**/.git/**)",
  // Project settings in .claude are loaded by later runs (--setting-sources project), so an agent could widen its own permissions.
  "Edit(**/.claude/**)",
  "Write(**/.claude/**)",
];
const FALLBACK_WAIT_MS = 30 * 60_000;

function shortInput(input: Record<string, unknown> | undefined): string {
  if (!input) return "";
  const pick = input.file_path ?? input.command ?? input.pattern ?? input.path ?? input.url ?? JSON.stringify(input);
  const s = String(pick).replace(/\s+/g, " ");
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}

// Reset time as an epoch (ms), from either "|<epoch seconds>" or "resets 2:40pm" (next local occurrence).
function parseRetryAfter(text: string): number {
  const epoch = text.match(/\|\s*(\d{10})\b/);
  if (epoch) return Number(epoch[1]) * 1000;
  const clock = text.match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (clock) {
    let hour = Number(clock[1]) % 12;
    if (clock[3]!.toLowerCase() === "pm") hour += 12;
    const when = new Date();
    when.setHours(hour, Number(clock[2] ?? 0), 0, 0);
    if (when.getTime() <= Date.now()) when.setDate(when.getDate() + 1);
    return when.getTime();
  }
  return Date.now() + FALLBACK_WAIT_MS;
}

// Only the CLI's own words (stderr and the result line) are classified. The agent's text
// talks about the user's code, where "rate limiting" or "login page" mean nothing about the run.
function classify(text: string, stderr: string, exitCode: number): AgentRunResult {
  if (/usage limit|rate limit|limit reached/i.test(text)) {
    return { status: "error", kind: "rate_limited", message: "Claude Code hit its usage limit.", retryAfter: parseRetryAfter(text) };
  }
  if (/not logged in|logged out|please run \/login|invalid api key|authentication/i.test(text)) {
    return { status: "error", kind: "not_logged_in", message: "Claude Code is logged out. Run `claude` once to log in." };
  }
  const tail = stderr.trim().split("\n").slice(-20).join("\n");
  return { status: "error", kind: "failed", message: tail || `Claude Code exited with code ${exitCode}` };
}

export function claudeAdapter(bin: string = config().claudeBin): AgentAdapter {
  return {
    id: "claude",
    label: "Claude Code",
    async run(input: AgentRunInput): Promise<AgentRunResult> {
      // The variadic --allowedTools would swallow a flag-looking entry as another option.
      const flagLike = input.allowedTools.find((t) => t.startsWith("-"));
      if (flagLike) throw new Error(`Invalid allowedTools entry: ${flagLike}`);

      let proc: ReturnType<typeof Bun.spawn>;
      try {
        proc = Bun.spawn(
          [
            bin, "-p",
            "--setting-sources", "project,local",
            "--output-format", "stream-json", "--verbose",
            "--permission-mode", "dontAsk",
            "--append-system-prompt", input.systemPrompt,
            "--allowedTools", ...input.allowedTools,
            "--disallowedTools", ...DENY,
          ],
          { cwd: input.cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe", env: process.env, signal: input.signal },
        );
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
          return { status: "error", kind: "not_installed", message: "Claude Code isn't installed or not on PATH" };
        }
        throw e;
      }

      // The prompt goes over stdin so a leading "-" can never be parsed as a flag.
      const stdin = proc.stdin as import("bun").FileSink;
      stdin.write(input.prompt);
      stdin.end();

      let limitResetsAt: number | undefined;
      let limitRejected = false;
      let final: { result: string; isError: boolean; inputTokens: number; outputTokens: number } | undefined;

      const handle = (line: string) => {
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        if (msg.type === "assistant") {
          for (const block of msg.message?.content ?? []) {
            if (block.type === "text" && block.text) {
              input.onChunk(block.text);
            } else if (block.type === "tool_use") {
              input.onChunk(`→ ${block.name} ${shortInput(block.input)}`.trimEnd());
            }
          }
        } else if (msg.type === "rate_limit_event") {
          const info = msg.rate_limit_info;
          if (info && info.status !== "allowed") {
            limitResetsAt = Number(info.resetsAt) * 1000;
            if (info.status === "rejected") limitRejected = true;
          }
        } else if (msg.type === "result") {
          final = {
            result: String(msg.result ?? ""),
            isError: Boolean(msg.is_error),
            inputTokens: msg.usage?.input_tokens ?? 0,
            outputTokens: msg.usage?.output_tokens ?? 0,
          };
        }
      };

      const readStdout = async () => {
        const decoder = new TextDecoder();
        let buf = "";
        for await (const part of proc.stdout as ReadableStream<Uint8Array>) {
          buf += decoder.decode(part, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            handle(buf.slice(0, nl));
            buf = buf.slice(nl + 1);
          }
        }
        if (buf.trim()) handle(buf);
      };

      const [, stderr, exitCode] = await Promise.all([
        readStdout(),
        new Response(proc.stderr as ReadableStream).text(),
        proc.exited,
      ]);

      // A stop is the engine's doing, not the task's, so it must not read as a failure or a limit.
      if (input.signal?.aborted) return { status: "error", kind: "failed", message: "Stopped" };

      // Warning-style statuses ("allowed_warning") only count if the run actually failed.
      const succeeded = exitCode === 0 && final !== undefined && !final.isError;
      if (limitResetsAt !== undefined && (limitRejected || !succeeded)) {
        const when = Number.isFinite(limitResetsAt) ? limitResetsAt : Date.now() + FALLBACK_WAIT_MS;
        return {
          status: "error",
          kind: "rate_limited",
          message: `Claude usage limit reached; resets at ${new Date(when).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`,
          retryAfter: when,
        };
      }
      if (succeeded && final) {
        return { status: "ok", summary: final.result, inputTokens: final.inputTokens, outputTokens: final.outputTokens };
      }
      return classify(`${final?.result ?? ""}\n${stderr}`, stderr, exitCode);
    },
  };
}
