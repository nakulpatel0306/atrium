import { config } from "../config";
import { ENV_GLOBS } from "../envpath";
import { atriumDenyPaths } from "./atrium-paths";
import { privateReadRules, privateReads } from "./private-paths";
import { FALLBACK_WAIT_MS, parseRetryAfter } from "./limits";
import { runAgentProcess } from "./process";
import { agentEnv, DEPENDENCY_DIRS } from "./seatbelt";
import { shortCommand } from "./short";
import type { AgentAdapter, AgentRunInput, AgentRunResult, AgentStatus, AgentUsage, WindowUsage } from "./types";

const usesBash = (tools: string[]) => tools.some((t) => t === "Bash" || t.startsWith("Bash("));

const denyRules = (cwd: string, privateData = false, bash = true) => [
  // .env names in any case, names ending in .env, and everything inside a folder with such a name.
  ...["Read", "Edit", "Write"].flatMap((tool) => ENV_GLOBS.flatMap((g) => [`${tool}(**/${g})`, `${tool}(**/${g}/**)`])),
  "Bash(cat *.env*)",
  // The Keychain CLI, which would hand an agent whatever the login keychain holds.
  "Bash(security *)",
  // GitHub is the engine's alone: creating repos, pushing, and pointing a repo at another remote.
  "Bash(gh *)",
  "Bash(git push*)",
  "Bash(git remote*)",
  "Bash(git clone*)",
  "Bash(git -c*)",
  // Driving other apps would let an agent act outside its sandbox. Matched anywhere in the command,
  // so "sh -c 'osascript …'" or "env osascript" is denied too.
  "Bash(*osascript*)",
  "Bash(*shortcuts*)",
  "Bash(*automator*)",
  "Bash(open *)",
  "Bash(* open *)",
  "Bash(*/open *)",
  // Planted hooks or config in .git could run code outside the agent's tool limits.
  "Edit(**/.git/**)",
  "Write(**/.git/**)",
  // Atrium's checks run tools from these, so only the engine installs into them.
  ...DEPENDENCY_DIRS.flatMap((d) => [`Edit(**/${d}/**)`, `Write(**/${d}/**)`]),
  // Project settings in .claude are loaded by later runs (--setting-sources project), so an agent could widen its own permissions.
  "Edit(**/.claude/**)",
  "Write(**/.claude/**)",
  // The OS sandbox covers Bash and its children, not Claude's own Read tool.
  "Read(~/.ssh/**)",
  "Read(~/.aws/**)",
  "Read(~/.gnupg/**)",
  "Read(~/.config/gh/**)",
  "Read(~/Library/Messages/**)",
  "Read(~/Library/Application Support/AddressBook/**)",
  "Read(~/Library/Contacts/**)",
  // Atrium's DB, transcripts and other spaces' folders; a general-space run keeps its own. "//" anchors at the root.
  ...atriumDenyPaths(cwd).flatMap((p) => [`Read(/${p})`, `Read(/${p}/**)`]),
  // A private space's run: the three folders bank exports land in, and no Bash at all unless it's a
  // private repo's test commands.
  ...(privateData ? privateReadRules(cwd) : []),
  ...(privateData && !bash ? ["Bash"] : []),
];

