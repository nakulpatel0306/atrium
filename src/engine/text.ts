// Shared by the engine and the dashboard, so it imports nothing.
const NAMES: Record<string, string> = { auto: "Auto", claude: "Claude", codex: "Codex", gemini: "Gemini", atrium: "Atrium" };
export const agentName = (id: string) => NAMES[id] ?? id;

export const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

// Agent and git messages don't always end in a full stop; the next sentence follows them.
export const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

export function bytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
