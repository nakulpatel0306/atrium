import type { Database } from "bun:sqlite";
import { atLeast, claudeAdapter, MIN_PRIVATE_VERSION } from "./agents/claude";
import { codexAdapter } from "./agents/codex";
import { geminiAdapter } from "./agents/gemini";
import { runAgentProcess } from "./agents/process";
import type { AgentAdapter } from "./agents/types";
import { config } from "./config";
import { tildePath } from "./folders";
import { HOME_CURRENCY, storedName, suggestedName } from "./profile";
import { runGh } from "./repos/gh";
import { listSpaces } from "./spaces";

// What "Get started" and `atrium doctor` show. Every check asks a CLI for its own status or version; none of them
// opens a credential file, a token or a Keychain item.
export type CheckState = "ready" | "not_installed" | "too_old" | "signed_out" | "unknown";
export type Check = {
  id: string;
  label: string;
  required: boolean;
  state: CheckState;
  version: string | null;
  minimum: string | null;
  message: string;
  install: string;
  signIn: string;
};
export type Report = {
  agents: Check[];
  github: Check;
  permissions: { label: string; message: string }[];
  investing: { spaceId: string | null };
  money: { formats: string[]; message: string };
  profile: { name: string | null; suggestedName: string | null; projectsRoot: string; homeCurrency: string };
  hasSpaces: boolean;
};

const VERSION = /(\d+)\.(\d+)\.(\d+)/;
const PROBE_MS = 10_000;

async function versionOf(bin: string): Promise<{ installed: boolean; version: number[] | null }> {
  let line = "";
  const signal = AbortSignal.timeout(PROBE_MS);
  const proc = await runAgentProcess([bin, "--version"], { cwd: process.cwd(), stdin: "", signal, onLine: (l) => void (line ||= l) });
  if (proc.notInstalled) return { installed: false, version: null };
  const m = proc.exitCode === 0 ? line.match(VERSION) : null;
  return { installed: proc.exitCode === 0, version: m ? [+m[1]!, +m[2]!, +m[3]!] : null };
}

// `claude auth status` prints JSON; only its loggedIn flag is read, the rest is dropped unread.
async function claudeSignedIn(bin: string): Promise<boolean | null> {
  let text = "";
  const signal = AbortSignal.timeout(PROBE_MS);
  const proc = await runAgentProcess([bin, "auth", "status"], { cwd: process.cwd(), stdin: "", signal, onLine: (l) => (text += l) });
  if (proc.notInstalled) return null;
  try {
    const flag = (JSON.parse(text) as { loggedIn?: unknown }).loggedIn;
    return typeof flag === "boolean" ? flag : null;
  } catch {
    // Output that isn't the JSON status is a failed check (timeout, rate limit), not a sign-out.
    return null;
  }
}

type AgentSpec = { id: string; label: string; required: boolean; bin: string; install: string; signIn: string; adapter: AgentAdapter; minimum?: readonly number[] };

async function agentCheck(spec: AgentSpec): Promise<Check> {
  const base = { id: spec.id, label: spec.label, required: spec.required, install: spec.install, signIn: spec.signIn, minimum: spec.minimum?.join(".") ?? null };
  const { installed, version } = await versionOf(spec.bin);
  if (!installed) return { ...base, state: "not_installed", version: null, message: `${spec.label} isn't installed.` };
  const v = version?.join(".") ?? null;
  // A version Atrium can't read counts as too old, as it does when a private run starts.
  const tooOld = spec.minimum && (!version || !atLeast(version, spec.minimum));
  if (tooOld) return { ...base, state: "too_old", version: v, message: `${spec.label} ${v ?? "(version unknown)"} is older than ${base.minimum}. Update it.` };
  const signedIn = spec.id === "claude" ? await claudeSignedIn(spec.bin) : (await spec.adapter.probe?.(AbortSignal.timeout(PROBE_MS)))?.loggedIn ?? null;
  if (signedIn === false) return { ...base, state: "signed_out", version: v, message: `${spec.label} is installed but not signed in.` };
  if (signedIn === null) return { ...base, state: "unknown", version: v, message: `Couldn't check whether ${spec.label} is signed in. Try again.` };
  return { ...base, state: "ready", version: v, message: `${spec.label} is installed and signed in.` };
}

