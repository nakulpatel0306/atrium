import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { config } from "../config";
import { atriumDenyPaths } from "./atrium-paths";
import type { AgentProcessResult } from "./process";
import type { AgentRunResult } from "./types";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

// Any path component starting or ending with ".env", in any case: /a/.env.local, /a/.ENVRC, /a/prod.env, /a/.env/x,
// but not /a/my.env.txt. Seatbelt regexes have no case flag, hence the character classes.
export const ENV_FILE_PATTERN = "/\\.[eE][nN][vV][^/]*(/|$)|\\.[eE][nN][vV](/|$)";

// Credentials, tokens, shell history, browser and mail data, and Atrium's own database, relative to home.
const SECRET_PATHS = [
  ".ssh", ".aws", ".gnupg", ".config/gh", "Library/Keychains", ".netrc", ".npmrc", ".yarnrc", ".yarnrc.yml", ".docker",
  ".kube", ".config/gcloud", ".azure", ".git-credentials", ".config/git/credentials", ".pypirc", ".claude", ".claude.json",
  ".config/op", ".password-store", ".zsh_history", ".bash_history", ".local/share/fish/fish_history",
  "Library/Application Support/Google/Chrome", "Library/Application Support/Firefox", "Library/Safari", "Library/Cookies",
  "Library/Messages", "Library/Mail", "Library/Application Support/Atrium",
];

// Inside cwd but off limits: git metadata (engine commits happen outside the sandbox), and the per-project
// settings of Claude and agy, which an agent could otherwise use to widen its own permissions.
const PROTECTED_IN_CWD = [".git", ".claude", ".agents"];

// Devices every CLI writes to; nothing else under /dev is writable.
const DEVICES = ["/dev/null", "/dev/zero", "/dev/tty", "/dev/dtracehelper"];

// Each CLI's own state dir: writable for that CLI, unreadable for the others (it holds their sign-in tokens).
export const codexStateDir = () => process.env.CODEX_HOME ?? join(homedir(), ".codex");
// Only agy's working state; the rest of ~/.gemini (its sign-in token, per-project permission config) stays
// read-only so a run can't widen its own permissions.
export const geminiStateDir = () => join(homedir(), ".gemini", "antigravity-cli");

export interface SeatbeltOptions {
  cwd: string;
  writable: string[];
  // Per agent: the other agents' state dirs. Tests also use it to plant a canary without touching real credentials.
  extraDenyRead?: string[];
  // Single files re-allowed inside a denied path, for a CLI that can't start without them.
  allowRead?: string[];
  // Whole folders re-allowed inside a denied path: the engine-made folder a sandboxed copy writes into.
  allowReadDirs?: string[];
  // Cut the run off from the Keychain's services as well as its files. Only for a CLI that keeps its sign-in elsewhere.
  denyKeychain?: boolean;
}

// File keychains (login, where Atrium keeps market data keys) are read from ~/Library/Keychains, which SECRET_PATHS
// already denies to every binary, a copied `security` included. These services front the data-protection keychain
// and the unlock prompt. com.apple.SecurityServer has to stay reachable: TLS certificate checks go through it, and
// without it Codex can't reach its API (verified: "invalid peer certificate: UnknownIssuer").
const KEYCHAIN_SERVICES =
  '(deny mach-lookup (global-name "com.apple.securityd") (global-name "com.apple.security.agent") (global-name-prefix "com.apple.securityd"))';

// Only the engine talks to GitHub (creating, pushing, cloning); agents never commit, so they need none of these.
const GITHUB_ENV = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "SSH_AUTH_SOCK", "GIT_ASKPASS", "SSH_ASKPASS"];

export function agentEnv(base: Record<string, string | undefined>): Record<string, string | undefined> {
  const env = { ...base };
  for (const name of GITHUB_ENV) delete env[name];
  return env;
}

// gh wherever it's installed, so a run can't use Nakul's GitHub login even through a path the env still names.
function ghBinaries(): string[] {
  const found = [Bun.which(config().ghBin), "/opt/homebrew/bin/gh", "/usr/local/bin/gh"].filter((p): p is string => !!p && existsSync(p));
  return [...new Set(found.map((p) => realpathSync(p)))];
}

// Seatbelt matches resolved paths (/private/var, never /var), so an unresolved path would silently never match.
// A path that doesn't exist yet resolves through its nearest existing parent.
function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    const parent = dirname(p);
    return parent === p ? p : join(canonical(parent), basename(p));
  }
}

