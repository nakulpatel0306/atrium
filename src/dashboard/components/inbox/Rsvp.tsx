import { useState } from "react";
import { post } from "../../api";
import { announce } from "../../live";
import type { EventView } from "../../mail";

const ANSWERS = [
  { id: "accepted", label: "Going" },
  { id: "tentative", label: "Maybe" },
  { id: "declined", label: "Not going" },
] as const;

// The user's own answer to an invitation, sent at once: it's his action, like answering in Calendar.
export function Rsvp({ e }: { e: Pick<EventView, "id" | "title" | "myStatus"> }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answer = async (id: (typeof ANSWERS)[number]["id"], label: string) => {
    setBusy(true);
    const res = await post(`/api/mail/events/${encodeURIComponent(e.id)}/rsvp`, { answer: id, note });
    setBusy(false);
    setError(res.ok ? null : res.error);
    if (res.ok) announce(`Answered ${e.title || "the invitation"}: ${label}.`);
  };
  return (
    <div className="cal-rsvp" role="group" aria-label={`Answer ${e.title || "this invitation"}`}>
      {ANSWERS.map((a) => (
        <button key={a.id} className="btn" aria-pressed={e.myStatus === a.id} disabled={busy} onClick={() => void answer(a.id, a.label)}>
          {a.label}
        </button>
      ))}
      <input className="mk-input cal-note" value={note} maxLength={500} placeholder="Note (optional)" aria-label="Note to the organizer" onChange={(x) => setNote(x.target.value)} />
      {error && <span className="err">{error}</span>}
    </div>
  );
}
