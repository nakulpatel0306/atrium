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

test("Portfolio: each row's weight and the total gain on what was invested", () => {
  const view = portfolioView(db, viewData(), fx.spaceId, NOW);
  const html = renderToStaticMarkup(<Portfolio spaceId={fx.spaceId} view={view} />);
  expect(html).toContain(">Weight<");
  for (const h of view.holdings) expect(html).toContain(`>${h.weightPct!.toFixed(1)}%<`);
  expect(text(html)).toMatch(/\+CA\$1,896 \(\+37\.2%\)\s+total gain on CA\$5,094 invested/);
});

test("Portfolio: the empty state points to the import", () => {
  const view = { total: null, dayCad: null, dayPct: null, dayLabel: null, mix: null, fx: null, holdings: [], gain: null, note: null, empty: true, left: null };
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
    days: 30,
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
  expect(renderToStaticMarkup(<Earnings spaceId="spc_x" view={{ rows: [], source: "x", days: 30 }} />)).toContain("No earnings in the next 30 days for your holdings or watchlists.");
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
      { key: "XEQT.TO", symbol: "XEQT", exchange: "TSX" as const, name: "XEQT.TO", type: "typed", note: "Not in Finnhub's search. Atrium prices it from Yahoo Finance during TSX hours." },
    ],
    note: null,
  };
  const lists = [{ id: "lst_1", name: "Holdings" }, { id: "lst_2", name: "Ideas" }];
  const html = renderToStaticMarkup(<SearchResults result={result} lists={lists} active={0} onOpen={() => {}} onAdd={() => {}} />);
  expect(html).toContain('role="listbox"');
  expect(html.indexOf("SHOP")).toBeLessThan(html.indexOf("XEQT.TO"));
  expect(html).toContain("Not in Finnhub&#x27;s search. Atrium prices it from Yahoo Finance during TSX hours.");
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
  const row = { ...view.holdings.find((h) => h.key === "XEQT.TO")!, price: null, dayPct: null, missing: "Not priced yet. Yahoo Finance fills in during TSX hours (9:30 AM to 4:00 PM ET)." };
  const left = "1 Canadian holding isn't in the total yet. Yahoo Finance prices it during TSX hours (9:30 AM to 4:00 PM ET).";
  const html = renderToStaticMarkup(<Portfolio spaceId={fx.spaceId} view={{ ...view, holdings: [row], left }} />);
  expect(html).toContain("1 Canadian holding isn&#x27;t in the total yet. Yahoo Finance prices it during TSX hours (9:30 AM to 4:00 PM ET).");
  expect(html).toContain("Priced during TSX hours");
  expect(html).not.toContain("Alpha Vantage");
});

// ---- Task 15: the Symbol page ----
import { saveEarnings, saveNews } from "../../src/engine/markets/events";
import { requestAsk, symbolView } from "../../src/engine/markets/symbol";
import { SymbolBody } from "../../src/dashboard/components/invest/SymbolPage";

const fake = () => "http://localhost:7571/fake";
const PRIVACY = "TradingView sees which tickers you view, including the ones you hold. It never sees how much you own or what it&#x27;s worth.";

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
  expect(html).toContain("TradingView chart · may be delayed");
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

test("Symbol page: a TSX stock with no earnings offers to add a date; a fund has no earnings section", () => {
  const atz = renderToStaticMarkup(<SymbolBody spaceId={fx.spaceId} view={symbolView(db, viewData(), fx.spaceId, "ATZ.TO", NOW)} marketsView={null} frameUrl={fake} now={NOW} />);
  expect(atz).toContain("No date yet");
  expect(atz).toContain("Add a date");
  const html = renderToStaticMarkup(<SymbolBody spaceId={fx.spaceId} view={symbolView(db, viewData(), fx.spaceId, "XEQT.TO", NOW)} marketsView={null} frameUrl={fake} now={NOW} />);
  expect(html).not.toContain("Next earnings");
  expect(html).not.toContain("Add a date");
  expect(html).toContain("CA$35.00");
  clean(html);
});

