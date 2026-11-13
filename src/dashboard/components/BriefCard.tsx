import { Lightbulb, Play, X } from "lucide-react";
import { useState } from "react";
import { type Brief, type BriefQuestion, gapHints, SIZES, type TaskSize } from "../../engine/brief";

export type Draft = { brief: Brief; questions: BriefQuestion[]; checks: string[]; error: string | null; suggestedVerify: string | null };

const lines = (text: string) => text.split("\n").map((l) => l.trim()).filter(Boolean);

type Props = {
  draft: Draft;
  repo: boolean;
  busy: boolean;
  onRun: (brief: Brief) => void;
  onDiscard: () => void;
};

type Fields = { goal: string; acceptance: string; verify: string; scope: string; nonGoals: string; lookFirst: string; size: TaskSize };

// The drafted brief under the ask, every field editable. Fields keep exactly what's typed, spaces and new lines
// included, and become a brief only when it runs. Nothing here is required: Run sends whatever it holds.
export function BriefCard({ draft, repo, busy, onRun, onDiscard }: Props) {
  const b = draft.brief;
  const [f, setF] = useState<Fields>({
    goal: b.goal,
    acceptance: b.acceptance.join("\n"),
    verify: b.verify,
    scope: b.scope,
    nonGoals: b.nonGoals.join("\n"),
    lookFirst: b.lookFirst.join("\n"),
    size: b.size,
  });
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const set = (key: keyof Fields) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [key]: e.target.value }));
  const brief: Brief = {
    ...b,
    goal: f.goal.trim(),
    acceptance: lines(f.acceptance),
    verify: f.verify.trim() || "auto",
    scope: f.scope.trim(),
    nonGoals: lines(f.nonGoals),
    lookFirst: lines(f.lookFirst),
    size: f.size,
  };
  const hints = gapHints(brief, { repo, checksFound: draft.checks.length > 0 });

  const run = () =>
    onRun({
      ...brief,
      answers: draft.questions.flatMap((q, i) => (answers[i]?.trim() ? [{ question: q.question, answer: answers[i]!.trim() }] : [])),
    });

  return (
    <div
      className="brief-card"
      role="group"
      aria-label="Brief"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onDiscard();
        } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          run();
        }
      }}
    >
      <div className="brief-head">
        <b>Brief</b>
        <span className="hint">Edit anything, then Run. ↩ in a box adds a line · ⌘↩ runs · Esc discards.</span>
        <button type="button" className="btn link subtle" aria-label="Discard the brief" onClick={onDiscard}>
          <X />
        </button>
      </div>
      {draft.error && <p className="hint">Couldn't draft a full brief: {draft.error} It holds your ask, and you can still run it.</p>}
      {draft.questions.map((q, i) => (
        <div className="brief-q" key={q.question}>
          <span>{q.question}</span>
          <div className="opts">
            {q.options.map((o) => (
              <button type="button" key={o} className={`btn${answers[i] === o ? " p" : ""}`} aria-pressed={answers[i] === o} onClick={() => setAnswers((a) => ({ ...a, [i]: o }))}>
                {o}
              </button>
            ))}
            <input aria-label={`Answer: ${q.question}`} placeholder={q.options.length ? "Or type an answer" : "Your answer"} value={q.options.includes(answers[i] ?? "") ? "" : (answers[i] ?? "")} onChange={(e) => setAnswers((a) => ({ ...a, [i]: e.target.value }))} />
          </div>
        </div>
      ))}
      <label>
        Goal
        <input value={f.goal} onChange={set("goal")} />
      </label>
      <label>
        <span>{repo ? "Acceptance criteria" : "Done when"} <span className="hint">one per line</span></span>
        <textarea rows={2} value={f.acceptance} onChange={set("acceptance")} />
      </label>
      {repo && (
        <>
          <label>
            <span>Check with <span className="hint">a command, or auto for {draft.checks.length ? draft.checks.join(", ") : "what Atrium finds"}</span></span>
            <input className="mono" value={f.verify} placeholder="auto" onChange={set("verify")} />
            {draft.suggestedVerify && f.verify !== draft.suggestedVerify && (
              <button type="button" className="btn link subtle" onClick={() => setF((x) => ({ ...x, verify: draft.suggestedVerify! }))}>
                Use <code>{draft.suggestedVerify}</code> as the check
              </button>
            )}
          </label>
          <div className="brief-row">
            <label>
              Scope
              <input value={f.scope} onChange={set("scope")} />
            </label>
            <label>
              Size
              <select className="pick" value={f.size} onChange={set("size")}>
                {SIZES.map((s) => (
                  <option key={s} value={s}>
                    {s[0]!.toUpperCase() + s.slice(1)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label>
            <span>Not in scope <span className="hint">one per line</span></span>
            <textarea rows={1} value={f.nonGoals} onChange={set("nonGoals")} />
          </label>
          <label>
            <span>Look at first <span className="hint">one file per line</span></span>
            <textarea className="mono" rows={1} value={f.lookFirst} onChange={set("lookFirst")} />
          </label>
        </>
      )}
      {hints.length > 0 && (
        <ul className="brief-hints">
          {hints.map((h) => (
            <li key={h}>
              <Lightbulb />
              {h}
            </li>
          ))}
        </ul>
      )}
      <div className="brief-acts">
        <button type="button" className="btn p" disabled={busy} onClick={run}>
          <Play />
          Run
        </button>
      </div>
    </div>
  );
}
