#!/usr/bin/env bun
// Dev only: fills a throwaway ATRIUM_HOME with the investing fixtures (fund files, USD/CAD, demo holdings for the
// Investing space, closes, earnings, news and a digest) so the dashboard can be screenshotted offline.
// Usage: ATRIUM_HOME=<temp dir> bun scripts/load-investing-fixtures.ts
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { openDb } from "../src/engine/db";
import { setSetting } from "../src/engine/settings";
import { recordCloses } from "../src/engine/markets/closes";
import { saveEarnings, saveNews } from "../src/engine/markets/events";
import { ndxEstimate, parseNdxMembers } from "../src/engine/markets/funds/nasdaq100";
import { parseIshares } from "../src/engine/markets/funds/parse-ishares";
import { parseRoundhill } from "../src/engine/markets/funds/parse-roundhill";
import { parseSsga } from "../src/engine/markets/funds/parse-ssga";
import { saveFundFile } from "../src/engine/markets/funds/store";
import { fetchUsdCad, saveFx } from "../src/engine/markets/fx";
import { addHolding } from "../src/engine/markets/holdings";
import { parseInstrumentKey } from "../src/engine/markets/instrument";
import { metaFromFunds } from "../src/engine/markets/meta";
import { demoProvider } from "../src/engine/markets/providers/demo";
import { saveNotes, saveWriteup } from "../src/engine/markets/research";
import { INVESTING_TICKERS, seedInvesting } from "../src/engine/markets/seed";

if (!process.env.ATRIUM_HOME) throw new Error("Set ATRIUM_HOME to a temp dir; this script never touches the real data.");
const DIR = resolve(import.meta.dir, "../tests/fixtures/markets/investing");
const text = (f: string) => readFileSync(join(DIR, f), "utf8");
const now = Date.parse(process.env.ATRIUM_MARKET_NOW ?? "2026-11-04T15:00:00-05:00");

const db = openDb();
setSetting(db, "markets.provider", "demo");

const TICKERS: [string, string][] = INVESTING_TICKERS.map((t) => [t.key, t.name]);
const space = { id: seedInvesting(db).spaceId };

// Made-up positions (demo data), shaped like a TFSA with these 14 holdings: [market value, book value], listing currency.
const SIZE: Record<string, [number, number]> = {
  "ATZ.TO": [2600, 2400], NOW: [2500, 2300], TSLA: [1800, 1500], AMZN: [2000, 1700], MARS: [900, 900], DRAM: [1000, 800], SPY: [4600, 4100],
  "VFV.TO": [4700, 4200], QQQ: [3200, 2900], QBTS: [700, 1100], SOFI: [1300, 1200], RKLB: [1900, 1400], "XEQT.TO": [5200, 4500], META: [2500, 2200],
};
const demoNow = demoProvider({ now: () => now });
for (const [key, name] of TICKERS) {
  const i = parseInstrumentKey(key)!;
  const [target, book] = SIZE[key]!;
  const [q] = await demoNow.quotes([i]);
  const quantity = Math.max(1, Math.round((target / q!.price) * 100) / 100);
  const cad = i.exchange === "US" ? "USD" : "CAD";
  addHolding(db, space.id, { account: "TFSA", symbol: i.symbol, exchange: i.exchange, name, quantity, bookValue: book, bookValueCad: cad === "USD" ? Math.round(book * 1.37) : book, currency: cad });
}

const fx = await fetchUsdCad({ fetch: (async () => new Response(text("boc-history.json"))) as unknown as typeof fetch, now: () => now, startDate: "2025-10-01" });
saveFx(db, fx);
const spy = parseSsga(new Uint8Array(readFileSync(join(DIR, "ssga-spy.xlsx"))), "SPY");
saveFundFile(db, spy, now - 2 * 86_400_000);
saveFundFile(db, parseIshares(text("ishares-xeqt.csv"), "XEQT.TO", "ishares-ca"), now - 2 * 86_400_000);
saveFundFile(db, parseRoundhill(text("roundhill-holdings.csv"), "MARS"), now - 2 * 86_400_000);
saveFundFile(db, parseRoundhill(text("roundhill-holdings.csv"), "DRAM"), now - 2 * 86_400_000);
saveFundFile(db, ndxEstimate(parseNdxMembers(text("wikipedia-nasdaq100.json")), spy), now - 2 * 86_400_000);
metaFromFunds(db);
db.query("UPDATE instrument_meta SET kind = CASE WHEN key IN ('MARS','DRAM','SPY','VFV.TO','QQQ','XEQT.TO') THEN 'etf' ELSE 'stock' END").run();
db.query("INSERT OR IGNORE INTO instrument_meta (key) VALUES ('NOW')").run();
db.query("UPDATE instrument_meta SET name = 'ServiceNow Inc', pe = 61.8, high52 = 1198.09, low52 = 712.5, div_yield = NULL, metrics_at = ?, edgar_eps_ttm = 14.1, edgar_at = ? WHERE key = 'NOW'").run(now - 3 * 86_400_000, now - 3 * 86_400_000);

