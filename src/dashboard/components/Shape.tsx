import { GitMerge, GitPullRequest, Split } from "lucide-react";
import { useState } from "react";
import { cacheShare, type Spend, spendText } from "../../engine/cost";
import { compact, SIZE_BUDGETS } from "../../engine/loop";
import {
  type ChildState,
  childState,
  costlier,
  fanOutEstimate,
  fanOutOf,
  type Shape,
  SHAPE_LABEL,
  type ShapeKind,
  shapeChoices,
  shapeLine,
  shapeOpen,
  suggestion,
  suggestionLine,
  switchOpen,
} from "../../engine/shape";
import { agentName } from "../agents";
import { get, post, type State } from "../api";

type Task = State["tasks"][number];

// The cost chip: weighted tokens and the estimate at list prices, with the cache's share one hover away.
export function CostChip({ spend }: { spend: Spend | undefined }) {
  if (!spend || spend.weighted === 0) return null;
  const share = cacheShare(spend);
  const title = [
    `${spend.weighted.toLocaleString("en-US")} weighted tokens (cache reads count 0.1×, cache writes 1.25×).`,
    `${spendText(spend)} at Anthropic's list prices. Your subscription doesn't bill per token; this is what the work would cost on the API.`,
    ...(share !== null ? [`${Math.round(share * 100)}% of what the agents read came from the prompt cache.`] : []),
  ].join(" ");
  return (
    <span className="tag cost" title={title}>
      {compact(spend.weighted)} · {spendText(spend).replace(/ est\.$/, "")}
    </span>
  );
}

// What a fan-out would cost, before it runs: from this space's recent tasks, or each run's budget when there are none.
export function estimateText(state: State, spaceId: string, budget: number, n: number): string {
  const recent = state.tasks
    .filter((t) => t.spaceId === spaceId && t.kind === "work" && t.status === "done" && !t.loop?.role && !t.loop?.fanout)
    .slice(-5)
    .map((t) => state.spend.tasks[t.id])
    .filter((s): s is Spend => !!s);
  const e = fanOutEstimate(n, recent, budget);
  if (e.basis === "budget") return `Runs ${n} tasks, each with its own budget: up to ${compact(e.weighted)} weighted tokens in all.`;
  return `About ${n}× a task here: ~${compact(e.weighted)} weighted tokens${e.usd !== null ? `, ~$${e.usd.toFixed(2)} est.` : ""}, from your last ${recent.length} in this space.`;
}

const kindLabel = (shape: Shape, kind: ShapeKind) =>
  kind === "split" ? `Split into ${shape.parts.length || "parts"}` : kind === "best_of_n" ? `Best of ${shape.attempts}` : SHAPE_LABEL[kind];

// The shapes to pick from, each with why not when it can't run here, and what a costlier one would cost. Used on
// the task, in Needs you and in the brief-first card.
export function ShapePicker({
  shape,
  size,
  value,
  mix,
  onChange,
  estimate,
}: {
  shape: Shape;
  size: "small" | "medium" | "large";
  value: ShapeKind;
  mix: boolean;
  onChange: (kind: ShapeKind, mix: boolean) => void;
  estimate: (n: number) => string;
}) {
  const choices = shapeChoices(shape, { size, checksFound: shape.checksFound });
  return (
    <div className="shape-pick" role="radiogroup" aria-label="How it runs">
      {choices.map((c) => (
        <button
          type="button"
          role="radio"
          key={c.kind}
          aria-checked={value === c.kind}
          className={`btn${value === c.kind ? " p" : ""}`}
          disabled={c.why !== null}
          title={c.why ?? undefined}
          onClick={() => onChange(c.kind, mix)}
        >
          {kindLabel(shape, c.kind)}
          {c.kind === shape.proposed && c.kind !== "single" && <span className="hint"> · suggested</span>}
        </button>
      ))}
      {costlier(value) && <p className="hint">{estimate(fanOutOf({ ...shape, kind: value }))}</p>}
      {value === "best_of_n" && (
        <label className="check">
          <input type="checkbox" checked={mix} onChange={(e) => onChange(value, e.target.checked)} />
          Give one attempt to Codex, when it can work in this space
        </label>
      )}
    </div>
  );
}

