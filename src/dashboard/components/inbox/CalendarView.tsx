import { CalendarPlus, ChevronLeft, ChevronRight, MapPin, Repeat } from "lucide-react";
import { useMemo, useState } from "react";
import { post, useEngineState } from "../../api";
import { clock } from "../../format";
import { DraftCard } from "./DraftCard";
import { Rsvp } from "./Rsvp";
import { addDays, agenda, type EventView, type MailOverview, overlaps, placeDay, startOfDay, startOfWeek, useEvents } from "../../mail";

const HOUR_PX = 40;
const STATUS: Record<string, string> = { accepted: "Going", declined: "Declined", tentative: "Maybe", needs_action: "Not answered" };

function when(e: EventView): string {
  if (e.allDay) return "All day";
  return `${clock(e.start)} – ${clock(e.end)}`;
}

// Move or cancel opens a card first; nothing changes until its own button and Undo window.
function OwnActions({ e }: { e: EventView }) {
  const [error, setError] = useState<string | null>(null);
  const draft = async (kind: "event_move" | "event_cancel") => {
    const res = await post("/api/mail/event-drafts", { kind, eventId: e.id });
    setError(res.ok ? null : res.error);
  };
  return (
    <span className="cal-own">
      <button className="btn link subtle" onClick={() => void draft("event_move")}>
        Move
      </button>
      <button className="btn link subtle" onClick={() => void draft("event_cancel")}>
        Cancel event
      </button>
      {error && <span className="err">{error}</span>}
    </span>
  );
}

function AgendaRow({ e, clash, own }: { e: EventView; clash: boolean; own: Set<string> }) {
  const invited = e.myStatus !== null && !!e.organizer && !own.has(e.organizer);
  const mine = (!e.organizer || own.has(e.organizer)) && !e.recurring;
  return (
    <div className="item cal-row">
      <span className="cal-dot" style={{ background: e.calendar.color }} title={e.calendar.title} aria-hidden />
      <span className="cal-when">{when(e)}</span>
      <span className="t">
        {e.title || "(no title)"}
        <span>
          {e.calendar.title}
          {e.location && (
            <>
              {" · "}
              <MapPin aria-hidden className="inline-ic" />
              {e.location}
            </>
          )}
        </span>
      </span>
      {e.recurring && <Repeat aria-label="Repeats" className="faint-ic" />}
      {e.myStatus && e.myStatus !== "accepted" && <span className="tag">{STATUS[e.myStatus]}</span>}
      {clash && <span className="tag bad">Overlaps</span>}
      {mine && <OwnActions e={e} />}
      {invited && <Rsvp e={e} />}
    </div>
  );
}

function Agenda({ now, own }: { now: number; own: Set<string> }) {
  const from = startOfDay(now);
  const events = useEvents(from, addDays(from, 7));
  const clashes = useMemo(() => overlaps(events ?? []), [events]);
  if (!events) return <div className="empty-row">Loading…</div>;
  return (
    <div className="cal-agenda">
      {agenda(events, now).map((g) => (
        <section key={g.day} aria-label={g.label}>
          <h3 className="cal-day">{g.label}</h3>
          <div className="list">{g.events.length ? g.events.map((e) => <AgendaRow key={e.id} e={e} clash={clashes.has(e.id)} own={own} />) : <div className="empty-row">Nothing scheduled.</div>}</div>
        </section>
      ))}
    </div>
  );
}

