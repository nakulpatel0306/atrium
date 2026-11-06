import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AdvancedToggleView } from "../../src/dashboard/components/invest/AdvancedToggle";
import { InvestTabs } from "../../src/dashboard/components/invest/InvestPanel";

const tabs = (advanced: boolean) => renderToStaticMarkup(<InvestTabs spaceId="spc_1" advanced={advanced} tab="portfolio" onTab={() => {}} />);
const labels = (html: string) => [...html.matchAll(/role="tab"[^>]*>([^<]+)</g)].map((m) => m[1]);

test("Advanced off shows the five simple views only", () => {
  expect(labels(tabs(false))).toEqual(["Portfolio", "Watchlists", "Earnings", "Alerts", "Money"]);
});

test("Advanced on adds Health, Ideas, Chart and Paper", () => {
  expect(labels(tabs(true))).toEqual(["Portfolio", "Watchlists", "Earnings", "Alerts", "Money", "Health", "Ideas", "Chart", "Paper"]);
});

test("the Advanced switch explains what it hides", () => {
  const html = renderToStaticMarkup(<AdvancedToggleView on={false} open busy={false} error={null} onToggle={() => {}} onOpen={() => {}} />);
  expect(html).toContain("Advanced tools");
  expect(html).toContain("Look-through, TFSA, ideas, screener, paper trading, indicator alerts and the data budget. Off keeps them saved and stops their background work.");
  expect(html).toContain('role="switch"');
  expect(html).toContain('aria-checked="false"');
});

// ---- Task 13: Portfolio, Earnings, Alerts ----
import { afterAll, beforeAll } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../../src/engine/db";
import { createAlert, listAlerts } from "../../src/engine/markets/alerts";
import { saveWriteup } from "../../src/engine/markets/research";
import { portfolioView } from "../../src/engine/markets/views";
import { sparkPath } from "../../src/dashboard/simple";
import { Portfolio } from "../../src/dashboard/components/invest/Portfolio";
import { Earnings } from "../../src/dashboard/components/invest/Earnings";
import { AlertsSimple } from "../../src/dashboard/components/invest/AlertsSimple";
import { tempHome } from "../helpers";
import { NOW, simpleFixture, viewData } from "../engine/markets/simple-fixture";

let home: ReturnType<typeof tempHome>;
let db: Database;
let fx: ReturnType<typeof simpleFixture>;
beforeAll(() => {
  home = tempHome();
  db = openDb();
  fx = simpleFixture(db);
});
afterAll(() => {
  db.close();
  home.cleanup();
});
const text = (html: string) => html.replace(/<[^>]+>/g, " ");
const clean = (html: string) => {
  for (const bad of ["undefined", "NaN", "null"]) expect(text(html)).not.toContain(bad);
};

test("sparkPath scales to the box", () => {
  expect(sparkPath([1, 2], 60, 24)).toBe("M0,23L60,1");
  expect(sparkPath([5, 5, 5], 60, 24)).toBe("M0,12L30,12L60,12");
  expect(sparkPath([], 60, 24)).toBe("");
  expect(sparkPath([3], 60, 24)).toBe("");
});

test("Portfolio: total, today, rows with sparklines, no note without a digest", () => {
  const html = renderToStaticMarkup(<Portfolio spaceId={fx.spaceId} view={portfolioView(db, viewData(), fx.spaceId, NOW)} />);
  expect(html).toContain("Portfolio value");
  expect(html).toContain("CA$");
  expect(html).toContain("today");
  expect(html).toContain("AMZN");
  expect(html).toContain("+2.0%");
  expect(html).toContain("<path");
  expect(html).not.toContain("What moved");
  clean(html);
});

test("Portfolio: the daily note renders markdown with the advice tag", () => {
  saveWriteup(db, { spaceId: fx.spaceId, kind: "digest", key: null, forDate: "2026-11-04", body: "**Up** on news", taskId: null });
  const html = renderToStaticMarkup(<Portfolio spaceId={fx.spaceId} view={portfolioView(db, viewData(), fx.spaceId, NOW)} />);
  expect(html).toContain("What moved");
  expect(html).toContain("<strong>Up</strong>");
  expect(html).toContain("Analysis, not advice");
  db.query("DELETE FROM market_writeups").run();
});

test("Portfolio: the empty state points to the import", () => {
  const view = { total: null, dayCad: null, dayPct: null, dayLabel: null, mix: null, fx: null, holdings: [], note: null, empty: true, left: null };
  const html = renderToStaticMarkup(<Portfolio spaceId="spc_x" view={view} />);
  expect(html).toContain("No holdings yet. Import your Wealthsimple holdings file to see your portfolio.");
  expect(html).toContain("Import holdings");
  expect(html).toContain("Your watchlists still work without it.");
});