// What a fan-out would cost, short, for the suggestion line: "est. ~$0.04", or the budgets' ceiling.
export function estimateShort(state: State, spaceId: string, budget: number, n: number): string {
  const recent = state.tasks
    .filter((t) => t.spaceId === spaceId && t.kind === "work" && t.status === "done" && !t.loop?.role && !t.loop?.fanout)
    .slice(-5)
    .map((t) => state.spend.tasks[t.id])
    .filter((s): s is Spend => !!s);
  const e = fanOutEstimate(n, recent, budget);
  return e.usd !== null ? `est. ~$${e.usd.toFixed(2)}` : `up to ${compact(e.weighted)} weighted tokens`;
}

const SWITCH_LABEL: Record<ShapeKind, string> = { single: "One writer instead", scouts: "Scouts instead", split: "Split instead", best_of_n: "Try best of N instead" };

// The shape line on a task: its chip, the one-line reason, the pre-pass's costlier suggestion while it runs as one
// writer, and the override while it can still change.
export function ShapeLine({ task, state }: { task: Task; state: State }) {
  const shape = task.loop?.shape;
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!shape) return null;
  const open = shapeOpen(task);
  const size = task.brief?.size ?? "medium";
  const offer = switchOpen(task) ? suggestion(shape, size) : null;
  const take = async (kind: ShapeKind) => {
    setBusy(true);
    setError(null);
    const res = await post(`/api/tasks/${task.id}/shape`, { kind });
    setBusy(false);
    if (!res.ok) setError(res.error);
  };
  const choose = async (kind: ShapeKind, mix: boolean) => {
    setError(null);
    const res = await post(`/api/tasks/${task.id}/shape`, { kind, mixVendors: mix });
    if (!res.ok) setError(res.error);
    // Best-of-N stays open, for the vendor choice under it.
    else setEditing(kind === "best_of_n");
  };
  return (
    <div className="shape-line">
      <Split />
      <span>{offer ? SHAPE_LABEL[shape.kind] : shapeLine(shape)}</span>
      {offer && (
        <span className="suggest">
          {suggestionLine(shape, offer)} ({estimateShort(state, task.spaceId, task.loop!.budget.tokens, fanOutOf({ ...shape, kind: offer }))}) ·{" "}
          <button
            type="button"
            className="btn link"
            disabled={busy}
            title={task.status === "running" ? "Stops the writer and starts over from the brief." : "Starts over from the brief."}
            onClick={() => void take(offer)}
          >
            {offer === "best_of_n" ? SWITCH_LABEL.best_of_n.replace("N", String(shape.attempts)) : SWITCH_LABEL[offer]}
          </button>
        </span>
      )}
      {!offer && shape.proposed !== shape.kind && <span className="hint">(suggested: {SHAPE_LABEL[shape.proposed]})</span>}
      {open && (
        <button type="button" className="btn link subtle" aria-expanded={editing} onClick={() => setEditing(!editing)}>
          Change
        </button>
      )}
      {open && editing && (
        <ShapePicker
          shape={shape}
          size={task.brief?.size ?? "medium"}
          value={shape.kind}
          mix={shape.mixVendors}
          onChange={(k, m) => void choose(k, m)}
          estimate={(n) => estimateText(state, task.spaceId, task.loop?.budget.tokens ?? SIZE_BUDGETS.medium.tokens, n)}
        />
      )}
      {error && <span className="err">{error}</span>}
    </div>
  );
}

const CHILD_TEXT: Record<ChildState, string> = { running: "working", ready: "ready", stuck: "needs you", dropped: "dropped" };

