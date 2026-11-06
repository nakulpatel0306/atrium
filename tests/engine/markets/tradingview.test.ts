import { expect, test } from "bun:test";
import { isTvSymbol, TV_KNOWN, tvPrefixFromListing, tvSymbol, tvSymbolUrl, widgetCoverage } from "../../../src/engine/markets/tradingview";

const TABLE: [string, string][] = [
  ["AMZN", "NASDAQ:AMZN"],
  ["ATZ.TO", "TSX:ATZ"],
  ["DRAM", "CBOE:DRAM"],
  ["MARS", "CBOE:MARS"],
  ["META", "NASDAQ:META"],
  ["NOW", "NYSE:NOW"],
  ["QBTS", "NASDAQ:QBTS"],
  ["QQQ", "NASDAQ:QQQ"],
  ["RKLB", "NASDAQ:RKLB"],
  ["SOFI", "NASDAQ:SOFI"],
  ["SPY", "AMEX:SPY"],
  ["TSLA", "NASDAQ:TSLA"],
  ["VFV.TO", "TSX:VFV"],
  ["XEQT.TO", "TSX:XEQT"],
];

test.each(TABLE)("%s maps to %s", (key, tv) => {
  expect(tvSymbol(key)).toBe(tv);
});

test("TV_KNOWN is exactly the 14 checked rows", () => {
  expect(Object.entries(TV_KNOWN).sort()).toEqual([...TABLE].sort());
});

test("unknown keys map by exchange or Finnhub listing", () => {
  expect(tvSymbol("SHOP.TO")).toBe("TSX:SHOP");
  expect(tvSymbol("ABC.V")).toBe("TSXV:ABC");
  expect(tvSymbol("ABC.NE")).toBe("NEO:ABC");
  expect(tvSymbol("GBTC:OTC")).toBe("OTC:GBTC");
  expect(tvSymbol("NVDA", "NASDAQ NMS - GLOBAL MARKET")).toBe("NASDAQ:NVDA");
  expect(tvSymbol("KO", "NEW YORK STOCK EXCHANGE, INC.")).toBe("NYSE:KO");
  expect(tvSymbol("XYZ", null)).toBe("XYZ");
  expect(tvSymbol("AMZN", "NEW YORK STOCK EXCHANGE, INC.")).toBe("NASDAQ:AMZN");
  expect(tvPrefixFromListing("NYSE ARCA")).toBe("AMEX");
  expect(tvPrefixFromListing("NYSE MKT LLC")).toBe("AMEX");
  expect(tvPrefixFromListing("CBOE BZX")).toBe("CBOE");
  expect(tvPrefixFromListing("BATS EXCHANGE")).toBe("CBOE");
  expect(tvPrefixFromListing(null)).toBeNull();
  expect(tvPrefixFromListing("LONDON STOCK EXCHANGE")).toBeNull();
});

test("widget coverage", () => {
  expect(widgetCoverage("CBOE:MARS")).toEqual({ ok: false, reason: "TradingView's free chart doesn't cover Cboe BZX listings, so this is Atrium's chart from Tiingo daily closes." });
  expect(widgetCoverage("NASDAQ:AMZN").ok).toBe(true);
  expect(widgetCoverage("XYZ").ok).toBe(true);
});

test("isTvSymbol only accepts plain symbols", () => {
  expect(isTvSymbol("NASDAQ:AMZN")).toBe(true);
  expect(isTvSymbol("TSX:BBD.B")).toBe(true);
  expect(isTvSymbol("XYZ")).toBe(true);
  expect(isTvSymbol('NASDAQ:AMZN"><script>')).toBe(false);
  expect(isTvSymbol("javascript:x")).toBe(false);
  expect(isTvSymbol("")).toBe(false);
});

test("attribution links", () => {
  expect(tvSymbolUrl("TSX:XEQT")).toBe("https://www.tradingview.com/symbols/TSX-XEQT/");
  expect(tvSymbolUrl("XYZ")).toBe("https://www.tradingview.com/symbols/XYZ/");
});
