import { SearchCheck, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { post, type State } from "../api";
import { showToast } from "../toast";
import { isRisky, shownSha } from "../queue";
import { HELD_ASKS } from "../../engine/needs";
import { attentionText, reviewChips } from "../summary";
import { approveLabel } from "./OutcomeBanner";

type Approval = State["approvals"][number];
type Outcome = State["tasks"][number]["outcome"];
export type Decision = ReturnType<typeof useDecision>;

// Approve or send back one approval. Needs you, the space's waiting list and a task's detail all decide through
// this, so a result reads the same and goes to the same endpoint wherever Nakul acts on it.
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
  showToast(held ? `Approved: ${approval.title} It starts in a minute.` : `Approved: ${approval.title}`, undoable ? () => reopen(approval.id) : undefined, approval.taskId ?? undefined);
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

export function DecideButtons({ d, outcome, risky = false }: { d: Decision; outcome: Outcome; risky?: boolean }) {
  return (
    <>
      <button className="btn" data-act="send-back" disabled={d.busy} onClick={() => d.setSendingBack(!d.sendingBack)}>
        Send back
      </button>
      <button
        className={`btn${risky ? "" : " p"}`}
        data-act="approve"
        data-risky={risky || undefined}
        disabled={d.busy}
        title={risky ? "Something here needs a look first: read the notes and findings before approving." : undefined}
        onClick={() => void d.decide("approve")}
      >
        {approveWord(outcome, risky)}
      </button>
    </>
  );
}

// What the checks said and what the reviewer said, as two chips that never cut each other off: each keeps its whole
// text and wraps to a line of its own when the row is narrow.
// `attention` adds a third: "Look closely", with what to look at on hover.
export function Chips({ chips, attention = null }: { chips: NonNullable<ReturnType<typeof reviewChips>>; attention?: string | null }) {
  return (
    <span className="chips">
      {attention && (
        <span className="chip waiting" title={attention} aria-label={attention}>
          <TriangleAlert />
          Look closely
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

// The one layout for deciding on a result, wherever it's decided: the queue's screen, a task's own page and a row in a
// list. Left to right: what the checks and the reviewer said, a way to the full screen when there is one, then Send
// back and Approve. Below them, a line that names the keys, or, once a risky Approve has had one press of a, asks for
// the second: the same height either way, so nothing moves under the pointer.
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
          <DecideButtons d={d} outcome={outcome} risky={risky} />
        </span>
      </div>
      {keys && (
        <p className={`decision-keys${armed ? " armed" : ""}`} role={armed ? "status" : undefined}>
          {armed ? (
            <>
              It has notes or findings that weren't fixed. Press <kbd>a</kbd> again to approve anyway.
            </>
          ) : (
            <>
              {risky ? (
                <>
                  <kbd>a</kbd> <kbd>a</kbd> approve anyway
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