// A split's parts or a best-of-N's attempts under their parent, with the decision once they're ready. Each child is a
// task of its own in the list, one click away.
export function Fanout({ task, state }: { task: Task; state: State }) {
  const fanout = task.loop?.fanout;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!fanout) return null;
  const children = fanout.children.map((id) => state.tasks.find((t) => t.id === id)).filter((t): t is Task => !!t);
  const deciding = task.status === "queued" && task.loop?.stage === "pick";
  const act = async (path: string, body: unknown) => {
    setBusy(true);
    setError(null);
    const res = await post<{ failed?: { taskId: string; error: string }[] }>(`/api/tasks/${task.id}/${path}`, body);
    setBusy(false);
    if (!res.ok) setError(res.error);
    else if (res.data.failed?.length) setError(res.data.failed.map((f) => `${children.find((c) => c.id === f.taskId)?.title ?? "A part"}: ${f.error}`).join(" "));
  };
  // The commit each part's pull request would push, as its PR card shows it, so the click approves exactly that.
  const openPrs = async () => {
    const shas: Record<string, string> = {};
    for (const c of children) {
      const info = await get<{ eligible: boolean; sha?: string; reason?: string }>(`/api/tasks/${c.id}/pr`);
      if (info.ok && info.data.eligible && info.data.sha) shas[c.id] = info.data.sha;
    }
    await act("parts", { action: "prs", shas });
  };
  const split = fanout.kind === "split";
  const ranked = [...children].sort((a, b) => (fanout.scores[b.id]?.score ?? -1) - (fanout.scores[a.id]?.score ?? -1));
  return (
    <section className="fanout" aria-label={split ? "Parts" : "Attempts"}>
      <h4>{split ? `Parts (${children.length})` : `Attempts (${children.length})`}</h4>
      {split || !deciding ? (
        <ul className="fanout-list">
          {children.map((c, i) => (
            <li key={c.id}>
              <span className={`tag${childState(c) === "stuck" || childState(c) === "dropped" ? " bad" : childState(c) === "ready" ? " good" : ""}`}>{CHILD_TEXT[childState(c)]}</span>
              <a href={`#task-${c.id}`}>{split ? c.title : `Attempt ${i + 1}`}</a>
              <span className="hint">{c.branch ?? ""}</span>
              {c.prUrl && (
                <a href={c.prUrl} target="_blank" rel="noreferrer">
                  pull request
                </a>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <div className="attempts">
          {ranked.map((c) => {
            const n = children.indexOf(c) + 1;
            const score = fanout.scores[c.id];
            const ready = childState(c) === "ready";
            return (
              <div key={c.id} className={`attempt${ready ? "" : " out"}`}>
                <b>
                  Attempt {n} <span className="hint">· {agentName(c.agent === "auto" ? "claude" : c.agent)}</span>
                </b>
                {ready ? (
                  <>
                    {c.loop?.checks === "passed" ? (
                      <span className="tag good">checks passed</span>
                    ) : (
                      <span className="tag wait" title={c.loop?.unverified ?? undefined}>
                        unverified: already failing before
                      </span>
                    )}
                    {score ? (
                      <p>
                        <span className="tag">{score.score}/10</span> {score.comment}
                      </p>
                    ) : (
                      <p className="hint">No score.</p>
                    )}
                    <p className="hint">{c.loop?.report.find((l) => /commit/.test(l)) ?? ""}</p>
                    <a href={`#task-${c.id}`}>See its changes</a>
                    <button type="button" className="btn p" disabled={busy} onClick={() => void act("pick", { attempt: c.id })}>
                      Pick this one
                    </button>
                  </>
                ) : (
                  <p className="hint">{c.blockedReason ?? "Didn't finish."}</p>
                )}
              </div>
            );
          })}
        </div>
      )}
      {!split && deciding && <p className="hint">{fanout.judgeNote ?? "Scored against the brief by the strong model. The scores are advice; you pick."}</p>}
      {deciding && (
        <div className="acts">
          {split && (
            <>
              <button type="button" className="btn p" disabled={busy} onClick={() => void openPrs()}>
                <GitPullRequest />
                Open {children.length} pull requests
              </button>
              <button type="button" className="btn" disabled={busy} onClick={() => void act("parts", { action: "merge" })}>
                <GitMerge />
                Merge into one branch
              </button>
            </>
          )}
          <button type="button" className="btn" disabled={busy} onClick={() => void act(split ? "parts" : "pick", split ? { action: "discard" } : { attempt: null })}>
            {split ? "Set them aside" : "None of these"}
          </button>
        </div>
      )}
      {error && <p className="err">{error}</p>}
    </section>
  );
}
