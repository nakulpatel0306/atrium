import { MessageCircleQuestion } from "lucide-react";
import { useState } from "react";
import { post, type State } from "../api";

type Task = State["tasks"][number];
type Space = State["spaces"][number];

// Tasks whose brief asked something, waiting for the answers before the writer starts.
export const askingTasks = (state: State, spaceId?: string): Task[] =>
  state.tasks.filter((t) => t.status === "queued" && (t.loop?.questions.length ?? 0) > 0 && (!spaceId || t.spaceId === spaceId));

// A brief's questions, one tap or a few words each. Start sends what's answered; the writer starts either way.
export function BriefQuestions({ task }: { task: Task }) {
  const questions = task.loop?.questions ?? [];
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = async () => {
    setBusy(true);
    setError(null);
    const sent = questions.flatMap((q, i) => (answers[i]?.trim() ? [{ question: q.question, answer: answers[i]!.trim() }] : []));
    const res = await post(`/api/tasks/${task.id}/answers`, { answers: sent });
    setBusy(false);
    if (!res.ok) setError(res.error);
  };
  return (
    <div className="brief-qs">
      {questions.map((q, i) => (
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
      <div className="acts">
        <button type="button" className="btn p" disabled={busy} onClick={() => void start()}>
          Start
        </button>
        <span className="hint">Unanswered questions are left to the agent.</span>
      </div>
      {error && <p className="err">{error}</p>}
    </div>
  );
}

// The Needs you row for a task asking before it starts.
export function QuestionsRow({ task, space }: { task: Task; space: Space | undefined }) {
  return (
    <div className="entry">
      <div className="item">
        <span className="sd" style={{ background: space?.color ?? "var(--faint)" }} />
        <span className="who">{space?.name ?? "Unknown space"}</span>
        <span className="t" title={task.title}>
          {task.title}
          <span>has a question before it starts</span>
        </span>
        <MessageCircleQuestion />
      </div>
      <div className="detail">
        <BriefQuestions task={task} />
      </div>
    </div>
  );
}
