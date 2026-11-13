import { Lightbulb, MessageSquareText, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { briefSections } from "../../engine/brief";
import type { CheckRow } from "../../engine/checks/run";
import { compact, findingLine, resolutionText, shownStage, type Stage } from "../../engine/loop";
import { agentName } from "../agents";
import { post, type State, useFetched } from "../api";
import { duration } from "../format";
import { attentionText, STAGE_TEXT } from "../summary";
import { Markdown } from "./Markdown";

type Task = State["tasks"][number];

const STRIP: (Stage | "brief")[] = ["brief", "writing", "checks", "review", "ready"];

// Brief · Writing · Checks · Review · Ready, with where the task is now; a pause replaces the stage it stopped in.
export function StageStrip({ task }: { task: Task }) {
  const now = shownStage(task.status, task.loop, task.brief !== null);
  const at = now === "paused" ? STRIP.indexOf(task.loop!.stage) : STRIP.indexOf(now);
  return (
    <ol className="stages" aria-label="Where this task is">
      {STRIP.map((s, i) => {
        const here = i === at;
        const label = here && now === "paused" ? "Paused" : STAGE_TEXT[s];
        return (
          <li key={s} className={`${here ? "on" : i < at ? "past" : ""}${here && now === "paused" ? " bad" : ""}${here && task.status === "running" ? " live" : ""}`} aria-current={here ? "step" : undefined}>
            {label}
          </li>
        );
      })}
    </ol>
  );
}

const CHECK_WORD: Record<CheckRow["status"], string> = { passed: "passed", failed: "failed", timeout: "timed out", missing: "couldn't run", skipped: "skipped" };

function CheckOutput({ taskId, version }: { taskId: string; version: unknown }) {
  const rows = useFetched<CheckRow[]>(`/api/tasks/${taskId}/checks`, version);
  if (!rows) return <p className="hint">Loading the check output…</p>;
  if (!rows.length) return <p className="hint">No checks have run yet.</p>;
  return (
    <ul className="check-rows">
      {rows.map((r) => (
        <li key={r.id}>
          <span className={`tag${r.status === "failed" || r.status === "timeout" ? " bad" : ""}`}>{CHECK_WORD[r.status]}</span>
          <code>{r.command}</code>
          <span className="hint">{duration(r.durationMs)}</span>
          {r.output.trim() && r.status !== "passed" && <pre className="term mono">{r.output.trimEnd()}</pre>}
        </li>
      ))}
    </ul>
  );
}

// The header badge: what the checks said, with their output one click away.
export function ChecksBadge({ task, onOpen }: { task: Task; onOpen: () => void }) {
  const loop = task.loop;
  if (!loop || loop.noChanges || loop.checks === "pending") return null;
  const text = loop.checks === "running" ? "checking" : loop.checks === "passed" ? "checks passed" : loop.checks === "failed" ? "checks failed" : "unverified";
  const tone = loop.checks === "failed" ? " bad" : loop.checks === "passed" ? " good" : loop.checks === "none" ? " wait" : "";
  return (
    <button type="button" className={`tag check-badge${tone}`} title={loop.checks === "none" ? "Unverified: no checks found" : "Show what the checks said"} onClick={onOpen}>
      {text}
    </button>
  );
}

function Paused({ task }: { task: Task }) {
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
  return (
    <div className="paused">
      <form
        className="hint-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (hint.trim()) void act("hint", { note: hint.trim() });
        }}
      >
        <textarea rows={2} aria-label="Hint for the agent" placeholder="What should it try, or what is it missing?" value={hint} onChange={(e) => setHint(e.target.value)} />
        <div className="acts">
          <button className="btn p" type="submit" disabled={busy || !hint.trim()}>
            <Lightbulb />
            Give it a hint
          </button>
          <button className="btn" type="button" disabled={busy} onClick={() => void act("explain")}>
            <MessageSquareText />
            Explain the problem instead
          </button>
        </div>
      </form>
      {error && <p className="err">{error}</p>}
    </div>
  );
}

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
  const used = `${compact(loop.usage.tokens)}${loop.usage.unreported ? "+" : ""} of ${compact(loop.budget.tokens)} tokens · ${Math.round(loop.usage.ms / 60_000)} of ${loop.budget.minutes} min`;
  return (
    <div className="budget">
      <span>
        Budget since you last stepped in: {used}
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
// findings ended, the budget, and the way on when it's paused.
export function LoopPanel({ task, showChecks }: { task: Task; showChecks: boolean }) {
  const [checksOpen, setChecksOpen] = useState(showChecks);
  const loop = task.loop;
  const attention = attentionText(loop);
  return (
    <section className="loop">
      <StageStrip task={task} />
      {loop?.paused && task.status === "blocked" && <Paused task={task} />}
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
      {task.brief && (
        <details className="brief-view">
          <summary>Brief</summary>
          <Markdown text={briefSections(task.brief, null).join("\n\n")} />
        </details>
      )}
      {loop && !loop.noChanges && loop.checks !== "pending" && (
        <div className="checks-line">
          {loop.checks === "none" ? <span>{loop.unverified ?? "Unverified: no checks found. Add a check command in this space's settings or in the brief."}</span> : <span>Checks {loop.checks === "running" ? "running" : loop.checks}</span>}
          <button className="btn link subtle" aria-expanded={checksOpen} onClick={() => setChecksOpen(!checksOpen)}>
            {checksOpen ? "Hide output" : "Show output"}
          </button>
        </div>
      )}
      {checksOpen && <CheckOutput taskId={task.id} version={task.updatedAt} />}
      {loop?.reviews.map((r, i) => (
        <div className="review-round" key={i}>
          <b>
            {loop.reviews.length > 1 ? `Review round ${i + 1}` : "Review"} by {agentName(r.reviewer)}
          </b>
          <span className="hint">
            {r.skipped ? ` didn't happen: ${r.skipped}` : r.verdict === "approve" ? " · ready to merge" : r.verdict === "changes" ? " · asked for changes" : " · no verdict"}
          </span>
          {r.findings.length > 0 && (
            <ol>
              {r.findings.map((f, n) => (
                <li key={n} className={`finding ${f.severity}`}>
                  {findingLine(f, n + 1).replace(/^\d+\. /, "")}
                  {r.verdict === "changes" && <span className="hint"> → {resolutionText(f)}</span>}
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
