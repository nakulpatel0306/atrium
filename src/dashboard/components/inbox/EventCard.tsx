import { CalendarDays } from "lucide-react";
import { useState } from "react";
import { namesLine, parseRecipients, type Recipient } from "../../../engine/mail/compose";
import { post, type State } from "../../api";
import { useMailOverview } from "../../mail";
import { cancelSend, clearSendError, pendingSendOf, startSend, usePendingSend, useSendError } from "../../pending-send";
import { FoldedDraft, type MailActionView, peopleText, SendNotes } from "./MailCard";

type Approval = State["approvals"][number];

// <input type="datetime-local"> speaks local "YYYY-MM-DDTHH:MM".
const pad = (n: number) => String(n).padStart(2, "0");
export const toLocalInput = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
export const fromLocalInput = (s: string) => (s ? new Date(s).getTime() : NaN);

// The day and time of the event a move or cancel is about, so the card names the exact one.
export const eventWhen = (e: { start: number; end: number; allDay: boolean }) =>
  e.allDay
    ? new Date(e.start).toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" })
    : `${new Date(e.start).toLocaleString([], { weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} to ${new Date(e.end).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;

const ACT: Record<string, string> = { event_create: "Create event", event_move: "Move event", event_cancel: "Cancel event" };

// A calendar change waiting on the user: a new event (and its invites), a move or a cancellation. Approve goes
// through the same Sending… tray and Undo as an email, then the calendar's own source makes exactly this change.
export function EventCard({ approval, action, folded = false }: { approval: Approval; action: MailActionView; folded?: boolean }) {
  const overview = useMailOverview();
  const e = action.event!;
  const [held] = useState(() => pendingSendOf(action.id));
  const pending = usePendingSend(action.id);
  const locked = pending !== null;
  const sendError = useSendError(action.id);
  const [open, setOpen] = useState(!folded || !!action.lastError || !!held);
  const h = held?.body as Partial<Record<string, unknown>> | undefined;
  const [calendarId, setCalendarId] = useState((h?.calendarId as string) ?? e.calendarId);
  const [title, setTitle] = useState((h?.title as string) ?? e.title);
  const [start, setStart] = useState(toLocalInput((h?.start as number) ?? e.start));
  const [end, setEnd] = useState(toLocalInput((h?.end as number) ?? e.end));
  const [location, setLocation] = useState((h?.location as string) ?? e.location);
  const [guests, setGuests] = useState(h ? peopleText(h.attendees as Recipient[]) : peopleText(e.attendees));
  const [notify, setNotify] = useState((h?.notify as boolean | undefined) ?? e.notify);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = action.kind === "event_create";
  // Calendar.app has no switch for telling guests; its server may tell them anyway, and the card says so.
  const mayNotify = action.reasons.some((r) => r.kind === "may_notify");
  const guestsP = parseRecipients(guests);
  const s = fromLocalInput(start);
  const en = fromLocalInput(end);
  const timeIssue = action.kind !== "event_cancel" && !(en > s) ? "The event has to end after it starts." : null;
  const ready = !timeIssue && !guestsP.problem && (!create || !!title.trim());
  const calendars = (overview?.calendars ?? []).filter((c) => c.enabled && !c.hidden && c.writable);
  const edited = () => {
    setError(null);
    clearSendError(action.id);
  };
  const label = create && guestsP.people.length ? "Create and invite" : ACT[action.kind]!;

  const approve = () => {
    if (!ready || locked) return;
    const name = create ? (guestsP.people.length ? namesLine(guestsP.people) : `"${title.trim()}"`) : `"${e.title}"`;
    startSend(action.id, name, { calendarId, title, start: s, end: en, allDay: e.allDay, location, attendees: guestsP.people, notify, seen: action.reasons.map((r) => r.key) }, `/api/mail/actions/${action.id}/send`);
  };
  const decline = async () => {
    setBusy(true);
    const res = await post(`/api/approvals/${approval.id}`, { decision: "reject" });
    if (!res.ok) {
      setError(res.error);
      setBusy(false);
    }
  };

  if (!open) return <FoldedDraft title={approval.title} line={new Date(e.start).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })} onOpen={() => setOpen(true)} />;

  return (
    <div className="entry msg-entry mail-card-entry" data-draft-id={action.id}>
      <div className="item">
        <CalendarDays className="msg-ico" />
        <span className="who">Calendar</span>
        <span className="t" title={approval.title}>
          {approval.title}
          <span>{action.draftedBy === "claude" ? "Drafted by Claude" : "Your change"}</span>
        </span>
        <div className="acts">
          {folded && (
            <button className="btn" data-act="open" aria-expanded onClick={() => setOpen(false)}>
              Hide
            </button>
          )}
          <button className="btn" disabled={busy || locked} onClick={() => void decline()}>
            Don't
          </button>
        </div>
      </div>
      <div className="detail msg-card mail-card">
        {action.lastError && <p className="err last-try">Last try failed: {action.lastError}</p>}
        <SendNotes action={action} people={guestsP.people} />
        {create ? (
          <>
            <label className="mail-field">
              <span className="lbl">Calendar</span>
              <select className="mk-input" value={calendarId} disabled={locked} onChange={(x) => (setCalendarId(x.target.value), edited())}>
                {calendars.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </select>
            </label>
            <label className="mail-field">
              <span className="lbl">Title</span>
              <input className="mk-input" value={title} readOnly={locked} onChange={(x) => (setTitle(x.target.value), edited())} />
            </label>
          </>
        ) : (
          <p className="msg-to">
            <span className="lbl">Event</span>
            <b>{e.title || "(no title)"}</b>
            <span className="sep">·</span>
            <span>{eventWhen(e)}</span>
          </p>
        )}
        {action.kind !== "event_cancel" && (
          <div className="mail-times">
            <label className="mail-field">
              <span className="lbl">Starts</span>
              <input className="mk-input" type="datetime-local" value={start} readOnly={locked} onChange={(x) => (setStart(x.target.value), edited())} />
            </label>
            <label className="mail-field">
              <span className="lbl">Ends</span>
              <input className="mk-input" type="datetime-local" value={end} readOnly={locked} onChange={(x) => (setEnd(x.target.value), edited())} />
            </label>
          </div>
        )}
        {timeIssue && <span className="err">{timeIssue}</span>}
        {create && (
          <>
            <label className="mail-field">
              <span className="lbl">Where</span>
              <input className="mk-input" value={location} readOnly={locked} onChange={(x) => (setLocation(x.target.value), edited())} />
            </label>
            <label className="mail-field">
              <span className="lbl">Guests</span>
              <input className="mk-input" value={guests} readOnly={locked} spellCheck={false} placeholder="Optional: name@example.com" onChange={(x) => (setGuests(x.target.value), edited())} />
            </label>
            {guestsP.problem && <span className="err">{guestsP.problem}</span>}
          </>
        )}
        {!create && e.attendees.length > 0 && !mayNotify && (
          <label className="inline">
            <input type="checkbox" checked={notify} disabled={locked} onChange={(x) => (setNotify(x.target.checked), edited())} />
            Tell its {e.attendees.length === 1 ? "guest" : `${e.attendees.length} guests`} ({namesLine(e.attendees)})
          </label>
        )}
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
            <button className="btn p" disabled={!ready || locked} onClick={approve}>
              {label}
            </button>
          )}
          <p className="faint">
            {create
              ? guestsP.people.length
                ? "Invitations go out from the calendar's own account."
                : "No one is invited."
              : mayNotify
                ? "Calendar's server may tell its guests."
                : notify && e.attendees.length
                  ? "Its guests are told."
                  : "No one is told."}
          </p>
        </div>
      </div>
      {(error ?? sendError) && (
        <div className="row-err err" role="alert">
          {error ?? sendError}
        </div>
      )}
    </div>
  );
}
