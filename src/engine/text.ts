// Shared by the engine and the dashboard, so it imports nothing.
const NAMES: Record<string, string> = { auto: "Auto", claude: "Claude", codex: "Codex", gemini: "Gemini", atrium: "Atrium" };
export const agentName = (id: string) => NAMES[id] ?? id;

// An agent CLI that fails and prints nothing leaves only its exit code, which tells the user nothing: say what happened
// and the two things to try.
export const silentExit = (name: string, exitCode: number, cli: string): string =>
  `${name} stopped with an error and didn't say why (exit code ${exitCode}). Retry the task; if it stops again, run \`${cli}\` once in a terminal to see the error.`;

const CLIS: Record<string, string> = { "Claude Code": "claude", Codex: "codex", Gemini: "agy" };
// A stop recorded before that wording ("Claude Code exited with code 1"), on its own or ending an Activity line,
// reads the same way now.
export const plainStop = (text: string): string =>
  text.replace(/\b(Claude Code|Codex|Gemini) exited with code (\d+)\.?$/, (_, name: string, code: string) => silentExit(name, Number(code), CLIS[name]!));

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
