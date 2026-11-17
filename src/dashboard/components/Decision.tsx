import { SearchCheck, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { announce } from "../live";
import { post, type State } from "../api";
import { showToast } from "../toast";
import { isRisky, shownSha } from "../queue";
import { HELD_ASKS } from "../../engine/needs";
import { answeredText, attentionText, reviewChips } from "../summary";
import { RISKY } from "../../engine/words";
import { approveLabel } from "./OutcomeBanner";

type Approval = State["approvals"][number];
// How long a first press of a risky Approve stays armed, by key or by click.
export const ARM_MS = 4000;

type Task = State["tasks"][number];
type Outcome = Task["outcome"];
export type Decision = ReturnType<typeof useDecision>;

// Approve or send back one approval. Needs you, the space's waiting list and a task's detail all decide through
// this, so a result reads the same and goes to the same endpoint wherever the user acts on it.
// `sha` is the commit the screen shows, for a result on a branch: approving binds to exactly that commit, and a branch
// that moved in the meantime is refused rather than approved unseen.
export function useDecision(approval: Approval, sha?: string | null) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sendingBack, setSendingBack] = useState(false);
  const [note, setNote] = useState("");

  const decide = async (decision: "approve" | "reject") => {
    setBusy(true);
    setError(null);
    const res = await post(`/api/approvals/${approval.id}`, {
      decision,
      ...(decision === "reject" && note.trim() ? { note: note.trim() } : {}),
      ...(decision === "approve" && sha ? { sha } : {}),
    });
    // On success the row disappears with the next state refresh. An approval can be taken back for a moment, in case
    // a key went to the wrong item.
    if (res.ok) {
      if (decision === "reject") return showToast(`Sent back: ${approval.title}`);
      return approvedToast(approval);
    }
    setError(res.error);
    setBusy(false);
  };

  return { busy, setBusy, error, setError, sendingBack, setSendingBack, note, setNote, decide };
}

// The toast after a yes, with an Undo wherever the engine can still take it back: a result until anything leaves the
// Mac, a new repo or a removal during the minute its start is held.
export function approvedToast(approval: Approval) {
  const held = approval.alwaysAsk !== null && HELD_ASKS.includes(approval.alwaysAsk);
  const undoable = (approval.kind === "review" && approval.taskId) || held;
  showToast(held ? `Approved: ${approval.title} (it starts in a minute)` : `Approved: ${approval.title}`, undoable ? () => reopen(approval.id) : undefined, approval.taskId ?? undefined);
}

