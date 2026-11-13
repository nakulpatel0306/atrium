import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "../config";
import { parseRetryAfter } from "./limits";
import { runAgentProcess } from "./process";
import { shortCommand } from "./short";
import { SANDBOX_EXEC, codexStateDir, sandboxFailed, seatbeltFailure, withPrivateTmp, wrapInSeatbelt } from "./seatbelt";
import type { AgentAdapter, AgentRunInput, AgentRunResult, AgentStatus } from "./types";

// Only the CLI's own words (error events and stderr) are classified, never the agent's message,
// which talks about the user's code.
function classify(message: string, stderr: string, exitCode: number): AgentRunResult {
  const text = `${message}\n${stderr}`;
  if (/usage limit/i.test(text)) {
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

// Codex's own sandbox only limits writes, so it runs inside Atrium's profile instead. macOS refuses to apply a
// sandbox inside another one, so Codex's sandbox is turned off and the outer profile is the boundary. With it off,
// sandbox_workspace_write.network_access has nothing to apply to, so the agent's commands share the CLI's network;
// accepted because secrets are unreadable, writes are confined, and the workspace already goes to the provider.
export function codexArgv(bin: string, input: AgentRunInput, tmp: string, sandboxExec: string = SANDBOX_EXEC): string[] {
  const state = codexStateDir();
  const argv = [
    bin, "exec", "-", "-C", input.cwd, "--sandbox", "danger-full-access",
    "--json", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules",
    "-c", 'approval_policy="never"',
  ];
  return wrapInSeatbelt(argv, {
    cwd: input.cwd,
    writable: input.mode === "review" ? [state, tmp] : [input.cwd, state, tmp],
    extraDenyRead: [join(homedir(), ".gemini")],
    // Codex signs in with ~/.codex/auth.json, so it never needs the Keychain.
    denyKeychain: true,
    sandboxExec,
  });
}

export function codexAdapter(bin: string = config().codexBin, sandboxExec: string = SANDBOX_EXEC): AgentAdapter {
  return {
    id: "codex",
    label: "Codex",
    async run(input: AgentRunInput): Promise<AgentRunResult> {
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
            input.onTool?.("bash", { command: item.command });
          }
        } else if (msg.type === "turn.completed") {
          // Cached input is a subset of input_tokens, not extra, so only the two totals are reported.
          usage = { inputTokens: msg.usage?.input_tokens ?? 0, outputTokens: msg.usage?.output_tokens ?? 0 };
        } else if (msg.type === "turn.failed") {
          errorMessage = String(msg.error?.message ?? "turn failed");
        } else if (msg.type === "error") {
          errorMessage ||= String(msg.message ?? "");
        }
      };

      // Codex has no system-prompt flag, so the instructions ride in front of the task.
      const proc = await withPrivateTmp((tmp, env) =>
        runAgentProcess(codexArgv(bin, input, tmp, sandboxExec), {
          cwd: input.cwd,
          stdin: `${input.systemPrompt}\n\n${input.prompt}`,
          env,
          signal: input.signal,
          onLine: handle,
        }),
      );
      const failure = seatbeltFailure(proc);
      if (proc.notInstalled || failure === "sandbox") return sandboxFailed("Codex");
      if (failure === "agent_missing") return { status: "error", kind: "not_installed", message: "Codex isn't installed, or `codex` isn't on your PATH. Install it, then retry." };
      const { stderr, exitCode } = proc;

      // A stop is the engine's doing, not the task's, so it must not read as a failure or a limit.
      if (proc.aborted) return { status: "error", kind: "failed", message: "Stopped" };

      if (exitCode === 0 && usage && !errorMessage) {
        return { status: "ok", summary: lastMessage, ...usage };
      }
      return classify(errorMessage, stderr, exitCode);
    },
    async probe(signal?: AbortSignal): Promise<AgentStatus> {
      let stdout = "";
      const proc = await runAgentProcess([bin, "login", "status"], { cwd: process.cwd(), stdin: "", signal, onLine: (l) => (stdout += `${l}\n`) });
      if (proc.notInstalled) return { installed: false, loggedIn: null, detail: "Install Codex and make sure `codex` is on your PATH." };
      // Codex 0.147 prints this line to stderr, so both streams are read.
      if (proc.exitCode === 0 && `${stdout}\n${proc.stderr}`.includes("Logged in")) return { installed: true, loggedIn: true, detail: "Signed in" };
      return { installed: true, loggedIn: false, detail: "Run `codex login` once in a terminal to sign in." };
    },
  };
}