test("Earnings: grouped by day, with time, estimate and a held chip", () => {
  const view = {
    rows: [
      { key: "NOW", name: "ServiceNow", date: "2026-11-12", hour: "amc", epsEstimate: 1.23, source: "finnhub" as const, held: true },
      { key: "NVDA", name: "Nvidia", date: "2026-11-12", hour: "bmo", epsEstimate: null, source: "finnhub" as const, held: false },
      { key: "ATZ.TO", name: "Aritzia", date: "2026-11-13", hour: null, epsEstimate: null, source: "you" as const, held: true },
    ],
    source: "Finnhub earnings calendar · checked Nov 4",
  };
  const html = renderToStaticMarkup(<Earnings spaceId="spc_x" view={view} />);
  expect(html).toContain("Thu, Nov 12");
  expect(html).toContain("Fri, Nov 13");
  expect(html).toContain("after close");
  expect(html).toContain("before open");
  expect(html).toContain("time not set");
  expect(html).toContain("EPS est. 1.23");
  expect(html.match(/you hold this/g)).toHaveLength(2);
  expect(html).toContain("Finnhub earnings calendar · checked Nov 4");
  clean(html);
  expect(renderToStaticMarkup(<Earnings spaceId="spc_x" view={{ rows: [], source: "x" }} />)).toContain("No earnings in the next two weeks for your holdings or watchlists.");
});

test("AlertsSimple: indicator alerts are paused while Advanced is off", () => {
  createAlert(db, { spaceId: fx.spaceId, key: "AMZN", rule: { kind: "rsi_below", level: 30, period: 14 } });
  createAlert(db, { spaceId: fx.spaceId, key: "XEQT.TO", rule: { kind: "price_above", level: 40 } });
  const html = renderToStaticMarkup(<AlertsSimple spaceId={fx.spaceId} alerts={listAlerts(db, fx.spaceId)} advanced={false} />);
  expect(html).toContain("XEQT.TO");
  expect(html).toContain("price above CA$40.00");
  expect(html).not.toContain("RSI");
  expect(html).toContain("1 indicator alert is paused. Turn on Advanced tools to see them.");
  expect(html).toContain("Set price alerts from a symbol&#x27;s page.");
  const on = renderToStaticMarkup(<AlertsSimple spaceId={fx.spaceId} alerts={listAlerts(db, fx.spaceId)} advanced />);
  expect(on).toContain("RSI(14) below 30");
  expect(on).not.toContain("paused");
});

// ---- Task 14: Watchlists and search ----
import { listsView } from "../../src/engine/markets/views";
import { createList } from "../../src/engine/markets/lists";
import { nextSearch } from "../../src/dashboard/simple";
import { Watchlists } from "../../src/dashboard/components/invest/Watchlists";
import { SearchResults } from "../../src/dashboard/components/invest/SymbolSearch";

test("Watchlists: list chips, the first list's rows and the search box", () => {
  const ideas = createList(db, fx.spaceId, "Ideas");
  const view = listsView(db, viewData(), fx.spaceId, NOW);
  const html = renderToStaticMarkup(<Watchlists spaceId={fx.spaceId} view={view} />);
  expect(html).toContain(">Holdings<");
  expect(html).toContain(">Ideas<");
  expect(html).toContain("AMZN");
  expect(html).toContain("XEQT.TO");
  expect(html).toContain('placeholder="Search a stock or ETF, like Shopify or XEQT.TO"');
  expect(html).toContain('aria-label="Remove AMZN from Holdings"');
  expect(html).toContain("New list");
  clean(html);
  const empty = renderToStaticMarkup(<Watchlists spaceId={fx.spaceId} view={view} initialList={ideas.id} />);
  expect(empty).toContain("Nothing here yet. Search above to add a stock or ETF.");
});

