// A short walkthrough of a finished change, for the user who wants to understand the code an agent wrote: the
// approach, the decisions with what they passed over, risky spots and where to look first. The reviewer writes it in
// the pass that already reads the diff; the cheap tier writes it alone when the reviewer couldn't. Whatever a model
// writes here is shown, never acted on. Imports nothing, so the dashboard can bundle it.

export type Spot = { file: string; line: number | null; note: string };

// Deep mode's one question before the walkthrough opens. `answer` is the right option's index; the user's click is
// `guess`, or `skipped`. Nothing is scored or kept beyond this task.
export type Predict = { question: string; options: string[]; answer: number; guess: number | null; skipped: boolean };

export type Walkthrough = {
  approach: string;
  decisions: { chose: string; rejected: string | null }[];
  risks: Spot[];
  look: Spot[];
  predict: Predict | null;
  // The commit it describes, so a turn after it leaves it stale.
  sha: string | null;
  // The agent that wrote it, and whether that was the reviewer's pass or a call of its own.
  by: string;
  source: "review" | "cheap";
};

export const APPROACH_MAX = 1000;
const NOTE_MAX = 300;
const ITEMS_MAX = 3;
const QUESTION_MAX = 200;
const OPTION_MAX = 120;

const KEYWORDS = ["APPROACH", "DECISION", "RISK", "LOOK", "PREDICT", "OPTION", "ANSWER", "FINDING", "VERDICT", "TRIAGE"];
// Agents dress lines up as bullets, quotes, `code` or **bold**; the keyword may carry a colon.
const LINE = new RegExp(`^[\\s>*_\`-]*(${KEYWORDS.join("|")})\\b[*_\`]*:?[*_\`]*\\s*(.*?)[\\s*_\`]*$`, "i");

// What the reviewer (or the cheap call) is asked to add. Deep mode adds the question.
export function walkthroughAsk(deep: boolean): string {
  return [
    "Then write a short walkthrough of the change for the user, who wants to understand it, not just approve it. Use exactly these lines:",
    "APPROACH <the approach in 3 to 5 plain sentences, on one line>",
    "DECISION <a key decision the change makes> REJECTED <the alternative it passed over>   (1 to 3 of these)",
    "RISK <file>:<line> <a spot that could break, and why>   (0 to 3 of these)",
    "LOOK <file>:<line> <where to look first, and why>   (1 to 3 of these, most useful first)",
    ...(deep
      ? [
          "PREDICT <one question the user can answer before reading the diff, such as which file changed most or how the change handles an edge case>",
          "OPTION <a possible answer>   (3 or 4 of these, one of them right)",
          "ANSWER <the number of the right option, counting from 1>",
        ]
      : []),
    "Use file paths exactly as the diff shows them and line numbers from the changed side.",
  ].join("\n");
}

