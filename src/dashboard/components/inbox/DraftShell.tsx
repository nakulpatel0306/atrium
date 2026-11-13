import { CalendarDays, Mail } from "lucide-react";
import { type ReactNode, useState } from "react";
import { personLabel } from "../../../engine/mail/compose";
import { post, type State } from "../../api";
import { cancelSend, pendingSendOf, usePendingSend, useSendError } from "../../pending-send";

type Approval = State["approvals"][number];
export type MailActionView = State["mailActions"][number];
export type Press = { label: string; onPress(): void; disabled: boolean };

export const peopleText = (people: { name: string; address: string }[]) => people.map(personLabel).join(", ");

// The one line of what to check before pressing: the engine's notes, then anyone Claude added. Addresses always
// show, since a name is whatever a sender or Claude chose.
export function noteLine(action: MailActionView, people: { name: string; address: string }[]): string | null {
  const marked = new Set([...action.to, ...action.cc, ...(action.event?.attendees ?? [])].filter((p) => p.added).map((p) => p.address));
  const added = people.filter((p) => marked.has(p.address.toLowerCase()));
  const parts = [...action.reasons.map((r) => r.text), ...(added.length ? [`added by Claude: ${added.map(personLabel).join(", ")}`] : [])];
  return parts.length ? `Check before sending: ${parts.join(" · ")}` : null;
}

// Every draft's card: a header with Don't send, one note line, its fields, and one primary button (plus at most one
// secondary). Cmd or Ctrl+Enter presses the primary. While a send waits in the tray, the footer offers only Undo.
export function DraftShell({
  approval,
  action,
  folded,
  people,
  primary,
  secondary,
  error,
  children,
}: {
  approval: Approval;
  action: MailActionView;
  folded: boolean;
  people: { name: string; address: string }[];
  primary: Press;
  secondary?: Press;
  error: string | null;
  children: ReactNode;
}) {
  const pending = usePendingSend(action.id);
  const sendError = useSendError(action.id);
  const [open, setOpen] = useState(() => !folded || !!action.lastError || !!pendingSendOf(action.id));
  const [declining, setDeclining] = useState(false);
  const [declineError, setDeclineError] = useState<string | null>(null);
  const Icon = action.event ? CalendarDays : Mail;
  const note = noteLine(action, people);
  const shownError = error ?? sendError ?? declineError;

  const decline = async () => {
    setDeclining(true);
    const res = await post(`/api/approvals/${approval.id}`, { decision: "reject" });
    if (!res.ok) {
      setDeclineError(res.error);
      setDeclining(false);
    }
  };

  if (!open) {
    return (
      <div className="entry msg-entry">
        <div className="item folded">
          <Icon className="msg-ico" />
          <span className="who">Inbox</span>
          <span className="t" title={approval.title}>
            {approval.title}
            <span>{action.draftedBy === "claude" ? "Drafted by Claude" : "Your draft"}</span>
          </span>
          <div className="acts">
            <button className="btn" data-act="open" aria-expanded={false} onClick={() => setOpen(true)}>
              Review
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="entry msg-entry mail-card-entry"
      data-draft-id={action.id}
      onKeyDown={(e) => {
        if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey) || pending || primary.disabled) return;
        e.preventDefault();
        primary.onPress();
      }}
    >
      <div className="item">
        <Icon className="msg-ico" />
        <span className="who">Inbox</span>
        <span className="t" title={approval.title}>
          {approval.title}
          <span>{action.draftedBy === "claude" ? "Drafted by Claude" : "Your draft"}</span>
        </span>
        <div className="acts">
          {folded && (
            <button className="btn" data-act="open" aria-expanded onClick={() => setOpen(false)}>
              Hide
            </button>
          )}
          <button className="btn" disabled={declining || !!pending} onClick={() => void decline()}>
            Don't send
          </button>
        </div>
      </div>
      <div className="detail msg-card mail-card">
        {action.lastError && <p className="err last-try">Last try failed: {action.lastError}</p>}
        {note && <p className="mail-note">{note}</p>}
        {children}
        <div className="msg-foot">
          {pending ? (
            <>
              <span className="sending">Sending…</span>
              {!pending.sending && (
                <button className="btn" onClick={() => cancelSend(action.id)}>
                  Undo
                </button>
              )}
            </>
          ) : (
            <>
              <button className="btn p" disabled={primary.disabled} onClick={primary.onPress} aria-keyshortcuts="Meta+Enter Control+Enter">
                {primary.label}
              </button>
              {secondary && (
                <button className="btn" disabled={secondary.disabled} onClick={secondary.onPress}>
                  {secondary.label}
                </button>
              )}
            </>
          )}
        </div>
      </div>
      {shownError && (
        <div className="row-err err" role="alert">
          {shownError}
        </div>
      )}
    </div>
  );
}
