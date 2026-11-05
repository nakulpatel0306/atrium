import { config } from "../config";
import { parseRetryAfter } from "./limits";
import type { AgentAdapter, AgentRunInput, AgentRunResult } from "./types";

function shortCommand(command: unknown): string {
  const s = String(command ?? "").replace(/\s+/g, " ");
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}

// Only the CLI's own words (error events and stderr) are classified, never the agent's message,
// which talks about the user's code.
function classify(message: string, stderr: string, exitCode: number): AgentRunResult {
  const text = `${message}\n${stderr}`;
  if (/hit your usage limit|usage limit/i.test(text)) {
    const retryAfter = parseRetryAfter(text);
    const at = new Date(retryAfter).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return { status: "error", kind: "rate_limited", message: `Codex usage limit reached; resets at ${at}`, retryAfter };
  }
  if (/not logged in|logged out|codex login|unauthorized/i.test(text)) {
    return { status: "error", kind: "not_logged_in", message: "Codex is logged out. Run `codex login` once in a terminal." };
  }
  const tail = message || stderr.trim().split("\n").slice(-20).join("\n");
  return { status: "error", kind: "failed", message: tail || `Codex exited with code ${exitCode}` };
}

export function codexAdapter(bin: string = config().codexBin): AgentAdapter {
  return {
    id: "codex",
    label: "Codex",
    async run(input: AgentRunInput): Promise<AgentRunResult> {
      let proc: ReturnType<typeof Bun.spawn>;
      try {
        proc = Bun.spawn(
          [
            bin, "exec", "-", "-C", input.cwd,
            "--sandbox", input.mode === "review" ? "read-only" : "workspace-write",
            "--json", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules",
            "-c", 'approval_policy="never"',
          ],
          { cwd: input.cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe", env: process.env, signal: input.signal },
        );
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
          return { status: "error", kind: "not_installed", message: "Codex isn't installed or not on PATH" };
        }
        throw e;
      }

      // Codex has no system-prompt flag, so the instructions ride in front of the task.
      const stdin = proc.stdin as import("bun").FileSink;
      stdin.write(`${input.systemPrompt}\n\n${input.prompt}`);
      stdin.end();

      let lastMessage = "";
      let errorMessage = "";
      let usage: { inputTokens: number; outputTokens: number } | undefined;

      const handle = (line: string) => {
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        if (msg.type === "item.completed") {
          const item = msg.item;
          if (item?.type === "agent_message" && item.text) {
            lastMessage = String(item.text);
            input.onChunk(lastMessage);
          } else if (item?.type === "command_execution") {
            input.onChunk(`→ bash ${shortCommand(item.command)}`.trimEnd());
          }
        } else if (msg.type === "turn.completed") {
          usage = { inputTokens: msg.usage?.input_tokens ?? 0, outputTokens: msg.usage?.output_tokens ?? 0 };
        } else if (msg.type === "turn.failed") {
          errorMessage = String(msg.error?.message ?? "turn failed");
        } else if (msg.type === "error") {
          errorMessage ||= String(msg.message ?? "");
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

      if (exitCode === 0 && usage && !errorMessage) {
        return { status: "ok", summary: lastMessage, ...usage };
      }
      return classify(errorMessage, stderr, exitCode);
    },
  };
}