// The paths a diff changes (a review's prompt holds one), so the walkthrough only links to files that are in it.
export function diffFiles(text: string): string[] {
  return [...new Set([...text.matchAll(/^diff --git a\/(.+?) b\//gm)].map((m) => m[1]!))];
}

const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// `<file>:<line> <note>` or `- <note>`. A file the diff doesn't hold can't be opened, so the spot keeps only its note.
function spot(rest: string, files: ReadonlySet<string>): Spot | null {
  const m = /^`?([^\s`]+?)`?(?::(\d+))?(?:\s+[-—–:]+)?\s+(.+)$/.exec(rest);
  if (!m) return rest.trim() ? { file: "", line: null, note: cap(rest.trim(), NOTE_MAX) } : null;
  const file = m[1]!.replace(/^(a|b)\//, "");
  const line = m[2] ? Number(m[2]) : null;
  const note = cap(m[3]!.trim(), NOTE_MAX);
  if (file === "-" || !files.has(file)) return { file: "", line: null, note: m[1] === "-" ? note : cap(rest.trim(), NOTE_MAX) };
  return { file, line: line !== null && line > 0 && line < 10_000_000 ? line : null, note };
}

// Reads the walkthrough lines out of a reply; null when there's no approach, which means the writer of the reply
// didn't (or couldn't) give one. `files` are the paths the diff changed.
export function parseWalkthrough(text: string, files: Iterable<string>, opts: { by: string; source: Walkthrough["source"]; sha: string | null; deep: boolean }): Walkthrough | null {
  const known = new Set(files);
  let approach = "";
  let inApproach = false;
  const decisions: Walkthrough["decisions"] = [];
  const risks: Spot[] = [];
  const look: Spot[] = [];
  let question = "";
  const options: string[] = [];
  let answer: number | null = null;
  for (const raw of text.split("\n")) {
    const m = LINE.exec(raw);
    if (!m) {
      // A model that wraps its approach keeps going on the next lines, up to a blank one.
      if (inApproach && raw.trim()) approach += ` ${raw.trim()}`;
      else inApproach = false;
      continue;
    }
    inApproach = false;
    const key = m[1]!.toUpperCase();
    const rest = m[2]!.trim();
    if (key === "APPROACH" && !approach && rest) {
      approach = rest;
      inApproach = true;
    } else if (key === "DECISION" && rest && decisions.length < ITEMS_MAX) {
      const [chose, rejected] = rest.split(/\s*[|;,]?\s+REJECTED\b:?\s*/i);
      if (chose) decisions.push({ chose: cap(chose.trim(), NOTE_MAX), rejected: rejected?.trim() ? cap(rejected.trim(), NOTE_MAX) : null });
    } else if (key === "RISK" && risks.length < ITEMS_MAX) {
      const s = spot(rest, known);
      if (s) risks.push(s);
    } else if (key === "LOOK" && look.length < ITEMS_MAX) {
      const s = spot(rest, known);
      // Where to look first is a link into the diff, so a spot outside it is left out.
      if (s?.file) look.push(s);
    } else if (key === "PREDICT" && !question && rest) question = cap(rest, QUESTION_MAX);
    else if (key === "OPTION" && rest && options.length < 4) options.push(cap(rest.replace(/^\d+[.)]\s*/, ""), OPTION_MAX));
    else if (key === "ANSWER" && answer === null) {
      const n = /^\d+/.exec(rest);
      if (n) answer = Number(n[0]) - 1;
    }
  }
  if (!approach.trim()) return null;
  const predict =
    opts.deep && question && options.length >= 3 && answer !== null && answer >= 0 && answer < options.length ? { question, options, answer, guess: null, skipped: false } : null;
  return { approach: cap(approach.trim(), APPROACH_MAX), decisions, risks, look, predict, sha: opts.sha, by: opts.by, source: opts.source };
}

// The reply without its walkthrough lines, for the agent thread: the card shows them.
export function withoutWalkthrough(text: string): string {
  const out: string[] = [];
  let inApproach = false;
  for (const raw of text.split("\n")) {
    const m = LINE.exec(raw);
    const key = m?.[1]!.toUpperCase();
    if (key && ["APPROACH", "DECISION", "RISK", "LOOK", "PREDICT", "OPTION", "ANSWER"].includes(key)) {
      inApproach = key === "APPROACH";
      continue;
    }
    if (inApproach && raw.trim() && !m) continue;
    inApproach = false;
    out.push(raw);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? cap(v.trim(), max) : null);
const spots = (v: unknown, needFile: boolean): Spot[] =>
  (Array.isArray(v) ? v : [])
    .slice(0, ITEMS_MAX)
    .map((s: Record<string, unknown>) => ({ file: typeof s?.file === "string" ? s.file : "", line: Number.isInteger(s?.line) && (s.line as number) > 0 ? (s.line as number) : null, note: str(s?.note, NOTE_MAX) ?? "" }))
    .filter((s) => s.note && (!needFile || s.file));

// A stored walkthrough, field by field: anything off reads as no walkthrough, or no question.
export function storedWalkthrough(v: unknown): Walkthrough | null {
  const w = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const approach = str(w.approach, APPROACH_MAX);
  if (!approach) return null;
  const decisions = (Array.isArray(w.decisions) ? w.decisions : [])
    .slice(0, ITEMS_MAX)
    .map((d: Record<string, unknown>) => ({ chose: str(d?.chose, NOTE_MAX) ?? "", rejected: str(d?.rejected, NOTE_MAX) }))
    .filter((d) => d.chose);
  const p = (w.predict && typeof w.predict === "object" ? w.predict : null) as Record<string, unknown> | null;
  const options = Array.isArray(p?.options) ? p.options.filter((o): o is string => typeof o === "string").slice(0, 4) : [];
  const answer = p?.answer;
  const guess = p?.guess;
  const predict =
    p && str(p.question, QUESTION_MAX) && options.length >= 3 && Number.isInteger(answer) && (answer as number) >= 0 && (answer as number) < options.length
      ? {
          question: str(p.question, QUESTION_MAX)!,
          options,
          answer: answer as number,
          guess: Number.isInteger(guess) && (guess as number) >= 0 && (guess as number) < options.length ? (guess as number) : null,
          skipped: p.skipped === true,
        }
      : null;
  return {
    approach,
    decisions,
    risks: spots(w.risks, false),
    look: spots(w.look, true),
    predict,
    sha: typeof w.sha === "string" ? w.sha : null,
    by: typeof w.by === "string" ? w.by : "claude",
    source: w.source === "review" ? "review" : "cheap",
  };
}

// Whether the question still stands between the user and the walkthrough.
export const predictOpen = (w: Walkthrough | null): boolean => !!w?.predict && w.predict.guess === null && !w.predict.skipped;
