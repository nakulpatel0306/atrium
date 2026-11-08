import type { Database } from "bun:sqlite";
import { setupInvesting } from "../../../src/engine/markets/setup";
import { parseInstrumentKey } from "../../../src/engine/markets/instrument";
import { addToWatchlist } from "../../../src/engine/markets/watchlist";

// Public symbols used as test data: a mix of US and TSX stocks and ETFs, including ones the fund fixtures cover.
export const DEMO_TICKERS: { key: string; name: string }[] = [
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
  { key: "META", name: "Meta Platforms" },
];

// An Investing space with every demo ticker on its watchlist.
export function seedDemoInvesting(db: Database): { spaceId: string } {
  const { spaceId } = setupInvesting(db);
  for (const t of DEMO_TICKERS) addToWatchlist(db, spaceId, parseInstrumentKey(t.key)!, t.name);
  return { spaceId };
}
