import { useState } from "react";
import { post, type State } from "../api";
import { announce } from "../live";
import { showToast } from "../toast";
import { approveLabel } from "./OutcomeBanner";

type Approval = State["approvals"][number];
type Outcome = State["tasks"][number]["outcome"];
export type Decision = ReturnType<typeof useDecision>;

// Approve or send back one approval. Needs you, the space's waiting list and a task's detail all decide through
// this, so a result reads the same and goes to the same endpoint wherever Nakul acts on it.
export function useDecision(approval: Approval) {
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

// A task in review, decided from its own detail.
export function ReviewActions({ approval, outcome, risky = false }: { approval: Approval; outcome: Outcome; risky?: boolean }) {
  const d = useDecision(approval);
  return (
    <div className="review-acts">
      <div className="acts">
        <span className="faint">Waiting for your review</span>
        <DecideButtons d={d} outcome={outcome} risky={risky} />
      </div>
      <SendBackNote d={d} />
      {d.error && <p className="err">{d.error}</p>}
    </div>
  );
}