test("Symbol page: Finnhub's dated news comes first; TradingView's feed only fills in, under its own name", () => {
  db.query("DELETE FROM market_news").run();
  const none = renderToStaticMarkup(<SymbolBody spaceId={fx.spaceId} view={symbolView(db, viewData(), fx.spaceId, "AMZN", NOW)} marketsView={null} frameUrl={fake} now={NOW} />);
  expect(none).toContain("TradingView news");
  expect(none).toContain("Its newest stories can be weeks old.");
  saveNews(db, [{ key: "AMZN", headline: "Amazon beats on AWS", source: "Reuters", url: "https://example.com/aws", at: NOW - 3600_000 }], NOW);
  const some = renderToStaticMarkup(<SymbolBody spaceId={fx.spaceId} view={symbolView(db, viewData(), fx.spaceId, "AMZN", NOW)} marketsView={null} frameUrl={fake} now={NOW} />);
  expect(some).toContain("Amazon beats on AWS");
  expect(some).toContain("Reuters · 1h ago");
  expect(some).not.toContain("TradingView news");
  db.query("DELETE FROM market_news").run();
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
  expect(html).toContain("Import a bank, card or Wealthsimple file to see where your money went.");
  expect(html).toContain("Your 2026 TFSA room isn&#x27;t set yet.");
  clean(html);
});