// A plain week grid, Monday first. Hours span the week's earliest start to its latest end (at least 8 to 18), and
// overlapping events share their column side by side.
function WeekGrid({ now }: { now: number }) {
  const [week, setWeek] = useState(() => startOfWeek(now));
  const events = useEvents(week, addDays(week, 7));
  const days = Array.from({ length: 7 }, (_, i) => addDays(week, i));
  const timed = (events ?? []).filter((e) => !e.allDay);
  const firstHour = Math.min(8, ...timed.map((e) => new Date(Math.max(e.start, week)).getHours()));
  const lastHour = Math.max(18, ...timed.map((e) => Math.min(24, new Date(e.end).getHours() + (new Date(e.end).getMinutes() ? 1 : 0))));
  const hours = Array.from({ length: lastHour - firstHour }, (_, i) => firstHour + i);
  const label = `${new Date(week).toLocaleDateString([], { month: "short", day: "numeric" })} – ${new Date(addDays(week, 6)).toLocaleDateString([], { month: "short", day: "numeric" })}`;

  return (
    <section className="cal-week" aria-label={`Week of ${label}`}>
      <div className="cal-week-head">
        <h3 className="cal-day">{label}</h3>
        <button className="btn" onClick={() => setWeek(addDays(week, -7))} aria-label="Previous week">
          <ChevronLeft />
        </button>
        <button className="btn" onClick={() => setWeek(startOfWeek(now))} disabled={week === startOfWeek(now)}>
          This week
        </button>
        <button className="btn" onClick={() => setWeek(addDays(week, 7))} aria-label="Next week">
          <ChevronRight />
        </button>
      </div>
      <div className="cal-grid" style={{ "--hours": hours.length, "--hour": `${HOUR_PX}px` } as React.CSSProperties}>
        <div className="cal-gutter" aria-hidden>
          <div className="cal-col-head" />
          <div className="cal-allday-cell" />
          {hours.map((h) => (
            <div key={h} className="cal-hour-label">
              {new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: "numeric" })}
            </div>
          ))}
        </div>
        {days.map((day) => {
          const next = addDays(day, 1);
          const todays = (events ?? []).filter((e) => e.start < next && e.end > day);
          const isToday = day === startOfDay(now);
          return (
            <div key={day} className={`cal-col${isToday ? " today" : ""}`}>
              <div className="cal-col-head">{new Date(day).toLocaleDateString([], { weekday: "short", day: "numeric" })}</div>
              <div className="cal-allday-cell">
                {todays
                  .filter((e) => e.allDay)
                  .map((e) => (
                    <div key={e.id} className="cal-allday" style={{ "--c": e.calendar.color } as React.CSSProperties} title={`${e.title} · ${e.calendar.title}`}>
                      {e.title || "(no title)"}
                    </div>
                  ))}
              </div>
              <div className="cal-body">
                {placeDay(todays).map(({ event: e, col, cols }) => {
                  const start = Math.max(e.start, day);
                  const end = Math.min(e.end, next);
                  const top = ((start - day) / 3600_000 - firstHour) * HOUR_PX;
                  const height = Math.max(18, ((end - start) / 3600_000) * HOUR_PX - 2);
                  return (
                    <div
                      key={e.id}
                      // A short or narrow block keeps just its title; the time is in its tooltip and the agenda.
                      className={`cal-ev${cols > 1 ? " clash" : ""}${height < 34 || cols > 2 ? " short" : ""}`}
                      style={{ top, height, left: `${(col / cols) * 100}%`, width: `calc(${100 / cols}% - 2px)`, "--c": e.calendar.color } as React.CSSProperties}
                      title={`${e.title} · ${when(e)} · ${e.calendar.title}`}
                    >
                      <b>{e.title || "(no title)"}</b>
                      <span>{clock(e.start)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// Every calendar merged, coloured by calendar: the agenda for the next seven days, then the week.
export function CalendarView({ overview }: { overview: MailOverview }) {
  const now = Date.now();
  const shown = overview.calendars.filter((c) => c.enabled && !c.hidden);
  const own = new Set(overview.accounts.map((a) => a.address));
  const state = useEngineState();
  const drafts = (state?.mailActions ?? []).filter((m) => m.event);
  const [error, setError] = useState<string | null>(null);
  const newEvent = async () => {
    const res = await post("/api/mail/event-drafts", { kind: "event_create" });
    setError(res.ok ? null : res.error);
  };
  return (
    <div className="calendar">
      <div className="cal-tools">
        <button className="btn" onClick={() => void newEvent()} disabled={!shown.some((c) => c.writable)}>
          <CalendarPlus />
          New event
        </button>
        {error && <span className="err">{error}</span>}
      </div>
      {drafts.map((d) => {
        const approval = state?.approvals.find((a) => a.id === d.approvalId);
        return approval ? <DraftCard key={d.id} approval={approval} action={d} /> : null;
      })}
      {shown.length > 0 && (
        <ul className="cal-legend" aria-label="Calendars">
          {shown.map((c) => (
            <li key={c.id}>
              <span className="cal-dot" style={{ background: c.color }} aria-hidden />
              {c.title}
            </li>
          ))}
        </ul>
      )}
      <Agenda now={now} own={own} />
      <WeekGrid now={now} />
    </div>
  );
}
