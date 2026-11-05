import { Minus, Plus, X } from "lucide-react";
import { useState } from "react";
import { del, post, put } from "../../api";
import { money } from "../../format";
import { useTfsa } from "../../investing";

// Contribution room from the numbers Nakul types in; CRA's figure can't be fetched.
export function TfsaCard() {
  const year = new Date().getFullYear();
  const t = useTfsa(year);
  const [room, setRoom] = useState("");
  const [entry, setEntry] = useState({ date: new Date().toISOString().slice(0, 10), amount: "" });
  const [error, setError] = useState<string | null>(null);
  const result = (res: { ok: boolean; error?: string }) => setError(res.ok ? null : (res.error ?? null));
  const add = async (kind: "contribution" | "withdrawal") => {
    const res = await post("/api/investing/tfsa/entries", { date: entry.date, kind, amount: Number(entry.amount) });
    result(res as { ok: boolean; error?: string });
    if (res.ok) setEntry({ ...entry, amount: "" });
  };

  return (
    <section>
      <h2>TFSA room {year}</h2>
      <div className="list">
        <div className={`item tfsa-line${t && t.over > 0 ? " over" : ""}`}>
          <span className="t">
            <b>{t?.text ?? "Loading…"}</b>
            {t && t.roomJan1 !== null && (
              <span>
                Room on Jan 1 {money(t.roomJan1, "CAD")} · contributed {money(t.contributed, "CAD")} · withdrawn {money(t.withdrawn, "CAD")}
                {t.addsBackNextYear > 0 ? ` (comes back as room on Jan 1, ${year + 1})` : ""}
              </span>
            )}
          </span>
          <span className="fresh live" title="Entered by you">
            Entered by you
          </span>
        </div>
        <form
          className="mk-form tfsa-form"
          onSubmit={(e) => {
            e.preventDefault();
            void put("/api/investing/tfsa/room", { year, roomJan1: Number(room) }).then((r) => {
              result(r as { ok: boolean; error?: string });
              if (r.ok) setRoom("");
            });
          }}
        >
          <label>
            Room on Jan 1 (from CRA My Account)
            <input className="mk-input" value={room} onChange={(e) => setRoom(e.target.value)} inputMode="decimal" placeholder="7000.00" />
          </label>
          <button className="btn" type="submit" disabled={!room.trim()}>
            Save room
          </button>
          <label>
            Date
            <input className="mk-input" type="date" value={entry.date} onChange={(e) => setEntry({ ...entry, date: e.target.value })} />
          </label>
          <label>
            Amount (CA$)
            <input className="mk-input" value={entry.amount} onChange={(e) => setEntry({ ...entry, amount: e.target.value })} inputMode="decimal" />
          </label>
          <button className="btn" type="button" disabled={!entry.amount.trim()} onClick={() => void add("contribution")}>
            <Plus />
            Contribution
          </button>
          <button className="btn" type="button" disabled={!entry.amount.trim()} onClick={() => void add("withdrawal")}>
            <Minus />
            Withdrawal
          </button>
          {error && <span className="err">{error}</span>}
        </form>
        {t?.entries.map((e) => (
          <div key={e.id} className="item mk-row">
            <span className="sym">{e.date}</span>
            <span className="t">{e.kind === "contribution" ? "Contribution" : "Withdrawal"}</span>
            <span className={`num${e.kind === "withdrawal" ? " faint" : ""}`}>{e.kind === "withdrawal" ? money(-e.amount, "CAD") : money(e.amount, "CAD")}</span>
            <button className="icon-btn" title="Remove this entry" aria-label="Remove this entry" onClick={() => void del(`/api/investing/tfsa/entries/${e.id}`)}>
              <X />
            </button>
          </div>
        ))}
        <div className="empty-row">Over-contributing costs 1% a month on the excess. Withdrawals only add room back on January 1 of the next year.</div>
      </div>
    </section>
  );
}
