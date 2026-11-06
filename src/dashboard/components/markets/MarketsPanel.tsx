import { useState } from "react";
import type { MarketsView } from "../../markets";
import { Health } from "./Health";
import { Ideas } from "./Ideas";
import { Research } from "./Research";
import { Paper } from "./Paper";
import { PriceChart } from "./PriceChart";

export type AdvancedTab = "health" | "ideas" | "chart" | "paper";

// Plan 7's tools, unchanged, behind the investing space's Advanced switch. Paper includes its strategies.
export function AdvancedPanel({ spaceId, tab, view }: { spaceId: string; tab: AdvancedTab; view: MarketsView | null }) {
  const [researchKey, setResearchKey] = useState<string | null>(null);
  if (!view) {
    return (
      <div className="list">
        <div className="empty-row">Loading prices…</div>
      </div>
    );
  }
  if (researchKey) {
    return (
      <>
        <button className="btn link inv-back" onClick={() => setResearchKey(null)}>
          ← Back to ideas
        </button>
        <Research key={researchKey} spaceId={spaceId} view={view} initialKey={researchKey} />
      </>
    );
  }
  if (tab === "health") return <Health spaceId={spaceId} />;
  if (tab === "ideas") return <Ideas spaceId={spaceId} onOpen={setResearchKey} />;
  if (tab === "chart") return <PriceChart view={view} initialKey={null} />;
  return <Paper view={view} />;
}
