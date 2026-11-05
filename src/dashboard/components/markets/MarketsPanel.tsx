import { Radio } from "lucide-react";
import { useState } from "react";
import { useMarkets } from "../../markets";
import { AdviceTag } from "./AdviceTag";
import { Alerts } from "./Alerts";
import { Health } from "./Health";
import { Holdings } from "./Holdings";
import { Paper } from "./Paper";
import { PriceChart } from "./PriceChart";
import { Watchlist } from "./Watchlist";

const TABS = ["overview", "health", "chart", "alerts", "paper"] as const;
type Tab = (typeof TABS)[number];
const TAB_TEXT: Record<Tab, string> = { overview: "Overview", health: "Health", chart: "Chart", alerts: "Alerts", paper: "Paper" };

export function MarketsPanel({ spaceId }: { spaceId: string }) {
  const view = useMarkets(spaceId);
  const [tab, setTab] = useState<Tab>("overview");
  const [chartKey, setChartKey] = useState<string | null>(null);

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
        <span className="mk-advice">
          <AdviceTag />
        </span>
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
      ) : tab === "health" ? (
        <Health spaceId={spaceId} />
      ) : tab === "chart" ? (
        <PriceChart key={chartKey ?? ""} view={view} initialKey={chartKey} />
      ) : tab === "alerts" ? (
        <Alerts view={view} />
      ) : (
        <Paper view={view} />
      )}
    </div>
  );
}