async function githubCheck(): Promise<Check> {
  const base = { id: "gh", label: "GitHub CLI", required: false, minimum: null, install: "brew install gh", signIn: "gh auth login" };
  const ver = await runGh(["--version"], { timeoutMs: PROBE_MS });
  if (ver.code !== 0) return { ...base, state: "not_installed", version: null, message: "The GitHub CLI isn't installed. It's only needed for code spaces that create or clone GitHub repos." };
  const version = ver.out.match(VERSION)?.[0] ?? null;
  const auth = await runGh(["auth", "status"], { timeoutMs: PROBE_MS });
  if (auth.code !== 0) return { ...base, state: "signed_out", version, message: "The GitHub CLI is installed but not signed in." };
  return { ...base, state: "ready", version, message: "The GitHub CLI is installed and signed in." };
}

export const MONEY_FORMATS = ["TD", "Amex", "Wealthsimple (chequing, savings, activity and holdings)", "Any bank's CSV with date, description and amount columns"];

// With no database (the command line), the profile and space questions use what the Mac itself says.
export async function doctor(db: Database | null): Promise<Report> {
  const c = config();
  const [claude, codex, gemini, github] = await Promise.all([
    agentCheck({ id: "claude", label: "Claude", required: true, bin: c.claudeBin, install: "curl -fsSL https://claude.ai/install.sh | bash", signIn: "claude auth login", adapter: claudeAdapter(), minimum: MIN_PRIVATE_VERSION }),
    agentCheck({ id: "codex", label: "Codex", required: false, bin: c.codexBin, install: "npm install -g @openai/codex", signIn: "codex login", adapter: codexAdapter() }),
    agentCheck({ id: "gemini", label: "Gemini (Antigravity)", required: false, bin: c.geminiBin, install: "Install Antigravity, which provides the agy command", signIn: "agy", adapter: geminiAdapter() }),
    githubCheck(),
  ]);
  const spaces = db ? listSpaces(db) : [];
  return {
    agents: [claude, codex, gemini],
    github,
    permissions: [
      { label: "Contacts", message: "Looked at only when you ask Atrium to text someone by name. macOS asks the first time." },
      { label: "Messages (Automation)", message: "Needed only to send a text after you press Send. macOS asks the first time." },
    ],
    investing: { spaceId: spaces.find((s) => s.kind === "markets" && s.name === "Investing")?.id ?? null },
    money: { formats: MONEY_FORMATS, message: "Import a CSV from your bank each month. Card and account numbers are masked before anything is saved." },
    profile: { name: db ? storedName(db) : null, suggestedName: suggestedName(), projectsRoot: tildePath(c.projectsRoot), homeCurrency: HOME_CURRENCY },
    hasSpaces: spaces.length > 0,
  };
}

const MARK: Record<CheckState, string> = { ready: "ok     ", not_installed: "missing", too_old: "old    ", signed_out: "sign in", unknown: "?      " };

export function formatDoctor(r: Report): string {
  const lines = ["Agents"];
  const row = (k: Check) => {
    lines.push(`  ${MARK[k.state]}  ${k.label}${k.version ? ` ${k.version}` : ""}${k.required ? " (required)" : " (optional)"}`);
    if (k.state === "not_installed") lines.push(`           install:  ${k.install}`);
    if (k.state === "not_installed" || k.state === "signed_out" || k.state === "unknown") lines.push(`           sign in:  ${k.signIn}`);
    if (k.state === "too_old") lines.push(`           ${k.message}`);
  };
  r.agents.forEach(row);
  lines.push("", "Code spaces");
  row(r.github);
  lines.push("", "Permissions (asked on first use, never from here)");
  for (const p of r.permissions) lines.push(`  ${p.label}: ${p.message}`);
  lines.push("", "Your folders", `  Projects folder: ${r.profile.projectsRoot}`, `  Home currency:   ${r.profile.homeCurrency} (fixed for now)`);
  lines.push("", "Investing and money are set up from the dashboard's Get started screen, or with: atrium investing setup");
  return lines.join("\n");
}
