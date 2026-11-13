// A task's brief: what the writer is asked to do, how Atrium checks it and what the reviewer judges it against.
// Shared by the engine and the dashboard (which edits it and shows its gap hints), so it imports nothing.

export type TaskSize = "small" | "medium" | "large";
export const SIZES: readonly TaskSize[] = ["small", "medium", "large"];

export type Brief = {
  goal: string;
  // What has to be true for the task to count as done. A general space calls these "done when".
  acceptance: string[];
  // A command that proves it, or "auto" for the checks Atrium finds in the repo.
  verify: string;
  scope: string;
  nonGoals: string[];
  // Files worth reading before writing anything.
  lookFirst: string[];
  size: TaskSize;
  // What the user said to the pre-pass's questions, passed on as written.
  answers: { question: string; answer: string }[];
};

export type BriefQuestion = { question: string; options: string[] };

const LIMITS = { text: 600, item: 300, items: 8, files: 8, questions: 2, options: 3 };

const text = (v: unknown, max = LIMITS.text): string => (typeof v === "string" ? v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim().slice(0, max) : "");
const list = (v: unknown, max: number): string[] => (Array.isArray(v) ? v.map((x) => text(x, LIMITS.item)).filter(Boolean).slice(0, max) : []);

// Anything the pre-pass or a client sends is cut down to this shape: unknown fields dropped, lengths capped.
export function normalizeBrief(raw: unknown, fallbackGoal = ""): Brief {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const verify = text(r.verify, LIMITS.item);
  const size = SIZES.includes(r.size as TaskSize) ? (r.size as TaskSize) : "medium";
  const answers = Array.isArray(r.answers)
    ? r.answers
        .map((a) => ({ question: text((a as Record<string, unknown>)?.question, LIMITS.item), answer: text((a as Record<string, unknown>)?.answer, LIMITS.item) }))
        .filter((a) => a.question && a.answer)
        .slice(0, LIMITS.questions)
    : [];
  return {
    goal: text(r.goal) || text(fallbackGoal),
    acceptance: list(r.acceptance, LIMITS.items),
    verify: verify && verify.toLowerCase() !== "auto" ? verify : "auto",
    scope: text(r.scope),
    nonGoals: list(r.nonGoals, LIMITS.items),
    lookFirst: list(r.lookFirst, LIMITS.files),
    size,
    answers,
  };
}

export function normalizeQuestions(raw: unknown): BriefQuestion[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((q) => ({ question: text((q as Record<string, unknown>)?.question, LIMITS.item), options: list((q as Record<string, unknown>)?.options, LIMITS.options) }))
    .filter((q) => q.question)
    .slice(0, LIMITS.questions);
}

export const NO_CHECK_HINT = "No way to check this is done: add a test command or acceptance check.";

// One line per gap that would leave the writer or the gate guessing. `checksFound` is whether the repo has
// checks Atrium can run without being told.
export function gapHints(brief: Brief, opts: { repo: boolean; checksFound: boolean }): string[] {
  const hints: string[] = [];
  if (!brief.goal) hints.push("No goal yet: say what this should achieve.");
  if (!opts.repo) {
    if (!brief.acceptance.length) hints.push("Say what done looks like, so the result can be judged.");
    return hints;
  }
  if (brief.verify === "auto" && !opts.checksFound) hints.push(NO_CHECK_HINT);
  if (!brief.acceptance.length) hints.push("No acceptance criteria: list what has to be true when it's done.");
  if (brief.size === "large" && !brief.scope && !brief.nonGoals.length) hints.push("A large change with no scope: say what's in and what's out.");
  return hints;
}

const bullets = (items: string[]) => items.map((i) => `- ${i}`).join("\n");

// The brief as sections of the writer's prompt. `checks` are the commands the gate will run, so the writer knows
// what "done" is measured by; null away from a repo.
export function briefSections(brief: Brief, checks: string[] | null): string[] {
  const parts: string[] = [];
  if (brief.goal) parts.push(`## Goal\n${brief.goal}`);
  if (brief.acceptance.length) parts.push(`## ${checks ? "Acceptance criteria" : "Done when"}\n${bullets(brief.acceptance)}`);
  if (checks) parts.push(checksSection(checks));
  if (brief.scope) parts.push(`## Scope\n${brief.scope}`);
  if (brief.nonGoals.length) parts.push(`## Not in scope\n${bullets(brief.nonGoals)}`);
  if (brief.lookFirst.length) parts.push(`## Look at these first\n${bullets(brief.lookFirst)}`);
  if (brief.answers.length) parts.push(`## Clarified\n${brief.answers.map((a) => `- ${a.question} ${a.answer}`).join("\n")}`);
  return parts;
}

export function checksSection(checks: string[]): string {
  return checks.length
    ? `## How it's checked\nAfter your turn Atrium runs these itself and sends you anything that fails, even ones you can't run yourself:\n${bullets(checks.map((c) => `\`${c}\``))}`
    : "## How it's checked\nThis repo has no checks Atrium can run, so say in your summary how you checked your work.";
}
