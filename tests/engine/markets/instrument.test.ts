import { expect, test } from "bun:test";
import { instrumentFromWealthsimple, instrumentKey, parseInstrumentKey } from "../../../src/engine/markets/instrument";

test("instrument keys round-trip", () => {
  expect(instrumentKey({ symbol: "SHOP", exchange: "TSX" })).toBe("SHOP.TO");
  expect(instrumentKey({ symbol: "AAPL", exchange: "US" })).toBe("AAPL");
  expect(instrumentKey({ symbol: "XYZ", exchange: "TSXV" })).toBe("XYZ.V");
  expect(instrumentKey({ symbol: "AAPL", exchange: "NEO" })).toBe("AAPL.NE");
  expect(instrumentKey({ symbol: "GBTC", exchange: "OTC" })).toBe("GBTC:OTC");
  expect(parseInstrumentKey("shop.to")).toEqual({ symbol: "SHOP", exchange: "TSX" });
  expect(parseInstrumentKey(" BRK.B ")).toEqual({ symbol: "BRK.B", exchange: "US" });
  expect(parseInstrumentKey("AAPL.NE")).toEqual({ symbol: "AAPL", exchange: "NEO" });
  expect(parseInstrumentKey("xyz.v")).toEqual({ symbol: "XYZ", exchange: "TSXV" });
  expect(parseInstrumentKey("gbtc:otc")).toEqual({ symbol: "GBTC", exchange: "OTC" });
  expect(parseInstrumentKey("BBD.B.TO")).toEqual({ symbol: "BBD.B", exchange: "TSX" });
  expect(parseInstrumentKey("")).toBeNull();
  expect(parseInstrumentKey("not a symbol")).toBeNull();
});

test("Wealthsimple exchanges map by MIC first", () => {
  expect(instrumentFromWealthsimple("NEO", "NEOE")).toBe("NEO");
  expect(instrumentFromWealthsimple("NASDAQ", "")).toBe("US");
  expect(instrumentFromWealthsimple("TSX", "XTSE")).toBe("TSX");
  expect(instrumentFromWealthsimple("MOON", "")).toBeNull();
  // A CDR on NEO with a US ticker must stay NEO whatever the exchange text says.
  expect(instrumentFromWealthsimple("NASDAQ", "NEOE")).toBe("NEO");
  expect(instrumentFromWealthsimple("TSX-V", "")).toBe("TSXV");
  expect(instrumentFromWealthsimple("Cboe Canada", "")).toBe("NEO");
  expect(instrumentFromWealthsimple("OTC Markets", "")).toBe("OTC");
  expect(instrumentFromWealthsimple("", "XNYS")).toBe("US");
});
