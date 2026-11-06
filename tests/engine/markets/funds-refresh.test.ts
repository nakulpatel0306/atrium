import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../../../src/engine/db";
import { createSpace } from "../../../src/engine/spaces";
import { dataBudget } from "../../../src/engine/markets/budget";
import { fundsJob, refreshFund } from "../../../src/engine/markets/funds/refresh";
import { FUND_SOURCES, fundUrl, isFund } from "../../../src/engine/markets/funds/sources";
import { loadFundFile } from "../../../src/engine/markets/funds/store";
import { FundFileError } from "../../../src/engine/markets/funds/types";
import { setAdvanced } from "../../../src/engine/markets/advanced";
import { addToWatchlist } from "../../../src/engine/markets/watchlist";
import type { Exchange } from "../../../src/engine/markets/instrument";
import { tempHome } from "../../helpers";
import { stubFetch } from "./fakes";

let home: ReturnType<typeof tempHome>;
let db: Database;
beforeEach(() => {
  home = tempHome();
  db = openDb();
});
afterEach(() => {
  db.close();
  home.cleanup();
});

const DIR = join(import.meta.dir, "../../fixtures/markets/investing");
const NOW = Date.parse("2026-11-07T15:05:00Z"); // Sat 10:05 ET
const DAY = 86_400_000;

// Serves the recorded issuer files by host; Roundhill's daily file exists for Nov 4 only.
function issuers(over: { ishares?: () => Response; invesco?: () => Response } = {}) {
  return stubFetch((url) => {
    if (url.host === "www.blackrock.com") return over.ishares?.() ?? new Response(readFileSync(join(DIR, "ishares-xeqt.csv")));
    if (url.host === "www.ssga.com") return new Response(readFileSync(join(DIR, "ssga-spy.xlsx")));
    if (url.host === "www.roundhillinvestments.com") {
      return url.pathname.endsWith("_11042026.csv")
        ? new Response(readFileSync(join(DIR, "roundhill-holdings.csv")))
        : new Response("<!doctype html><html></html>", { headers: { "content-type": "text/html" } });
    }
    if (url.host === "www.invesco.com") return over.invesco?.() ?? new Response("Not Acceptable", { status: 406 });
    if (url.host === "en.wikipedia.org") return new Response(readFileSync(join(DIR, "wikipedia-nasdaq100.json")));
    throw new Error(`unexpected host ${url.host}`);
  });
}

test("the registry knows Nakul's funds", () => {
  expect(FUND_SOURCES["XEQT.TO"]).toEqual({ kind: "ishares-ca", productId: "309480", slug: "ishares-core-equity-etf-portfolio", ticker: "XEQT" });
  expect(FUND_SOURCES["VFV.TO"]!.kind).toBe("alias");
  for (const k of ["SPY", "MARS", "DRAM", "QQQ"]) expect(isFund(k)).toBe(true);
  expect(isFund("NOW")).toBe(false);
  expect(fundUrl(FUND_SOURCES["XEQT.TO"]!)).toBe(
    "https://www.blackrock.com/ca/investors/en/products/309480/ishares-core-equity-etf-portfolio/1464253357814.ajax?fileType=csv&fileName=XEQT_holdings&dataType=fund",
  );
});

test("refreshFund saves XEQT, then refuses a second refresh the same day", async () => {
  const s = issuers();
  const f = await refreshFund(db, "XEQT.TO", { fetch: s.fetch, now: () => NOW });
  expect(f.asOf).toBe("2026-11-04");
  expect(loadFundFile(db, "XEQT.TO")).toMatchObject({ asOf: "2026-11-04", source: "ishares-ca", fetchedAt: NOW, lastError: null });
  expect(s.calls[0]!.headers["user-agent"]).toBe("Atrium/1.0 (personal portfolio dashboard)");
  await expect(refreshFund(db, "XEQT.TO", { fetch: s.fetch, now: () => NOW + 3_600_000 })).rejects.toThrow(
    new FundFileError("Holdings for XEQT.TO were already refreshed today."),
  );
  expect(s.calls).toHaveLength(1);
  expect(dataBudget(db, NOW).find((r) => r.source === "ishares")!.callsToday).toBe(1);
});

