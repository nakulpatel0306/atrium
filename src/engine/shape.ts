// The shape of a coding task: one writer (the default), read-only scouts first, independent parts, or several
// attempts to pick from. The brief's pre-pass proposes one; the engine checks it against the task and caps its
// fan-out; the costlier shapes run only once the user clicks for them. Shared with the dashboard, so it imports
// nothing but types.
import type { TaskSize } from "./brief";
import type { Spend } from "./cost";

export type ShapeKind = "single" | "scouts" | "split" | "best_of_n";
export const SHAPES: readonly ShapeKind[] = ["single", "scouts", "split", "best_of_n"];

export type SplitPart = { title: string; goal: string; files: string[] };

export type Shape = {
  kind: ShapeKind;
  reason: string;
  // What the pre-pass proposed, kept when the engine or the user chose otherwise.
  proposed: ShapeKind;
  // Questions for read-only scouts, when scouting.
  scouts: string[];
  // The independent parts the pre-pass found, kept so a split can be chosen later.
  parts: SplitPart[];
  // How many attempts a best-of-N runs.
  attempts: number;
  // The user's click on a shape that costs more. Only a user's choice sets it, never the pre-pass.
  approved: boolean;
  // The user asked for one attempt of a best-of-N to go to another vendor (Codex) when it can work in the space.
  mixVendors: boolean;
  // Whether the repo had checks Atrium can run when the shape was proposed, which best-of-N needs to pick with.
  checksFound: boolean;
};

// Fan-out by task size, after Anthropic's effort scaling: one agent for small work, a few for medium, at most five.
export const FAN_OUT: Record<TaskSize, number> = { small: 1, medium: 4, large: 5 };
const MAX_ATTEMPTS = 3;
const PARTS_READ = 10;

export const costlier = (kind: ShapeKind): boolean => kind === "split" || kind === "best_of_n";

export const SHAPE_LABEL: Record<ShapeKind, string> = {
  single: "Single writer",
  scouts: "Scouts, then one writer",
  split: "Split into tasks",
  best_of_n: "Best of N",
};

const DEFAULT_REASON: Record<ShapeKind, string> = {
  single: "one change with one writer",
  scouts: "broad reading first, then one writer",
  split: "independent parts with their own files",
  best_of_n: "uncertain, with checks that can pick between attempts",
};

export type ShapeContext = { size: TaskSize; checksFound: boolean };

const LIMITS = { reason: 160, question: 300, title: 80, goal: 300, files: 8 };
const text = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");
const list = (v: unknown, max: number, each: number): string[] => (Array.isArray(v) ? v.map((x) => text(x, each)).filter(Boolean).slice(0, max) : []);

function parts(v: unknown, max: number): SplitPart[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((p) => {
      const r = (p && typeof p === "object" ? p : {}) as Record<string, unknown>;
      return { title: text(r.title, LIMITS.title), goal: text(r.goal, LIMITS.goal), files: list(r.files, LIMITS.files, LIMITS.question) };
    })
    .filter((p) => p.title && p.goal)
    .slice(0, max);
}

