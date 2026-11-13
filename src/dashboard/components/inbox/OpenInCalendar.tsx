import { useState } from "react";
import { post } from "../../api";

// A Calendar.app event is changed or answered in Calendar itself; this opens it there.
export function OpenInCalendar({ eventId }: { eventId: string }) {
  const [error, setError] = useState<string | null>(null);
  const open = async () => {
    const res = await post(`/api/mail/events/${encodeURIComponent(eventId)}/open-in-calendar`);
    setError(res.ok ? null : res.error);
  };
  return (
    <span className="cal-own">
      <button className="btn link subtle" onClick={() => void open()}>
        Open in Calendar
      </button>
      {error && <span className="err">{error}</span>}
    </span>
  );
}