test("stale file kept", async () => {
  await refreshFund(db, "XEQT.TO", { fetch: issuers().fetch, now: () => NOW - 8 * DAY });
  const s = issuers({ ishares: () => new Response("boom", { status: 500 }) });
  await expect(refreshFund(db, "XEQT.TO", { fetch: s.fetch, now: () => NOW })).rejects.toThrow("iShares returned an error (HTTP 500)");
  const kept = loadFundFile(db, "XEQT.TO")!;
  expect(kept.asOf).toBe("2026-11-04");
  expect(kept.lines.length).toBeGreaterThan(1500);
  expect(kept.lastError).toContain("HTTP 500");
});

test("garbage file rejected", async () => {
  await refreshFund(db, "XEQT.TO", { fetch: issuers().fetch, now: () => NOW - 8 * DAY });
  const s = issuers({ ishares: () => new Response("<html><body>We're down for maintenance</body></html>") });
  await expect(refreshFund(db, "XEQT.TO", { fetch: s.fetch, now: () => NOW })).rejects.toThrow(
    "The XEQT.TO holdings file has changed shape; Atrium couldn't find its holdings table.",
  );
  expect(loadFundFile(db, "XEQT.TO")!.lines.length).toBeGreaterThan(1500);
});

test("Roundhill: the latest daily file is found and shared by MARS and DRAM", async () => {
  const s = issuers();
  const cache = new Map<string, string>();
  const mars = await refreshFund(db, "MARS", { fetch: s.fetch, now: () => NOW, cache });
  const dram = await refreshFund(db, "DRAM", { fetch: s.fetch, now: () => NOW, cache });
  expect(mars.asOf).toBe("2026-11-04");
  expect(dram.note).toContain("swaps");
  // Sat, Fri, Thu tried and missing, then Wed's file; DRAM reuses it.
  expect(s.calls.map((c) => c.url.pathname.slice(-12))).toEqual(["11072026.csv", "11062026.csv", "11052026.csv", "11042026.csv"]);
});

test("QQQ falls back to the Nasdaq-100 estimate when Invesco says no", async () => {
  const s = issuers();
  const f = await refreshFund(db, "QQQ", { fetch: s.fetch, now: () => NOW });
  expect(f.source).toBe("ndx-estimate");
  expect(loadFundFile(db, "QQQ")!.source).toBe("ndx-estimate");
  expect(s.calls.some((c) => c.url.host === "en.wikipedia.org")).toBe(true);
  expect(loadFundFile(db, "SPY")).not.toBeNull();
  expect(f.lines.find((l) => l.ticker === "NVDA")!.weight).toBeGreaterThan(0.05);
});

test("VFV.TO refreshes SPY", async () => {
  const f = await refreshFund(db, "VFV.TO", { fetch: issuers().fetch, now: () => NOW });
  expect(f.fund).toBe("SPY");
  expect(loadFundFile(db, "SPY")).not.toBeNull();
});

test("the weekly job refreshes held and watched funds older than a week", async () => {
  const space = createSpace(db, { name: "Investing", kind: "markets", goal: "g" });
  setAdvanced(db, space.id, true);
  for (const [sym, ex] of [["XEQT", "TSX"], ["SPY", "US"], ["NOW", "US"]] as const) {
    addToWatchlist(db, space.id, { symbol: sym, exchange: ex as Exchange });
  }
  await refreshFund(db, "XEQT.TO", { fetch: issuers().fetch, now: () => NOW - 2 * DAY });
  await refreshFund(db, "SPY", { fetch: issuers().fetch, now: () => NOW - 9 * DAY });
  const s = issuers();
  const job = fundsJob(db, { fetch: s.fetch, now: () => NOW });
  expect(job.slot).toEqual({ at: "10:00", days: [6] });
  await job.run(NOW);
  expect(s.calls.map((c) => c.url.host)).toEqual(["www.ssga.com"]);
  expect(loadFundFile(db, "SPY")!.fetchedAt).toBe(NOW);
});

test("funds job makes no requests while Advanced is off", async () => {
  const space = createSpace(db, { name: "Investing", kind: "markets", goal: "g" });
  addToWatchlist(db, space.id, { symbol: "SPY", exchange: "US" });
  const off = issuers();
  await fundsJob(db, { fetch: off.fetch, now: () => NOW }).run(NOW);
  expect(off.calls).toHaveLength(0);
  setAdvanced(db, space.id, true);
  const on = issuers();
  await fundsJob(db, { fetch: on.fetch, now: () => NOW }).run(NOW);
  expect(on.calls.length).toBeGreaterThan(0);
});