// Two paths overlap when they're the same file or one is a folder holding the other, folding case as APFS does.
function overlaps(a: string, b: string): boolean {
  const x = a.toLowerCase().replace(/^\.\//, "").replace(/\/+$/, "");
  const y = b.toLowerCase().replace(/^\.\//, "").replace(/\/+$/, "");
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

// Why these parts can't run as separate tasks, or null when they can: at least two, within the fan-out cap, each
// naming its files, and no file in two parts.
export function splitProblem(ps: SplitPart[], size: TaskSize): string | null {
  if (ps.length < 2) return "It didn't find independent parts to split into.";
  if (ps.length > FAN_OUT[size]) return `A ${size} task splits into at most ${FAN_OUT[size]} parts.`;
  if (ps.some((p) => !p.files.length)) return "Each part needs its own files, and one named none.";
  for (let i = 0; i < ps.length; i++) {
    for (let j = i + 1; j < ps.length; j++) {
      if (ps[i]!.files.some((f) => ps[j]!.files.some((g) => overlaps(f, g)))) return "Two of the parts touch the same files, so one writer does it.";
    }
  }
  return null;
}

// Why best-of-N can't run here, or null when it can.
export function bestOfProblem(ctx: ShapeContext): string | null {
  if (!ctx.checksFound) return "No automatic check to pick between attempts.";
  if (ctx.size === "small") return "A small task runs as one attempt.";
  return null;
}

// The pre-pass's proposal, read as untrusted: unknown fields dropped, lengths capped, and a shape the task doesn't
// support turned back into one writer with the engine's own reason. Never approved.
export function proposeShape(raw: unknown, ctx: ShapeContext): Shape {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const proposed = SHAPES.includes(r.kind as ShapeKind) ? (r.kind as ShapeKind) : "single";
  const base: Shape = {
    kind: proposed,
    reason: text(r.reason, LIMITS.reason) || DEFAULT_REASON[proposed],
    proposed,
    scouts: list(r.scouts, FAN_OUT[ctx.size], LIMITS.question),
    // Read past the cap, so too many parts turn the split down rather than silently dropping one.
    parts: parts(r.parts, PARTS_READ),
    attempts: Math.min(MAX_ATTEMPTS, FAN_OUT[ctx.size], Math.max(2, Number.isInteger(r.attempts) ? (r.attempts as number) : 2)),
    approved: false,
    mixVendors: false,
    checksFound: ctx.checksFound,
  };
  const single = (reason: string): Shape => ({ ...base, kind: "single", reason });
  if (proposed === "scouts" && !base.scouts.length) return single(DEFAULT_REASON.single);
  if (proposed === "split") {
    const problem = splitProblem(base.parts, ctx.size);
    if (problem) return single(problem);
  }
  if (proposed === "best_of_n") {
    const problem = bestOfProblem(ctx);
    if (problem) return single(problem);
  }
  return base;
}

// The shapes a task can be switched to, each with why not when it can't.
export function shapeChoices(shape: Shape, ctx: ShapeContext): { kind: ShapeKind; why: string | null }[] {
  return SHAPES.map((kind) => ({
    kind,
    why: kind === "split" ? splitProblem(shape.parts, ctx.size) : kind === "best_of_n" ? bestOfProblem(ctx) : null,
  }));
}

// The user's choice. A costlier shape chosen by the user is approved; switching to scouts with no questions from the
// pre-pass sends one scout to map the code the goal touches.
export function chooseShape(shape: Shape, kind: ShapeKind, ctx: ShapeContext, goal: string, opts: { mixVendors?: boolean } = {}): Shape {
  const why = shapeChoices(shape, ctx).find((c) => c.kind === kind)?.why;
  if (why) throw new Error(why);
  const scouts = kind === "scouts" && !shape.scouts.length ? [`Find the code this task touches and how it fits together: ${goal}`.slice(0, LIMITS.question)] : shape.scouts;
  const reason = kind === shape.kind ? shape.reason : "your choice";
  return { ...shape, kind, scouts, reason, approved: costlier(kind), mixVendors: kind === "best_of_n" && opts.mixVendors === true };
}

// A stored shape read strictly: anything off reads as no shape (one writer), and only a literal true approves.
export function storedShape(v: unknown): Shape | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (!SHAPES.includes(r.kind as ShapeKind) || !SHAPES.includes(r.proposed as ShapeKind)) return null;
  return {
    kind: r.kind as ShapeKind,
    reason: text(r.reason, LIMITS.reason),
    proposed: r.proposed as ShapeKind,
    scouts: list(r.scouts, FAN_OUT.large, LIMITS.question),
    parts: parts(r.parts, FAN_OUT.large),
    attempts: Math.min(MAX_ATTEMPTS, Math.max(2, Number.isInteger(r.attempts) ? (r.attempts as number) : 2)),
    approved: r.approved === true,
    mixVendors: r.mixVendors === true,
    checksFound: r.checksFound === true,
  };
}

// The one line on the task: "Single writer: sequential change in one module".
export function shapeLine(shape: Shape): string {
  const label = shape.kind === "split" ? `Split into ${shape.parts.length} tasks` : shape.kind === "best_of_n" ? `Best of ${shape.attempts}` : SHAPE_LABEL[shape.kind];
  return `${label}: ${shape.reason}`;
}

// What runs at once from the pre-pass's proposal: the proposal itself when it costs no more than one writer, and
// otherwise one writer, with the proposal kept as a suggestion the user can take with a click.
export function runNow(shape: Shape): Shape {
  return costlier(shape.kind) && !shape.approved ? { ...shape, kind: "single" } : shape;
}

// The costlier shape the pre-pass suggested and the task can still take, while it runs as something cheaper.
export function suggestion(shape: Shape | null | undefined, size: TaskSize): ShapeKind | null {
  if (!shape || !costlier(shape.proposed) || shape.kind === shape.proposed) return null;
  return shapeChoices(shape, { size, checksFound: shape.checksFound }).find((c) => c.kind === shape.proposed)?.why === null ? shape.proposed : null;
}

// "Could run as 2 parts: two independent pieces" for the suggestion line.
export function suggestionLine(shape: Shape, kind: ShapeKind): string {
  const as = kind === "split" ? `${shape.parts.length} parts` : `the best of ${shape.attempts} attempts`;
  return `Could run as ${as}: ${shape.reason}`;
}

// How many tasks a shape runs.
export const fanOutOf = (shape: Shape): number => (shape.kind === "split" ? shape.parts.length : shape.kind === "best_of_n" ? shape.attempts : 1);

// What a fan-out would cost, shown before it launches: the space's recent tasks times the fan-out when there are
// any, else each run's budget as the ceiling.
export function fanOutEstimate(n: number, recent: Spend[], budgetTokens: number): { weighted: number; usd: number | null; basis: "recent" | "budget" } {
  const priced = recent.filter((s) => s.weighted > 0);
  if (!priced.length) return { weighted: n * budgetTokens, usd: null, basis: "budget" };
  const avg = (f: (s: Spend) => number) => priced.reduce((a, s) => a + f(s), 0) / priced.length;
  const fullyPriced = priced.every((s) => s.unpriced === 0);
  return { weighted: Math.round(n * avg((s) => s.weighted)), usd: fullyPriced ? n * avg((s) => s.usd) : null, basis: "recent" };
}

// Whether a task can switch to a costlier shape: it hasn't fanned out or reached review, so starting over from the
// brief throws away no more than its writer's turns so far.
export const switchOpen = (t: ShapedTask): boolean =>
  t.kind === "work" &&
  (t.status === "queued" || t.status === "running" || t.status === "blocked") &&
  !!t.loop?.shape &&
  !t.loop.fanout &&
  !t.loop.role &&
  ["writing", "checks", "paused"].includes(t.loop.stage);

type ShapedTask = {
  kind: string;
  status: string;
  loop: { stage: string; fanout: unknown; role: unknown; checkedSha: string | null; said: string | null; session: unknown; shape: Shape | null } | null;
};

// Whether a task's shape can still change: nothing has run past its brief, and it hasn't fanned out.
export const shapeOpen = (t: ShapedTask): boolean =>
  t.kind === "work" &&
  t.status === "queued" &&
  !!t.loop?.shape &&
  !t.loop.fanout &&
  !t.loop.role &&
  (t.loop.stage === "brief" || (t.loop.stage === "writing" && t.loop.checkedSha == null && t.loop.said == null && t.loop.session == null));

export type ChildState = "running" | "ready" | "stuck" | "dropped";

// Where a part or attempt is: ready once its loop is done; an attempt that stopped is dropped, a part that stopped
// waits on the user, like any blocked task.
export function childState(t: { status: string; loop: { stage: string; role: "part" | "attempt" | null } | null }): ChildState {
  if (t.status === "done" && t.loop?.stage === "ready") return "ready";
  if (t.status === "blocked" || t.status === "failed" || t.status === "done") return t.loop?.role === "attempt" ? "dropped" : "stuck";
  return "running";
}
