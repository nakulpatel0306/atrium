import { KIND, RISKY } from "../../engine/words";
import { Lightbulb, MessageSquareText, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { briefSections } from "../../engine/brief";
import type { CheckRow } from "../../engine/checks/run";
import { compact, findingLine, shownStage, type Stage } from "../../engine/loop";
import { agentName } from "../agents";
import { post, type State, useFetched } from "../api";
import { duration } from "../format";
import { answeredText, attentionText, STAGE_TEXT } from "../summary";
import { BriefQuestions } from "./BriefQuestions";
import { Markdown } from "./Markdown";
import { asksBeforeStarting, cleanResult } from "../../engine/needs";
import { Fanout, ShapeLine } from "./Shape";

type Task = State["tasks"][number];

const STRIP: (Stage | "brief")[] = ["brief", "writing", "checks", "review", "ready"];

// Brief · Writing · Checks · Review · Ready, with where the task is now; a pause replaces the stage it stopped in.
export function StageStrip({ task }: { task: Task }) {
  const now = shownStage(task.status, task.loop);
  const at = now === "paused" ? STRIP.indexOf(task.loop!.stage) : STRIP.indexOf(now);
  // Ready with something open reads amber, like its Approve anyway: one rule (needs.ts) for both.
  const notes = now === "ready" && task.status === "review" && !cleanResult(task);
  return (
    <ol className="stages" aria-label="Where this task is">
      {STRIP.map((s, i) => {
        const here = i === at;
        const label = here && now === "paused" ? "Paused" : here && notes ? RISKY : STAGE_TEXT[s];
        return (
          <li key={s} className={`${here ? "on" : i < at ? "past" : ""}${here && (now === "paused" || notes) ? " wait" : ""}${here && task.status === "running" ? " live" : ""}`} aria-current={here ? "step" : undefined}>
            {label}
          </li>
        );
      })}
    </ol>
  );
}

const CHECK_WORD: Record<CheckRow["status"], string> = { passed: "passed", failed: "failed", timeout: "timed out", missing: "couldn't run", skipped: "skipped" };

function CheckOutput({ taskId, version, alreadyFailing }: { taskId: string; version: unknown; alreadyFailing: string[] }) {
  const rows = useFetched<CheckRow[]>(`/api/tasks/${taskId}/checks`, version);
  if (!rows) return <p className="hint">Loading the check output…</p>;
  if (!rows.length) return <p className="hint">No checks have run yet.</p>;
  return (
    <ul className="check-rows">
      {rows.map((r) => (
        <li key={r.id}>
          {alreadyFailing.includes(r.name) && r.status === "failed" ? (
            <span className="tag wait">still failing, as before this task</span>
          ) : (
            <span className={`tag${r.status === "failed" || r.status === "timeout" ? " bad" : ""}`}>{CHECK_WORD[r.status]}</span>
          )}
          <code>{r.command}</code>
          <span className="hint">{duration(r.durationMs)}</span>
          {r.output.trim() && r.status !== "passed" && <pre className="term mono">{r.output.trimEnd()}</pre>}
        </li>
      ))}
    </ul>
  );
}

// The pre-pass's idea of a check command, used only once the user says so.
function SuggestedCheck({ task, command }: { task: Task; command: string }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <p className="checks-line">
      <span>
        The brief suggests checking with <code>{command}</code>.
      </span>
      <button
        className="btn"
        onClick={async () => {
          const res = await post(`/api/tasks/${task.id}/accept-verify`);
          if (!res.ok) setError(res.error);
        }}
      >
        Use it as the check
      </button>
      {error && <span className="err">{error}</span>}
    </p>
  );
}

// The header badge: what the checks said, with their output one click away.
export function ChecksBadge({ task, onOpen }: { task: Task; onOpen: () => void }) {
  const loop = task.loop;
  if (!loop || loop.noChanges || loop.checks === "pending") return null;
  const text = loop.checks === "running" ? "Checking" : loop.checks === "passed" ? "Checks passed" : loop.checks === "failed" ? "Checks failed" : "Unverified";
  // Says what the checks said, nothing more: the review has its own chip, so passed checks stay green.
  const tone = loop.checks === "failed" ? " bad" : loop.checks === "passed" ? " good" : loop.checks === "none" ? " wait" : "";
  return (
    <button type="button" className={`tag check-badge${tone}`} title={loop.checks === "none" ? (loop.unverified ?? "Unverified: no checks found") : "Show what the checks said"} onClick={onOpen}>
      {text}
    </button>
  );
}