// A year of demo closes, so performance and the screener have history (demo closes only show in Demo mode).
const demo = demoNow;
for (const [key] of TICKERS) {
  const bars = await demo.bars(parseInstrumentKey(key)!, "1Day", now - 400 * 86_400_000, now);
  recordCloses(db, key, bars.map((b) => ({ date: new Date(b.t * 1000 + 12 * 3_600_000).toISOString().slice(0, 10), close: b.c, adjClose: b.c, source: "demo" })));
}
db.query("INSERT OR REPLACE INTO market_dividends (key, ex_date, amount, source) VALUES ('SPY', '2025-12-19', 1.9, 'tiingo'), ('SPY', '2026-03-20', 1.76, 'tiingo'), ('SPY', '2026-06-20', 1.84, 'tiingo'), ('SPY', '2026-09-19', 1.86, 'tiingo'), ('QQQ', '2026-09-22', 0.72, 'tiingo')").run();

saveEarnings(db, [{ key: "NOW", date: "2026-11-09", hour: "amc", epsEstimate: 3.61 }, { key: "RKLB", date: "2026-11-10", hour: "amc", epsEstimate: -0.05 }, { key: "SOFI", date: "2026-11-24", hour: "bmo", epsEstimate: 0.11 }], "finnhub");
saveNews(db, [
  { key: "RKLB", headline: "Rocket Lab wins NASA contract for two Neutron launches", source: "Reuters", url: "https://example.com/rklb-nasa", at: now - 2 * 3_600_000 },
  { key: "NOW", headline: "ServiceNow raises full-year subscription guidance", source: "CNBC", url: "https://example.com/now-guidance", at: now - 26 * 3_600_000 },
  { key: "NOW", headline: "Five software stocks to watch this week", source: "MarketWatch", url: "https://example.com/now-5", at: now - 50 * 3_600_000 },
  { key: "TSLA", headline: "Tesla deliveries beat estimates in October", source: "Bloomberg", url: "https://example.com/tsla", at: now - 5 * 3_600_000 },
], now);
saveNotes(db, space.id, "NOW", { thesis: "Workflow platform that keeps consolidating IT, HR and customer service onto one data model. Watch net retention and AI SKU attach.", notes: "Q3: cRPO +21%. Margin guide raised." });
saveWriteup(db, {
  spaceId: space.id,
  kind: "digest",
  key: null,
  forDate: "2026-11-03",
  body: "Your portfolio rose about 0.8% today, led by RKLB (+6.1%) after a NASA contract for two Neutron launches. NOW gained 2.3% following its guidance raise yesterday. Canadian holdings (ATZ.TO, XEQT.TO) are at yesterday's close; VFV.TO is shown at its Nov 3 close with an intraday estimate from SPY.\n\nOn concentration: through SPY, QQQ, VFV and XEQT you hold about 4% NVDA and 3.5% MSFT without owning either directly.\n\nAnalysis, not advice.",
  taskId: null,
});
saveWriteup(db, {
  spaceId: space.id,
  kind: "thesis_check",
  key: "NOW",
  forDate: "2026-11-09",
  body: "Your thesis still lines up with the last quarter: cRPO grew 21% and management raised the subscription guide. The risk to watch on the 9th is AI SKU attach, which the thesis leans on but which the company hasn't broken out yet.\n\nAnalysis, not advice.",
  taskId: null,
});
// Mark today's job slots as done so the dev engine makes no network calls while it's being screenshotted.
for (const name of ["fx", "eod", "funds", "meta", "news", "digest"]) {
  db.query("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(`markets.job.${name}`, JSON.stringify({ ranFor: now, lastRunAt: now - 3_600_000, lastError: null, attempts: 0, lastAttemptAt: null }));
}
console.log(`Loaded investing fixtures into ${process.env.ATRIUM_HOME} (space ${space.id}).`);
db.close();
