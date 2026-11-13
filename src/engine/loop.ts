// Where a coding task is in the loop (write, checks, review, you), and the rules that move it on or pause it.
// Shared by the engine and the dashboard, so it imports nothing but types.
import type { BriefQuestion, TaskSize } from "./brief";
import type { Session } from "./sessions";
import type { Shape } from "./shape";

// A task that fanned out: its parts (a split) or attempts (best-of-N), and what the judge made of the attempts.
export type Fanout = {
  kind: "split" | "best_of_n";
  children: string[];
  scores: Record<string, { score: number; comment: string }>;
  // Why the judge didn't score the attempts, when it didn't.
  judgeNote: string | null;
};

// A split's or a best-of-N's parent waits on its children ("parts"), its judge ("judge") and then the user ("pick").
export type Stage = "brief" | "writing" | "checks" | "review" | "ready" | "paused" | "parts" | "judge" | "pick";
export type ChecksState = "pending" | "running" | "passed" | "failed" | "none";
export type Severity = "high" | "medium" | "low";

export type Finding = {
  severity: Severity;
  file: string | null;
  line: number | null;
  reason: string;
  // How the writer answered it on the turn after the review; null until then, or when it didn't say.
  resolution: { action: "fixed" | "declined"; note: string } | null;
};

export type ReviewRound = {
  reviewer: string;
  verdict: "approve" | "changes" | null;
  findings: Finding[];
  // Why the review didn't happen, when it didn't.
  skipped: string | null;
};

export type Budget = { tokens: number; minutes: number };
export type Pause = { kind: "budget" | "loop"; diagnosis: string };

export type LoopState = {
  stage: Stage;
  checks: ChecksState;
  // The branch commit the checks last ran on, so a turn that changed nothing isn't checked twice.
  checkedSha: string | null;
  passing: string[];
  // The last failure's signature, and how many turns in a row ended without a check newly passing.
  failSig: string | null;
  stalled: number;
  // What the next writer turn is told first: a failing check report, or review findings to triage.
  feedback: string | null;
  // The feedback is the last review's findings, so the next good turn's TRIAGE lines answer them.
  triaging: boolean;
  reviews: ReviewRound[];
  // The commit the last review read; a triage turn that leaves it unchanged has nothing new to review.
  reviewedSha: string | null;
  // True once any review asked for changes, so the result never counts as clean evidence for a rule.
  triaged: boolean;
  // The writer's last summary and branch lines, kept for the approval made once the loop is done.
  report: string[];
  noChanges: boolean;
  // Why the result is unverified though checks exist (they couldn't run, or the change edits how dependencies
  // install); null otherwise.
  unverified: string | null;
  // Checks that fail on the base commit, with the end of their output then and on the branch now ("" before the
  // first turn's checks). One that still fails keeps the result unverified; none counts toward loop detection.
  alreadyFailing: { name: string; before: string; now: string }[];
  // Whether the writer was already sent back once because such a check still fails.
  staleRetried: boolean;
  // Config files outside git as the task found them, by content hash (checks/attention.ts outsideSnapshot); null
  // until the first repo turn takes it.
  outside: Record<string, string> | null;
  // What the brief's pre-pass asked and what it noticed, while the brief stage waits for answers.
  questions: BriefQuestion[];
  hints: string[];
  // A check command the pre-pass suggested, which the brief uses only once the user accepts it.
  suggestedVerify: string | null;
  // Things the change does to the checks themselves (edits their config, drops or skips tests): shown on the
  // result, put to the reviewer, and never approved by a rule.
  attention: string[];
  // Counted since the user last stepped in (started, retried or gave a hint); `unreported` when an agent
  // didn't report its tokens, so the count is a floor.
  usage: { tokens: number; ms: number; unreported: boolean };
  budget: Budget;
  paused: Pause | null;
  // The next run explains what's wrong instead of trying again; its answer lands in `explanation`.
  explain: boolean;
  explanation: string | null;
  // The writer's Claude session, kept between turns while its prompt cache is warm (sessions.ts); null when there is
  // none to resume.
  session: Session | null;
  // What the writer's last finished turn said it did, for the progress note a fresh session starts with.
  said: string | null;
  // How the work runs (shape.ts); null for one writer, as before shapes existed.
  shape: Shape | null;
  // A part of a split or an attempt of a best-of-N, which reports to its parent instead of to the user.
  role: "part" | "attempt" | null;
  fanout: Fanout | null;
  // The branch was put together by the engine (a merge of the parts, or the attempt the user picked), so the next
  // turn runs the checks and review on it without a writer.
  adopted: boolean;
  // Set once the user stepped in after a pause, so the writer goes on with the strong tier's model (tiers.ts).
  escalated: boolean;
};