// The way on from a pause. When loop detection paused it on a repeated failure and the space has learning on, the
// diagnosis comes first: another attempt at the same error is the slowest way to fix it and teaches nothing.
function Paused({ task, nudge }: { task: Task; nudge: boolean }) {
  const [hint, setHint] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (path: string, body?: unknown) => {
    setBusy(true);
    setError(null);
    const res = await post(`/api/tasks/${task.id}/${path}`, body);
    setBusy(false);
    if (!res.ok) setError(res.error);
    else setHint("");
  };
  const explain = (
    <button className="btn" type="button" data-act="explain" disabled={busy} onClick={() => void act("explain")}>
      <MessageSquareText />
      Explain the problem
    </button>
  );
  return (
    <div className="paused">
      {nudge && (
        <div className="nudge">
          <p>Want the diagnosis instead of another attempt? It reads the branch and says what's actually going wrong, without trying again.</p>
          {explain}
        </div>
      )}
      <form
        className="hint-form"
        onSubmit={(e) => {
          e.preventDefault();
          // Pressed with nothing written, it goes to the box rather than looking unavailable.
          if (hint.trim()) void act("hint", { note: hint.trim() });
          else e.currentTarget.querySelector("textarea")?.focus();
        }}
      >
        <textarea rows={2} aria-label="Hint for the agent" placeholder="What should it try, or what is it missing?" value={hint} onChange={(e) => setHint(e.target.value)} />
        <div className="acts">
          {/* A pause's one primary step, named as on every surface (engine/words.ts); the diagnosis is the other way on. */}
          <button className="btn p" type="submit" disabled={busy}>
            <Lightbulb />
            {KIND.paused.action}
          </button>
          {!nudge && explain}
        </div>
      </form>
      {error && <p className="err">{error}</p>}
    </div>
  );
}

// How a round's findings ended, counted as the review chip counts them, so "asked for changes" and "1 open finding"
// tell one story.
const stillOpen = (r: { findings: { resolution: { action: string } | null }[] }): string => {
  const declined = r.findings.filter((f) => f.resolution?.action === "declined").length;
  const open = r.findings.filter((f) => !f.resolution).length;
  const parts = [declined && `${declined} declined`, open && `${open} open`].filter(Boolean);
  return parts.length ? `: ${parts.join(", ")}` : ": all fixed";
};

function Budget({ task }: { task: Task }) {
  const loop = task.loop!;
  const [editing, setEditing] = useState(false);
  const [tokens, setTokens] = useState(String(loop.budget.tokens));
  const [minutes, setMinutes] = useState(String(loop.budget.minutes));
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    const res = await post(`/api/tasks/${task.id}/budget`, { budget: { tokens: Number(tokens), minutes: Number(minutes) } });
    if (res.ok) setEditing(false);
    else setError(res.error);
  };
  const over = loop.usage.tokens - loop.budget.tokens;
  const used = `${compact(loop.usage.tokens)}${loop.usage.unreported ? "+" : ""} of ${compact(loop.budget.tokens)} tokens${over > 0 ? `, over by ${compact(over)}` : ""} · ${Math.round(loop.usage.ms / 60_000)} of ${loop.budget.minutes} min`;
  return (
    <div className="budget">
      <span>
        <span className={over > 0 ? "over" : undefined} title="Tokens are counted the way the API prices them: a read from Claude's prompt cache counts a tenth, a cache write 1.25×, everything else in full.">
          Budget since your last hint: {used}
        </span>
        {loop.usage.unreported && <span className="hint"> (an agent didn't report its tokens, so this is at least)</span>}
      </span>
      {task.status !== "done" &&
        (editing ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <input aria-label="Token budget" inputMode="numeric" value={tokens} onChange={(e) => setTokens(e.target.value)} />
            tokens
            <input aria-label="Minutes budget" inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value)} />
            min
            <button className="btn" type="submit">
              Save
            </button>
          </form>
        ) : (
          <button className="btn link subtle" onClick={() => setEditing(true)}>
            Change
          </button>
        ))}
      {error && <span className="err">{error}</span>}
    </div>
  );
}

