import type { Database } from "bun:sqlite";
import { logActivity } from "../events";
import { getSetting, setSetting } from "../settings";
import { createSpace, listSpaces } from "../spaces";
import { parseInstrumentKey } from "./instrument";
import { addToWatchlist, listWatchlist } from "./watchlist";

// Nakul's 13 tickers. Quantities only come from his Wealthsimple holdings import.
export const INVESTING_TICKERS: { key: string; name: string }[] = [
  { key: "ATZ.TO", name: "Aritzia" },
  { key: "NOW", name: "ServiceNow" },
  { key: "TSLA", name: "Tesla" },
  { key: "AMZN", name: "Amazon" },
  { key: "MARS", name: "Roundhill Space & Technology ETF" },
  { key: "DRAM", name: "Roundhill Memory ETF" },
  { key: "SPY", name: "SPDR S&P 500 ETF Trust" },
  { key: "VFV.TO", name: "Vanguard S&P 500 Index ETF" },
  { key: "QQQ", name: "Invesco QQQ Trust" },
  { key: "QBTS", name: "D-Wave Quantum" },
  { key: "SOFI", name: "SoFi Technologies" },
  { key: "RKLB", name: "Rocket Lab" },
  { key: "XEQT.TO", name: "iShares Core Equity ETF Portfolio" },
];
const SPACE_NAME = "Investing";
const GOAL = "Long-term TFSA investing: portfolio health, research and ideas.";
const SEEDED = "investing.seeded";

// Idempotent: the existing Investing space is reused and tickers already watched are left as they are.
export function seedInvesting(db: Database): { spaceId: string; created: boolean; added: number } {
  const existing = listSpaces(db).find((s) => s.name === SPACE_NAME && s.kind === "markets" && s.status === "active");
  const space = existing ?? createSpace(db, { name: SPACE_NAME, kind: "markets", goal: GOAL, private: true });
  const before = new Set(listWatchlist(db, space.id).map((w) => w.key));
  let added = 0;
  for (const t of INVESTING_TICKERS) {
    if (before.has(t.key)) continue;
    addToWatchlist(db, space.id, parseInstrumentKey(t.key)!, t.name);
    added++;
  }
  setSetting(db, SEEDED, new Date().toISOString());
  if (added > 0) logActivity(db, space.id, "atrium", `Added your ${added} tickers to the Investing watchlist.`);
  return { spaceId: space.id, created: !existing, added };
}

// Once, ever, on the real DB (no ATRIUM_HOME): removing the tickers or the space later is never undone.
export function seedOnBoot(db: Database): void {
  if (process.env.ATRIUM_HOME || getSetting(db, SEEDED)) return;
  seedInvesting(db);
}