test("Money: the recap, budgets, subscriptions, Wealthsimple totals, and answers", () => {
  importMoney(db, fx.spaceId, previewMoney(moneyCsv("rbc.csv")));
  importMoney(db, fx.spaceId, previewMoney(moneyCsv("ws-activity-2026.csv")));
  saveWriteup(db, { spaceId: fx.spaceId, kind: "money", key: null, forDate: new Date(NOW).toISOString(), body: "You pay **CA$58.47** a month for subscriptions.\n\nAnalysis, not advice.", taskId: null });
  const view = { ...moneyView(db, fx.spaceId, NOW, "2026-10"), starters: STARTERS };
  const html = renderToStaticMarkup(<MoneyBody spaceId={fx.spaceId} view={view} now={NOW} />);
  expect(html).toContain("Groceries");
  expect(html).toContain("Based on 12 transactions, Oct 1 to Oct 27");
  expect(html).toContain("+CA$1,088.30 vs September");
  expect(html).toContain("Explain my month");
  expect(html).toContain("Set limit");
  expect(html).toContain("Show 12 transactions");
  expect(html).toContain("Subscriptions");
  expect(html).toContain("Netflix.com");
  expect(html).toContain("Bills");
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

test("Portfolio says once what TradingView sees, since its rows show TradingView charts", () => {
  const html = renderToStaticMarkup(<Portfolio spaceId={fx.spaceId} view={portfolioView(db, viewData(), fx.spaceId, NOW)} />);
  expect(html.split("TradingView sees which tickers you view, including the ones you hold. It never sees how much you own or what it&#x27;s worth.")).toHaveLength(2);
  expect(html).not.toContain("never your holdings");
});

test("the Settings TSX hint asks for an Alpha Vantage key only when there isn't one", async () => {
  const { tsxSourceHint } = await import("../../src/dashboard/components/Settings");
  expect(tsxSourceHint(false)).toBe("TSX prices during the day come from Yahoo Finance's public feed (no key, unofficial). Add a free Alpha Vantage key for official closing prices.");
  expect(tsxSourceHint(true)).toBe("TSX prices during the day come from Yahoo Finance's public feed (no key, unofficial). Alpha Vantage supplies the official closing prices.");
});

// ---- Plan 14: recap, budgets, subscriptions, TFSA room, reminder ----
import { setBudget } from "../../src/engine/money/budgets";
import { setRoom } from "../../src/engine/markets/tfsa";
import { requestExplain } from "../../src/engine/money/summary";
import { NeedsYou } from "../../src/dashboard/components/NeedsYou";
import { makeState } from "../tui/fixtures";

const wipeMoney = () => {
  for (const t of ["tasks", "money_transactions", "money_imports", "money_budgets", "money_nudges", "tfsa_room"]) db.query(`DELETE FROM ${t}`).run();
};

test("Money: four banks' files give a recap with its basis, the room tie-in, budget bars, flags and Explain", () => {
  wipeMoney();
  for (const f of ["td-chequing.csv", "td-credit.csv", "amex.csv", "ws-cash.csv"]) importMoney(db, fx.spaceId, previewMoney(moneyCsv(f)));
  setBudget(db, fx.spaceId, "Dining", 120);
  setBudget(db, fx.spaceId, "Groceries", 400);
  setRoom(db, 2026, 7000);
  const view = { ...moneyView(db, fx.spaceId, NOW, "2026-10"), starters: STARTERS };
  const html = renderToStaticMarkup(<MoneyBody spaceId={fx.spaceId} view={view} now={NOW} />);
  const t = text(html);
  expect(t).toContain("transfers left out");
  expect(t).toContain("Biggest changes");
  expect(t).toContain("Best Buy");
  expect(t).toContain("CA$7,000.00 of TFSA room left for 2026.");
  expect(t).toMatch(/You had CA\$[\d,.]+ left over in October\. You have CA\$7,000\.00 of TFSA room for 2026\. Facts, not advice\./);
  expect(html).toContain('class="money-bar over"');
  expect(html).toContain('class="money-bar near"');
  expect(t).toContain("price went up");
  expect(t).toContain("new this month");
  expect(t).toContain("was CA$11.99");
  clean(html);
  requestExplain(db, fx.spaceId, "2026-10", NOW);
  const asking = renderToStaticMarkup(<MoneyBody spaceId={fx.spaceId} view={{ ...moneyView(db, fx.spaceId, NOW, "2026-10"), starters: STARTERS }} now={NOW} />);
  expect(asking).toContain("Claude is putting your month into words…");
  // An Explain doesn't block the Ask box's own status line.
  expect(asking).not.toContain("Claude is looking at your money…");
  wipeMoney();
});

test("Money: an incomplete month says so plainly", () => {
  wipeMoney();
  importMoney(db, fx.spaceId, previewMoney("Date,Description,Amount\n2026-09-01,LUNCH,-14\n2026-09-30,LUNCH,-14\n2026-10-02,LUNCH,-14\n2026-10-12,LUNCH,-14\n", { account: "TD chequing", signs: "negative-out" }));
  const html = renderToStaticMarkup(<MoneyBody spaceId={fx.spaceId} view={{ ...moneyView(db, fx.spaceId, NOW, "2026-10"), starters: STARTERS }} now={NOW} />);
  expect(text(html)).toContain("Incomplete: TD chequing only through Oct 12.");
  db.query("DELETE FROM money_transactions").run();
  db.query("DELETE FROM money_imports").run();
});

test("Money: the Imports list, an unknown account said plainly, and no undo while Claude is looking", () => {
  wipeMoney();
  importMoney(db, fx.spaceId, previewMoney(moneyCsv("td-chequing.csv")));
  importMoney(db, fx.spaceId, previewMoney(moneyCsv("td-chequing-iso.csv"), { account: "Imported" }));
  const render = () => text(renderToStaticMarkup(<MoneyBody spaceId={fx.spaceId} view={{ ...moneyView(db, fx.spaceId, NOW, "2026-10"), starters: STARTERS }} now={NOW} />));
  const t = render();
  expect(t).toContain("Imports");
  expect(t).toMatch(/Unknown account\.\s+Change it\?/);
  expect(t).toContain("Oct 1 to Nov 3");
  expect(t).toContain("11 rows");
  expect(t).toContain("TD chequing");
  expect(t).toContain("Undo import");
  expect(t).toContain("Change account");
  expect(t).not.toContain("Imported");
  requestMoneyAsk(db, fx.spaceId, "Where did my money go last month?");
  const busy = render();
  expect(busy).toContain("Claude is looking at your money. Undo and Change account come back when it&#x27;s done.");
  expect(busy).not.toContain("Undo import");
  expect(busy).not.toContain("Change it?");
  expect(busy).toContain("Unknown account");
  wipeMoney();
});

test("Money: the import sends only the file's text, never its name", () => {
  const src = readFileSync(join(import.meta.dir, "../../src/dashboard/components/invest/MoneyImport.tsx"), "utf8");
  expect(src).toContain("file.text()");
  expect(/file\.name|\.name\b/.test(src)).toBe(false);
});

test("Needs you shows the import reminder as a quiet row with Import now and Dismiss, not counted", () => {
  const s = makeState({ approvals: [], proposals: [] });
  s.nudges = [{ id: "mnd_1", spaceId: "spc_1", spaceName: "Investing", kind: "import", title: "Time to import October", body: "Amex isn't imported for October yet.", path: "/space/spc_1?tab=money", createdAt: 0 }];
  const t = text(renderToStaticMarkup(<NeedsYou state={s} />));
  expect(t).toContain("Time to import October");
  expect(t).toContain("Import now");
  expect(t).toContain("Dismiss");
  expect(t).not.toContain("all caught up");
  expect(t).not.toContain("Needs you · 1");
});
