import { Radio } from "lucide-react";
import { useState } from "react";
import { useMarkets } from "../../markets";
import { AdviceTag } from "../markets/AdviceTag";
import { AdvancedPanel, type AdvancedTab } from "../markets/MarketsPanel";
import { usePortfolio, useEarnings } from "../../simple";
import { AdvancedToggle } from "./AdvancedToggle";
import { AlertsSimple } from "./AlertsSimple";
import { Earnings } from "./Earnings";
import { Portfolio } from "./Portfolio";

const SIMPLE = ["portfolio", "watchlists", "earnings", "alerts"] as const;
const ADVANCED: AdvancedTab[] = ["health", "ideas", "chart", "paper"];
export type InvestTab = (typeof SIMPLE)[number] | AdvancedTab;
const TEXT: Record<InvestTab, string> = {
  portfolio: "Portfolio",
  watchlists: "Watchlists",
  earnings: "Earnings",
  alerts: "Alerts",
  health: "Health",
  ideas: "Ideas",
  chart: "Chart",
  paper: "Paper",
};

export function InvestTabs({ advanced, tab, onTab }: { spaceId: string; advanced: boolean; tab: InvestTab; onTab: (t: InvestTab) => void }) {
  const button = (t: InvestTab) => (
    <button key={t} role="tab" aria-selected={tab === t} aria-pressed={tab === t} onClick={() => onTab(t)}>
      {TEXT[t]}
    </button>
  );
  return (
    <div className="inv-tabs" role="tablist">
      {SIMPLE.map(button)}
      {advanced && <span className="inv-tabs-div" aria-hidden />}
      {advanced && ADVANCED.map(button)}
    </div>
  );
}

export function InvestPanel({ spaceId, symbol }: { spaceId: string; symbol: string | null }) {
  const view = useMarkets(spaceId);
  const [picked, setTab] = useState<InvestTab>("portfolio");
  const advanced = view?.advanced ?? false;
  // An Advanced tab left open falls back to Portfolio once Advanced is off.
  const tab = !advanced && ADVANCED.includes(picked as AdvancedTab) ? "portfolio" : picked;

  return (
    <div className="markets invest">
      <div className="mk-head inv-head">
        {symbol ? <span /> : <InvestTabs spaceId={spaceId} advanced={advanced} tab={tab} onTab={setTab} />}
        <span className="inv-head-right">
          {view && (
            <span className={`feedline ${view.feed.mode}`} title={view.feed.streamError ?? view.feed.reason}>
              <Radio />
              {view.feed.reason}
            </span>
          )}
          <AdviceTag />
          <AdvancedToggle spaceId={spaceId} on={advanced} />
        </span>
      </div>
      {symbol ? (
        <div className="list">
          <div className="empty-row">Loading {symbol}…</div>
        </div>
      ) : ADVANCED.includes(tab as AdvancedTab) ? (
        <AdvancedPanel spaceId={spaceId} tab={tab as AdvancedTab} view={view} />
      ) : tab === "portfolio" ? (
        <PortfolioTab spaceId={spaceId} />
      ) : tab === "earnings" ? (
        <EarningsTab spaceId={spaceId} />
      ) : tab === "alerts" ? (
        view ? <AlertsSimple spaceId={spaceId} alerts={view.alerts} advanced={advanced} /> : <Loading />
      ) : (
        <Loading />
      )}
    </div>
  );
}

function Loading() {
  return <div className="inv-loading">Loading…</div>;
}

function PortfolioTab({ spaceId }: { spaceId: string }) {
  const view = usePortfolio(spaceId);
  return view ? <Portfolio spaceId={spaceId} view={view} /> : <Loading />;
}

function EarningsTab({ spaceId }: { spaceId: string }) {
  const view = useEarnings(spaceId);
  return view ? <Earnings spaceId={spaceId} view={view} /> : <Loading />;
}
