// Shared by the engine and the dashboard, so it imports nothing.
const NAMES: Record<string, string> = { auto: "Auto", claude: "Claude", codex: "Codex", gemini: "Gemini", atrium: "Atrium" };
export const agentName = (id: string) => NAMES[id] ?? id;

// The status command each CLI has that reports something useful after a silent failure: whether it is still signed in.
// These are the ones Atrium's own probes run (doctor.ts, agents/codex.ts); Gemini has none, so it only gets the retry.
const STATUS: Record<string, string> = { "Claude Code": "claude auth status", Codex: "codex login status" };
const silentCause = (name: string, exitCode: number) => `${name} exited without a message (exit code ${exitCode})`;

// An agent CLI that fails and prints nothing leaves only its exit code, which tells the user nothing: say what happened
// and what to try.
export const silentExit = (name: string, exitCode: number): string =>
  `${silentCause(name, exitCode)}. Retry the task${STATUS[name] ? `; if it stops again, \`${STATUS[name]}\` in a terminal shows whether ${name} is still signed in` : ""}.`;

// A stop recorded before that wording ("Claude Code exited with code 1"), on its own or ending an Activity line,
// reads the same way now.
export const plainStop = (text: string): string =>
  text.replace(/\b(Claude Code|Codex|Gemini) exited with code (\d+)\.?$/, (_, name: string, code: string) => silentExit(name, Number(code)));

// For a one-line surface (Home's line, an Activity row): the cause alone, since the remedy is on the task's page.
export const shortStop = (text: string): string =>
  plainStop(text).replace(/\b(Claude Code|Codex|Gemini) exited without a message \(exit code (\d+)\)\. Retry the task.*$/, (_, name: string, code: string) => silentCause(name, Number(code)));

export const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

// Agent and git messages don't always end in a full stop; the next sentence follows them.
export const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

export function bytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

// A file's size, with a decimal while it is small enough for one to matter ("2.6 KB", "51 KB").
export function fileSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return bytes(n);
}