test("SearchResults: US first, a typed TSX hit with its note, Open and Add on each", () => {
  const result = {
    hits: [
      { key: "SHOP", symbol: "SHOP", exchange: "US" as const, name: "Shopify Inc", type: "Common Stock", note: null },
      { key: "XEQT.TO", symbol: "XEQT", exchange: "TSX" as const, name: "XEQT.TO", type: "typed", note: "Not in Finnhub's search. Atrium will price it from Alpha Vantage after the close." },
    ],
    note: null,
  };
  const lists = [{ id: "lst_1", name: "Holdings" }, { id: "lst_2", name: "Ideas" }];
  const html = renderToStaticMarkup(<SearchResults result={result} lists={lists} active={0} onOpen={() => {}} onAdd={() => {}} />);
  expect(html).toContain('role="listbox"');
  expect(html.indexOf("SHOP")).toBeLessThan(html.indexOf("XEQT.TO"));
  expect(html).toContain("Not in Finnhub&#x27;s search. Atrium will price it from Alpha Vantage after the close.");
  expect(html.match(/>Open</g)).toHaveLength(2);
  expect(html.match(/>Add to Holdings</g)).toHaveLength(2);
  expect(html).toContain(">US<");
  expect(html).toContain(">TSX<");
  const noted = renderToStaticMarkup(<SearchResults result={{ hits: [], note: "Finnhub is busy. Try again in a minute." }} lists={lists} active={-1} onOpen={() => {}} onAdd={() => {}} />);
  expect(noted).toContain("Finnhub is busy. Try again in a minute.");
});

test("nextSearch only sends trimmed, changed queries", () => {
  expect(nextSearch(null, "  ")).toBeNull();
  expect(nextSearch(null, " shop ")).toBe("shop");
  expect(nextSearch("shop", "shop ")).toBeNull();
  expect(nextSearch("shop", "shopi")).toBe("shopi");
});

test("Portfolio says which holdings the total leaves out, and a Canadian row says how to include it", () => {
  const view = portfolioView(db, viewData(), fx.spaceId, NOW);
  const row = { ...view.holdings.find((h) => h.key === "XEQT.TO")!, price: null, dayPct: null, missing: "Canadian prices need a free Alpha Vantage key (Settings → Market data)." };
  const left = "1 Canadian holding isn't in the total. Add a free Alpha Vantage key in Settings → Market data to include it.";
  const html = renderToStaticMarkup(<Portfolio spaceId={fx.spaceId} view={{ ...view, holdings: [row], left }} />);
  expect(html).toContain("1 Canadian holding isn&#x27;t in the total. Add a free Alpha Vantage key in Settings → Market data to include it.");
  expect(html).toContain("Add Alpha Vantage to include in totals");
});

// ---- Task 15: the Symbol page ----
import { saveEarnings, saveNews } from "../../src/engine/markets/events";
import { requestAsk, symbolView } from "../../src/engine/markets/symbol";
import { SymbolBody } from "../../src/dashboard/components/invest/SymbolPage";

const fake = () => "http://localhost:7571/fake";
const PRIVACY = "TradingView sees which symbols you open, never your holdings.";

test("Symbol page for a held US stock", () => {
  db.query("INSERT OR REPLACE INTO instrument_meta (key, name, kind, pe, high52, low52, market_cap, metrics_at, listing) VALUES ('AMZN', 'Amazon.com Inc', 'stock', 40.1, 260, 160, 2410000, ?, 'NASDAQ NMS - GLOBAL MARKET')").run(NOW);
  saveEarnings(db, [{ key: "AMZN", date: "2026-11-12", hour: "amc", epsEstimate: 1.23 }], "finnhub");
  saveNews(db, Array.from({ length: 6 }, (_, n) => ({ key: "AMZN", headline: `Story ${n}`, source: "CNBC", url: `https://example.com/${n}`, at: NOW - n * 3600_000 })), NOW);
  const view = symbolView(db, viewData(), fx.spaceId, "AMZN", NOW);
  const html = renderToStaticMarkup(<SymbolBody spaceId={fx.spaceId} view={view} marketsView={null} frameUrl={fake} now={NOW} />);
  expect(html).toContain("US$250.00");
  expect(html).toContain("Finnhub · real-time");
  expect(html).toContain("Key stats");
  expect(html).toContain("Market cap");
  expect(html).toContain("Your position");
  expect(html).toContain("10 shares in TFSA");
  expect(html).toContain("Next earnings");
  expect(html).toContain("Thu, Nov 12 · after close · EPS est. 1.23");
  expect(html.match(/rel="noopener noreferrer"/g)?.length).toBe(5);
  expect(html.split(PRIVACY)).toHaveLength(2);
  expect(html).toContain("TradingView · delayed");
  expect(html).toContain("Ask Claude about this");
  expect(html).toContain("Anything specific? Leave blank for a quick overview.");
  clean(html);
  expect(text(html)).not.toContain("**");
});

