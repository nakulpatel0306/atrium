import { useEffect, useRef, useState } from "react";
import { del, patch, put } from "../api";
import { relative } from "../format";
import { type MailOverview, sourceLabel, useMailOverview } from "../mail";
import { ACCOUNT_COLORS } from "../../engine/mail/colors";
import { AppleSource, GoogleConnect } from "./MailSources";

type Account = MailOverview["accounts"][number];

function AccountRow({ a, sibling }: { a: Account; sibling: Account | undefined }) {
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const change = async (body: Record<string, unknown>) => {
    const res = await patch(`/api/mail/accounts/${encodeURIComponent(a.id)}`, body);
    setError(res.ok ? null : res.error);
  };
  const disconnect = async () => {
    const res = await del(`/api/mail/accounts/${encodeURIComponent(a.id)}`);
    setConfirm(false);
    setError(res.ok ? null : res.error);
  };
  const status = a.status === "signed_out" ? "Signed out" : a.lastError ? "Couldn't sync" : a.syncedAt ? `Synced ${relative(a.syncedAt)}` : "Not synced yet";
  return (
    <div className="entry">
      <div className="item acct-row">
        <label className="acct-color" title="Colour">
          <span className="acct-dot" style={{ background: a.color }} aria-hidden />
          <select className="sr-select" aria-label={`Colour for ${a.address}`} value={a.color} onChange={(e) => void change({ color: e.target.value })}>
            {ACCOUNT_COLORS.map((c, i) => (
              <option key={c} value={c}>
                Colour {i + 1}
              </option>
            ))}
          </select>
        </label>
        <span className="t">
          {a.address}
          <span>
            {sourceLabel(a.source)}
            {a.preferred ? "" : " · not used"} · {status}
          </span>
        </span>
        <div className="acts">
          {sibling && !a.preferred && (
            <button className="btn" onClick={() => void change({ preferred: true })}>
              Read through {sourceLabel(a.source)}
            </button>
          )}
          {a.preferred && (
            <button className="toggle" role="switch" aria-checked={a.enabled} aria-label={`Show ${a.address}`} onClick={() => void change({ enabled: !a.enabled })}>
              <span className="switch" />
              {a.enabled ? "Shown" : "Hidden"}
            </button>
          )}
          {a.source === "google" &&
            (confirm ? (
              <>
                <button className="btn" onClick={() => setConfirm(false)}>
                  Cancel
                </button>
                <button className="btn danger" onClick={() => void disconnect()}>
                  Disconnect
                </button>
              </>
            ) : (
              <button className="btn" onClick={() => setConfirm(true)}>
                Disconnect…
              </button>
            ))}
        </div>
      </div>
      {confirm && <div className="row-err hint">Atrium forgets this account's sign-in and removes its cached mail and calendars from this Mac. Nothing changes in Gmail.</div>}
      {(error || a.lastError) && <div className="row-err err">{error ?? a.lastError}</div>}
    </div>
  );
}

const WINDOWS = {
  mailDays: { label: "Mail from the last", options: [7, 14, 30, 60, 90], unit: "days" },
  calBack: { label: "Calendar back", options: [7, 14, 30, 60], unit: "days" },
  calAhead: { label: "Calendar ahead", options: [30, 60, 90, 180], unit: "days" },
} as const;

// Settings → Accounts: each address once per source, which source it's read through, its colour, and the sources.
export function AccountsSettings() {
  const overview = useMailOverview();
  const ref = useRef<HTMLHeadingElement>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (overview && location.hash === "#accounts") ref.current?.scrollIntoView({ block: "start" });
  }, [overview !== null]);
  if (!overview) return null;
  const { accounts } = overview;
  const setWindow = async (key: keyof typeof WINDOWS, value: number) => {
    const res = await put("/api/mail/settings", { [key]: value });
    setError(res.ok ? null : res.error);
  };
  const setCalendar = async (id: string, enabled: boolean) => {
    const res = await patch(`/api/mail/calendars/${encodeURIComponent(id)}`, { enabled });
    setError(res.ok ? null : res.error);
  };
  return (
    <>
      <h2 id="accounts" ref={ref}>
        Accounts
      </h2>
      <p className="brief">Mail and calendar, read on this Mac and shown in the Inbox space. An address you reach through both Google and Mail.app is read once, through the source you pick. Atrium never sends anything without your yes.</p>
      {accounts.length > 0 && (
        <div className="list">
          {accounts.map((a) => (
            <AccountRow key={a.id} a={a} sibling={accounts.find((x) => x.address === a.address && x.id !== a.id)} />
          ))}
        </div>
      )}
      <GoogleConnect overview={overview} />
      <AppleSource what="mail" overview={overview} />
      <AppleSource what="calendar" overview={overview} />
      {overview.calendars.length > 0 && (
        <>
          <h2>Calendars</h2>
          <div className="list">
            {overview.calendars.map((c) => (
              <div key={c.id} className="item">
                <span className="cal-dot" style={{ background: c.color }} aria-hidden />
                <span className="t">
                  {c.title}
                  <span>
                    {c.source === "apple" ? "Calendar.app" : "Google"}
                    {c.hidden ? ` · ${c.hidden}` : ""}
                  </span>
                </span>
                <button className="toggle" role="switch" aria-checked={c.enabled} aria-label={`Show ${c.title}`} disabled={!!c.hidden} onClick={() => void setCalendar(c.id, !c.enabled)}>
                  <span className="switch" />
                  {c.enabled ? "Shown" : "Hidden"}
                </button>
              </div>
            ))}
          </div>
        </>
      )}
      <div className="mk-form mail-windows">
        {(Object.keys(WINDOWS) as (keyof typeof WINDOWS)[]).map((k) => (
          <label key={k}>
            {WINDOWS[k].label}
            <select className="pick" value={overview.settings[k]} onChange={(e) => void setWindow(k, Number(e.target.value))}>
              {[...new Set([...WINDOWS[k].options, overview.settings[k]])]
                .sort((x, y) => x - y)
                .map((n) => (
                  <option key={n} value={n}>
                    {n} {WINDOWS[k].unit}
                  </option>
                ))}
            </select>
          </label>
        ))}
      </div>
      {error && <p className="err">{error}</p>}
    </>
  );
}