export const MAX_REVIEW_ROUNDS = 2;
// Writer turns in a row that end with failing checks and nothing newly passing before Atrium pauses.
export const STALL_TURNS = 3;
// Identical tool calls in a row, or identical edits anywhere in one run, before Atrium pauses.
export const REPEAT_LIMIT = 3;

export const SIZE_BUDGETS: Record<TaskSize, Budget> = {
  small: { tokens: 200_000, minutes: 20 },
  medium: { tokens: 600_000, minutes: 45 },
  large: { tokens: 1_500_000, minutes: 90 },
};

export function newLoop(budget: Budget): LoopState {
  return {
    stage: "writing",
    checks: "pending",
    checkedSha: null,
    passing: [],
    failSig: null,
    stalled: 0,
    feedback: null,
    triaging: false,
    reviews: [],
    reviewedSha: null,
    triaged: false,
    report: [],
    noChanges: false,
    unverified: null,
    alreadyFailing: [],
    staleRetried: false,
    outside: null,
    questions: [],
    hints: [],
    suggestedVerify: null,
    attention: [],
    usage: { tokens: 0, ms: 0, unreported: false },
    budget,
    paused: null,
    explain: false,
    explanation: null,
    escalated: false,
    session: null,
    said: null,
    shape: null,
    role: null,
    fanout: null,
    adopted: false,
  };
}

// Back to writing after the user steps in: the counters that judge "stuck" and the budget start over, and a loop
// that was paused goes on with the strong model.
export function resumed(loop: LoopState): LoopState {
  return { ...loop, stage: "writing", paused: null, escalated: loop.escalated || loop.paused !== null, explain: false, stalled: 0, failSig: null, usage: { tokens: 0, ms: 0, unreported: false } };
}

export function overBudget(loop: LoopState): string | null {
  const { usage, budget } = loop;
  if (usage.tokens >= budget.tokens) return `It used ${compact(usage.tokens)} weighted tokens, its budget.`;
  if (usage.ms >= budget.minutes * 60_000) return `It worked for ${budget.minutes} minutes, its budget.`;
  return null;
}

// Tokens as the budget counts them, weighted the way the API prices them against fresh input: a cache read costs
// about a tenth, a cache write a quarter more. Output is counted as is.
export const CACHE_READ_WEIGHT = 0.1;
export const CACHE_WRITE_WEIGHT = 1.25;
export function weightedTokens(r: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }): number {
  return Math.round(r.inputTokens + r.outputTokens + (r.cacheReadTokens ?? 0) * CACHE_READ_WEIGHT + (r.cacheWriteTokens ?? 0) * CACHE_WRITE_WEIGHT);
}

export const compact = (n: number) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

// The line a check's output starts with when its front was cut to fit the cap (checks/run.ts).
export const OUTPUT_CUT = "[earlier output cut]";
// How much of the end of a failure is signed: well inside the output cap, so where the cap happened to fall
// never shows.
const SIGNED_LINES = 80;

// A test runner's lines that change from run to run of the same failure: its totals and how long it took.
const SUMMARY_LINE = /^\s*(Ran \d+ tests?|\d+ (pass|fail|passed|failed|skip|skipped|todo|expect\(\) calls?)\b|Tests?:|Test Suites:|Snapshots:|Time:|Duration\b|Done in |Finished in |Executed \d+)/i;

// What changes from run to run of the same failure, taken out of a check's output and nothing else: colour codes,
// bracketed timings (bun prints `(fail) name [0.41ms]` on some runs and `(fail) name` on others), the runner's
// totals and duration lines, and paths into temp folders. Assertion text is left as it is, times and sizes in it
// included, so a different value is a different failure.
export function steadyOutput(output: string): string {
  return output
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\s*\[\d+(\.\d+)?\s?(ns|µs|us|ms|s|m)\]/g, "")
    .replace(/(\/private)?\/(var\/folders|tmp|var\/tmp)\/\S+/g, "#")
    .split("\n")
    .filter((line) => !SUMMARY_LINE.test(line))
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n");
}

