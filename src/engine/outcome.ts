// Whether a run did what its task asks, in the agent's own last line. Shared by the engine and the dashboard, so
// it imports nothing.
export type Outcome = "done" | "partial" | "couldnt" | "unknown";
export type ParsedOutcome = { outcome: Outcome; reason: string | null; body: string };

export const OUTCOME_INSTRUCTION = [
  "Your very last line must be exactly one of:",
  "OUTCOME: done",
  "OUTCOME: partial - <one plain sentence saying what's left>",
  "OUTCOME: couldnt - <one plain sentence saying why>",
  "Say done only if you did everything the task title asks. Drafting something is not sending it. If the task needs something only Atrium can do (sending a message, creating a repo), you have not done that part.",
].join("\n");

const REASON_MAX = 300;
// Agents dress the line up in markdown and pick their own dashes, so emphasis and any dash count as separators.
const LINE = /^outcome[*_`\s]*[:\-–—]?[*_`\s]*(done|partial|partly done|couldn['’]?t|could not)\b[*_`\s]*[:\-–—.]*\s*(.*)$/i;
const EDGES = /^[`*_>\s]+|[`*_>\s]+$/g;

const WORDS: Record<string, Outcome> = {
  done: "done",
  partial: "partial",
  "partly done": "partial",
  couldnt: "couldnt",
  "couldn't": "couldnt",
  "could not": "couldnt",
};

function cleanReason(raw: string): string | null {
  const text = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!text) return null;
  return text.length > REASON_MAX ? `${text.slice(0, REASON_MAX - 1)}…` : text;
}

// Only the last non-empty line counts: an agent quoting the instruction mid-reply hasn't reported anything.
export function parseOutcome(summary: string): ParsedOutcome {
  const lines = summary.replace(/\r\n?/g, "\n").split("\n");
  let last = lines.length - 1;
  while (last >= 0 && !lines[last]!.trim()) last--;
  const whole = lines.join("\n").trim();
  if (last < 0) return { outcome: "unknown", reason: null, body: whole };
  const m = LINE.exec(lines[last]!.replace(EDGES, ""));
  if (!m) return { outcome: "unknown", reason: null, body: whole };
  return {
    outcome: WORDS[m[1]!.toLowerCase().replace("’", "'")] ?? "unknown",
    reason: cleanReason(m[2]!),
    body: lines.slice(0, last).join("\n").trim(),
  };
}

export function outcomeLabel(o: Outcome): string | null {
  if (o === "couldnt") return "not done";
  if (o === "partial") return "partly done";
  return null;
}
