import { config } from "../config";
import { ENV_GLOBS } from "../envpath";
import { atriumDenyPaths } from "./atrium-paths";
import { privateReadRules, privateReads } from "./private-paths";
import { FALLBACK_WAIT_MS, parseRetryAfter } from "./limits";
import { runAgentProcess } from "./process";
import { agentEnv, DEPENDENCY_DIRS } from "./seatbelt";
import { shortCommand } from "./short";
import type { AgentAdapter, AgentRunInput, AgentRunResult, AgentStatus, AgentUsage, ModelTokens, WindowUsage } from "./types";

// "Bash(bun test*)" is the Bash tool with a rule; --tools takes only the tool names.
const builtinTools = (allowed: string[]): string[] => [...new Set(allowed.map((t) => t.replace(/\(.*$/, "")))];

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
  // Nothing in .claude is read as settings (see the run's flags), but a repo's .claude still holds what Claude Code
  // reads in other ways, and what the user's own sessions in it would load, so agents leave it alone.
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
    // Hooks run outside the sandbox. No settings file is loaded (see --setting-sources), and this keeps any other
    // source of hooks shut too.
    disableAllHooks: true,
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// A kept session is started under Atrium's own id, so it's known before the run, or resumed from it. Without one
// the CLI keeps nothing on disk.
function sessionArgs(session: AgentRunInput["session"]): string[] {
  if (!session) return ["--no-session-persistence"];
  if (!UUID.test(session.id)) throw new Error(`Invalid session id: ${session.id}`);
  return session.resume ? ["--resume", session.id] : ["--session-id", session.id];
}

// The result's per-model totals, subagents included, keyed by the model names Claude Code reports.
function modelTotals(raw: unknown): ModelTokens[] | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  return Object.entries(raw as Record<string, Record<string, unknown>>).map(([model, u]) => ({
    model,
    inputTokens: n(u?.inputTokens),
    outputTokens: n(u?.outputTokens),
    cacheReadTokens: n(u?.cacheReadInputTokens),
    cacheWriteTokens: n(u?.cacheCreationInputTokens),
    cacheWrite1hTokens: n(u?.cacheCreationEphemeral1hInputTokens),
    ...(typeof u?.costUSD === "number" && Number.isFinite(u.costUSD) && u.costUSD >= 0 && { costUSD: u.costUSD }),
  }));
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
      for (const m of [input.model, input.fallbackModel]) if (m?.startsWith("-")) throw new Error(`Invalid model: ${m}`);
      // Fail closed: a version Atrium can't read counts as too old.
      if (input.privateData) {
        const v = await cliVersion(bin, input.signal);
        if (!v || !atLeast(v, MIN_PRIVATE_VERSION)) return { status: "error", kind: "failed", message: TOO_OLD };
      }

      let limitResetsAt: number | undefined;
      let limitRejected = false;
      let usage: AgentUsage | undefined;
      let contextTokens: number | undefined;
      let final: { result: string; isError: boolean; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; cacheWrite1hTokens: number; models?: ModelTokens[] } | undefined;

      const handle = (line: string) => {
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        if (msg.type === "assistant") {
          // The main agent's own step (not a subagent's): what it read in is the context it now holds.
          const u = msg.message?.usage;
          if (u && !msg.parent_tool_use_id) contextTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
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
            cacheWrite1hTokens: msg.usage?.cache_creation?.ephemeral_1h_input_tokens ?? 0,
            models: modelTotals(msg.modelUsage),
          };
        }
      };

      const proc = await runAgentProcess(
        [
          bin, "-p",
          // No settings files at all, the user's included: a repo's own .claude/settings.json could otherwise run hooks
          // and an apiKeyHelper outside the sandbox, set env (ANTHROPIC_BASE_URL) for the CLI, or bring plugins. Only
          // Atrium's pinned --settings apply. The repo's CLAUDE.md still loads, through --add-dir and the env below.
          "--setting-sources", "",
          "--add-dir", input.cwd,
          "--settings", sandboxSettings(input.cwd, { privateData: input.privateData, bash: usesBash(input.allowedTools) }),
          "--strict-mcp-config", ...sessionArgs(input.session),
          "--output-format", "stream-json", "--verbose",
          "--permission-mode", "dontAsk",
          ...(input.model ? ["--model", input.model] : []),
          ...(input.fallbackModel ? ["--fallback-model", input.fallbackModel] : []),
          ...(input.maxTurns ? ["--max-turns", String(input.maxTurns)] : []),
          "--append-system-prompt", input.systemPrompt,
          // Only the built-in tools Atrium allows exist in the run at all. Without --tools, dontAsk still lets an agent
          // use tools no rule names (Agent, EnterWorktree, Monitor, CronCreate…: a second writer, a worktree, a command
          // outside the Bash rules), and Claude Code removes the others for its subagents too. No tools at all is
          // "--tools ''", since an empty allow list can't be expressed with the variadic flag.
          "--tools", builtinTools(input.allowedTools).join(","),
          ...(input.allowedTools.length ? ["--allowedTools", ...input.allowedTools] : []),
          "--disallowedTools", ...denyRules(input.cwd, input.privateData, usesBash(input.allowedTools)), ...(input.allowedTools.length ? [] : ["mcp__*"]),
        ],
        { cwd: input.cwd, stdin: input.prompt, env: { ...agentEnv(process.env), CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1" }, signal: input.signal, onLine: handle },
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
          ...(final.cacheWrite1hTokens > 0 && { cacheWrite1hTokens: final.cacheWrite1hTokens }),
          ...(usage && { usage }),
          ...(final.models && { models: final.models }),
          ...(contextTokens !== undefined && { contextTokens }),
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
