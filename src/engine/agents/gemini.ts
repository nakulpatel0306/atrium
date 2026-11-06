import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "../config";
import { parseRetryAfter } from "./limits";
import { runAgentProcess } from "./process";
import { shortCommand } from "./short";
import { SANDBOX_EXEC, codexStateDir, geminiStateDir, sandboxFailed, seatbeltFailure, withPrivateTmp, wrapInSeatbelt } from "./seatbelt";
import type { AgentAdapter, AgentRunInput, AgentRunResult, AgentStatus } from "./types";

const MODEL = "gemini-3.8-flash-medium";
const SIGN_IN = "Run `agy` once in a terminal to sign in.";
const NO_ANSWER = "Gemini finished without an answer, likely because it needed a tool Atrium doesn't allow. Try Claude or Codex for this task.";

// agy's sign-in goes through the login keychain file, so that one file is reopened inside the denied Keychains dir.
const LOGIN_KEYCHAIN = join(homedir(), "Library", "Keychains", "login.keychain-db");

// Passed per run with --settings, so nothing is written to the user's agy config. Headless agy auto-denies any
// action without an allow rule, and allowNonWorkspaceAccess:false keeps file tools inside the workspace. The deny
// list is belt and braces for browser, URL and MCP tools. agy has no setting that turns off its server-side
// search_web tool, so that one stays reachable.
export const GEMINI_SETTINGS = {
  allowNonWorkspaceAccess: false,
  permissions: { deny: ["browser_*", "open_browser_url", "read_url_content", "call_mcp_tool"] },
};

export function geminiArgv(bin: string, input: AgentRunInput, tmp: string, sandboxExec: string = SANDBOX_EXEC): string[] {
  // A value starting with "-" could parse as a flag, so such a prompt gets a leading newline.
  const text = `${input.systemPrompt}\n\n${input.prompt}`;
  const prompt = text.startsWith("-") ? `\n${text}` : text;
  const argv = [
    bin, "-p", prompt, "--output-format", "stream-json", "--model", MODEL, "--disable-slash-commands",
    "--sandbox", "--print-timeout", "900s", "--settings", JSON.stringify(GEMINI_SETTINGS),
    "--mode", input.mode === "review" ? "plan" : "accept-edits",
  ];
  return wrapInSeatbelt(argv, {
    cwd: input.cwd,
    writable: input.mode === "review" ? [geminiStateDir(), tmp] : [input.cwd, geminiStateDir(), tmp],
    extraDenyRead: [codexStateDir()],
    // agy signs in through the Keychain, so securityd stays reachable (no denyKeychain). Its headless mode runs no
    // shell commands, so it has no way to call `security` or a copy of it.
    allowRead: [LOGIN_KEYCHAIN],
    sandboxExec,
  });
}

// Only the CLI's own words (result error and stderr) are classified, never the agent's response.
function classify(message: string, stderr: string, exitCode: number): AgentRunResult {
  const text = `${message}\n${stderr}`;
  if (/quota|rate.?limit|resource.?exhausted|too many requests/i.test(text)) {
    const retryAfter = parseRetryAfter(text);
    const at = new Date(retryAfter).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return { status: "error", kind: "rate_limited", message: `Gemini quota reached; resets at ${at}`, retryAfter };
  }
  if (/authentication required|not (logged|signed) in|unauthenticated|sign in/i.test(text)) {
    return { status: "error", kind: "not_logged_in", message: SIGN_IN };
  }
  const tail = message || stderr.trim().split("\n").slice(-20).join("\n");
  return { status: "error", kind: "failed", message: tail || `Gemini exited with code ${exitCode}` };
}

export function geminiAdapter(bin: string = config().geminiBin, sandboxExec: string = SANDBOX_EXEC): AgentAdapter {
  return {
    id: "gemini",
    label: "Gemini",
    async run(input: AgentRunInput): Promise<AgentRunResult> {
      let response: string | undefined;
      let status = "";
      let errorMessage = "";
      let usage = { inputTokens: 0, outputTokens: 0 };

      const handle = (line: string) => {
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        if (msg.event === "step_update") {
          const step = msg.step_update;
          if (step?.step_type === "agent_response" && step.state === "ACTIVE" && step.text_delta?.trim()) {
            input.onChunk(String(step.text_delta));
          } else if (step?.step_type === "tool" && step.state === "DONE") {
            const name = step.tool_name ?? step.tool_info?.name ?? "tool";
            const p = step.tool_info?.parameters ?? {};
            input.onChunk(`→ ${name} ${shortCommand(p.CommandLine ?? p.command ?? p.Path ?? p.query)}`.trimEnd());
          }
        } else if (msg.event === "result") {
          const r = msg.result ?? {};
          status = String(r.status ?? "");
          response = String(r.response ?? "");
          errorMessage = typeof r.error === "string" ? r.error : String(r.error?.message ?? "");
          usage = { inputTokens: r.usage?.input_tokens ?? 0, outputTokens: r.usage?.output_tokens ?? 0 };
        }
      };

      // The prompt is an argv value, so stdin stays empty.
      const proc = await withPrivateTmp((tmp, env) =>
        runAgentProcess(geminiArgv(bin, input, tmp, sandboxExec), { cwd: input.cwd, stdin: "", env, signal: input.signal, onLine: handle }),
      );
      const failure = seatbeltFailure(proc);
      if (proc.notInstalled || failure === "sandbox") return sandboxFailed("Gemini");
      if (failure === "agent_missing") return { status: "error", kind: "not_installed", message: "Antigravity isn't installed, or `agy` isn't on your PATH. Install it, then retry." };

      // A stop is the engine's doing, not the task's, so it must not read as a failure or a limit.
      if (proc.aborted) return { status: "error", kind: "failed", message: "Stopped" };

      if (proc.exitCode === 0 && status === "SUCCESS" && response?.trim()) {
        return { status: "ok", summary: response.trimEnd(), ...usage };
      }
      // A tool needing approval is auto-denied in headless mode; agy still exits 0 with an empty response. Its own
      // explanation goes to the transcript, and Nakul gets one he can act on.
      if (proc.exitCode === 0 && status === "SUCCESS") {
        if (proc.stderr.trim()) input.onChunk(proc.stderr.trim());
        const known = classify("", proc.stderr, proc.exitCode);
        return known.status === "error" && known.kind !== "failed" ? known : { status: "error", kind: "failed", message: NO_ANSWER };
      }
      return classify(errorMessage, proc.stderr, proc.exitCode);
    },

    async probe(signal?: AbortSignal): Promise<AgentStatus> {
      let stdout = "";
      const proc = await runAgentProcess([bin, "models"], { cwd: process.cwd(), stdin: "", signal, onLine: (l) => (stdout += `${l}\n`) });
      if (proc.notInstalled) return { installed: false, loggedIn: null, detail: "Install Antigravity and make sure `agy` is on your PATH." };
      if (proc.exitCode === 0 && /^gemini-/m.test(stdout)) return { installed: true, loggedIn: true, detail: "Signed in" };
      if (proc.exitCode !== 0 && /authentication|sign in|not (logged|signed) in/i.test(`${stdout}\n${proc.stderr}`)) {
        return { installed: true, loggedIn: false, detail: SIGN_IN };
      }
      return { installed: true, loggedIn: null, detail: "Couldn't confirm sign-in; `agy models` listed no Gemini models." };
    },
  };
}
