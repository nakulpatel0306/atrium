import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../../../src/engine/db";
import { saveQuotes } from "../../../src/engine/markets/cache";
import { saveFx } from "../../../src/engine/markets/fx";
import { saveFundFile } from "../../../src/engine/markets/funds/store";
import type { FundLine } from "../../../src/engine/markets/funds/types";
import { addHolding } from "../../../src/engine/markets/holdings";
import { healthFor } from "../../../src/engine/markets/portfolio";
import { createSpace } from "../../../src/engine/spaces";
import { tempHome } from "../../helpers";
import { NOW, viewData } from "./simple-fixture";

let home: ReturnType<typeof tempHome>;
let db: Database;
let spaceId: string;
beforeEach(() => {
  home = tempHome();
  db = openDb();
  spaceId = createSpace(db, { name: "Investing", kind: "markets", goal: "g" }).id;
});
afterEach(() => {
  db.close();
  home.cleanup();
});

const line = (ticker: string, weight: number, sector: string | null): FundLine => ({ ticker, key: ticker, name: ticker, weight, kind: "stock", sector, country: "United States", currency: "USD", via: null });

// As the audit found it: SPY's file and QQQ's estimate carry no sectors, XEQT's iShares file does, and META (a direct
// holding added the same morning) has no metadata row at all.
test("funds and stocks without their own sector borrow it from another fund's file, so little is Unknown", () => {
  saveFundFile(db, { fund: "SPY", source: "ssga", asOf: "2026-11-05", lines: [line("AAPL", 0.4, null), line("AMZN", 0.3, null), line("META", 0.3, null)], note: null }, NOW);
  saveFundFile(db, { fund: "QQQ", source: "ndx-estimate", asOf: "2026-11-05", lines: [line("AAPL", 0.6, null), line("META", 0.4, null)], note: null }, NOW);
  saveFundFile(
    db,
    { fund: "XEQT.TO", source: "ishares-ca", asOf: "2026-11-05", lines: [line("AAPL", 0.5, "Information Technology"), line("AMZN", 0.3, "Consumer Discretionary"), line("META", 0.2, "Communication Services")], note: null },
    NOW,
  );
  for (const [symbol, qty] of [["SPY", 1], ["QQQ", 1], ["META", 1]] as const) {
    addHolding(db, spaceId, { account: "TFSA", symbol, exchange: "US", name: symbol, quantity: qty, bookValue: 100, currency: "USD" });
  }
  saveQuotes(db, ["SPY", "QQQ", "META"].map((key) => ({ key, price: 100, prevClose: 100, at: NOW, source: "finnhub" as const, freshness: "live" as const })));
  saveFx(db, [{ date: "2026-11-04", rate: 1.4 }]);
  const h = healthFor(db, viewData(), spaceId, NOW);
  const pct = Object.fromEntries(h.bySector.map((s) => [s.label, Math.round(s.pct * 10) / 10]));
  expect(pct.Unknown).toBeUndefined();
  // SPY: 40 IT, 30 CD, 30 CS; QQQ: 60 IT, 40 CS; META: 100 CS. Each is a third of the portfolio.
  expect(pct["Information Technology"]).toBeCloseTo(33.3, 1);
  expect(pct["Consumer Discretionary"]).toBeCloseTo(10, 1);
  expect(pct["Communication Services"]).toBeCloseTo(56.7, 1);
});
