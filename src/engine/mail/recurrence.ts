// One form for an occurrence's original start, whichever source sent it: the UTC instant in ms, as text. Google
// gives "2026-11-12T10:00:00-05:00" (or "2026-11-12" for an all-day event) and Calendar.app gives
// "2026-11-12T15:00:00Z"; both become "1794495600000". A date-only value is that day's local midnight, matching how
// all-day events are stored. Null for a single event; unreadable text is kept as it came.
export function canonicalRecurrence(value: string | null | undefined): string | null {
  if (!value) return null;
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00`).getTime() : Date.parse(value);
  return Number.isNaN(ms) ? value : String(ms);
}
