import { config } from "../config";
import { FALLBACK_WAIT_MS, parseRetryAfter } from "./limits";
import { runAgentProcess } from "./process";
import { shortCommand } from "./short";
import type { AgentAdapter, AgentRunInput, AgentRunResult, AgentStatus, AgentUsage, WindowUsage } from "./types";

const denyRules = () => [
  "Read(**/.env*)",
  "Edit(**/.env*)",
  "Write(**/.env*)",
  // Names ending in .env, such as prod.env.
  "Read(**/*.env)",
  "Edit(**/*.env)",
  "Write(**/*.env)",
  "Bash(cat *.env*)",
  // Planted hooks or config in .git could run code outside the agent's tool limits.
  "Edit(**/.git/**)",
  "Write(**/.git/**)",
  // Project settings in .claude are loaded by later runs (--setting-sources project), so an agent could widen its own permissions.
  "Edit(**/.claude/**)",
  "Write(**/.claude/**)",
  // The OS sandbox covers Bash and its children, not Claude's own Read tool.
  "Read(~/.ssh/**)",
  "Read(~/.aws/**)",
  "Read(~/.gnupg/**)",
  "Read(~/.config/gh/**)",
  // Atrium's own DB and transcripts hold other spaces' work. A "//" prefix anchors the rule at the filesystem root.
  `Read(/${config().home}/**)`,
];

// Per-run settings: the sandbox must hard-fail rather than quietly run unconfined.
export function sandboxSettings(cwd: string): string {
  return JSON.stringify({
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: false,
      filesystem: {
        denyRead: ["~/.ssh", "~/.aws", "~/.gnupg", "~/.config/gh", "~/Library/Keychains", "~/**/.env*", "~/**/*.env", `${cwd}/**/.env*`, `${cwd}/**/*.env`, config().home],
      },
      network: { allowedDomains: ["registry.npmjs.org"] },
    },
  });
}

function shortInput(input: Record<string, unknown> | undefined): string {
  if (!input) return "";
  return shortCommand(input.file_path ?? input.command ?? input.pattern ?? input.path ?? input.url ?? JSON.stringify(input));
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
  if (/sandbox/i.test(stderr) && /unavailable|not available|failed to start/i.test(stderr)) {
    return {
      status: "error",
      kind: "failed",
      message: "Claude's sandbox isn't available on this Mac, so Atrium won't run Claude without it. Update Claude Code (`claude update`) and try again.",
    };
  }
  const tail = stderr.trim().split("\n").slice(-20).join("\n");
  return { status: "error", kind: "failed", message: tail || `Claude Code exited with code ${exitCode}` };
}

// resetsAt arrives in epoch seconds. A window without a numeric utilization carries nothing to record.
function windowUsage(w: any, fallbackResetsAt?: unknown): WindowUsage | undefined {
  const resetsAt = Number(w?.resetsAt ?? fallbackResetsAt) * 1000;
  return typeof w?.utilization === "number" && Number.isFinite(resetsAt) ? { utilization: w.utilization, resetsAt } : undefined;
}

export function claudeAdapter(bin: string = config().claudeBin): AgentAdapter {
  return {
    id: "claude",
    label: "Claude Code",
    async run(input: AgentRunInput): Promise<AgentRunResult> {
      // The variadic --allowedTools would swallow a flag-looking entry as another option.
      const flagLike = input.allowedTools.find((t) => t.startsWith("-"));
      if (flagLike) throw new Error(`Invalid allowedTools entry: ${flagLike}`);

      let limitResetsAt: number | undefined;
      let limitRejected = false;
      let usage: AgentUsage | undefined;
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
          const windows = info?.unifiedWindows;
          // Only the five-hour window falls back to the event's own reset time, which is for the window that fired it.
          const fiveHour = windowUsage(windows?.five_hour, info?.rateLimitType === "five_hour" ? info.resetsAt : undefined);
          const sevenDay = windowUsage(windows?.seven_day);
          if (fiveHour || sevenDay) usage = { ...(fiveHour && { fiveHour }), ...(sevenDay && { sevenDay }) };
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

      const proc = await runAgentProcess(
        [
          bin, "-p",
          "--setting-sources", "project,local",
          "--settings", sandboxSettings(input.cwd),
          "--strict-mcp-config", "--no-session-persistence",
          "--output-format", "stream-json", "--verbose",
          "--permission-mode", "dontAsk",
          "--append-system-prompt", input.systemPrompt,
          "--allowedTools", ...input.allowedTools,
          "--disallowedTools", ...denyRules(),
        ],
        { cwd: input.cwd, stdin: input.prompt, signal: input.signal, onLine: handle },
      );
      if (proc.notInstalled) return { status: "error", kind: "not_installed", message: "Claude Code isn't installed or not on PATH" };
      const { stderr, exitCode } = proc;

      // A stop is the engine's doing, not the task's, so it must not read as a failure or a limit.
      if (proc.aborted) return { status: "error", kind: "failed", message: "Stopped" };

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
        return {
          status: "ok",
          summary: final.result,
          inputTokens: final.inputTokens,
          outputTokens: final.outputTokens,
          ...(usage && { usage }),
        };
      }
      return classify(`${final?.result ?? ""}\n${stderr}`, stderr, exitCode);
    },
    // `claude` has no cheap sign-in check, so a logged-out CLI shows up when a run fails.
    async probe(): Promise<AgentStatus> {
      const proc = await runAgentProcess([bin, "--version"], { cwd: process.cwd(), stdin: "", onLine() {} });
      if (proc.notInstalled || proc.exitCode !== 0) return { installed: false, loggedIn: null, detail: "Claude Code isn't installed or not on PATH" };
      return { installed: true, loggedIn: null, detail: "Installed" };
    },
  };
}