export async function reopen(id: string): Promise<{ ok: boolean; error?: string }> {
  const res = await post(`/api/approvals/${id}/reopen`);
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

export function SendBackNote({ d }: { d: Decision }) {
  if (!d.sendingBack) return null;
  return (
    <form
      className="note"
      onSubmit={(e) => {
        e.preventDefault();
        void d.decide("reject");
      }}
    >
      <input
        autoFocus
        value={d.note}
        aria-label="What should change?"
        onChange={(e) => d.setNote(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && d.setSendingBack(false)}
        placeholder="What should change? (a short note for the agent)"
      />
      <button className="btn" type="button" onClick={() => d.setSendingBack(false)}>
        Cancel
      </button>
      <button className="btn p" type="submit" disabled={d.busy}>
        Send back
      </button>
    </form>
  );
}

// The two answers to a result. `data-act` lets the Needs you keys press them on the focused row. A `risky` result
// (a note, a check that didn't pass, a finding left open) gets a quieter Approve that says so.
// What a result's Approve says: plain, "Approve anyway" when something needs a look, or the not-done wording. A
// summary row's way to it says the same.
const approveWord = (outcome: Outcome, risky: boolean): string => {
  const label = approveLabel(outcome && outcome !== "done" ? outcome : null);
  return risky && label === "Approve" ? "Approve anyway" : label;
};

export function approveText(state: State, approval: Approval): string {
  const task = approval.taskId ? state.tasks.find((t) => t.id === approval.taskId) : undefined;
  return approveWord(task?.outcome ?? null, isRisky(state, approval));
}

// Every label a button can show, stacked in one grid cell with only the current one visible, so the button keeps the
// width of its longest label and nothing moves under the pointer when it changes.
function Labels({ shown, all }: { shown: string; all: string[] }) {
  return (
    <span className="btn-labels">
      {[...new Set(all)].map((l) => (
        <span key={l} className={l === shown ? "on" : undefined} aria-hidden={l === shown ? undefined : true}>
          {l}
        </span>
      ))}
    </span>
  );
}

// The arm's own words, said on the button itself: by key or by click, approve or accept.
export const armLabel = (word: string, by: "key" | "click"): string => `${by === "key" ? "Press a" : "Click"} again to ${word.startsWith("Accept") ? "accept" : "approve"}`;

// A risky Approve takes two presses with the mouse as with the keys: the first arms it (or a page's first a did,
// `armed`), the second approves. It disarms by itself after a few seconds.
export function DecideButtons({ d, outcome, risky = false, armed = false }: { d: Decision; outcome: Outcome; risky?: boolean; armed?: boolean }) {
  const [clicked, setClicked] = useState(false);
  useEffect(() => {
    if (!clicked) return;
    const t = setTimeout(() => setClicked(false), ARM_MS);
    return () => clearTimeout(t);
  }, [clicked]);
  const word = approveWord(outcome, risky);
  const approve = () => {
    if (risky && !armed && !clicked) {
      setClicked(true);
      return announce(`${armLabel(word, "click")}.`);
    }
    setClicked(false);
    void d.decide("approve");
  };
  return (
    <>
      <button className="btn" data-act="send-back" disabled={d.busy} onClick={() => d.setSendingBack(!d.sendingBack)}>
        Send back
      </button>
      <button
        className={`btn${risky ? "" : " p"}`}
        data-act="approve"
        data-risky={risky || undefined}
        data-word={word}
        disabled={d.busy}
        title={risky ? "Something here needs a look first: read the notes and findings before approving." : undefined}
        onClick={approve}
      >
        {risky ? <Labels shown={clicked ? armLabel(word, "click") : armed ? armLabel(word, "key") : word} all={[word, armLabel(word, "key"), armLabel(word, "click")]} /> : word}
      </button>
    </>
  );
}

// What the checks said and what the reviewer said, as two chips that never cut each other off: each keeps its whole
// text and wraps to a line of its own when the row is narrow.
// `attention` adds a third, the risky word (engine/words.ts), with what to look at on hover.
export function Chips({ chips, attention = null }: { chips: NonNullable<ReturnType<typeof reviewChips>>; attention?: string | null }) {
  return (
    <span className="chips">
      {attention && (
        <span className="chip waiting" title={attention} aria-label={attention}>
          <TriangleAlert />
          {RISKY}
        </span>
      )}
      <span className={`chip${chips.checks.tone ? ` ${chips.checks.tone}` : ""}`}>{chips.checks.text}</span>
      {chips.review && (
        <span className={`chip${chips.review.tone ? ` ${chips.review.tone}` : ""}`}>
          <SearchCheck />
          {chips.review.text}
        </span>
      )}
    </span>
  );
}

// A risky result's reasons, in one place above the walkthrough and the diff: the attention note and every finding the
// writer didn't fix, with what it said.
export function OpenPoints({ task }: { task: Task }) {
  const loop = task.loop;
  if (!loop) return null;
  const attention = loop.attention;
  const open = loop.reviews.flatMap((r) => r.findings.filter((f) => f.resolution?.action !== "fixed").map((f) => ({ f, asked: r.verdict === "changes" })));
  const notes = [loop.unverified, ...loop.alreadyFailing.map((c) => `${c.name} was already failing before the change.`)].filter((x): x is string => !!x);
  if (!attention.length && !open.length && !notes.length) return null;
  return (
    <section className="open-points" aria-label={`${RISKY}: why`}>
      <h4>
        <TriangleAlert />
        {RISKY}: why
      </h4>
      <ul>
        {attention.map((a) => (
          <li key={a}>{a}</li>
        ))}
        {notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
        {open.map(({ f, asked }, i) => (
          <li key={i} className={`finding ${f.severity}`}>
            <span className={`tag sev-${f.severity}`}>{f.severity}</span> {f.file && <code>{f.file}{f.line ? `:${f.line}` : ""}</code>} {f.reason}
            <span className="reply">{answeredText(f, asked)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// The one layout for deciding on a result, wherever it's decided: the queue's screen, a task's own page and a row in a
// list. Left to right: what the checks and the reviewer said, a way to the full screen when there is one, then Send
// back and Approve. Below them, a line that names the keys, or, once a risky Approve has had one press of a (its button
// then says to press it again), why and how to back out: the same height either way, so nothing moves.
export function DecisionBar({ approval, state, open, armed = false, keys = false }: { approval: Approval; state: State; open?: () => void; armed?: boolean; keys?: boolean }) {
  const task = approval.taskId ? state.tasks.find((t) => t.id === approval.taskId) : undefined;
  const d = useDecision(approval, shownSha(state, approval));
  const chips = reviewChips(approval, state);
  const outcome = task?.outcome && task.outcome !== "done" ? task.outcome : null;
  const risky = isRisky(state, approval);
  return (
    <div className="decision">
      <div className="decision-row">
        {chips ? <Chips chips={chips} attention={attentionText(task?.loop)} /> : <span className="review-line">Waiting for your decision</span>}
        <span className="decision-acts">
          {open && (
            <button className="btn" data-act="open" onClick={open}>
              Open
            </button>
          )}
          <DecideButtons d={d} outcome={outcome} risky={risky} armed={armed} />
        </span>
      </div>
      {keys && (
        <p className={`decision-keys${armed ? " armed" : ""}`}>
          {armed ? (
            <>
              It has notes or findings that weren't fixed. <kbd>Esc</kbd> cancels.
            </>
          ) : (
            <>
              {risky ? (
                <>
                  <kbd>a</kbd> twice: approve anyway
                </>
              ) : (
                <>
                  <kbd>a</kbd> approve
                </>
              )}{" "}
              · <kbd>s</kbd> send back · <kbd>?</kbd> all keys
            </>
          )}
        </p>
      )}
      <SendBackNote d={d} />
      {d.error && <p className="err">{d.error}</p>}
    </div>
  );
}
