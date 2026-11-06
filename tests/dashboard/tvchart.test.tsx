import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChartCard, TvChart } from "../../src/dashboard/components/invest/TvChart";
import { CHART_TIMEOUT_MS, chartReducer, embedOrigin, embedUrl, type ChartEvent, type ChartState } from "../../src/dashboard/simple";

const PRIVACY = "TradingView sees which symbols you open, never your holdings.";

test("chartReducer", () => {
  const table: [ChartState, ChartEvent, ChartState][] = [
    ["ready", { type: "start", online: true }, "loading"],
    ["ready", { type: "start", online: false }, "offline"],
    ["failed", { type: "retry", online: true }, "loading"],
    ["failed", { type: "retry", online: false }, "offline"],
    ["loading", { type: "loaded" }, "ready"],
    ["failed", { type: "loaded" }, "ready"],
    ["loading", { type: "timeout" }, "failed"],
    ["loading", { type: "failed" }, "failed"],
    ["failed", { type: "failed" }, "failed"],
    ["loading", { type: "offline" }, "offline"],
    ["ready", { type: "offline" }, "ready"],
    ["offline", { type: "online" }, "offline"],
    ["ready", { type: "timeout" }, "ready"],
    ["offline", { type: "loaded" }, "offline"],
  ];
  for (const [from, e, to] of table) expect(`${from} + ${JSON.stringify(e)} → ${chartReducer(from, e)}`).toBe(`${from} + ${JSON.stringify(e)} → ${to}`);
  expect(CHART_TIMEOUT_MS).toBe(12_000);
});

test("embedUrl uses the engine-reported chart listener and carries only the symbol and parent", () => {
  const embed = { port: 7577, token: "abc123" };
  const url = embedUrl("NASDAQ:AMZN", embed, { hostname: "127.0.0.1", port: "7420" });
  const u = new URL(url);
  expect(u.origin).toBe("http://localhost:7577");
  expect(u.pathname).toBe("/embed/abc123/tradingview");
  expect(url).toContain("symbol=NASDAQ%3AAMZN");
  expect(url).toContain("parent=http%3A%2F%2F127.0.0.1%3A7420");
  expect([...u.searchParams.keys()]).toEqual(["symbol", "parent"]);
  expect(embedOrigin({ hostname: "localhost" }, 7577)).toBe("http://127.0.0.1:7577");
});

test("no chart listener this launch means Atrium's chart, never a guessed frame", () => {
  const out = renderToStaticMarkup(<TvChart tv="NASDAQ:AMZN" coverage={{ ok: true }} fallback={<div>fallback chart</div>} frameUrl={null} />);
  expect(out).not.toContain("<iframe");
  expect(out).toContain("fallback chart");
  expect(out).toContain("TradingView&#x27;s chart couldn&#x27;t start this time, so this is Atrium&#x27;s chart from daily closes.");
});

test("renders the frame with the sandbox, the labels and the privacy line once", () => {
  const out = renderToStaticMarkup(<TvChart tv="NASDAQ:AMZN" coverage={{ ok: true }} fallback={<div>fallback chart</div>} frameUrl={() => "http://localhost:7571/fake"} />);
  expect(out).toContain('<iframe title="NASDAQ:AMZN chart by TradingView" src="http://localhost:7571/fake"');
  expect(out).toContain('sandbox="allow-scripts allow-same-origin allow-popups"');
  expect(out.split(PRIVACY)).toHaveLength(2);
  expect(out).toContain("TradingView · delayed");
  expect(out).toContain("Show Atrium&#x27;s chart");
  expect(out).not.toContain("tradingview.com");
  expect(out).not.toContain("s3.");
  expect(out).not.toContain("fallback chart");
});

test("coverage not ok renders the fallback", () => {
  const reason = "TradingView's free chart doesn't cover OTC Markets listings, so this is Atrium's chart from its own daily closes.";
  const out = renderToStaticMarkup(<TvChart tv="OTC:GBTC" coverage={{ ok: false, reason }} fallback={<div>fallback chart</div>} frameUrl={() => "http://localhost:7571/fake"} />);
  expect(out).not.toContain("<iframe");
  expect(out).toContain("TradingView&#x27;s free chart doesn&#x27;t cover OTC Markets listings");
  expect(out).toContain("fallback chart");
  expect(out).not.toContain(PRIVACY);
});

test("the offline and failed cards say what happened and offer two ways on", () => {
  const off = renderToStaticMarkup(<ChartCard state="offline" onRetry={() => {}} onFallback={() => {}} />);
  expect(off).toContain("The chart needs the internet. Prices below are Atrium&#x27;s last saved ones.");
  expect(off).toContain("Try again");
  expect(off).toContain("Show Atrium&#x27;s chart");
  const failed = renderToStaticMarkup(<ChartCard state="failed" onRetry={() => {}} onFallback={() => {}} />);
  expect(failed).toContain("The chart didn&#x27;t load. TradingView may be down or blocked.");
});
