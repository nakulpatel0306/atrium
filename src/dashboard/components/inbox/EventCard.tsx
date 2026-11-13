import { useState } from "react";
import { namesLine, parseRecipients, type Recipient } from "../../../engine/mail/compose";
import type { State } from "../../api";
import { useMailOverview } from "../../mail";
import { clearSendError, pendingSendOf, startSend, usePendingSend } from "../../pending-send";
import { DraftShell, type MailActionView, peopleText } from "./DraftShell";

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

// A calendar change waiting on the user: a new event (and its invites), or a move or cancellation of a Google event he
// organises. Its button goes through the same Sending… tray and Undo as an email.
export function EventCard({ approval, action, folded = false }: { approval: Approval; action: MailActionView; folded?: boolean }) {
  const overview = useMailOverview();
  const e = action.event!;
  const h = pendingSendOf(action.id)?.body as Partial<Record<string, unknown>> | undefined;
  const locked = usePendingSend(action.id) !== null;
  const [calendarId, setCalendarId] = useState((h?.calendarId as string) ?? e.calendarId);
  const [title, setTitle] = useState((h?.title as string) ?? e.title);
  const [start, setStart] = useState(toLocalInput((h?.start as number) ?? e.start));
  const [end, setEnd] = useState(toLocalInput((h?.end as number) ?? e.end));
  const [location, setLocation] = useState((h?.location as string) ?? e.location);
  const [guests, setGuests] = useState(h ? peopleText(h.attendees as Recipient[]) : peopleText(e.attendees));
  const [notify, setNotify] = useState((h?.notify as boolean | undefined) ?? e.notify);

  const create = action.kind === "event_create";
  const guestsP = parseRecipients(guests);
  const s = fromLocalInput(start);
  const en = fromLocalInput(end);
  const timeIssue = action.kind !== "event_cancel" && !(en > s) ? "The event has to end after it starts." : null;
  const calendars = (overview?.calendars ?? []).filter((c) => c.enabled && !c.hidden && c.writable);
  // Said before the press: Calendar.app can't invite people for another app.
  const noGuestsHere = create && guestsP.people.length > 0 && calendars.find((c) => c.id === calendarId)?.source === "apple";
  const ready = !locked && !timeIssue && !guestsP.problem && (!create || !!title.trim()) && !noGuestsHere;
  const edited = (fn: () => void) => {
    fn();
    clearSendError(action.id);
  };
  const name = create ? (guestsP.people.length ? namesLine(guestsP.people) : `"${title.trim()}"`) : `"${e.title}"`;
  const primary = {
    label: create && guestsP.people.length ? "Create and invite" : ACT[action.kind]!,
    disabled: !ready,
    onPress: () => startSend(action.id, name, { calendarId, title, start: s, end: en, allDay: e.allDay, location, attendees: guestsP.people, notify, seen: action.reasons.map((r) => r.key) }, `/api/mail/actions/${action.id}/send`),
  };

  return (
    <DraftShell approval={approval} action={action} folded={folded} people={guestsP.people} primary={primary} error={null}>
      {create ? (
        <>
          <label className="mail-field">
            <span className="lbl">Calendar</span>
            <select className="mk-input" value={calendarId} disabled={locked} onChange={(x) => edited(() => setCalendarId(x.target.value))}>
              {calendars.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </select>
          </label>
          <label className="mail-field">
            <span className="lbl">Title</span>
            <input className="mk-input" value={title} readOnly={locked} onChange={(x) => edited(() => setTitle(x.target.value))} />
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
            <input className="mk-input" type="datetime-local" value={start} readOnly={locked} onChange={(x) => edited(() => setStart(x.target.value))} />
          </label>
          <label className="mail-field">
            <span className="lbl">Ends</span>
            <input className="mk-input" type="datetime-local" value={end} readOnly={locked} onChange={(x) => edited(() => setEnd(x.target.value))} />
          </label>
        </div>
      )}
      {timeIssue && <span className="err">{timeIssue}</span>}
      {create && (
        <>
          <label className="mail-field">
            <span className="lbl">Where</span>
            <input className="mk-input" value={location} readOnly={locked} onChange={(x) => edited(() => setLocation(x.target.value))} />
          </label>
          <label className="mail-field">
            <span className="lbl">Guests</span>
            <input className="mk-input" value={guests} readOnly={locked} spellCheck={false} placeholder="Optional: name@example.com" onChange={(x) => edited(() => setGuests(x.target.value))} />
          </label>
          {guestsP.problem && <span className="err">{guestsP.problem}</span>}
          {noGuestsHere && <span className="err">Calendar.app can't invite people for Atrium. Pick a Google calendar, or leave Guests empty.</span>}
        </>
      )}
      {!create && e.attendees.length > 0 && (
        <label className="inline">
          <input type="checkbox" checked={notify} disabled={locked} onChange={(x) => edited(() => setNotify(x.target.checked))} />
          Tell its {e.attendees.length === 1 ? "guest" : `${e.attendees.length} guests`} ({namesLine(e.attendees)})
        </label>
      )}
    </DraftShell>
  );
}
