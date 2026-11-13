import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter, ModelTokens } from "./agents/types";
import { type Brief, type BriefQuestion, normalizeBrief, normalizeQuestions } from "./brief";
import { runModels } from "./usage";

// The pre-pass is meant to feel instant next to the task itself: the cheap tier's model, a few reads, then an answer.
const BRIEF_TURNS = 6;
const BRIEF_TIMEOUT_MS = 90_000;
const READ_TOOLS = ["Read", "Glob", "Grep"];

const SYSTEM = [
  "You turn a one-line request into a brief another agent will work from, through Atrium.",
  "Read only what you need to name the right files; don't change anything.",
  "Never read, print, or edit .env files, keys, or tokens.",
  "Answer with one JSON object and nothing else.",
].join("\n");

function prompt(ask: string, repo: boolean): string {
  const shape = repo
    ? `{"goal": "one sentence", "acceptance": ["what has to be true when it's done"], "verify": "a command that proves it, or auto", "scope": "what may change", "nonGoals": ["what must not change"], "lookFirst": ["repo-relative paths"], "size": "small | medium | large", "questions": [], "shape": {"kind": "single | scouts | split | best_of_n", "reason": "one short line", "scouts": [], "parts": [], "attempts": 2}}`
    : `{"goal": "one sentence", "acceptance": ["what done looks like"], "size": "small | medium | large", "questions": []}`;
  return [
    `Request: ${ask}`,
    `Write the brief as JSON in this shape:\n${shape}`,
    "Keep every field short. Size: small is one file or a few lines, medium a feature in one area, large a change across several areas.",
    "Only when the request could reasonably mean two different things, add up to 2 questions as {\"question\": \"…\", \"options\": [\"…\", \"…\"]} with 2–3 short answers each. Otherwise leave questions empty; never ask what you can find out by reading.",
    ...(repo ? ["Use \"auto\" for verify unless the request names a specific test or command.", SHAPE_RULES] : []),
  ].join("\n\n");
}

// How work should be shaped, after the evidence on when more agents help: most coding is sequential, and parallel
// writers on dependent work make conflicting choices.
const SHAPE_RULES = [
  "Shape: how the work should run. Pick single unless another clearly fits:",
  "- single: one writer. Bug fixes, refactors, features in one module, anything sequential. The default.",
  "- scouts: the work first needs broad read-only exploration (where is X used, how do these parts fit). Put up to 3 questions for read-only scouts in \"scouts\".",
  "- split: truly independent pieces that touch disjoint files and each have their own tests. Put each in \"parts\" as {\"title\": \"…\", \"goal\": \"…\", \"files\": [\"paths\"]}; no file in two parts.",
  "- best_of_n: uncertain work (a flaky bug, performance, several plausible designs) that the repo's tests can judge. Set \"attempts\" to 2 or 3.",
  "Give one short reason, like \"sequential change in one module\".",
].join("\n");

// `suggestedVerify` is the pre-pass's own idea of a check command. The gate never takes it from the pre-pass, which
// reads a repo that may be written to mislead it: the brief's verify stays "auto" until the user accepts it.
// `models` is what the pre-pass itself used, for the cost meter.
// `shape` is the pre-pass's proposal as it came, for proposeShape to read once the checks are known.
export type DraftResult = { brief: Brief; questions: BriefQuestion[]; error: string | null; suggestedVerify: string | null; models: ModelTokens[]; shape: unknown };

// Never fails: a pre-pass that can't answer still leaves a brief holding the ask itself, and the task runs as is.
export async function draftBrief(
  adapter: AgentAdapter,
  input: { ask: string; repoPath: string | null; privateData: boolean; model?: string; signal?: AbortSignal },
): Promise<DraftResult> {
  let models: ModelTokens[] = [];
  const fallback = (error: string): DraftResult => ({ brief: normalizeBrief({}, input.ask), questions: [], error, suggestedVerify: null, models, shape: null });
  const repo = input.repoPath !== null;
  // Away from a repo there's nothing to read, so it gets an empty folder and no tools.
  const cwd = input.repoPath ?? mkdtempSync(join(tmpdir(), "atrium-run-"));
  const timeout = AbortSignal.timeout(BRIEF_TIMEOUT_MS);
  try {
    const result = await adapter.run({
      prompt: prompt(input.ask, repo),
      cwd,
      systemPrompt: SYSTEM,
      allowedTools: repo ? READ_TOOLS : [],
      mode: "review",
      privateData: input.privateData,
      ...(input.model && { model: input.model }),
      maxTurns: BRIEF_TURNS,
      signal: input.signal ? AbortSignal.any([input.signal, timeout]) : timeout,
      onChunk() {},
    });
    if (result.status !== "ok") return fallback(timeout.aborted ? "The brief took too long to draft." : result.message);
    models = runModels(result, input.model ?? null);
    const parsed = parseJson(result.summary);
    if (!parsed) return fallback("The brief came back in a shape Atrium couldn't read.");
    const drafted = normalizeBrief(parsed, input.ask);
    const suggestedVerify = drafted.verify === "auto" ? null : drafted.verify;
    return { brief: { ...drafted, verify: "auto" }, questions: normalizeQuestions(parsed.questions), error: null, suggestedVerify, models, shape: repo ? parsed.shape : null };
  } catch (e) {
    return fallback((e as Error).message);
  } finally {
    if (!repo) rmSync(cwd, { recursive: true, force: true });
  }
}

// The object may come fenced or with a sentence around it; the outermost braces are taken.
function parseJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(text.slice(start, end + 1));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
