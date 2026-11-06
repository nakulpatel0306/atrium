// The simple investing views' client side: the chart frame's address and state, plus hooks and formatting.

// The TradingView page has a listener of its own on the engine's port + 1, under the other loopback name, so its
// code runs cross-origin to the dashboard with no API behind it.
export function embedOrigin(loc: { hostname: string; port: string }): string {
  const port = Number(loc.port) + 1;
  return loc.hostname === "localhost" ? `http://127.0.0.1:${port}` : `http://localhost:${port}`;
}

export function embedUrl(tv: string, loc: { hostname: string; port: string } = location): string {
  const q = new URLSearchParams({ symbol: tv, parent: `http://${loc.hostname}:${loc.port}` });
  return `${embedOrigin(loc)}/embed/tradingview?${q}`;
}

export type ChartState = "loading" | "ready" | "offline" | "failed";
export type ChartEvent =
  | { type: "start"; online: boolean }
  | { type: "loaded" }
  | { type: "failed" }
  | { type: "timeout" }
  | { type: "online" }
  | { type: "offline" }
  | { type: "retry"; online: boolean };

export const CHART_TIMEOUT_MS = 12_000;

// Nothing reloads by itself: coming back online leaves the offline card up until Try again.
export function chartReducer(s: ChartState, e: ChartEvent): ChartState {
  switch (e.type) {
    case "start":
    case "retry":
      return e.online ? "loading" : "offline";
    case "loaded":
      return s === "loading" || s === "failed" ? "ready" : s;
    case "timeout":
    case "failed":
      return s === "loading" || s === "failed" ? "failed" : s;
    case "offline":
      return s === "loading" ? "offline" : s;
    case "online":
      return s;
  }
}
