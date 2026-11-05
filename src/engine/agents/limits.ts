export const FALLBACK_WAIT_MS = 30 * 60_000;

// Reset time as an epoch (ms), from "|<epoch seconds>" (Claude), "resets 2:40pm" (Claude)
// or "try again at 3:40 PM" (Codex): the next local occurrence of that clock time.
// "in 2h 5m" (Gemini) is a duration from now.
export function parseRetryAfter(text: string): number {
  const epoch = text.match(/\|\s*(\d{10})\b/);
  if (epoch) return Number(epoch[1]) * 1000;
  const span = text.match(/\bin\s+(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\b/i);
  if (span && (span[1] || span[2])) return Date.now() + (Number(span[1] ?? 0) * 60 + Number(span[2] ?? 0)) * 60_000;
  const clock = text.match(/(?:resets?|try again)\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (clock) {
    let hour = Number(clock[1]) % 12;
    if (clock[3]!.toLowerCase() === "pm") hour += 12;
    const when = new Date();
    when.setHours(hour, Number(clock[2] ?? 0), 0, 0);
    if (when.getTime() <= Date.now()) when.setDate(when.getDate() + 1);
    return when.getTime();
  }
  return Date.now() + FALLBACK_WAIT_MS;
}