// Per-run settings: the sandbox must hard-fail rather than quietly run unconfined.
export function sandboxSettings(cwd: string, opts: { privateData?: boolean; bash?: boolean } = {}): string {
  const reads = opts.privateData ? privateReads(cwd, { bash: opts.bash ?? true }) : null;
  return JSON.stringify({
    // A private run's file tools refuse anything outside its working directory, in every mode. Without
    // this, -p runs read outside it freely (Claude Code 2.1.257 or later honours it).
    ...(reads && { permissions: { blockReadsOutsideWorkingDirectories: true } }),
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      // Passed with --settings, which outranks the repo's .claude settings and the user's, and (with this false) makes
      // the sandbox admin-required, so a cloned repo can't add excluded commands, sockets or hosts.
      allowUnsandboxedCommands: false,
      // Apple Events would let a sandboxed command drive Mail, Messages or Terminal as "bun" once the user has allowed that.
      allowAppleEvents: false,
      enableWeakerNestedSandbox: false,
      enableWeakerNetworkIsolation: false,
      autoAllowBashIfSandboxed: false,
      filesystem: {
        denyRead: [
          "~/.ssh", "~/.aws", "~/.gnupg", "~/.config/gh", "~/Library/Keychains",
          "~/Library/Messages", "~/Library/Application Support/AddressBook", "~/Library/Contacts",
          // A wildcard entry that matches a folder blocks its contents too.
          ...ENV_GLOBS.flatMap((g) => [`~/**/${g}`, `${cwd}/**/${g}`]),
          ...atriumDenyPaths(cwd),
          ...(reads?.denyRead ?? []),
        ],
        // Bash can't install into or plant tools in the folders Atrium's checks run from.
        denyWrite: DEPENDENCY_DIRS.map((d) => `${cwd}/${d}`),
        ...(reads?.allowRead.length && { allowRead: reads.allowRead }),
      },
      network: { allowedDomains: ["registry.npmjs.org"], allowLocalBinding: false, allowAllUnixSockets: false },
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

// permissions.blockReadsOutsideWorkingDirectories, which fences a private run's file tools to its folder, arrived in
// Claude Code 2.1.257 (settings reference: "Requires Claude Code v2.1.257 or later"). An older CLI would ignore it, so
// a private run refuses to start there.
export const MIN_PRIVATE_VERSION = [2, 1, 257] as const;
export const TOO_OLD = "This space is private, and Claude Code is too old to keep its reads to the space's own folder. Run `claude update`, then retry.";

export function atLeast(v: number[], min: readonly number[]): boolean {
  for (let i = 0; i < min.length; i++) if ((v[i] ?? 0) !== min[i]) return (v[i] ?? 0) > min[i]!;
  return true;
}

async function cliVersion(bin: string, signal?: AbortSignal): Promise<number[] | null> {
  let line = "";
  const proc = await runAgentProcess([bin, "--version"], { cwd: process.cwd(), stdin: "", signal, onLine: (l) => void (line ||= l) });
  const m = !proc.notInstalled && proc.exitCode === 0 ? line.match(/(\d+)\.(\d+)\.(\d+)/) : null;
  return m ? [+m[1]!, +m[2]!, +m[3]!] : null;
}

export function claudeAdapter(bin: string = config().claudeBin): AgentAdapter {
  return {
    id: "claude",
    label: "Claude Code",
    async run(input: AgentRunInput): Promise<AgentRunResult> {
      // The variadic --allowedTools would swallow a flag-looking entry as another option.
      const flagLike = input.allowedTools.find((t) => t.startsWith("-"));
      if (flagLike) throw new Error(`Invalid allowedTools entry: ${flagLike}`);
      // Fail closed: a version Atrium can't read counts as too old.
      if (input.privateData) {
        const v = await cliVersion(bin, input.signal);
        if (!v || !atLeast(v, MIN_PRIVATE_VERSION)) return { status: "error", kind: "failed", message: TOO_OLD };
      }

      let limitResetsAt: number | undefined;
      let limitRejected = false;
      let usage: AgentUsage | undefined;
      let final: { result: string; isError: boolean; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } | undefined;

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
              input.onTool?.(String(block.name), block.input);
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
            cacheReadTokens: msg.usage?.cache_read_input_tokens ?? 0,
            cacheWriteTokens: msg.usage?.cache_creation_input_tokens ?? 0,
          };
        }
      };

      const proc = await runAgentProcess(
        [
          bin, "-p",
          "--setting-sources", "project,local",
          "--settings", sandboxSettings(input.cwd, { privateData: input.privateData, bash: usesBash(input.allowedTools) }),
          "--strict-mcp-config", "--no-session-persistence",
          "--output-format", "stream-json", "--verbose",
          "--permission-mode", "dontAsk",
          ...(input.model ? ["--model", input.model] : []),
          ...(input.maxTurns ? ["--max-turns", String(input.maxTurns)] : []),
          "--append-system-prompt", input.systemPrompt,
          // No tools at all ("--tools ''") rather than an empty allow list, which the variadic flag can't express.
          ...(input.allowedTools.length ? ["--allowedTools", ...input.allowedTools] : ["--tools", ""]),
          "--disallowedTools", ...denyRules(input.cwd, input.privateData, usesBash(input.allowedTools)), ...(input.allowedTools.length ? [] : ["mcp__*"]),
        ],
        { cwd: input.cwd, stdin: input.prompt, env: agentEnv(process.env), signal: input.signal, onLine: handle },
      );
      if (proc.notInstalled) return { status: "error", kind: "not_installed", message: "Claude Code isn't installed, or `claude` isn't on your PATH. Install it, then retry." };
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
          ...(usage && { usage }),
        };
      }
      if (succeeded && final) {
        return {
          status: "ok",
          summary: final.result,
          inputTokens: final.inputTokens,
          outputTokens: final.outputTokens,
          cacheReadTokens: final.cacheReadTokens,
          cacheWriteTokens: final.cacheWriteTokens,
          ...(usage && { usage }),
        };
      }
      return classify(`${final?.result ?? ""}\n${stderr}`, stderr, exitCode);
    },
    // `claude` has no cheap sign-in check, so a logged-out CLI shows up when a run fails.
    async probe(signal?: AbortSignal): Promise<AgentStatus> {
      const proc = await runAgentProcess([bin, "--version"], { cwd: process.cwd(), stdin: "", signal, onLine() {} });
      if (proc.notInstalled || proc.exitCode !== 0) return { installed: false, loggedIn: null, detail: "Install Claude Code and make sure `claude` is on your PATH." };
      return { installed: true, loggedIn: null, detail: "Installed" };
    },
  };
}
