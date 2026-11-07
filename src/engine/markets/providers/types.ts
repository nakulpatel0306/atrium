import type { Exchange, Instrument } from "../instrument";

export type ProviderId = "alpaca" | "finnhub" | "alphavantage" | "tiingo" | "yahoo" | "demo";
export type Freshness = "live" | "eod" | "demo";
// fetchedAt is set only by Yahoo, whose freshness is judged by when Atrium fetched it rather than by its last trade.
export type Quote = { key: string; price: number; prevClose: number | null; at: number; source: ProviderId; freshness: Freshness; fetchedAt?: number };
// t is epoch seconds; a daily bar sits at its session date's ET midnight.
export type Bar = { t: number; o: number; h: number; l: number; c: number; v: number };
export type Timeframe = "1Day" | "5Min";
export type NewsItem = { key: string; headline: string; source: string; url: string; at: number };

// marketCap is in millions, in the listing's currency.
export type Metrics = { pe: number | null; high52: number | null; low52: number | null; divYield: number | null; marketCap: number | null };
export type Profile = { name: string; country: string | null; currency: string | null; industry: string | null; exchange: string | null };
export type SearchHit = { key: string; symbol: string; exchange: Exchange; name: string; type: string; note: string | null };
export type EarningsDate = { key: string; date: string; hour: string | null; epsEstimate: number | null };

// partial: what a per-symbol call collected before it failed (earnings), so the caller can keep it and resume.
export class ProviderError extends Error {
  partial?: { done: string[]; rows: EarningsDate[]; failed?: { key: string; reason: string }[] };
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
  metric?(i: Instrument): Promise<Metrics>;
  profile?(i: Instrument): Promise<Profile | null>;
  search?(q: string, signal?: AbortSignal): Promise<SearchHit[]>;
  earnings?(list: Instrument[], from: string, to: string): Promise<EarningsDate[]>;
  stream?(list: Instrument[], ev: StreamEvents): QuoteStream;
  maxStreamSymbols?: number;
  validate(): Promise<void>;
}