// A failure's last lines, from after any cut, steadied.
function signedPart(output: string): string {
  const lines = output.split("\n");
  const cut = lines.findIndex((l) => l.startsWith(OUTPUT_CUT));
  return steadyOutput((cut >= 0 ? lines.slice(cut + 1) : lines).join("\n").trimEnd())
    .split("\n")
    .slice(-SIGNED_LINES)
    .join("\n");
}

// One signature for a set of failing checks: each check's name, exit code and the steady end of its output. The
// same failure twice in a row reads the same, however its timings and the output cap came out.
export function failureSignature(failed: { name: string; exitCode: number | null; output: string }[]): string {
  return [...failed]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((f) => `${f.name}\n${f.exitCode}\n${signedPart(f.output)}`)
    .join("\n\n");
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

// Watches one run's tool calls for the shapes of a stuck agent: the same call over and over, or the same edit
// made again and again (which only works if something keeps undoing it).
export function toolWatch(limit = REPEAT_LIMIT): (name: string, input: unknown) => string | null {
  let last = "";
  let streak = 0;
  const edits = new Map<string, number>();
  return (name, input) => {
    const sig = `${name}\u0000${stable(input)}`;
    streak = sig === last ? streak + 1 : 1;
    last = sig;
    const what = describeTool(name, input);
    if (EDIT_TOOLS.has(name)) {
      const n = (edits.get(sig) ?? 0) + 1;
      edits.set(sig, n);
      if (n >= limit) return `It made the same ${what} ${limit} times.`;
    }
    if (streak >= limit) return `It ran the same ${what} ${limit} times in a row.`;
    return null;
  };
}

function describeTool(name: string, input: unknown): string {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const target = String(i.file_path ?? i.command ?? i.pattern ?? i.path ?? "").replace(/\s+/g, " ").slice(0, 60);
  const kind = EDIT_TOOLS.has(name) ? "edit" : name === "Bash" || name === "bash" ? "command" : `${name} call`;
  return target ? `${kind} (${target})` : kind;
}

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

const FINDING = /^[\s>*-]*`?FINDING:?\s+(high|medium|low)\s+(\S+?)(?::(\d+))?(?:\s+[-—–:]+)?\s+(.+?)`?\s*$/i;

// A reviewer lists each problem as `FINDING <severity> <file>:<line> <reason>`; "-" stands for no file.
export function parseFindings(text: string): Finding[] {
  const out: Finding[] = [];
  for (const raw of text.split("\n")) {
    const m = FINDING.exec(raw);
    if (!m) continue;
    const file = m[2] === "-" ? null : m[2]!.replace(/^`|`$/g, "");
    out.push({ severity: m[1]!.toLowerCase() as Severity, file, line: m[3] ? Number(m[3]) : null, reason: m[4]!.slice(0, 400), resolution: null });
  }
  return out.slice(0, 20);
}

const TRIAGE = /^[\s>*-]*`?TRIAGE:?\s+#?(\d+)\s+(fixed|declined)\b[\s:—–-]*(.*?)`?\s*$/i;

// The writer answers each finding with `TRIAGE <n> fixed|declined - <why>`. Returns the findings with their
// answers, and the summary with those lines taken out.
export function applyTriage(findings: Finding[], summary: string): { findings: Finding[]; body: string } {
  const answers = new Map<number, Finding["resolution"]>();
  const kept: string[] = [];
  for (const line of summary.split("\n")) {
    const m = TRIAGE.exec(line);
    if (!m) {
      kept.push(line);
      continue;
    }
    answers.set(Number(m[1]), { action: m[2]!.toLowerCase() as "fixed" | "declined", note: m[3]!.slice(0, 400) });
  }
  return {
    findings: findings.map((f, i) => ({ ...f, resolution: answers.get(i + 1) ?? f.resolution })),
    body: kept.join("\n").trim(),
  };
}

export const findingLine = (f: Finding, n: number): string =>
  `${n}. [${f.severity}] ${f.file ? `${f.file}${f.line ? `:${f.line}` : ""} — ` : ""}${f.reason}`;

export function resolutionText(f: Finding): string {
  if (!f.resolution) return "not answered";
  return `${f.resolution.action === "fixed" ? "fixed" : "declined"}${f.resolution.note ? `: ${f.resolution.note}` : ""}`;
}

// The stage the strip shows, from the task's status and its loop.
export function shownStage(status: string, loop: LoopState | null): Stage {
  if (!loop) return status === "review" || status === "done" ? "ready" : "writing";
  if (status === "review" || status === "done") return "ready";
  if (loop.paused) return "paused";
  return loop.stage;
}
