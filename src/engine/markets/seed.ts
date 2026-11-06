import type { Database } from "bun:sqlite";
import { logActivity } from "../events";
import { getSetting, setSetting } from "../settings";
import { createSpace, listSpaces } from "../spaces";
import { parseInstrumentKey } from "./instrument";
import { addToList, ensureDefaultList, listItems } from "./lists";
import { addToWatchlist, listWatchlist } from "./watchlist";

// Nakul's 14 tickers. Quantities only come from his Wealthsimple holdings import.
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
  { key: "META", name: "Meta Platforms" },
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

export const META_ADDED = "investing.added.META";

// META joined his holdings after the first seed. It goes into the Investing space's first list once; if he
// removes it later, it stays removed. With no Investing space yet, nothing is recorded so a later boot tries again.
export function addMetaOnce(db: Database): "added" | "present" | "no_space" | "done_before" {
  if (getSetting(db, META_ADDED)) return "done_before";
  const space = listSpaces(db).find((s) => s.name === SPACE_NAME && s.kind === "markets" && s.status === "active");
  if (!space) return "no_space";
  const list = ensureDefaultList(db, space.id);
  const had = listItems(db, list.id).some((i) => i.key === "META");
  if (!had) {
    addToList(db, list.id, { symbol: "META", exchange: "US" }, "Meta Platforms");
    logActivity(db, space.id, "atrium", `Added META to your ${list.name} list.`);
  }
  setSetting(db, META_ADDED, new Date().toISOString());
  return had ? "present" : "added";
}

export function addMetaOnBoot(db: Database): void {
  if (process.env.ATRIUM_HOME) return;
  addMetaOnce(db);
}