// The loop in a task's detail: its stage, the brief it runs from, the checks, each review round and how its
// findings ended, the budget, and the way on when it's paused. Away from a repo there are no stages or checks.
// `briefOpen` shows the brief unfolded, as the Needs you queue does: it's what the result is judged against.
export function LoopPanel({ task, state, repo, showChecks, briefOpen = false }: { task: Task; state: State; repo: boolean; showChecks: boolean; briefOpen?: boolean }) {
  const [checksOpen, setChecksOpen] = useState(showChecks);
  const loop = task.loop;
  const attention = attentionText(loop);
  return (
    <section className="loop">
      {repo && !loop?.fanout && <StageStrip task={task} />}
      {repo && <ShapeLine task={task} state={state} />}
      {repo && <Fanout task={task} state={state} />}
      {loop?.paused && task.status === "blocked" && <Paused task={task} nudge={loop.paused.kind === "loop" && !loop.explanation && state.spaces.find((sp) => sp.id === task.spaceId)?.learning !== "off"} />}
      {loop?.explanation && (
        <div className="explained">
          <h4>What it says is wrong</h4>
          <Markdown text={loop.explanation} />
        </div>
      )}
      {attention && (
        <p className="attention" role="note">
          <TriangleAlert />
          {attention}
        </p>
      )}
      {loop?.stage === "brief" && task.status === "running" && <p className="hint">Drafting the brief. The writer starts as soon as it's ready.</p>}
      {loop?.stage === "brief" && asksBeforeStarting(task) && <BriefQuestions task={task} />}
      {task.brief && (
        <details className="brief-view" open={briefOpen || loop?.questions.length ? true : undefined}>
          <summary>Brief</summary>
          <Markdown text={briefSections(task.brief, null).join("\n\n")} />
        </details>
      )}
      {loop?.suggestedVerify && task.status !== "done" && <SuggestedCheck task={task} command={loop.suggestedVerify} />}
      {loop && loop.hints.length > 0 && (
        <ul className="brief-hints">
          {loop.hints.map((h) => (
            <li key={h}>
              <Lightbulb />
              {h}
            </li>
          ))}
        </ul>
      )}
      {repo && loop && !loop.noChanges && loop.checks !== "pending" && (
        <div className="checks-line">
          {loop.checks === "none" ? <span>{loop.unverified ?? "Unverified: no checks found. Add a check command in this space's settings or in the brief."}</span> : <span>Checks {loop.checks === "running" ? "running" : loop.checks}</span>}
          <button className="btn link subtle" aria-expanded={checksOpen} onClick={() => setChecksOpen(!checksOpen)}>
            {checksOpen ? "Hide output" : "Show output"}
          </button>
        </div>
      )}
      {checksOpen && <CheckOutput taskId={task.id} version={task.updatedAt} alreadyFailing={(loop?.alreadyFailing ?? []).map((f) => f.name)} />}
      {loop?.reviews.map((r, i) => (
        <div className="review-round" key={i}>
          <b>
            {loop.reviews.length > 1 ? `Review round ${i + 1}` : "Review"} by {agentName(r.reviewer)}
          </b>
          <span className="hint">
            {r.skipped ? ` didn't happen: ${r.skipped}` : r.verdict === "approve" ? " · ready to merge" : r.verdict === "changes" ? ` · asked for changes${stillOpen(r)}` : " · no verdict"}
          </span>
          {r.findings.length > 0 && (
            <ol>
              {r.findings.map((f, n) => (
                <li key={n} className={`finding ${f.severity}`}>
                  {findingLine(f, n + 1).replace(/^\d+\. /, "")}
                  {r.verdict === "changes" && <span className="hint"> · {answeredText(f, true)}</span>}
                </li>
              ))}
            </ol>
          )}
        </div>
      ))}
      {loop && <Budget task={task} />}
    </section>
  );
}
