import { Send } from "lucide-react";
import { useEffect, useState } from "react";
import { cancelSend, SEND_DELAY_MS, usePendingSends } from "../pending-send";

// Every text waiting out its window, each with its own Undo. It has no close button and nothing else shows here,
// so no other message can push a send's Undo off the screen.
export function SendTray() {
  const sends = usePendingSends();
  const [now, setNow] = useState(() => Date.now());
  const waiting = sends.length > 0;
  // Ticks the countdown only while something waits.
  useEffect(() => {
    if (!waiting) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [waiting]);
  if (!waiting) return null;
  return (
    <section className="send-tray" aria-label="Texts waiting to send">
      {sends.map((p) => {
        const left = Math.max(0, Math.ceil((p.startedAt + SEND_DELAY_MS - now) / 1000));
        return (
          <div className="send-row" key={p.id}>
            <Send />
            <span className="t">
              {p.sending ? `Sending to ${p.name}…` : `Sending to ${p.name} in ${left}s…`}
            </span>
            {!p.sending && (
              <button className="btn" onClick={() => cancelSend(p.id)}>
                Undo
              </button>
            )}
          </div>
        );
      })}
    </section>
  );
}