// SBPL strings take backslash escapes, so a quote in a path can't end the string and inject rules.
function str(p: string): string {
  return `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

const subpath = (p: string) => `(subpath ${str(canonical(p))})`;

// A deny list on top of allow-default: the CLI keeps network (it must reach its provider) and normal reads,
// but secret paths and .env files are unreadable and writes are confined to the given dirs.
export function seatbeltProfile(opts: SeatbeltOptions): string {
  const home = homedir();
  const cwd = canonical(opts.cwd);
  // The default Atrium dir is denied whole unless it is this engine's own, whose run-specific denies (everything
  // but the run's own space folder) come from atriumDenyPaths.
  const secrets = SECRET_PATHS.map((d) => join(home, d)).filter((p) => p !== config().home);
  const denyRead = [...new Set([...secrets, ...atriumDenyPaths(opts.cwd), ...(opts.extraDenyRead ?? [])])].map(subpath);
  const writable = opts.writable.map(subpath);
  return [
    "(version 1)",
    "(allow default)",
    // LaunchServices and Apple Events start apps (Terminal, Finder) outside the sandbox, which would escape it.
    "(deny lsopen)",
    "(deny appleevent-send)",
    // The Keychain CLI would hand an agent Atrium's market data keys; agents only ever get prices.
    '(deny process-exec (literal "/usr/bin/security"))',
    // Sending messages and controlling apps belong to the engine alone, after Nakul's own Send.
    '(deny process-exec (literal "/usr/bin/osascript"))',
    // GitHub is the engine's alone: no gh, no SSH to git hosts, and no SSH agent to sign or push with.
    ...ghBinaries().map((p) => `(deny process-exec (literal ${str(p)}))`),
    '(deny network-outbound (remote tcp "*:22"))',
    // No local sockets at all: SSH agents (launchd's, 1Password's, Secretive's) and any other local service are
    // reached through one, wherever it lives and whether or not SSH_AUTH_SOCK names it.
    "(deny network-outbound (remote unix-socket))",
    // Except DNS, which macOS answers through mDNSResponder's socket.
    '(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))',
    ...(opts.denyKeychain ? [KEYCHAIN_SERVICES] : []),
    // Atrium's API listens on loopback, and a forged Host/Origin from inside a run could approve its own drafts.
    // "localhost" covers 127.0.0.1, ::1, 0.0.0.0 and ::ffff:127.0.0.1; the CLIs only need the internet.
    '(deny network-outbound (remote ip "localhost:*"))',
    `(deny file-read* ${denyRead.join(" ")} (regex #"${ENV_FILE_PATTERN}"))`,
    // Later rules win in Seatbelt, so these literals reopen just the named files.
    ...(opts.allowRead?.length ? [`(allow file-read* ${opts.allowRead.map((p) => `(literal ${str(canonical(p))})`).join(" ")})`] : []),
    ...(opts.allowReadDirs?.length ? [`(allow file-read* ${opts.allowReadDirs.map(subpath).join(" ")})`] : []),
    `(deny file-write* (require-not (require-any ${writable.join(" ")} ${DEVICES.map((d) => `(literal "${d}")`).join(" ")} (regex #"^/dev/fd/[0-9]+$"))))`,
    // Writes to .env names are denied too, or an agent could rename .env to a readable name.
    `(deny file-write* ${PROTECTED_IN_CWD.map((d) => subpath(join(cwd, d))).join(" ")} (regex #"${ENV_FILE_PATTERN}"))`,
  ].join("\n");
}

export function wrapInSeatbelt(argv: string[], opts: SeatbeltOptions & { sandboxExec?: string }): string[] {
  return [opts.sandboxExec ?? SANDBOX_EXEC, "-p", seatbeltProfile(opts), ...argv];
}

// The shared per-user temp dir holds files that unsandboxed tools trust (xcrun's db, node's compile cache), so each
// run gets its own temp dir instead, pointed to by TMPDIR/TMP/TEMP and removed when the run ends.
export async function withPrivateTmp<T>(run: (tmp: string, env: Record<string, string | undefined>) => Promise<T>): Promise<T> {
  const tmp = mkdtempSync(join(tmpdir(), "atrium-agent-"));
  try {
    return await run(tmp, agentEnv({ ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp }));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function sandboxFailed(label: string): AgentRunResult {
  return { status: "error", kind: "failed", message: `Atrium couldn't start the sandbox for ${label}; this agent is paused for safety.` };
}

// sandbox-exec never execs the agent once it fails, so a failure here means the agent didn't run at all.
// It exits 71 when it can't exec the agent (missing binary) or apply the profile, 65 for a bad profile.
export function seatbeltFailure(proc: AgentProcessResult): "sandbox" | "agent_missing" | null {
  if (proc.notInstalled) return "sandbox";
  if (proc.exitCode !== 65 && proc.exitCode !== 71) return null;
  if (!/^sandbox-exec: /m.test(proc.stderr)) return null;
  return /^sandbox-exec: execvp\(\) of .* failed: No such file or directory/m.test(proc.stderr) ? "agent_missing" : "sandbox";
}
