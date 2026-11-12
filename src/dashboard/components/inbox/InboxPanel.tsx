import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { post } from "../../api";
import { relative } from "../../format";
import { navigate, usePath } from "../../route";
import { type MailOverview, useMailOverview } from "../../mail";
import { CalendarView } from "./CalendarView";
import { InboxList } from "./InboxList";

export type InboxTab = "inbox" | "calendar";

function SyncLine({ overview }: { overview: MailOverview }) {
  const [error, setError] = useState<string | null>(null);
  const problems = overview.accounts.filter((a) => a.preferred && a.enabled && a.lastError).length + (overview.apple.mailProblem ? 1 : 0) + (overview.apple.calendarProblem ? 1 : 0);
  const sync = async () => {
    const res = await post("/api/mail/sync", { force: true });
    setError(res.ok ? null : res.error);
  };
  return (
    <span className="mail-sync" role="status">
      {overview.syncing ? "Syncing…" : overview.syncedAt ? `Synced ${relative(overview.syncedAt)}` : "Not synced yet"}
      {problems > 0 && (
        <button className="btn link subtle" onClick={() => navigate("/settings#accounts")}>
          {problems === 1 ? "1 source needs attention" : `${problems} sources need attention`}
        </button>
      )}
      <button className="btn" onClick={() => void sync()} disabled={overview.syncing} aria-label="Sync mail and calendar now">
        <RefreshCw />
        Sync
      </button>
      {error && <span className="err">{error}</span>}
    </span>
  );
}

// The Inbox space's own view: the unified Inbox and the merged Calendar. Opening it asks for a sync (the engine
// skips it if one ran in the last minute).
export function InboxPanel({ spaceId }: { spaceId: string }) {
  // `?tab=calendar` opens the Calendar; the space's Tasks and Files tabs read their own values.
  const tab: InboxTab = new URLSearchParams(usePath().split("?")[1] ?? "").get("tab") === "calendar" ? "calendar" : "inbox";
  const overview = useMailOverview();
  useEffect(() => {
    void post("/api/mail/sync", {});
  }, [tab]);
  const go = (t: InboxTab) => navigate(`/space/${encodeURIComponent(spaceId)}${t === "calendar" ? "?tab=calendar" : ""}`);
  const connected = overview && (overview.accounts.length > 0 || overview.apple.mail || overview.apple.calendar);

  return (
    <div className="inbox-panel">
      <div className="mk-head">
        <div className="inv-tabs" role="tablist" aria-label="Inbox views">
          {(["inbox", "calendar"] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => go(t)}>
              {t === "inbox" ? "Inbox" : "Calendar"}
            </button>
          ))}
        </div>
        {overview && connected && <SyncLine overview={overview} />}
      </div>
      {!overview ? (
        <div className="empty-row mail-empty">Loading your mail…</div>
      ) : !connected ? (
        <div className="list">
          <div className="empty-row mail-empty">
            <p>No mail or calendar connected yet.</p>
            <p className="hint">Connect Google, or let Atrium read Apple Mail and Calendar on this Mac. Everything stays on this Mac and only goes to Claude.</p>
            <button className="btn p" onClick={() => navigate("/settings#accounts")}>
              Connect an account
            </button>
          </div>
        </div>
      ) : tab === "calendar" ? (
        <CalendarView overview={overview} />
      ) : (
        <InboxList overview={overview} />
      )}
    </div>
  );
}
