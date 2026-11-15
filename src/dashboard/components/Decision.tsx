import { SearchCheck } from "lucide-react";
import { useState } from "react";
import { post, type State } from "../api";
import { announce } from "../live";
import { showToast } from "../toast";
import { isRisky, shownSha } from "../queue";
import { reviewLine } from "../summary";
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
      if (decision === "reject") return announce(`Sent back: ${approval.title}`);
      return showToast(`Approved: ${approval.title}`, approval.kind === "review" && approval.taskId ? () => reopen(approval.id) : undefined, approval.taskId ?? undefined);
    }
    setError(res.error);
    setBusy(false);
  };

  return { busy, setBusy, error, setError, sendingBack, setSendingBack, note, setNote, decide };
}

async function reopen(id: string): Promise<{ ok: boolean; error?: string }> {
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
export function DecideButtons({ d, outcome, risky = false }: { d: Decision; outcome: Outcome; risky?: boolean }) {
  const label = approveLabel(outcome && outcome !== "done" ? outcome : null);
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
        {risky && label === "Approve" ? "Approve anyway" : label}
      </button>
    </>
  );
}

// The one layout for deciding on a result, wherever it's decided: the queue's screen, a task's own page and a row in a
// list. Left to right: what the checks and the reviewer said, a way to the full screen when there is one, then Send
// back and Approve. Below them, a line that names the keys, or, once a risky Approve has had one press of a, asks for
// the second: the same height either way, so nothing moves under the pointer.
export function DecisionBar({ approval, state, open, armed = false, keys = false }: { approval: Approval; state: State; open?: () => void; armed?: boolean; keys?: boolean }) {
  const task = approval.taskId ? state.tasks.find((t) => t.id === approval.taskId) : undefined;
  const d = useDecision(approval, shownSha(state, approval));
  const review = reviewLine(approval, state);
  const outcome = task?.outcome && task.outcome !== "done" ? task.outcome : null;
  return (
    <div className="decision">
      <div className="decision-row">
        {review ? (
          <span className={`review-line${review.tone ? ` ${review.tone}` : ""}`} title={review.text}>
            <SearchCheck />
            {review.text}
          </span>
        ) : (
          <span className="review-line">Waiting for your decision</span>
        )}
        <span className="decision-acts">
          {open && (
            <button className="btn" data-act="open" onClick={open}>
              Open
            </button>
          )}
          <DecideButtons d={d} outcome={outcome} risky={isRisky(state, approval)} />
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
              <kbd>a</kbd> approve · <kbd>s</kbd> send back · <kbd>?</kbd> all keys
            </>
          )}
        </p>
      )}
      <SendBackNote d={d} />
      {d.error && <p className="err">{d.error}</p>}
    </div>
  );
}
