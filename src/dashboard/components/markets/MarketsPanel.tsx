import { Radio } from "lucide-react";
import { useState } from "react";
import { useMarkets } from "../../markets";
import { Holdings } from "./Holdings";
import { Watchlist } from "./Watchlist";

const TABS = ["overview", "chart", "alerts", "paper"] as const;
type Tab = (typeof TABS)[number];
const TAB_TEXT: Record<Tab, string> = { overview: "Overview", chart: "Chart", alerts: "Alerts", paper: "Paper" };

export function MarketsPanel({ spaceId }: { spaceId: string }) {
  const view = useMarkets(spaceId);
  const [tab, setTab] = useState<Tab>("overview");
  const [, setChartKey] = useState<string | null>(null);

  return (
    <div className="markets">
      <div className="mk-head">
        <div className="seg" role="tablist">
          {TABS.map((t) => (
            <button key={t} role="tab" aria-pressed={tab === t} aria-selected={tab === t} onClick={() => setTab(t)}>
              {TAB_TEXT[t]}
            </button>
          ))}
        </div>
        {view && (
          <span className={`feedline ${view.feed.mode}`} title={view.feed.streamError ?? view.feed.reason}>
            <Radio />
            {view.feed.reason}
            {view.feed.streamError && <span className="faint"> · {view.feed.streamError}</span>}
          </span>
        )}
      </div>
      {!view ? (
        <div className="list">
          <div className="empty-row">Loading prices…</div>
        </div>
      ) : tab === "overview" ? (
        <>
          <Watchlist
            view={view}
            onOpen={(key) => {
              setChartKey(key);
              setTab("chart");
            }}
          />
          <Holdings view={view} />
        </>
      ) : (
        <div className="list">
          <div className="empty-row">Coming next.</div>
        </div>
      )}
    </div>
  );
}
