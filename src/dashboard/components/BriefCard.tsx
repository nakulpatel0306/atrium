import { Lightbulb, Play, X } from "lucide-react";
import { useState } from "react";
import { type Brief, type BriefQuestion, gapHints, SIZES, type TaskSize } from "../../engine/brief";

export type Draft = { brief: Brief; questions: BriefQuestion[]; checks: string[]; error: string | null };

const lines = (text: string) => text.split("\n").map((l) => l.trim()).filter(Boolean);

type Props = {
  draft: Draft;
  repo: boolean;
  busy: boolean;
  onRun: (brief: Brief) => void;
  onDiscard: () => void;
};

// The drafted brief under the ask, every field editable. Nothing here is required: Run sends whatever it holds.
export function BriefCard({ draft, repo, busy, onRun, onDiscard }: Props) {
  const [brief, setBrief] = useState<Brief>(draft.brief);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const set = <K extends keyof Brief>(key: K, value: Brief[K]) => setBrief((b) => ({ ...b, [key]: value }));
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
        <span className="hint">Edit anything, then Run. ⌘↩ runs it, Esc discards it.</span>
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
        <input value={brief.goal} onChange={(e) => set("goal", e.target.value)} />
      </label>
      <label>
        {repo ? "Acceptance criteria" : "Done when"} <span className="hint">one per line</span>
        <textarea rows={2} value={brief.acceptance.join("\n")} onChange={(e) => set("acceptance", lines(e.target.value))} />
      </label>
      {repo && (
        <>
          <label>
            Check with <span className="hint">a command, or auto for {draft.checks.length ? draft.checks.join(", ") : "what Atrium finds"}</span>
            <input className="mono" value={brief.verify} onChange={(e) => set("verify", e.target.value.trim() || "auto")} />
          </label>
          <div className="brief-row">
            <label>
              Scope
              <input value={brief.scope} onChange={(e) => set("scope", e.target.value)} />
            </label>
            <label>
              Size
              <select className="pick" value={brief.size} onChange={(e) => set("size", e.target.value as TaskSize)}>
                {SIZES.map((s) => (
                  <option key={s} value={s}>
                    {s[0]!.toUpperCase() + s.slice(1)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label>
            Not in scope <span className="hint">one per line</span>
            <textarea rows={1} value={brief.nonGoals.join("\n")} onChange={(e) => set("nonGoals", lines(e.target.value))} />
          </label>
          <label>
            Look at first <span className="hint">one file per line</span>
            <textarea className="mono" rows={1} value={brief.lookFirst.join("\n")} onChange={(e) => set("lookFirst", lines(e.target.value))} />
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