test("Symbol page: an ask answer renders markdown with advice and what it made; a queued ask links to its task", () => {
  saveWriteup(db, { spaceId: fx.spaceId, kind: "ask", key: "AMZN", forDate: new Date(NOW).toISOString(), body: "## Summary\n**Strong** quarter\n\nAnalysis, not advice.", taskId: "tsk_done" });
  const answered = symbolView(db, viewData(), fx.spaceId, "AMZN", NOW);
  const html = renderToStaticMarkup(<SymbolBody spaceId={fx.spaceId} view={answered} marketsView={null} frameUrl={fake} now={NOW} />);
  expect(html).toContain("<h2>Summary</h2>");
  expect(html).toContain("<strong>Strong</strong>");
  expect(html).toContain("Analysis, not advice");
  expect(html).toContain('class="ask-made"');
  expect(html).toContain("Quick overview");
  const t = requestAsk(db, fx.spaceId, "AMZN", "Why up today?");
  const queued = renderToStaticMarkup(<SymbolBody spaceId={fx.spaceId} view={symbolView(db, viewData(), fx.spaceId, "AMZN", NOW)} marketsView={null} frameUrl={fake} now={NOW} />);
  expect(queued).toContain("Claude is looking at AMZN…");
  expect(queued).toContain(`href="/space/${fx.spaceId}?task=${t.id}"`);
  db.query("DELETE FROM tasks").run();
  db.query("DELETE FROM market_writeups").run();
});

test("Symbol page: a TSX key with no earnings offers to add a date", () => {
  const html = renderToStaticMarkup(<SymbolBody spaceId={fx.spaceId} view={symbolView(db, viewData(), fx.spaceId, "XEQT.TO", NOW)} marketsView={null} frameUrl={fake} now={NOW} />);
  expect(html).toContain("No date yet");
  expect(html).toContain("Add a date");
  expect(html).toContain("CA$35.00");
  clean(html);
});

test("Symbol page: no chart listener means Atrium's chart and no frame", () => {
  const html = renderToStaticMarkup(<SymbolBody spaceId={fx.spaceId} view={symbolView(db, viewData(), fx.spaceId, "MARS", NOW)} marketsView={null} frameUrl={null} now={NOW} />);
  expect(html).not.toContain("<iframe");
  expect(html).toContain("TradingView&#x27;s chart couldn&#x27;t start this time");
});

// ---- Money ----
import { importMoney, previewMoney } from "../../src/engine/money/import";
import { moneyView, requestMoneyAsk, STARTERS } from "../../src/engine/money/summary";
import { MoneyBody } from "../../src/dashboard/components/invest/Money";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const moneyCsv = (name: string) => readFileSync(join(import.meta.dir, "../fixtures/money", name), "utf8");

test("Money: empty state invites an import and still offers the starter questions", () => {
  const html = renderToStaticMarkup(<MoneyBody spaceId={fx.spaceId} view={{ ...moneyView(db, fx.spaceId, NOW), starters: STARTERS }} now={NOW} />);
  expect(html).toContain("Ask about my money");
  for (const q of STARTERS) expect(html).toContain(q.replace("'", "&#x27;"));
  expect(html).toContain("Import a bank, card or Wealthsimple file");
  expect(html).toContain("No bank or card transactions yet.");
  clean(html);
});

test("Money: the month by category, recurring and unusual charges, Wealthsimple totals, and answers", () => {
  importMoney(db, fx.spaceId, previewMoney(moneyCsv("rbc.csv")));
  importMoney(db, fx.spaceId, previewMoney(moneyCsv("ws-activity-2026.csv")));
  saveWriteup(db, { spaceId: fx.spaceId, kind: "money", key: null, forDate: new Date(NOW).toISOString(), body: "You pay **CA$58.47** a month for subscriptions.\n\nAnalysis, not advice.", taskId: null });
  const view = { ...moneyView(db, fx.spaceId, NOW, "2026-10"), starters: STARTERS };
  const html = renderToStaticMarkup(<MoneyBody spaceId={fx.spaceId} view={view} now={NOW} />);
  expect(html).toContain("Groceries");
  expect(html).toContain("Recurring charges");
  expect(html).toContain("Netflix.com");
  expect(html).toContain("Same amount at Best Buy within 3 days.");
  expect(html).toContain("CA$9,000.00");
  expect(html).toContain("<strong>CA$58.47</strong>");
  expect(html).toContain("Analysis, not advice");
  expect(html).toContain("October 2026");
  clean(html);
  requestMoneyAsk(db, fx.spaceId, "Where did my money go last month?");
  const queued = renderToStaticMarkup(<MoneyBody spaceId={fx.spaceId} view={{ ...moneyView(db, fx.spaceId, NOW), starters: STARTERS }} now={NOW} />);
  expect(queued).toContain("Claude is looking at your money…");
  db.query("DELETE FROM tasks").run();
  db.query("DELETE FROM market_writeups").run();
  db.query("DELETE FROM money_transactions").run();
});
