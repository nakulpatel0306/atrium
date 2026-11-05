import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../../../src/engine/db";
import * as alerts from "../../../src/engine/markets/alerts";
import { cachedQuotes } from "../../../src/engine/markets/cache";
import { recordCloses } from "../../../src/engine/markets/closes";
import { ESTIMATED, estimateFor } from "../../../src/engine/markets/estimate";
import { saveFx } from "../../../src/engine/markets/fx";
import type { Quote } from "../../../src/engine/markets/providers/types";
import { tempHome } from "../../helpers";

let home: ReturnType<typeof tempHome>;
let db: Database;
beforeEach(() => {
  home = tempHome();
  db = openDb();
  recordCloses(db, "VFV.TO", [{ date: "2026-11-04", close: 150, adjClose: null, source: "alphavantage" }]);
  recordCloses(db, "SPY", [{ date: "2026-11-04", close: 600, adjClose: null, source: "tiingo" }]);
  saveFx(db, [{ date: "2026-11-04", rate: 1.3961 }]);
});
afterEach(() => {
  db.close();
  home.cleanup();
});

const AT = Date.parse("2026-11-05T15:00:00Z"); // Thu 10:00 ET
const spy = (extra: Partial<Quote> = {}): Quote => ({ key: "SPY", price: 606, prevClose: 600, at: AT - 1000, source: "finnhub", freshness: "live", ...extra });

test("VFV is estimated from SPY's move and USD/CAD", () => {
  expect(ESTIMATED["VFV.TO"]).toEqual({ proxy: "SPY" });
  const e = estimateFor(db, "VFV.TO", spy(), AT)!;
  expect(e.value).toBe(151.5);
  expect(e.source).toBe("Estimate from SPY × USD/CAD (Bank of Canada Nov 4)");
  expect(e.tone).toBe("estimate");
  saveFx(db, [{ date: "2026-11-05", rate: 1.41 }]);
  expect(estimateFor(db, "VFV.TO", spy(), AT)!.value).toBe(153.01);
});

test("no estimate without a live proxy, its close, or a rate", () => {
  expect(estimateFor(db, "VFV.TO", spy({ freshness: "eod", source: "tiingo" }), AT)).toBeNull();
  expect(estimateFor(db, "VFV.TO", null, AT)).toBeNull();
  expect(estimateFor(db, "VFV.TO", spy({ at: AT - 86_400_000 }), AT)).toBeNull();
  expect(estimateFor(db, "SHOP.TO", spy(), AT)).toBeNull();
  recordCloses(db, "VFV.TO", [{ date: "2026-11-05", close: 151, adjClose: null, source: "alphavantage" }]);
  expect(estimateFor(db, "VFV.TO", spy(), AT)).toBeNull();
});

test("estimate is display-only", () => {
  const evaluate = spyOn(alerts, "evaluateQuotes");
  try {
    expect(estimateFor(db, "VFV.TO", spy(), AT)).not.toBeNull();
    expect(cachedQuotes(db, ["VFV.TO"]).size).toBe(0);
    expect(evaluate).not.toHaveBeenCalled();
  } finally {
    evaluate.mockRestore();
  }
});
