import type { Instrument } from "../instrument";

export type ProviderId = "alpaca" | "finnhub" | "alphavantage" | "demo";
export type Freshness = "live" | "eod" | "demo";
export type Quote = { key: string; price: number; prevClose: number | null; at: number; source: ProviderId; freshness: Freshness };
// t is epoch seconds; a daily bar sits at its session date's ET midnight.
export type Bar = { t: number; o: number; h: number; l: number; c: number; v: number };
export type Timeframe = "1Day" | "5Min";
export type NewsItem = { key: string; headline: string; source: string; url: string; at: number };

export class ProviderError extends Error {
  constructor(
    readonly kind: "auth" | "rate_limited" | "unavailable" | "no_history" | "unknown_symbol",
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export type StreamEvents = { quote(q: Quote): void; status(s: { ok: boolean; message: string }): void };
export type QuoteStream = { set(list: Instrument[]): void; close(): void };

// from/to are epoch ms.
export interface MarketProvider {
  id: ProviderId;
  label: string;
  covers(i: Instrument): boolean;
  quotes(list: Instrument[], signal?: AbortSignal): Promise<Quote[]>;
  bars(i: Instrument, tf: Timeframe, from: number, to: number, signal?: AbortSignal): Promise<Bar[]>;
  news?(list: Instrument[], since: number): Promise<NewsItem[]>;
  stream?(list: Instrument[], ev: StreamEvents): QuoteStream;
  maxStreamSymbols?: number;
  validate(): Promise<void>;
}
